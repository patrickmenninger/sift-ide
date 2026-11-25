import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import type { ChangeRequest, SourceRange, SourceRanges } from "@sift/core";
import type { EditController } from "./edits.js";
import { logicOfSource, planNavigation, sourceOfLogic } from "./logic-model.js";
import type { Project } from "./project.js";
import type { HostMessage, LogicDocumentState, StepRef, UnitEdit, UnitTarget, WebviewMessage } from "./webview/protocol.js";

/** What the logic documents need from the rest of the extension. */
export interface LogicHost {
  readonly extensionUri: vscode.Uri;
  projectFor(uri: vscode.Uri): Project | null;
  /** Describe or update a source file's units (estimate first). */
  describe(uri: vscode.Uri): Promise<void>;
  showError(err: unknown): void;
  /** Change requests: drafts, proposing, review (phase-2-design §8, M15). */
  readonly edits: EditController;
}

export const LOGIC_VIEW_TYPE = "sift.logic";

/**
 * Logic documents (phase-2-design §6.1–6.4, M12): a custom editor for `.sift` files, also opened
 * for a source file with **Sift: Open Logic**. Step ↔ source highlighting both ways, Ctrl+click
 * navigation with an implementation picker, hover cards for calls, status badges, and Verify.
 * Editing (M15): drafts on units, proposing, questions, and requests whose code changed; the
 * work is the host's `EditController`.
 *
 * A source file with no `.sift` file yet gets a plain webview panel with the same document, since
 * a custom editor needs a file to open.
 */
export class LogicDocuments implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly viewSet = new Set<LogicView>();
  /** Unit to scroll to when a document opening for (root, source) is ready. */
  private readonly pendingReveal = new Map<string, string>();
  /** Unit to open for editing when a document opening for (root, source) is ready. */
  private readonly pendingEdit = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly selectionTimers = new Map<LogicView, ReturnType<typeof setTimeout>>();
  private hoverSeq = 0;

  /** A hovered step's code. */
  private readonly stepDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
    borderRadius: "2px",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.wordHighlightStrongForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  /** A hovered unit: its lines marked in the margin. */
  private readonly unitDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
  });
  /** A stale unit: its ranges are not trusted, so the whole unit is outlined (§6.2). */
  private readonly staleDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "dashed",
    borderColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(private readonly host: LogicHost) {
    this.disposables.push(
      this.stepDecoration,
      this.unitDecoration,
      this.staleDecoration,
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.onSelection(editor)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDirty(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDirty(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDirty(doc, false)),
    );
  }

  /** Open logic documents (integration tests read them). */
  get views(): readonly LogicView[] {
    return [...this.viewSet];
  }

  register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(LOGIC_VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  // ── Opening ──────────────────────────────────────────────────────────────────────────────

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const project = this.host.projectFor(document.uri);
    const relative = project?.relative(document.uri.fsPath) ?? null;
    const source = relative === null ? null : sourceOfLogic(relative);
    if (!project || source === null) {
      panel.webview.html = messageHtml(project ? "This file is not a Sift logic file." : 'This file is not in a Sift project. Run "Sift: Initialize" to set one up.');
      return;
    }
    this.attach(panel, project, source);
  }

  /**
   * Open the logic of a source file: its `.sift` file in the logic editor, or a panel when it has
   * none yet. An open document for the file is reused.
   */
  async open(project: Project, source: string, options: { reveal?: string; edit?: string; viewColumn?: vscode.ViewColumn; preserveFocus?: boolean } = {}): Promise<void> {
    const viewColumn = options.viewColumn ?? vscode.ViewColumn.Beside;
    const preserveFocus = options.preserveFocus ?? false;
    const existing = this.views.find((v) => v.project === project && v.source === source);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? viewColumn, preserveFocus);
      if (options.reveal) existing.post({ type: "reveal", unitId: options.reveal });
      if (options.edit) existing.post({ type: "edit", unitId: options.edit });
      return;
    }
    if (options.reveal) this.pendingReveal.set(viewKey(project, source), options.reveal);
    if (options.edit) this.pendingEdit.set(viewKey(project, source), options.edit);
    const logicFile = join(project.root, logicOfSource(source));
    if (existsSync(logicFile)) {
      await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(logicFile), LOGIC_VIEW_TYPE, { viewColumn, preserveFocus });
      return;
    }
    const panel = vscode.window.createWebviewPanel(LOGIC_VIEW_TYPE, `Logic: ${basename(source)}`, { viewColumn, preserveFocus }, { retainContextWhenHidden: true });
    this.attach(panel, project, source);
  }

  /** The source file of the logic document that has focus. */
  activeSource(): { project: Project; source: string } | null {
    const view = this.views.find((v) => v.panel.active);
    return view ? { project: view.project, source: view.source } : null;
  }

  private attach(panel: vscode.WebviewPanel, project: Project, source: string): LogicView {
    const view = new LogicView(panel, project, source, this, this.host);
    this.viewSet.add(view);
    panel.onDidDispose(() => {
      this.viewSet.delete(view);
      const timer = this.selectionTimers.get(view);
      if (timer) clearTimeout(timer);
      this.selectionTimers.delete(view);
      this.clearDecorations(view);
      view.dispose();
    });
    return view;
  }

  /** Called by a view once its webview is listening. */
  takePending(view: LogicView): { reveal?: string; edit?: string } {
    const key = viewKey(view.project, view.source);
    const reveal = this.pendingReveal.get(key);
    const edit = this.pendingEdit.get(key);
    this.pendingReveal.delete(key);
    this.pendingEdit.delete(key);
    return { ...(reveal ? { reveal } : {}), ...(edit ? { edit } : {}) };
  }

  // ── Logic → source ───────────────────────────────────────────────────────────────────────

  /** Highlight a step's (or unit's) code in the visible editors of the source (§6.2). */
  async highlight(view: LogicView, at: StepRef | null): Promise<void> {
    const seq = ++this.hoverSeq;
    const editors = sourceEditors(view);
    if (!at || editors.length === 0) {
      this.clearDecorations(view);
      return;
    }
    const ranges = await view.ranges(at).catch(() => null);
    if (seq !== this.hoverSeq) return; // the mouse moved on
    for (const editor of editors) this.decorate(editor, at, ranges);
  }

  /** Show a step's (or unit's) code: open the source beside the document and select it. */
  async showSource(view: LogicView, at: StepRef): Promise<void> {
    const ranges = await view.ranges(at);
    const first = ranges.ranges[0];
    const editor = await vscode.window.showTextDocument(view.sourceUri, {
      viewColumn: sourceColumn(view),
      preserveFocus: true,
      ...(first ? { selection: new vscode.Range(toRange(first).start, toRange(first).start) } : {}),
    });
    if (first) editor.revealRange(toRange(first), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.decorate(editor, at, ranges);
  }

  private decorate(editor: vscode.TextEditor, at: StepRef, ranges: SourceRanges | null): void {
    const all = (ranges?.ranges ?? []).map(toRange);
    const fresh = ranges?.fresh ?? false;
    editor.setDecorations(this.stepDecoration, fresh && at.stepId ? all : []);
    editor.setDecorations(this.unitDecoration, fresh && !at.stepId ? all : []);
    editor.setDecorations(this.staleDecoration, fresh ? [] : all);
  }

  clearDecorations(view: LogicView): void {
    for (const editor of sourceEditors(view)) {
      for (const d of [this.stepDecoration, this.unitDecoration, this.staleDecoration]) editor.setDecorations(d, []);
    }
  }

  // ── Source → logic ───────────────────────────────────────────────────────────────────────

  /** The cursor moved in a source editor: mark the step that owns it in that file's logic (§6.2). */
  private onSelection(editor: vscode.TextEditor): void {
    for (const view of this.views) {
      if (!sameUri(editor.document.uri, view.sourceUri)) continue;
      const previous = this.selectionTimers.get(view);
      if (previous) clearTimeout(previous);
      this.selectionTimers.set(
        view,
        setTimeout(() => {
          this.selectionTimers.delete(view);
          void this.syncCurrent(view, editor);
        }, 120),
      );
    }
  }

  async syncCurrent(view: LogicView, editor: vscode.TextEditor): Promise<void> {
    // Positions in an unsaved buffer do not match the saved file the engine reads.
    if (editor.document.isDirty) {
      view.post({ type: "current", at: null });
      return;
    }
    const p = editor.selection.active;
    const location = await view.project.server.request("sift/stepAt", { source: view.source, position: { line: p.line + 1, col: p.character + 1 } }).catch(() => null);
    view.post({ type: "current", at: location ? { unitId: location.unitId, ...(location.stepId ? { stepId: location.stepId } : {}) } : null });
  }

  private onDirty(doc: vscode.TextDocument, dirty = doc.isDirty): void {
    for (const view of this.views) if (sameUri(doc.uri, view.sourceUri)) view.setDirty(dirty);
  }

  // ── Navigation (§6.3) ────────────────────────────────────────────────────────────────────

  /** Ctrl+click or F12 on a step: follow its calls. `source`: Alt+click, open the callee's code. */
  async navigate(view: LogicView, at: StepRef, source: boolean): Promise<void> {
    if (!at.stepId) return;
    const targets = await view.project.server.request("sift/stepTargets", { unit: at.unitId, step: at.stepId });
    const plan = planNavigation(targets);
    if (plan.kind === "open") return this.openTarget(view, plan.target, source);
    if (plan.kind === "card") {
      view.post({ type: "targets", at, targets, pinned: true });
      return;
    }
    if (plan.kind === "none") {
      vscode.window.setStatusBarMessage(`Sift: ${plan.message}`, 4000);
      return;
    }
    const sameMember = new Set(plan.targets.map((t) => t.symbol.slice(t.symbol.lastIndexOf(".") + 1))).size === 1;
    const picked = await vscode.window.showQuickPick(
      plan.targets.map((t) => ({ label: t.symbol, description: t.file, detail: t.summary, target: t })),
      { title: sameMember ? "Go to Implementation" : "Go to Call", placeHolder: source ? "Open whose code?" : "Open whose logic?", matchOnDescription: true, matchOnDetail: true },
    );
    if (picked) await this.openTarget(view, picked.target, source);
  }

  async openTarget(view: LogicView, target: UnitTarget, source: boolean): Promise<void> {
    if (source) {
      const extraction = await view.project.server.request("sift/extraction", { source: target.file }).catch(() => null);
      const range = extraction?.units.find((u) => u.symbol === target.symbol)?.range;
      const uri = vscode.Uri.joinPath(vscode.Uri.file(view.project.root), target.file);
      const start = range ? toRange(range).start : undefined;
      await vscode.window.showTextDocument(uri, { viewColumn: sourceColumn(view), ...(start ? { selection: new vscode.Range(start, start) } : {}) });
      return;
    }
    if (target.file === view.source) {
      view.post({ type: "reveal", unitId: target.unitId });
      return;
    }
    // In the document's own column, so Go Back (navigation history) returns to it.
    await this.open(view.project, target.file, { reveal: target.unitId, ...(view.panel.viewColumn ? { viewColumn: view.panel.viewColumn } : {}) });
  }

  dispose(): void {
    for (const timer of this.selectionTimers.values()) clearTimeout(timer);
    for (const view of this.views) view.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** One open logic document: a webview showing one source file's logic. */
export class LogicView implements vscode.Disposable {
  private state: LogicDocumentState;
  private ready = false;
  private loading: Promise<void> | null = null;
  private again = false;
  /** Open change requests on this file's units, newest first. */
  private requests: ChangeRequest[] = [];
  private rangeCache = new Map<string, Promise<SourceRanges>>();
  private readonly disposables: vscode.Disposable[] = [];
  /** The last messages sent to the webview, newest last (integration tests read them). */
  readonly sent: HostMessage[] = [];
  readonly sourceUri: vscode.Uri;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly project: Project,
    readonly source: string,
    private readonly docs: LogicDocuments,
    private readonly host: LogicHost,
  ) {
    this.sourceUri = vscode.Uri.joinPath(vscode.Uri.file(project.root), source);
    const open = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, this.sourceUri));
    this.state = { source, file: null, error: null, dirty: open?.isDirty ?? false, edits: [], provider: project.server.info?.provider ?? null };
    const dist = vscode.Uri.joinPath(host.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.iconPath = vscode.Uri.joinPath(host.extensionUri, "media", "sift.svg");
    panel.webview.html = documentHtml(panel.webview, dist);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.receive(m)),
      // Every refresh (a file saved, descriptions written) can change freshness and text.
      project.onDidChangeStatus(() => void this.reload()),
      project.server.onDidChangeState((s) => s.kind === "running" && void this.reload()),
      // Change requests created, proposed, or found to need review (phase-2-design §8.9).
      project.server.on("sift/didChange", (change) => change.type === "edits" && void this.reloadEdits()),
      host.edits.onDidChangeActivity(() => this.postEdits()),
    );
    void this.reload();
  }

  /** Handle a message from the webview. Public so integration tests can act as the webview. */
  async receive(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": {
          this.ready = true;
          this.post({ type: "state", state: this.state });
          const pending = this.docs.takePending(this);
          if (pending.reveal) this.post({ type: "reveal", unitId: pending.reveal });
          if (pending.edit) this.post({ type: "edit", unitId: pending.edit });
          const editor = sourceEditors(this)[0];
          if (editor) await this.docs.syncCurrent(this, editor);
          return;
        }
        case "hover":
          return await this.docs.highlight(this, message.at);
        case "showSource":
          return await this.docs.showSource(this, message.at);
        case "navigate":
          return await this.docs.navigate(this, message.at, message.source);
        case "targets": {
          const at = message.at;
          if (!at.stepId) return;
          const targets = await this.project.server.request("sift/stepTargets", { unit: at.unitId, step: at.stepId });
          this.post({ type: "targets", at, targets, pinned: false });
          return;
        }
        case "openTarget":
          return await this.docs.openTarget(this, message.target, message.source);
        case "verify":
          return await this.verify(message.unitId);
        case "describe":
          return await this.host.describe(this.sourceUri);
        case "draft":
          await this.saveDraft(message.unitId, message, message.seq);
          return;
        case "propose": {
          const saved = await this.saveDraft(message.unitId, message, message.seq);
          if (saved) await this.host.edits.propose(this.project, saved.id);
          return;
        }
        case "cancel":
          return this.host.edits.cancel(this.project, message.id);
        case "answer":
          return await this.host.edits.answer(this.project, message.id, message.answers);
        case "review":
          await this.host.edits.reviews.show(this.project, message.id);
          return;
        case "discard":
          await this.host.edits.reject(this.project, message.id);
          return await this.reloadEdits();
        case "replan":
          return await this.host.edits.replan(this.project, message.id);
      }
    } catch (err) {
      this.host.showError(err);
    }
  }

  /**
   * Save a unit's draft as its change request. The webview hears that the draft was handled (saved
   * or refused) after the state that shows it, so it can drop its own copy.
   */
  private async saveDraft(unitId: string, draft: { edits: ChangeRequest["edits"]; request: string }, seq: number): Promise<ChangeRequest | undefined> {
    try {
      const ref = this.state.file?.units.find((u) => u.unit.id === unitId)?.ref;
      if (!ref) throw new Error("This unit is no longer described in the file.");
      return await this.host.edits.saveDraft(this.project, ref, unitId, { edits: draft.edits, request: draft.request });
    } catch (err) {
      this.host.showError(err);
      return undefined;
    } finally {
      await this.reloadEdits();
      this.post({ type: "draftSaved", unitId, seq });
    }
  }

  /** Load the file's change requests again and show them. */
  async reloadEdits(): Promise<void> {
    this.requests = await this.host.edits.openRequests(this.project, this.source).catch(() => this.requests);
    this.postEdits();
  }

  /** Show the change requests with what the host is doing with each. */
  private postEdits(): void {
    this.state = { ...this.state, edits: this.unitEdits(), provider: this.project.server.info?.provider ?? null };
    this.post({ type: "state", state: this.state });
  }

  private unitEdits(): UnitEdit[] {
    return this.requests.map((request) => ({ request, activity: this.host.edits.activity(this.project, request.id) }));
  }

  post(message: HostMessage): void {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  /** Load the file's logic again. Overlapping calls run once more, not once each. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      try {
        do {
          this.again = false;
          this.rangeCache = new Map();
          try {
            const file = await this.project.server.request("sift/logicFile", { source: this.source });
            this.requests = await this.host.edits.openRequests(this.project, this.source).catch(() => this.requests);
            this.state = { ...this.state, file, error: null, edits: this.unitEdits(), provider: this.project.server.info?.provider ?? null };
          } catch (err) {
            this.state = { ...this.state, file: null, error: err instanceof Error ? err.message : String(err) };
          }
          this.docs.clearDecorations(this);
          this.post({ type: "state", state: this.state });
        } while (this.again);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  get current(): LogicDocumentState {
    return this.state;
  }

  /** Whether the webview's script loaded and asked for its state. */
  get webviewReady(): boolean {
    return this.ready;
  }

  setDirty(dirty: boolean): void {
    if (this.state.dirty === dirty) return;
    this.state = { ...this.state, dirty };
    this.post({ type: "state", state: this.state });
  }

  /** A step's or unit's source ranges, cached until the next reload. */
  ranges(at: StepRef): Promise<SourceRanges> {
    const key = at.stepId ? `${at.unitId}/${at.stepId}` : at.unitId;
    let pending = this.rangeCache.get(key);
    if (!pending) {
      pending = this.project.server.request("sift/sourceRanges", { unit: at.unitId, ...(at.stepId ? { step: at.stepId } : {}) });
      pending.catch(() => this.rangeCache.delete(key));
      this.rangeCache.set(key, pending);
    }
    return pending;
  }

  private async verify(unitId: string): Promise<void> {
    const result = await this.project.server.request("sift/verify", { targets: [unitId] });
    const refused = result.refused[0];
    if (refused) {
      void vscode.window.showWarningMessage(`Sift did not verify ${refused.unit.slice(refused.unit.indexOf("#") + 1)}: ${refused.reason}.`);
    } else {
      vscode.window.setStatusBarMessage(`Sift: verified ${result.verified.map((r) => r.slice(r.indexOf("#") + 1)).join(", ")}`, 3000);
    }
    await this.reload();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

function viewKey(project: Project, source: string): string {
  return `${project.root}\n${source}`;
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme) return false;
  return process.platform === "win32" ? a.fsPath.toLowerCase() === b.fsPath.toLowerCase() : a.fsPath === b.fsPath;
}

function sourceEditors(view: LogicView): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter((e) => sameUri(e.document.uri, view.sourceUri));
}

/** Where to show the source: where it is already visible, else beside the document. */
function sourceColumn(view: LogicView): vscode.ViewColumn {
  return sourceEditors(view)[0]?.viewColumn ?? vscode.ViewColumn.Beside;
}

/** Sift ranges are 1-based, end exclusive. */
function toRange(r: SourceRange): vscode.Range {
  return new vscode.Range(r.start.line - 1, r.start.col - 1, r.end.line - 1, r.end.col - 1);
}

/** A webview page loading one of the bundles in dist/ (`webview` for logic, `graph` for graph views, `review` for a proposed edit). */
export function documentHtml(webview: vscode.Webview, dist: vscode.Uri, entry: "webview" | "graph" | "review" = "webview", title = "Logic"): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, `${entry}.js`));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, `${entry}.css`));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}

function messageHtml(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 20px;"><p>${escaped}</p></body></html>`;
}
