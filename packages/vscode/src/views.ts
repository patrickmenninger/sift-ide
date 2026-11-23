import * as vscode from "vscode";
import type { GapNote, QueryHit } from "@sift/core";
import { confidenceIcon, gapLabel, hitTooltip, nodeLabel } from "./graph-labels.js";
import type { Project } from "./project.js";
import { describeCounts, KIND_LABELS, KIND_ORDER, plural, statusBarContent, symbolOf, type OutOfDateKind, type StatusEntry } from "./status-model.js";

/** Projects by workspace folder; the views read from it. */
export interface ProjectRegistry {
  readonly projects: readonly Project[];
  onDidChange: vscode.Event<void>;
}

// ── Out-of-date tree (phase-2-design §6.4: "a Problems-style list from status") ──────────────

type StatusNode =
  | { type: "project"; project: Project }
  | { type: "group"; project: Project; kind: OutOfDateKind; entries: StatusEntry[] }
  | { type: "entry"; project: Project; entry: StatusEntry }
  | { type: "message"; text: string };

const KIND_ICONS: Record<OutOfDateKind, string> = {
  stale: "warning",
  changed: "diff-modified",
  new: "diff-added",
  renamed: "diff-renamed",
  ambiguous: "question",
  contextChanged: "references",
  deleted: "diff-removed",
  unreadable: "error",
};

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusNode> {
  private readonly emitter = new vscode.EventEmitter<StatusNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly registry: ProjectRegistry) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: StatusNode): StatusNode[] {
    const projects = this.registry.projects;
    if (!node) {
      if (projects.length === 0) return [];
      if (projects.length > 1) return projects.map((project) => ({ type: "project", project }));
      return this.groups(projects[0]!);
    }
    if (node.type === "project") return this.groups(node.project);
    if (node.type === "group") return node.entries.map((entry) => ({ type: "entry", project: node.project, entry }));
    return [];
  }

  private groups(project: Project): StatusNode[] {
    const state = project.server.state;
    if (state.kind === "failed") return [{ type: "message", text: `Sift is not running: ${state.message.split("\n")[0]}` }];
    if (!project.status) return [{ type: "message", text: state.kind === "starting" ? "Starting…" : "Checking…" }];
    if (project.entries.length === 0) return [{ type: "message", text: "Every description matches the code." }];
    return KIND_ORDER.map((kind) => ({ type: "group" as const, project, kind, entries: project.entries.filter((e) => e.kind === kind) })).filter((g) => g.entries.length > 0);
  }

  getTreeItem(node: StatusNode): vscode.TreeItem {
    switch (node.type) {
      case "project": {
        const item = new vscode.TreeItem(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(node.project.root))?.name ?? node.project.root, vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.project.outOfDate > 0 ? plural(node.project.outOfDate, "unit") : "up to date";
        item.contextValue = "sift.project";
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(KIND_LABELS[node.kind].group, vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.entries.length);
        item.iconPath = new vscode.ThemeIcon(KIND_ICONS[node.kind]);
        item.contextValue = node.kind === "deleted" || node.kind === "unreadable" ? "sift.group" : "sift.group.generatable";
        return item;
      }
      case "entry": {
        const { entry } = node;
        const item = new vscode.TreeItem(entry.kind === "unreadable" ? entry.unit : symbolOf(entry.unit), vscode.TreeItemCollapsibleState.None);
        item.description = entry.kind === "unreadable" ? "" : entry.file;
        item.tooltip = [entry.unit, KIND_LABELS[entry.kind].group, entry.detail].filter(Boolean).join("\n");
        item.iconPath = new vscode.ThemeIcon(KIND_ICONS[entry.kind]);
        item.contextValue = entry.kind === "deleted" || entry.kind === "unreadable" ? "sift.entry" : "sift.entry.generatable";
        if (entry.kind !== "deleted") {
          item.command = { command: "sift.openUnit", title: "Open", arguments: [node.project.root, entry.unit] };
        }
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "sift.message";
        return item;
      }
    }
  }
}

// ── Callers / callees trees (phase-2-design §6.5) ───────────────────────────────────────────

type CallNode =
  | { type: "subject"; project: Project; id: string }
  | { type: "hit"; project: Project; hit: QueryHit }
  | { type: "effects"; effects: string[] }
  | { type: "gaps"; project: Project; gaps: GapNote[] }
  | { type: "gap"; project: Project; gap: GapNote }
  | { type: "message"; text: string };

export class CallTreeProvider implements vscode.TreeDataProvider<CallNode> {
  private readonly emitter = new vscode.EventEmitter<CallNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private subject: { project: Project; id: string } | null = null;

  constructor(readonly direction: "callers" | "callees") {}

  get current(): { project: Project; id: string } | null {
    return this.subject;
  }

  show(project: Project, id: string): void {
    this.subject = { project, id };
    this.emitter.fire(undefined);
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  async getChildren(node?: CallNode): Promise<CallNode[]> {
    if (!node) return this.subject ? [{ type: "subject", ...this.subject }] : [];
    try {
      if (node.type === "subject") return await this.level(node.project, node.id, true);
      if (node.type === "hit") return await this.level(node.project, node.hit.id, false);
    } catch (err) {
      return [{ type: "message", text: err instanceof Error ? err.message : String(err) }];
    }
    if (node.type === "gaps") return node.gaps.map((gap) => ({ type: "gap", project: node.project, gap }));
    return [];
  }

  /** One level below a node: its direct callers or callees; at the top, effects and gaps too. */
  private async level(project: Project, id: string, top: boolean): Promise<CallNode[]> {
    const out: CallNode[] = [];
    if (this.direction === "callers") {
      const r = await project.server.request("sift/callers", { query: id, depth: 1 });
      out.push(...r.callers.map((hit): CallNode => ({ type: "hit", project, hit })));
      if (top && r.possibleCallers.length > 0) out.push({ type: "gaps", project, gaps: r.possibleCallers });
      if (top && out.length === 0) out.push({ type: "message", text: "No callers found in the project." });
    } else {
      const r = await project.server.request("sift/callees", { query: id, depth: 1 });
      if (top && r.effects.length > 0) out.push({ type: "effects", effects: r.effects });
      out.push(...r.callees.map((hit): CallNode => ({ type: "hit", project, hit })));
      if (top && r.unresolved.length > 0) out.push({ type: "gaps", project, gaps: r.unresolved });
      if (top && out.length === 0) out.push({ type: "message", text: "Calls nothing in the project." });
    }
    return out;
  }

  getTreeItem(node: CallNode): vscode.TreeItem {
    switch (node.type) {
      case "subject": {
        const label = nodeLabel(node.id);
        const item = new vscode.TreeItem(label.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = label.description;
        item.iconPath = new vscode.ThemeIcon(this.direction === "callers" ? "call-incoming" : "call-outgoing");
        item.tooltip = node.id;
        if (label.kind === "unit") item.command = { command: "sift.openUnit", title: "Open", arguments: [node.project.root, node.id] };
        item.contextValue = "sift.callSubject";
        return item;
      }
      case "hit": {
        const label = nodeLabel(node.hit.id);
        // Only units can be expanded further; routes and events are where a path starts or ends.
        const item = new vscode.TreeItem(label.label, label.kind === "unit" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        const via = node.hit.via.dispatch ? ` · via ${nodeLabel(node.hit.via.dispatch).label}` : node.hit.via.event ? ` · via ${nodeLabel(node.hit.via.event).label}` : "";
        item.description = `${label.description}${via}`;
        const confidence = confidenceIcon(node.hit.via.confidence);
        item.iconPath = new vscode.ThemeIcon(confidence.icon);
        item.tooltip = hitTooltip(node.hit, this.direction);
        item.contextValue = label.kind === "unit" ? "sift.callUnit" : "sift.callNode";
        if (label.kind === "unit") item.command = { command: "sift.openUnit", title: "Open", arguments: [node.project.root, node.hit.id] };
        else if (node.hit.via.sites[0]) item.command = { command: "sift.openRange", title: "Open", arguments: [node.project.root, node.hit.via.file, node.hit.via.sites[0].range] };
        return item;
      }
      case "effects": {
        const item = new vscode.TreeItem("Effects", vscode.TreeItemCollapsibleState.None);
        item.description = node.effects.join(", ");
        item.iconPath = new vscode.ThemeIcon("zap");
        item.tooltip = `Effects, including those of the units it calls directly: ${node.effects.join(", ")}`;
        return item;
      }
      case "gaps": {
        const label = this.direction === "callers" ? "Possible callers not resolved" : "Calls not resolved";
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = String(node.gaps.length);
        item.iconPath = new vscode.ThemeIcon("question");
        item.tooltip = "Call sites Sift could not connect to a unit. Some of them may reach this code.";
        return item;
      }
      case "gap": {
        const { label, description } = gapLabel(node.gap);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = description;
        item.iconPath = new vscode.ThemeIcon("circle-outline");
        item.command = { command: "sift.openRange", title: "Open", arguments: [node.project.root, node.gap.file, node.gap.site.range] };
        return item;
      }
      case "message":
        return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
  }
}

// ── Explorer decorations (phase-2-design §6.4: "a dot on source files whose logic is stale or missing") ──

export class OutOfDateDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  constructor(private readonly registry: ProjectRegistry) {}

  refresh(): void {
    // Decorations are cheap to recompute; refresh them all.
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    for (const project of this.registry.projects) {
      const rel = project.relative(uri.fsPath);
      if (rel === null) continue;
      const problems = project.files.get(rel);
      if (!problems) return undefined;
      const onlyNew = problems.total === (problems.counts.new ?? 0);
      return {
        badge: "●",
        tooltip: `Sift: ${onlyNew ? "not described yet" : "logic out of date"} (${describeCounts(problems.counts)})`,
        color: new vscode.ThemeColor(onlyNew ? "sift.missingLogicForeground" : "sift.staleLogicForeground"),
        propagate: false,
      };
    }
    return undefined;
  }
}

// ── Status bar ──────────────────────────────────────────────────────────────────────────────

export class SiftStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("sift.status", vscode.StatusBarAlignment.Left, 50);
  private busy: string | null = null;

  constructor(private readonly registry: ProjectRegistry) {
    this.item.name = "Sift";
  }

  setBusy(text: string | null): void {
    this.busy = text;
    this.update();
  }

  update(): void {
    const projects = this.registry.projects;
    if (projects.length === 0) {
      this.item.hide();
      return;
    }
    const failed = projects.find((p) => p.server.state.kind === "failed");
    const starting = projects.some((p) => p.server.state.kind === "starting" || !p.status);
    const content = this.busy
      ? statusBarContent({ kind: "busy", text: this.busy })
      : failed && failed.server.state.kind === "failed"
        ? statusBarContent({ kind: "failed", message: failed.server.state.message.split("\n")[0]! })
        : starting
          ? statusBarContent({ kind: "starting" })
          : statusBarContent({
              kind: "ready",
              outOfDate: projects.reduce((n, p) => n + p.outOfDate, 0),
              units: projects.reduce((n, p) => n + (p.status?.counts.units ?? 0), 0),
              verified: projects.reduce((n, p) => n + (p.status?.counts.verified ?? 0), 0),
            });
    this.item.text = content.text;
    this.item.tooltip = content.tooltip;
    this.item.backgroundColor = failed ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.command = failed ? "sift.showOutput" : "sift.focusStatus";
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
