import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { SiftError, type ChangeRequest, type DescriptionEdit } from "@sift/core";
import { activityOf, describeRequest, draftAction, filesOf, openRequestFor, shortName, SHOWN_STATES, textHash } from "./edit-host-model.js";
import type { Project } from "./project.js";
import { ReviewPanels } from "./review-panel.js";
import type { EditActivity } from "./webview/protocol.js";

/** What editing needs from the rest of the extension. */
export interface EditUiHost {
  readonly extensionUri: vscode.Uri;
  readonly projects: readonly Project[];
  showError(err: unknown): void;
  /** Open a unit's logic, scrolled to it. */
  openUnitLogic(project: Project, ref: string): Promise<void>;
  openCode(project: Project, ref: string): Promise<void>;
  /** Open a file's logic with a unit ready for editing. */
  editInLogic(project: Project, file: string, unitId: string): Promise<void>;
}

/** Virtual documents holding a proposal's new text, for the diff editor. */
export const PROPOSAL_SCHEME = "sift-proposal";

/**
 * The editing UI's host side (phase-2-design §8, M15): saves drafts as change requests, runs
 * proposals with progress and cancellation, answers questions, re-plans requests whose code
 * changed, and applies an approved change through a `WorkspaceEdit` (so VS Code's own undo works
 * and open editors follow), then lets Sift write the descriptions. Undo restores both, refusing
 * when a file changed since.
 */
export class EditController implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly activities = new Map<string, EditActivity>();
  private readonly cancels = new Map<string, vscode.CancellationTokenSource>();
  /** Draft saves per unit, one at a time, so two quick edits never create two requests. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activityEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeActivity = this.activityEmitter.event;
  private readonly contents = new Map<string, string>();
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.contentEmitter.event;
  readonly reviews: ReviewPanels;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly host: EditUiHost) {
    this.reviews = new ReviewPanels(this, host);
    this.disposables.push(this.activityEmitter, this.contentEmitter, this.reviews, vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this));
  }

  /** What the extension is doing with a request (proposing, checks, applying), or null. */
  activity(project: Project, id: string): EditActivity | null {
    return this.activities.get(key(project, id)) ?? null;
  }

  private setActivity(project: Project, id: string, activity: EditActivity | null): void {
    if (activity) this.activities.set(key(project, id), activity);
    else this.activities.delete(key(project, id));
    this.activityEmitter.fire();
  }

  /** Open requests on a file's units, newest first. */
  async openRequests(project: Project, file: string): Promise<ChangeRequest[]> {
    const all = await project.server.request("sift/edit/list", {});
    return all.filter((r) => r.file === file && SHOWN_STATES.includes(r.state));
  }

  // ── Drafts ───────────────────────────────────────────────────────────────────────────────

  /**
   * Save a unit's draft: create its change request, change it, or discard it when it asks for
   * nothing. Returns the request that holds the draft (undefined when there is none).
   */
  saveDraft(project: Project, ref: string, unitId: string, draft: { edits: DescriptionEdit[]; request: string }): Promise<ChangeRequest | undefined> {
    return this.serial(key(project, unitId), async () => {
      const open = openRequestFor(await project.server.request("sift/edit/list", {}), unitId);
      const action = draftAction(open, draft);
      const request = draft.request.trim();
      switch (action.kind) {
        case "create":
          return project.server.request("sift/edit/create", { unit: ref, edits: draft.edits, ...(request ? { request } : {}) });
        case "update":
          return project.server.request("sift/edit/update", { id: action.id, edits: draft.edits, request: request === "" ? null : request });
        case "discard":
          await project.server.request("sift/edit/reject", { id: action.id });
          return undefined;
        case "none":
          return open;
        case "refuse":
          throw new SiftError("EDIT_INVALID_STATE", action.message);
      }
    });
  }

  private serial<T>(k: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(k) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.queues.set(k, settled);
    void settled.then(() => this.queues.get(k) === settled && this.queues.delete(k));
    return next;
  }

  // ── Proposing (§8.3) ─────────────────────────────────────────────────────────────────────

  /** Plan, write, and check the change, with progress; open the review when it is ready. */
  async propose(project: Project, id: string): Promise<void> {
    if (this.activity(project, id)) return;
    const k = key(project, id);
    const cancel = new vscode.CancellationTokenSource();
    this.cancels.set(k, cancel);
    const token = `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.setActivity(project, id, "starting");
    const subscription = project.server.on("sift/editProgress", (p) => {
      if (p.token !== token) return;
      const activity = activityOf(p.event);
      if (activity) this.setActivity(project, id, activity);
    });
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Sift: proposing a change…" }, () =>
        project.server.request("sift/edit/propose", { id, token }, cancel.token),
      );
      this.setActivity(project, id, null);
      if (result.state === "ready") await this.reviews.show(project, id);
      else if (result.state === "needs-answers") vscode.window.setStatusBarMessage(`Sift has ${result.questions?.length === 1 ? "a question" : "questions"} about the change to ${shortName(result)}.`, 5000);
      else if (result.state === "failed") vscode.window.setStatusBarMessage(`Sift could not propose the change to ${shortName(result)}.`, 5000);
    } catch (err) {
      if (err instanceof SiftError && err.code === "CANCELLED") vscode.window.setStatusBarMessage("Sift: proposal cancelled. Your draft is kept.", 4000);
      else this.host.showError(err);
    } finally {
      subscription.dispose();
      cancel.dispose();
      this.cancels.delete(k);
      this.setActivity(project, id, null);
    }
  }

  cancel(project: Project, id: string): void {
    this.cancels.get(key(project, id))?.cancel();
  }

  /** Answer the open questions; once all are answered, propose again with them. */
  async answer(project: Project, id: string, answers: { questionId: string; answer: string }[]): Promise<void> {
    const result = await project.server.request("sift/edit/answer", { id, answers });
    if (result.state === "draft") await this.propose(project, id);
  }

  async reject(project: Project, id: string): Promise<void> {
    await project.server.request("sift/edit/reject", { id });
  }

  /** A request whose code changed: start it over from the current code and propose it again (§8.9). */
  async replan(project: Project, id: string): Promise<void> {
    const before = await project.server.request("sift/edit/get", { id });
    const rebased = await project.server.request("sift/edit/rebase", { id });
    const dropped = before.edits.length - rebased.edits.length;
    if (dropped > 0) void vscode.window.showWarningMessage(`${dropped} of your edits to ${shortName(rebased)} no longer fit the current description and were dropped.`);
    if (rebased.edits.length === 0 && !rebased.request) {
      vscode.window.setStatusBarMessage("Sift: nothing left to propose; edit the description again.", 5000);
      return;
    }
    await this.propose(project, id);
  }

  /** Run the configured checks (edit.checks) on a copy of the project with the change. */
  async runChecks(project: Project, id: string): Promise<void> {
    if (this.activity(project, id)) return;
    this.setActivity(project, id, "checks");
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Sift: running the configured checks…", cancellable: true }, (_progress, cancel) =>
        project.server.request("sift/edit/runChecks", { id }, cancel),
      );
    } catch (err) {
      if (!(err instanceof SiftError && err.code === "CANCELLED")) this.host.showError(err);
    } finally {
      this.setActivity(project, id, null);
    }
  }

  // ── Apply and undo (§8.8) ────────────────────────────────────────────────────────────────

  /**
   * Apply a ready change: the source through a `WorkspaceEdit` (VS Code's undo works, open editors
   * update), saved; then Sift checks the files hold exactly the proposed text and writes the
   * descriptions, recording what was replaced so Undo can restore it. Returns whether it applied.
   */
  async approve(project: Project, id: string): Promise<boolean> {
    if (this.activity(project, id)) return false;
    const req = await project.server.request("sift/edit/get", { id });
    if (req.state !== "ready" || !req.proposal) throw new SiftError("EDIT_INVALID_STATE", `The change to ${shortName(req)} is not ready to apply (${req.state}).`);
    const proposal = req.proposal;
    let confirmBroader = false;
    if (proposal.scope.broader) {
      const units = proposal.scope.broader.units.map((r) => r.slice(r.indexOf("#") + 1));
      const choice = await vscode.window.showWarningMessage(
        `This change reaches beyond ${shortName(req)}.`,
        { modal: true, detail: `${proposal.scope.broader.reason}\n\nIt also changes: ${units.join(", ") || "(none listed)"}.` },
        "Apply the broader change",
      );
      if (choice !== "Apply the broader change") return false;
      confirmBroader = true;
    }
    const dirty = this.dirtyFiles(project, filesOf(req));
    if (dirty.length > 0) throw new SiftError("EDIT_CONFLICT", `Save or revert ${dirty.join(", ")} first: the change is applied to the saved files.`);

    this.setActivity(project, id, "applying");
    try {
      // What each file holds now must be what the change was proposed for.
      const before: Record<string, string> = {};
      for (const f of proposal.files) {
        const text = await readFile(join(project.root, f.path), "utf8").catch(() => null);
        if (text === null || textHash(text) !== f.beforeHash) throw new SiftError("EDIT_CONFLICT", `${f.path} changed since this change was proposed. Re-plan it from the unit's logic.`);
        before[f.path] = text;
      }
      if (proposal.files.length === 0) {
        await project.server.request("sift/edit/apply", { id, confirmBroader });
      } else if (await this.writeThroughEditor(project, proposal.files)) {
        try {
          await project.server.request("sift/edit/apply", { id, confirmBroader, sourceWritten: true, sourceBefore: before });
        } catch (err) {
          // Sift refused (the request changed, or a description file moved on): put the code back.
          for (const [path, text] of Object.entries(before)) await writeFile(join(project.root, path), text, "utf8");
          throw err;
        }
      } else {
        // The editor's copy differs from the disk (line endings, an encoding): let Sift write the files.
        await project.server.request("sift/edit/apply", { id, confirmBroader });
      }
    } finally {
      this.setActivity(project, id, null);
    }
    void project.refreshStatus().catch(() => {});
    void vscode.window.showInformationMessage(`Applied the change to ${shortName(req)}.`, "Undo").then(async (choice) => {
      if (choice === "Undo") await this.undo(project, id).catch((err: unknown) => this.host.showError(err));
    });
    return true;
  }

  /**
   * Replace each file's text through one `WorkspaceEdit` and save. Returns false, changing nothing,
   * when an editor's text is not the file's text on disk. A save participant (format on save) may
   * change what is written; the file then gets exactly the reviewed text.
   */
  private async writeThroughEditor(project: Project, files: { path: string; text: string }[]): Promise<boolean> {
    const docs: { doc: vscode.TextDocument; path: string; text: string }[] = [];
    for (const f of files) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(project.root), f.path));
      const disk = await readFile(join(project.root, f.path), "utf8");
      if (doc.isDirty || doc.getText() !== disk) return false;
      docs.push({ doc, path: f.path, text: f.text });
    }
    const edit = new vscode.WorkspaceEdit();
    for (const { doc, text } of docs) edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new SiftError("EDIT_CONFLICT", "VS Code did not apply the change.");
    for (const { doc } of docs) await doc.save();
    for (const { path, text } of docs) {
      const saved = await readFile(join(project.root, path), "utf8");
      if (saved !== text) await writeFile(join(project.root, path), text, "utf8");
    }
    return true;
  }

  /** Restore what an applied change wrote, if nothing changed the files since. */
  async undo(project: Project, id: string): Promise<void> {
    const req = await project.server.request("sift/edit/get", { id });
    const dirty = this.dirtyFiles(project, filesOf(req));
    if (dirty.length > 0) throw new SiftError("EDIT_CONFLICT", `Save or revert ${dirty.join(", ")} first: Sift restores the saved files.`);
    this.setActivity(project, id, "undoing");
    try {
      const result = await project.server.request("sift/edit/undo", { id });
      void project.refreshStatus().catch(() => {});
      vscode.window.setStatusBarMessage(`Sift: undid the change to ${shortName(result.request)} (${result.restored.length} file${result.restored.length === 1 ? "" : "s"} restored).`, 5000);
    } finally {
      this.setActivity(project, id, null);
    }
  }

  /** **Sift: Undo Edit…**: pick an applied change and undo it. */
  async undoCommand(): Promise<void> {
    const applied = (
      await Promise.all(this.host.projects.map(async (project) => (await project.server.request("sift/edit/list", { states: ["applied"] })).map((req) => ({ project, req }))))
    ).flat();
    if (applied.length === 0) {
      void vscode.window.showInformationMessage("There are no applied Sift edits to undo.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      applied.map(({ project, req }) => ({ label: shortName(req), description: `${req.file} · ${new Date(req.updatedAt).toLocaleString()}`, detail: describeRequest(req), project, req })),
      { title: "Undo Sift Edit", placeHolder: "Which change? Sift restores the files only if nothing changed them since.", matchOnDescription: true, matchOnDetail: true },
    );
    if (picked) await this.undo(picked.project, picked.req.id);
  }

  // ── Source diff (§8.8: VS Code's diff editor against a virtual document) ───────────────────

  async openDiff(project: Project, req: ChangeRequest, path: string): Promise<void> {
    const file = req.proposal?.files.find((f) => f.path === path);
    if (!file) return;
    const proposed = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${path}`, query: `${req.id}&${encodeURIComponent(project.root)}` });
    this.contents.set(proposed.toString(), file.text);
    this.contentEmitter.fire(proposed);
    const current = vscode.Uri.joinPath(vscode.Uri.file(project.root), path);
    await vscode.commands.executeCommand("vscode.diff", current, proposed, `${basename(path)} ↔ proposed change (Sift)`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  /** Project-relative paths among `files` open with unsaved changes. */
  dirtyFiles(project: Project, files: string[]): string[] {
    const wanted = new Set(files.map((f) => normalise(join(project.root, f))));
    return vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === "file" && wanted.has(normalise(d.uri.fsPath))).map((d) => project.relative(d.uri.fsPath) ?? d.uri.fsPath);
  }

  dispose(): void {
    for (const c of this.cancels.values()) c.cancel();
    for (const d of this.disposables) d.dispose();
  }
}

function key(project: Project, id: string): string {
  return `${project.root}\n${id}`;
}

function normalise(path: string): string {
  const p = path.replace(/\\/g, "/");
  return process.platform === "win32" ? p.toLowerCase() : p;
}
