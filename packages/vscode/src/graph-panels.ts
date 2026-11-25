import * as vscode from "vscode";
import type { SourceRange } from "@sift/core";
import { buildModel, type GraphQuery } from "./graph-model.js";
import { documentHtml } from "./logic-editor.js";
import type { Project } from "./project.js";

export type { GraphQuery };
import type { GraphHostMessage, GraphModel, GraphViewKind, GraphViewState, GraphWebviewMessage } from "./webview/graph-protocol.js";

/** What the graph views need from the rest of the extension. */
export interface GraphHost {
  readonly extensionUri: vscode.Uri;
  /** Open a unit's logic, scrolled to it. */
  openUnitLogic(project: Project, ref: string): Promise<void>;
  /** Open a unit's (or declaration's) code. */
  openCode(project: Project, ref: string): Promise<void>;
  openSite(project: Project, file: string, range: SourceRange): Promise<void>;
  showError(err: unknown): void;
  log(line: string): void;
}

export const GRAPH_VIEW_TYPE = "sift.graph";
const VIEW_TITLES: Record<GraphViewKind, string> = { neighbourhood: "Neighbourhood", flow: "Flow", impact: "Impact" };

/**
 * Graph views (phase-2-design §6.5, M13): one webview panel per kind (neighbourhood, flow,
 * impact), reused for the next query of that kind. Each reloads when the project's status
 * refreshes, so a saved change shows up without asking.
 */
export class GraphPanels implements vscode.Disposable {
  private readonly panels = new Map<GraphViewKind, GraphPanel>();

  constructor(private readonly host: GraphHost) {}

  /** Open panels (integration tests read them). */
  get views(): readonly GraphPanel[] {
    return [...this.panels.values()];
  }

  async show(project: Project, query: GraphQuery): Promise<GraphPanel> {
    const existing = this.panels.get(query.view);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      await existing.retarget(project, query);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(GRAPH_VIEW_TYPE, VIEW_TITLES[query.view], { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true });
    const view = new GraphPanel(panel, project, query, this, this.host);
    this.panels.set(query.view, view);
    panel.onDidDispose(() => {
      if (this.panels.get(query.view) === view) this.panels.delete(query.view);
      view.dispose();
    });
    await view.reload();
    return view;
  }

  dispose(): void {
    for (const view of this.panels.values()) view.panel.dispose();
    this.panels.clear();
  }
}

/** One graph panel: its query, the model, and the webview drawing it. */
export class GraphPanel implements vscode.Disposable {
  private state: GraphViewState = { model: null, error: null, loading: true, dirty: false };
  private ready = false;
  private loading: Promise<void> | null = null;
  private again = false;
  private projectSubscriptions: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  /** The last messages sent to the webview, newest last (integration tests read them). */
  readonly sent: GraphHostMessage[] = [];
  /** What the webview last drew (integration tests read it). */
  drawn: { nodes: number; error?: string } | null = null;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private projectValue: Project,
    private queryValue: GraphQuery,
    private readonly panels: GraphPanels,
    private readonly host: GraphHost,
  ) {
    const dist = vscode.Uri.joinPath(host.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.iconPath = vscode.Uri.joinPath(host.extensionUri, "media", "sift.svg");
    panel.webview.html = documentHtml(panel.webview, dist, "graph", VIEW_TITLES[queryValue.view]);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: GraphWebviewMessage) => this.receive(m)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDirty(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onDirty(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onDirty(d)),
    );
    this.watch();
    this.updateTitle();
  }

  get project(): Project {
    return this.projectValue;
  }

  get query(): GraphQuery {
    return this.queryValue;
  }

  get current(): GraphViewState {
    return this.state;
  }

  get model(): GraphModel | null {
    return this.state.model;
  }

  /** Whether the webview's script loaded and asked for its state. */
  get webviewReady(): boolean {
    return this.ready;
  }

  /** Show another query in this panel. */
  async retarget(project: Project, query: GraphQuery): Promise<void> {
    if (project !== this.projectValue) {
      this.projectValue = project;
      this.watch();
    }
    this.queryValue = query;
    this.drawn = null;
    this.state = { model: null, error: null, loading: true, dirty: this.state.dirty };
    this.post({ type: "state", state: this.state });
    this.updateTitle();
    await this.reload();
  }

  private watch(): void {
    for (const d of this.projectSubscriptions) d.dispose();
    const project = this.projectValue;
    this.projectSubscriptions = [
      // Every status refresh follows a change on disk, which can change the graph.
      project.onDidChangeStatus(() => void this.reload()),
      project.server.onDidChangeState((s) => s.kind === "running" && void this.reload()),
    ];
  }

  private updateTitle(): void {
    const q = this.queryValue;
    const subject = q.view === "neighbourhood" ? q.ref.slice(q.ref.indexOf("#") + 1) : q.view === "flow" ? q.route.replace(/^route:/, "") : q.what;
    this.panel.title = `${VIEW_TITLES[q.view]}: ${subject}`;
  }

  /** Handle a message from the webview. Public so integration tests can act as the webview. */
  async receive(message: GraphWebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.ready = true;
          this.post({ type: "state", state: this.state });
          return;
        case "refresh":
          return await this.reload();
        case "open":
          return await this.open(message.nodeId, message.source);
        case "neighbourhood":
          await this.panels.show(this.projectValue, { view: "neighbourhood", ref: message.nodeId });
          return;
        case "openSite":
          return await this.host.openSite(this.projectValue, message.file, message.range);
        case "drawn":
          this.drawn = { nodes: message.nodes, ...(message.error ? { error: message.error } : {}) };
          if (message.error) this.host.log(`Could not lay out the ${this.queryValue.view} diagram: ${message.error}`);
          return;
      }
    } catch (err) {
      this.host.showError(err);
    }
  }

  /** A node was clicked: units open their logic (or code), routes their flow, events their registration. */
  private async open(nodeId: string, source: boolean): Promise<void> {
    const node = this.state.model?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    switch (node.kind) {
      case "unit":
        return source ? this.host.openCode(this.projectValue, node.id) : this.host.openUnitLogic(this.projectValue, node.id);
      case "declaration":
        return this.host.openCode(this.projectValue, node.id);
      case "route":
        await this.panels.show(this.projectValue, { view: "flow", route: node.id });
        return;
      case "event":
        if (node.site) await this.host.openSite(this.projectValue, node.site.file, node.site.range);
        return;
      default:
        return;
    }
  }

  post(message: GraphHostMessage): void {
    this.sent.push(message);
    if (this.sent.length > 50) this.sent.shift();
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  /** Run the query again. Overlapping calls run once more, not once each. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      try {
        do {
          this.again = false;
          const query = this.queryValue;
          this.state = { ...this.state, loading: true, dirty: this.anyDirty() };
          let next: GraphViewState;
          try {
            next = { model: await buildModel(this.projectValue.server, query), error: null, loading: false, dirty: this.state.dirty };
          } catch (err) {
            next = { model: null, error: err instanceof Error ? err.message : String(err), loading: false, dirty: this.state.dirty };
          }
          // A retarget while this ran starts over with the new query.
          if (query !== this.queryValue) {
            this.again = true;
            continue;
          }
          this.state = next;
          this.post({ type: "state", state: this.state });
        } while (this.again);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private anyDirty(): boolean {
    return vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === "file" && this.projectValue.relative(d.uri.fsPath) !== null);
  }

  private onDirty(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file" || this.projectValue.relative(doc.uri.fsPath) === null) return;
    const dirty = this.anyDirty();
    if (dirty === this.state.dirty) return;
    this.state = { ...this.state, dirty };
    this.post({ type: "state", state: this.state });
  }

  dispose(): void {
    for (const d of [...this.projectSubscriptions, ...this.disposables]) d.dispose();
  }
}
