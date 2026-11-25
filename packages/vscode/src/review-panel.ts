import * as vscode from "vscode";
import { filesOf, shortName } from "./edit-host-model.js";
import type { EditController, EditUiHost } from "./edits.js";
import { documentHtml } from "./logic-editor.js";
import type { Project } from "./project.js";
import type { ReviewHostMessage, ReviewState, ReviewWebviewMessage } from "./webview/review-protocol.js";

export const REVIEW_VIEW_TYPE = "sift.review";

/** Review panels (phase-2-design §8.8), one per change request, reused when it is reviewed again. */
export class ReviewPanels implements vscode.Disposable {
  private readonly viewSet = new Set<ReviewPanel>();

  constructor(
    private readonly edits: EditController,
    private readonly host: EditUiHost,
  ) {}

  /** Open review panels (integration tests read them). */
  get views(): readonly ReviewPanel[] {
    return [...this.viewSet];
  }

  async show(project: Project, id: string): Promise<ReviewPanel> {
    const existing = this.views.find((v) => v.project === project && v.id === id);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside);
      await existing.reload();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(REVIEW_VIEW_TYPE, "Review change", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true });
    const view = new ReviewPanel(panel, project, id, this.edits, this.host);
    this.viewSet.add(view);
    panel.onDidDispose(() => {
      this.viewSet.delete(view);
      view.dispose();
    });
    await view.reload();
    return view;
  }

  dispose(): void {
    for (const view of this.views) view.panel.dispose();
  }
}

/** One review: the change request's proposal, Approve / Reject, and Undo once applied. */
export class ReviewPanel implements vscode.Disposable {
  private state: ReviewState = { request: null, error: null, activity: null, dirty: [] };
  private ready = false;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last messages sent to the webview, newest last (integration tests read them). */
  readonly sent: ReviewHostMessage[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly project: Project,
    readonly id: string,
    private readonly edits: EditController,
    private readonly host: EditUiHost,
  ) {
    const dist = vscode.Uri.joinPath(host.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.iconPath = vscode.Uri.joinPath(host.extensionUri, "media", "sift.svg");
    panel.webview.html = documentHtml(panel.webview, dist, "review", "Review change");
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: ReviewWebviewMessage) => this.receive(m)),
      project.server.on("sift/didChange", (change) => change.type === "edits" && change.ids.includes(id) && void this.reload()),
      edits.onDidChangeActivity(() => this.update({ activity: edits.activity(project, id) })),
      vscode.workspace.onDidChangeTextDocument(() => this.updateDirty()),
      vscode.workspace.onDidSaveTextDocument(() => this.updateDirty()),
      vscode.workspace.onDidCloseTextDocument(() => this.updateDirty()),
    );
  }

  get current(): ReviewState {
    return this.state;
  }

  get webviewReady(): boolean {
    return this.ready;
  }

  /** Handle a message from the webview. Public so integration tests can act as the webview. */
  async receive(message: ReviewWebviewMessage): Promise<void> {
    const req = this.state.request;
    try {
      switch (message.type) {
        case "ready":
          this.ready = true;
          this.post();
          return;
        case "openDiff":
          if (req) await this.edits.openDiff(this.project, req, message.path);
          return;
        case "openUnit":
          await (message.source ? this.host.openCode(this.project, message.ref) : this.host.openUnitLogic(this.project, message.ref));
          return;
        case "runChecks":
          await this.edits.runChecks(this.project, this.id);
          return;
        case "approve":
          await this.edits.approve(this.project, this.id);
          return;
        case "reject":
          await this.edits.reject(this.project, this.id);
          return;
        case "undo":
          await this.edits.undo(this.project, this.id);
          return;
        case "openLogic":
          if (req) await this.host.editInLogic(this.project, req.file, req.unitId);
          return;
      }
    } catch (err) {
      this.host.showError(err);
    } finally {
      if (message.type !== "ready" && message.type !== "openDiff" && message.type !== "openUnit") await this.reload();
    }
  }

  async reload(): Promise<void> {
    try {
      const request = await this.project.server.request("sift/edit/get", { id: this.id });
      this.panel.title = `Review: ${shortName(request)}`;
      this.update({ request, error: null });
    } catch (err) {
      this.update({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private updateDirty(): void {
    const req = this.state.request;
    const dirty = req ? this.edits.dirtyFiles(this.project, filesOf(req)) : [];
    if (dirty.join("\n") !== this.state.dirty.join("\n")) this.update({ dirty });
  }

  private update(change: Partial<ReviewState>): void {
    this.state = { ...this.state, ...change };
    if (change.request) this.state.dirty = this.edits.dirtyFiles(this.project, filesOf(change.request));
    this.post();
  }

  private post(): void {
    const message: ReviewHostMessage = { type: "state", state: this.state };
    this.sent.push(message);
    if (this.sent.length > 50) this.sent.shift();
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
