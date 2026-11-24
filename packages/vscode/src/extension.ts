import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { GenerateEvent, SourceRange } from "@sift/core";
import { planSummary, resultSummary } from "./generate-summary.js";
import { GraphPanels, type GraphHost, type GraphPanel } from "./graph-panels.js";
import { LogicDocuments, type LogicHost, type LogicView } from "./logic-editor.js";
import { sourceOfLogic } from "./logic-model.js";
import { Project } from "./project.js";
import type { ServerChild } from "./server-process.js";
import { CallTreeProvider, OutOfDateDecorations, SiftStatusBar, StatusTreeProvider, type ProjectRegistry } from "./views.js";

const CONFIG_FILE = "sift.config.yaml";

/**
 * The extension shell (phase-2-design §6, M11): one `sift serve` per workspace folder that holds
 * sift.config.yaml, a status bar item and explorer decorations for out-of-date logic, the
 * out-of-date, callers, and callees views, and generating with an estimate first.
 */
class Sift implements ProjectRegistry, LogicHost, GraphHost, vscode.Disposable {
  private readonly byFolder = new Map<string, Project>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly output = vscode.window.createOutputChannel("Sift", { log: true });
  private readonly statusTree = new StatusTreeProvider(this);
  private readonly callers = new CallTreeProvider("callers");
  private readonly callees = new CallTreeProvider("callees");
  private readonly decorations = new OutOfDateDecorations(this);
  private readonly statusBar = new SiftStatusBar(this);
  readonly logic = new LogicDocuments(this);
  readonly graphs = new GraphPanels(this);
  private readonly disposables: vscode.Disposable[] = [];
  /** Files the user said "not now" to under `sift.updateOnSave: ask`, until their logic is current again. */
  private readonly declined = new Set<string>();
  private generating = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  get projects(): readonly Project[] {
    return [...this.byFolder.values()];
  }

  activate(): void {
    const { subscriptions } = this.context;
    subscriptions.push(this);
    this.disposables.push(
      this.output,
      this.statusBar,
      this.changeEmitter,
      vscode.window.registerTreeDataProvider("sift.outOfDate", this.statusTree),
      vscode.window.registerTreeDataProvider("sift.callers", this.callers),
      vscode.window.registerTreeDataProvider("sift.callees", this.callees),
      vscode.window.registerFileDecorationProvider(this.decorations),
      this.logic,
      this.logic.register(),
      this.graphs,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncFolders()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc)),
    );
    // Source files the TypeScript adapter reads, descriptions, and the config. Other languages
    // join this list with their adapters.
    const watcher = vscode.workspace.createFileSystemWatcher("**/{*.ts,*.tsx,*.mts,*.cts,*.js,*.jsx,*.mjs,*.cjs,*.sift,sift.config.yaml,tsconfig.json,package.json}");
    const onFile = (uri: vscode.Uri) => this.onFileEvent(uri);
    this.disposables.push(watcher, watcher.onDidCreate(onFile), watcher.onDidDelete(onFile), watcher.onDidChange(onFile));

    const command = (id: string, run: (...args: never[]) => unknown) =>
      this.disposables.push(
        vscode.commands.registerCommand(id, async (...args: never[]) => {
          try {
            await run(...args);
          } catch (err) {
            this.showError(err);
          }
        }),
      );
    command("sift.initialize", () => this.initialize());
    command("sift.restartServer", () => this.restartServers());
    command("sift.showOutput", () => this.output.show());
    command("sift.refreshStatus", () => Promise.all(this.projects.map((p) => p.refreshStatus())));
    command("sift.focusStatus", () => vscode.commands.executeCommand("sift.outOfDate.focus"));
    command("sift.describeFile", (uri?: vscode.Uri) => this.generateFor(uri ?? vscode.window.activeTextEditor?.document.uri, "file"));
    command("sift.describeFolder", (uri?: vscode.Uri) => this.generateFor(uri, "folder"));
    command("sift.updateAll", () => this.updateAll());
    command("sift.generateEntry", (node?: { project?: Project; entry?: { file: string }; entries?: { file: string }[] }) => this.generateNode(node));
    command("sift.showCallers", (uri?: vscode.Uri) => this.showCalls("callers", uri));
    command("sift.showCallees", (uri?: vscode.Uri) => this.showCalls("callees", uri));
    command("sift.showCallersOfNode", (node?: { project: Project; hit?: { id: string }; id?: string }) => this.showCallsOfNode("callers", node));
    command("sift.showCalleesOfNode", (node?: { project: Project; hit?: { id: string }; id?: string }) => this.showCallsOfNode("callees", node));
    command("sift.showNeighbourhood", (uri?: vscode.Uri) => this.showNeighbourhood(uri));
    command("sift.showNeighbourhoodOfNode", (node?: { project: Project; hit?: { id: string }; id?: string }) => {
      const id = node?.hit?.id ?? node?.id;
      if (node && id && id.includes("#") && !id.startsWith("ext:")) return this.graphs.show(node.project, { view: "neighbourhood", ref: id });
      return undefined;
    });
    command("sift.showFlow", (route?: string) => this.showFlow(route));
    command("sift.showImpact", (uri?: vscode.Uri) => this.showImpact(uri));
    command("sift.showImpactOfChanges", () => this.showImpactOfChanges());
    command("sift.openLogic", (uri?: vscode.Uri) => this.openLogic(uri));
    command("sift.openSourceOfLogic", () => this.openSourceOfLogic());
    command("sift.openUnit", (root: string, ref: string) => this.openUnit(root, ref));
    command("sift.openRange", (root: string, file: string, range: SourceRange) => this.openRange(root, file, range));
    command("sift.openCallSite", (node?: { project: Project; hit: { via: { file: string; sites: { range: SourceRange }[] } } }) => {
      const site = node?.hit.via.sites[0];
      if (node && site) return this.openRange(node.project.root, node.hit.via.file, site.range);
      return undefined;
    });
    this.onDidChange(() => this.refreshViews());
    this.syncFolders();
  }

  // ── Projects and servers ─────────────────────────────────────────────────────────────────

  /** Start a server for each folder with sift.config.yaml; stop those whose folder went away. */
  private syncFolders(): void {
    const wanted = new Map<string, vscode.WorkspaceFolder>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === "file" && existsSync(join(folder.uri.fsPath, CONFIG_FILE))) wanted.set(folder.uri.toString(), folder);
    }
    let changed = false;
    for (const [key, project] of this.byFolder) {
      if (!wanted.has(key)) {
        project.dispose();
        this.byFolder.delete(key);
        changed = true;
      }
    }
    for (const [key, folder] of wanted) {
      if (this.byFolder.has(key)) continue;
      this.byFolder.set(key, this.createProject(folder));
      changed = true;
    }
    void vscode.commands.executeCommand("setContext", "sift.active", this.byFolder.size > 0);
    if (changed) this.changeEmitter.fire();
  }

  private createProject(folder: vscode.WorkspaceFolder): Project {
    const root = folder.uri.fsPath;
    const log = (line: string) => this.output.info(this.byFolder.size > 1 ? `[${folder.name}] ${line}` : line);
    const project = new Project(root, { launch: () => this.launchServer(root), log });
    project.server.onDidChangeState(() => this.changeEmitter.fire());
    project.onDidChangeStatus(() => {
      this.forgetDeclined(project);
      this.changeEmitter.fire();
    });
    void project.refreshStatus().catch((err: unknown) => log(`Status failed: ${err instanceof Error ? err.message : String(err)}`));
    return project;
  }

  /** `sift serve` from the bundle, on VS Code's own Node (Electron run as Node). */
  private launchServer(root: string): ServerChild {
    const server = this.context.asAbsolutePath(join("dist", "server.mjs"));
    return spawn(process.execPath, [server, "serve", root], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  private async restartServers(): Promise<void> {
    if (this.byFolder.size === 0) this.syncFolders();
    await Promise.all(
      this.projects.map(async (p) => {
        await p.server.restart();
        await p.refreshStatus();
      }),
    );
  }

  projectFor(uri: vscode.Uri): Project | null {
    for (const project of this.projects) if (project.relative(uri.fsPath) !== null) return project;
    return null;
  }

  private requireProject(uri: vscode.Uri | undefined): { project: Project; path: string } {
    if (!uri) throw new UserError("Open a source file first.");
    const project = this.projectFor(uri);
    if (!project) {
      throw new UserError(
        this.byFolder.size === 0 ? 'This workspace has no Sift project. Run "Sift: Initialize" to set one up.' : `${vscode.workspace.asRelativePath(uri)} is not in a Sift project.`,
      );
    }
    return { project, path: project.relative(uri.fsPath) ?? "" };
  }

  // ── Keeping the status current ───────────────────────────────────────────────────────────

  private onFileEvent(uri: vscode.Uri): void {
    const path = uri.fsPath.replace(/\\/g, "/");
    if (/\/(node_modules|\.git)\//.test(path) || path.includes("/.sift/.cache/")) return;
    if (path.endsWith(`/${CONFIG_FILE}`)) {
      // A new config starts a server; a changed one needs a restart to be read.
      const project = this.projectFor(uri);
      if (project && existsSync(uri.fsPath)) void project.server.restart().then(() => project.refreshStatus(), () => {});
      this.syncFolders();
      return;
    }
    this.projectFor(uri)?.scheduleRefresh();
  }

  private onSaved(doc: vscode.TextDocument): void {
    const project = this.projectFor(doc.uri);
    if (!project) return;
    if (vscode.workspace.getConfiguration("sift", doc.uri).get<string>("updateOnSave") !== "ask") return;
    const path = project.relative(doc.uri.fsPath);
    if (!path) return;
    // Ask once the status reflects the save.
    const subscription = project.onDidChangeStatus(() => {
      subscription.dispose();
      const problems = project.files.get(path);
      const key = `${project.root}\n${path}`;
      if (!problems || this.declined.has(key) || this.generating) return;
      void vscode.window.showInformationMessage(`The logic for ${path} is out of date.`, "Update…", "Not now").then((choice) => {
        if (choice === "Update…") void this.generate(project, [path]).catch((err: unknown) => this.showError(err));
        else if (choice === "Not now") this.declined.add(key);
      });
    });
    project.scheduleRefresh();
  }

  private forgetDeclined(project: Project): void {
    for (const key of this.declined) {
      const [root, path] = key.split("\n") as [string, string];
      if (root === project.root && !project.files.has(path)) this.declined.delete(key);
    }
  }

  private refreshViews(): void {
    this.statusTree.refresh();
    this.decorations.refresh();
    this.statusBar.update();
  }

  // ── Generating (phase-2-design §6.4: explicit, with an estimate first) ────────────────────

  private async generateFor(uri: vscode.Uri | undefined, scope: "file" | "folder"): Promise<void> {
    const { project, path } = this.requireProject(uri);
    if (scope === "folder" && path === "") return this.generate(project, undefined);
    await this.generate(project, [path]);
  }

  private async updateAll(): Promise<void> {
    const projects = this.projects;
    if (projects.length === 0) throw new UserError('This workspace has no Sift project. Run "Sift: Initialize" to set one up.');
    let project = projects[0]!;
    if (projects.length > 1) {
      const picked = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.root))?.name ?? p.root, description: `${p.outOfDate} out of date`, project: p })),
        { placeHolder: "Update the descriptions of which project?" },
      );
      if (!picked) return;
      project = picked.project;
    }
    await this.generate(project, undefined);
  }

  private async generateNode(node?: { project?: Project; entry?: { file: string }; entries?: { file: string }[] }): Promise<void> {
    if (!node?.project) return;
    const files = node.entry ? [node.entry.file] : [...new Set((node.entries ?? []).map((e) => e.file))];
    if (files.length > 0) await this.generate(node.project, files);
  }

  private async generate(project: Project, paths: string[] | undefined): Promise<void> {
    if (this.generating) throw new UserError("Sift is already generating descriptions. Wait for it to finish, or cancel it.");
    this.generating = true;
    try {
      const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Sift: estimating…" }, () =>
        project.server.request("sift/generate", { ...(paths ? { paths } : {}), dryRun: true }),
      );
      const provider = project.server.info?.provider ?? { id: "claude-code", local: false };
      const summary = planSummary(plan, { local: provider.local, providerId: provider.id });
      if (summary.nothing) {
        // Renames and deletions need no AI, but they still rewrite .sift files: ask first.
        if (summary.message.startsWith("Nothing")) {
          void vscode.window.showInformationMessage(summary.message);
          return;
        }
        const ok = await vscode.window.showInformationMessage(summary.message, { modal: true, detail: summary.detail || undefined }, "Apply");
        if (ok !== "Apply") return;
      } else {
        const ok = await vscode.window.showInformationMessage(summary.message, { modal: true, detail: summary.detail }, "Generate");
        if (ok !== "Generate") return;
      }

      const token = `g${Date.now().toString(36)}`;
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Sift", cancellable: true },
        async (progress, cancel) => {
          let total = 0;
          let done = 0;
          const subscription = project.server.on("sift/generateProgress", (p) => {
            if (p.token !== token) return;
            const e = p.event;
            this.logEvent(e);
            if (e.type === "start") {
              total = e.units;
              progress.report({ message: `describing ${total} unit${total === 1 ? "" : "s"}…` });
            } else if (e.type === "described" || e.type === "failed") {
              if (e.type === "described" && e.action === "context-check") return;
              done++;
              const name = e.unit.slice(e.unit.indexOf("#") + 1);
              progress.report({ message: `${done}/${total} ${name}`, ...(total > 0 ? { increment: 100 / total } : {}) });
            }
          });
          this.statusBar.setBusy("generating…");
          try {
            return await project.server.request("sift/generate", { ...(paths ? { paths } : {}), token }, cancel);
          } finally {
            subscription.dispose();
            this.statusBar.setBusy(null);
          }
        },
      );
      const result = resultSummary(report);
      for (const f of report.failed) this.output.warn(`failed: ${f.unit}: ${f.reason}${f.problems.map((p) => `\n  - ${p}`).join("")}`);
      this.output.info(result.message);
      const show = result.problem ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(result.message, "Show Output").then((c) => c && this.output.show());
      await project.refreshStatus();
    } finally {
      this.generating = false;
    }
  }

  private logEvent(e: GenerateEvent): void {
    if (e.type === "described") this.output.info(`✓ ${e.unit}  ${e.task} · ${e.model} · ${(e.durationMs / 1000).toFixed(1)}s${e.stale ? " · stale" : ""}`);
    else if (e.type === "failed") this.output.warn(`✗ ${e.unit}: ${e.reason}`);
    else if (e.type === "substituted") this.output.warn(`${e.model} is used instead of the ${e.from} tier: ${e.reason}`);
    else this.output.info(`Describing or updating ${e.units} units in ${e.files} files…`);
  }

  // ── Callers and callees ──────────────────────────────────────────────────────────────────

  private async showCalls(direction: "callers" | "callees", uri?: vscode.Uri): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    const { project, path } = this.requireProject(target);
    const position = editor && target && editor.document.uri.toString() === target.toString() ? editor.selection.active : new vscode.Position(0, 0);
    const unit = await project.unitAt(path, { line: position.line + 1, col: position.character + 1 });
    if (!unit) throw new UserError(`Sift found no function or method at the cursor in ${path}.`);
    await this.revealCalls(direction, project, unit.ref);
  }

  private async showCallsOfNode(direction: "callers" | "callees", node?: { project: Project; hit?: { id: string }; id?: string }): Promise<void> {
    const id = node?.hit?.id ?? node?.id;
    if (node && id) await this.revealCalls(direction, node.project, id);
  }

  private async revealCalls(direction: "callers" | "callees", project: Project, ref: string): Promise<void> {
    (direction === "callers" ? this.callers : this.callees).show(project, ref);
    await vscode.commands.executeCommand("setContext", `sift.has${direction === "callers" ? "Callers" : "Callees"}`, true);
    await vscode.commands.executeCommand(`sift.${direction}.focus`);
  }

  // ── Graph views (phase-2-design §6.5) ───────────────────────────────────────────────────

  /** The unit at the cursor (or the file's module scope), for commands that act on it. */
  private async unitAtCursor(uri?: vscode.Uri): Promise<{ project: Project; ref: string }> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    const { project, path } = this.requireProject(target);
    const position = editor && target && editor.document.uri.toString() === target.toString() ? editor.selection.active : new vscode.Position(0, 0);
    const unit = await project.unitAt(path, { line: position.line + 1, col: position.character + 1 });
    if (!unit) throw new UserError(`Sift found no function or method at the cursor in ${path}.`);
    return { project, ref: unit.ref };
  }

  private async showNeighbourhood(uri?: vscode.Uri): Promise<void> {
    const { project, ref } = await this.unitAtCursor(uri);
    await this.graphs.show(project, { view: "neighbourhood", ref });
  }

  private async showImpact(uri?: vscode.Uri): Promise<void> {
    const { project, ref } = await this.unitAtCursor(uri);
    await this.graphs.show(project, { view: "impact", refs: [ref], what: `changing ${ref.slice(ref.indexOf("#") + 1)}` });
  }

  private async showImpactOfChanges(): Promise<void> {
    const project = await this.pickProject("Show the impact of changes in which project?");
    if (project) await this.graphs.show(project, { view: "impact", refs: [], diff: "HEAD", what: "uncommitted changes" });
  }

  /** Show a route's flow; without a route, pick one. */
  private async showFlow(route?: string): Promise<void> {
    const project = await this.pickProject("Show a route from which project?");
    if (!project) return;
    if (route) {
      await this.graphs.show(project, { view: "flow", route: route.startsWith("route:") ? route : `route:${route}` });
      return;
    }
    const routes = await project.server.request("sift/routes", {});
    if (routes.length === 0) throw new UserError("Sift found no HTTP routes in this project. Routes come from rule packs (Express is built in).");
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.slice("route:".length), route: r })),
      { title: "Show Route Flow", placeHolder: "Which route?", matchOnDescription: true },
    );
    if (picked) await this.graphs.show(project, { view: "flow", route: picked.route });
  }

  /** The project of the active editor, the only project, or one the user picks. */
  private async pickProject(question: string): Promise<Project | undefined> {
    const projects = this.projects;
    if (projects.length === 0) throw new UserError('This workspace has no Sift project. Run "Sift: Initialize" to set one up.');
    const active = vscode.window.activeTextEditor && this.projectFor(vscode.window.activeTextEditor.document.uri);
    if (active) return active;
    if (projects.length === 1) return projects[0];
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.root))?.name ?? p.root, project: p })),
      { placeHolder: question },
    );
    return picked?.project;
  }

  /** From a graph view: open a unit's logic, scrolled to it (or the file's logic when it is not described yet). */
  async openUnitLogic(project: Project, ref: string): Promise<void> {
    const file = ref.slice(0, ref.indexOf("#"));
    const logic = await project.server.request("sift/logicFile", { source: file }).catch(() => null);
    const unit = logic?.units.find((u) => u.ref === ref);
    await this.logic.open(project, file, { ...(unit ? { reveal: unit.unit.id } : {}), viewColumn: vscode.ViewColumn.Beside });
  }

  openCode(project: Project, ref: string): Promise<void> {
    return this.openUnit(project.root, ref);
  }

  openSite(project: Project, file: string, range: SourceRange): Promise<void> {
    return this.openRange(project.root, file, range);
  }

  log(line: string): void {
    this.output.warn(line);
  }

  // ── Logic documents (phase-2-design §6.1) ───────────────────────────────────────────────

  describe(uri: vscode.Uri): Promise<void> {
    return this.generateFor(uri, "file");
  }

  /** Open the logic of a source file beside it. */
  private async openLogic(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const { project, path } = this.requireProject(target);
    const source = sourceOfLogic(path);
    if (source !== null) {
      // Already a .sift file: show it as a logic document.
      await this.logic.open(project, source, { viewColumn: vscode.ViewColumn.Active });
      return;
    }
    await this.logic.open(project, path, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  }

  /** From a logic document, open its source file beside it. */
  private async openSourceOfLogic(): Promise<void> {
    const active = this.logic.activeSource();
    if (!active) throw new UserError("Open a logic document first.");
    await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(active.project.root), active.source), { viewColumn: vscode.ViewColumn.Beside });
  }

  // ── Navigation ───────────────────────────────────────────────────────────────────────────

  private async openUnit(root: string, ref: string): Promise<void> {
    const project = this.projects.find((p) => p.root === root);
    const hash = ref.indexOf("#");
    const file = hash < 0 ? ref : ref.slice(0, hash);
    const symbol = hash < 0 ? null : ref.slice(hash + 1);
    let range: SourceRange | undefined;
    if (project && symbol) {
      const extraction = await project.server.request("sift/extraction", { source: file }).catch(() => null);
      range = extraction?.units.find((u) => u.symbol === symbol)?.range;
    }
    await this.openRange(root, file, range);
  }

  private async openRange(root: string, file: string, range?: SourceRange): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), file);
    const selection = range ? new vscode.Range(range.start.line - 1, range.start.col - 1, range.start.line - 1, range.start.col - 1) : undefined;
    await vscode.window.showTextDocument(uri, { preview: true, ...(selection ? { selection } : {}) });
  }

  // ── Initialize ───────────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file" && !existsSync(join(f.uri.fsPath, CONFIG_FILE)));
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(vscode.workspace.workspaceFolders?.length ? "Every folder in this workspace already has Sift set up." : "Open a folder first.");
      return;
    }
    const folder =
      folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: "Set up Sift in which folder?" }))?.folder;
    if (!folder) return;
    const server = this.context.asAbsolutePath(join("dist", "server.mjs"));
    const output = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [server, "init", folder.uri.fsPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
      ),
    );
    const result = JSON.parse(output) as { created: string[]; updated: string[] };
    this.output.info(`Set up Sift in ${folder.uri.fsPath}: created ${result.created.join(", ") || "nothing"}; updated ${result.updated.join(", ") || "nothing"}.`);
    this.syncFolders();
    const choice = await vscode.window.showInformationMessage(`Set up Sift in ${folder.name}. Review sift.config.yaml and commit it.`, "Open sift.config.yaml");
    if (choice) await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, CONFIG_FILE));
  }

  // ── Errors ───────────────────────────────────────────────────────────────────────────────

  showError(err: unknown): void {
    if (err instanceof UserError) {
      void vscode.window.showInformationMessage(err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const details = (err as { details?: unknown }).details;
    this.output.error(`${message}${Array.isArray(details) ? details.map((d) => `\n  ${String(d)}`).join("") : ""}`);
    void vscode.window.showErrorMessage(`Sift: ${message.split("\n")[0]}`, "Show Output").then((c) => c && this.output.show());
  }

  dispose(): void {
    for (const project of this.byFolder.values()) project.dispose();
    this.byFolder.clear();
    for (const d of this.disposables) d.dispose();
  }
}

/** A problem with what the user asked for, shown as information rather than an error. */
class UserError extends Error {}

let instance: Sift | null = null;

export function activate(context: vscode.ExtensionContext): { projects: () => readonly Project[]; logicViews: () => readonly LogicView[]; graphViews: () => readonly GraphPanel[] } {
  instance = new Sift(context);
  instance.activate();
  // Returned for integration tests.
  return { projects: () => instance?.projects ?? [], logicViews: () => instance?.logic.views ?? [], graphViews: () => instance?.graphs.views ?? [] };
}

export async function deactivate(): Promise<void> {
  // Stop the servers cleanly (stdin closed) rather than leaving it to process exit.
  const projects = instance?.projects ?? [];
  instance = null;
  await Promise.all(projects.map((p) => p.server.stop()));
}
