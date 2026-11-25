import type { EdgeConfidence, FlowResult, GapNote, QueryHit } from "@sift/core";
import type { RequestMethod, Requests } from "@sift/server";
import { confidenceIcon, gapLabel, nodeLabel } from "./graph-labels.js";
import type { GapItem, GraphEdge, GraphEdgeKind, GraphModel, GraphNode, GraphNodeKind } from "./webview/graph-protocol.js";

/**
 * Graph view models (phase-2-design §6.5), built from the server's query results. No `vscode`
 * here, so the models are tested against the fixture in-process.
 */

type CallersResult = Requests["sift/callers"]["result"];
type CalleesResult = Requests["sift/callees"]["result"];
type ImpactResult = Requests["sift/impact"]["result"];

/** Edges below this confidence are drawn dashed (§6.5: "dashed for name-match and rule"). */
const WEAK: ReadonlySet<EdgeConfidence> = new Set<EdgeConfidence>(["rule", "name-match", "inferred"]);
const CONFIDENCE_ORDER: EdgeConfidence[] = ["resolved", "rule", "language-server", "name-match", "inferred"];

/** At most this many gap sites are listed in a gaps node; the count says how many there are. */
export const GAP_ITEMS = 8;

/** How a node ID reads in a diagram. */
export function describeNode(id: string): { kind: GraphNodeKind; label: string; detail: string } {
  if (id.startsWith("ext:")) {
    const hash = id.lastIndexOf("#");
    return { kind: "external", label: id.slice(hash + 1), detail: id.slice("ext:".length, hash) };
  }
  const label = nodeLabel(id);
  if (label.kind === "route") return { kind: "route", label: label.label, detail: "route" };
  if (label.kind === "event") return { kind: "event", label: label.label, detail: "event" };
  return { kind: "unit", label: label.label === "<module>" ? "(module scope)" : label.label, detail: label.description };
}

/** Collects nodes and edges, merging repeats. */
class Builder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
    let node = this.nodes.get(id);
    if (!node) {
      const d = describeNode(id);
      node = { id, kind: d.kind, label: d.label, detail: d.detail, effects: [], tooltip: id };
      this.nodes.set(id, node);
    }
    const { effects, ...rest } = extra;
    Object.assign(node, rest);
    if (effects) node.effects = [...new Set([...node.effects, ...effects])];
    return node;
  }

  /** An interface or abstract member reached through dispatch. */
  declaration(id: string): GraphNode {
    const node = this.node(id);
    if (node.kind === "unit") {
      node.kind = "declaration";
      node.tooltip = `${id}\ninterface or abstract member`;
    }
    return node;
  }

  edge(from: string, to: string, kind: GraphEdgeKind, confidence?: EdgeConfidence, weak = confidence !== undefined && WEAK.has(confidence)): void {
    const id = `${from}→${to}|${kind}`;
    const existing = this.edges.get(id);
    // The same pair reached twice keeps the stronger reading.
    if (existing && (!existing.weak || weak)) return;
    this.edges.set(id, { id, from, to, kind, ...(confidence ? { confidence } : {}), weak });
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  model(base: Omit<GraphModel, "nodes" | "edges">): GraphModel {
    return { ...base, nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

function gapItems(gaps: GapNote[]): GapItem[] {
  return gaps.map((g) => ({ ...gapLabel(g), file: g.file, range: g.site.range }));
}

function gapsNode(b: Builder, id: string, gaps: GapNote[], what: string): GraphNode {
  const n = gaps.length;
  return b.node(id, {
    kind: "gaps",
    label: `${n} ${what}`,
    detail: "not resolved",
    gaps: gapItems(gaps),
    tooltip: "Call sites Sift could not connect to a unit. Some of them may be connected here; open each one to check.",
  });
}

function hitTooltip(hit: QueryHit): string {
  const lines = [hit.id, confidenceIcon(hit.via.confidence).text];
  if (hit.via.dispatch) lines.push(`through ${hit.via.dispatch}`);
  if (hit.via.event) lines.push(`through ${hit.via.event}`);
  if (hit.via.effects?.length) lines.push(`effects: ${hit.via.effects.join(", ")}`);
  return lines.join("\n");
}

/** A hit's own node, with what the hit says about it. Routes get the place they are registered. */
function hitNode(b: Builder, hit: QueryHit): GraphNode {
  const site = hit.via.sites[0];
  const node = b.node(hit.id, { tooltip: hitTooltip(hit), ...(hit.via.effects ? { effects: hit.via.effects } : {}) });
  if ((node.kind === "route" || node.kind === "event") && site && !node.site) node.site = { file: hit.via.file, range: site.range };
  return node;
}

/**
 * Neighbourhood: the unit, its direct callers and callees, the interface members between them
 * (with implementations), the routes it handles, and the events in between. Callers above,
 * callees below.
 */
export function neighbourhoodModel(callers: CallersResult, callees: CalleesResult): GraphModel {
  const b = new Builder();
  const subject = callers.subject;
  const d = describeNode(subject);
  b.node(subject, { role: "subject", effects: callees.effects, tooltip: `${subject}${callees.effects.length ? `\neffects, with those of its direct callees: ${callees.effects.join(", ")}` : ""}` });

  for (const hit of callers.callers) {
    hitNode(b, hit);
    const c = hit.via.confidence;
    if (hit.via.kind === "handles-route") {
      b.edge(hit.id, subject, "handles-route", c);
    } else if (hit.via.event) {
      b.node(hit.via.event, { tooltip: hit.via.event });
      b.edge(hit.id, hit.via.event, "emits", c);
      b.edge(hit.via.event, subject, "listens", "rule");
    } else if (hit.via.dispatch) {
      b.declaration(hit.via.dispatch);
      b.edge(hit.id, hit.via.dispatch, "calls", c);
      b.edge(hit.via.dispatch, subject, "implements");
    } else {
      b.edge(hit.id, subject, "calls", c);
    }
  }
  if (callers.possibleCallers.length > 0) {
    gapsNode(b, "gaps:callers", callers.possibleCallers, callers.possibleCallers.length === 1 ? "possible caller" : "possible callers");
    b.edge("gaps:callers", subject, "possible", undefined, true);
  }

  for (const hit of callees.callees) addCallee(b, subject, hit);
  if (callees.unresolved.length > 0) {
    gapsNode(b, "gaps:callees", callees.unresolved, callees.unresolved.length === 1 ? "call" : "calls");
    b.edge(subject, "gaps:callees", "possible", undefined, true);
  }

  const counts = `${callers.callers.length} caller${callers.callers.length === 1 ? "" : "s"}, ${callees.callees.length} callee${callees.callees.length === 1 ? "" : "s"}`;
  return b.model({ view: "neighbourhood", title: d.label, subtitle: `${d.detail} · ${counts}`, notes: [] });
}

/** A callee hit, drawn from `parent`: through its interface member or event when it has one. */
function addCallee(b: Builder, parent: string, hit: QueryHit): void {
  hitNode(b, hit);
  const c = hit.via.confidence;
  if (hit.via.dispatch) {
    b.declaration(hit.via.dispatch);
    b.edge(parent, hit.via.dispatch, "calls", c);
    b.edge(hit.via.dispatch, hit.id, "implements");
  } else if (hit.via.event) {
    b.node(hit.via.event, { tooltip: hit.via.event });
    b.edge(parent, hit.via.event, "emits", c);
    b.edge(hit.via.event, hit.id, "listens", "rule");
  } else if (hit.via.kind === "emits") {
    // An event nobody listens to.
    b.edge(parent, hit.id, "emits", c);
  } else {
    b.edge(parent, hit.id, "calls", c);
  }
}

/** Flow: from the route through its handlers down to library calls, effects as chips (§6.5). */
export function flowModel(flow: FlowResult): GraphModel {
  const b = new Builder();
  const route = describeNode(flow.route);
  b.node(flow.route, { role: "subject" });
  for (const h of flow.handlers) {
    b.node(h.id, {
      role: "handler",
      ...(h.handlerKey ? { note: "inline callback", tooltip: `${h.id}\nhandles ${route.label} with an inline callback` } : { tooltip: `${h.id}\nhandles ${route.label}` }),
    });
    b.edge(flow.route, h.id, "handles-route", "rule");
  }
  for (const hit of flow.hits) addCallee(b, hit.parent, hit);
  for (const [id, effects] of Object.entries(flow.effects)) if (b.has(id)) b.node(id, { effects });

  const units = flow.hits.filter((h) => !h.id.startsWith("ext:")).length;
  const library = flow.hits.length - units;
  const notes = flow.handlers.length === 0 ? ["No handler is registered for this route."] : [];
  return b.model({ view: "flow", title: route.label, subtitle: `${units} unit${units === 1 ? "" : "s"} and ${library} library call${library === 1 ? "" : "s"} reached`, notes });
}

/**
 * Impact: the changed units at the bottom, what may be affected above them, routes on top. Each
 * node carries the weakest confidence on its path; an edge is dashed where the path weakens.
 */
export function impactModel(impact: ImpactResult, what: string): GraphModel {
  const b = new Builder();
  const confidenceOf = new Map<string, EdgeConfidence>();
  for (const s of impact.subjects) {
    b.node(s, { role: "changed", tooltip: `${s}\nchanged` });
    confidenceOf.set(s, "resolved");
  }
  const rank = (c: EdgeConfidence) => CONFIDENCE_ORDER.indexOf(c);
  const weaker = (c: EdgeConfidence, from: string) => rank(c) > rank(confidenceOf.get(from) ?? "resolved");

  for (const u of impact.units) {
    const via = u.via.dispatch ? `through ${nodeLabel(u.via.dispatch).label}` : u.via.event ? `through ${nodeLabel(u.via.event).label}` : undefined;
    b.node(u.id, {
      confidence: u.confidence,
      depth: u.depth,
      ...(via ? { note: via } : {}),
      tooltip: [u.id, `${u.depth === 1 ? "calls a changed unit" : `${u.depth} calls away from a change`}`, `weakest link: ${confidenceIcon(u.confidence).text}`, `path: ${u.path.map((p) => nodeLabel(p).label).join(" ← ")}`].join("\n"),
    });
    confidenceOf.set(u.id, u.confidence);
  }
  for (const u of impact.units) {
    const prev = u.path[u.path.length - 2];
    if (!prev) continue;
    const weak = weaker(u.confidence, prev);
    if (u.via.dispatch) {
      b.declaration(u.via.dispatch);
      b.edge(u.id, u.via.dispatch, "calls", undefined, weak);
      b.edge(u.via.dispatch, prev, "implements");
    } else if (u.via.event) {
      b.node(u.via.event, { tooltip: u.via.event });
      b.edge(u.id, u.via.event, "emits", undefined, weak);
      b.edge(u.via.event, prev, "listens", undefined, true);
    } else {
      b.edge(u.id, prev, "calls", undefined, weak);
    }
  }
  for (const r of impact.routes) {
    b.node(r.id, {
      confidence: r.confidence,
      tooltip: [r.id, `handled by ${r.handler}`, `weakest link: ${confidenceIcon(r.confidence).text}`, `path: ${r.path.map((p) => nodeLabel(p).label).join(" ← ")}`].join("\n"),
    });
    b.edge(r.id, r.handler, "handles-route", r.confidence, weaker(r.confidence, r.handler) || WEAK.has(r.confidence));
  }
  if (impact.gaps.length > 0) {
    gapsNode(b, "gaps:impact", impact.gaps, impact.gaps.length === 1 ? "site not resolved" : "sites not resolved");
    for (const s of impact.subjects) b.edge("gaps:impact", s, "possible", undefined, true);
  }

  const n = impact.units.length;
  const routes = impact.routes.length;
  const model = b.model({
    view: "impact",
    title: what,
    subtitle: `${impact.subjects.length} changed · ${n} unit${n === 1 ? "" : "s"} and ${routes} route${routes === 1 ? "" : "s"} may be affected`,
    notes: impact.notes,
  });
  if (impact.subjects.length === 0) model.empty = "No changed units: nothing Sift reads has changed.";
  return model;
}

export type GraphQuery =
  | { view: "neighbourhood"; ref: string }
  | { view: "flow"; route: string }
  /** `diff`: a git ref; the units changed since it join `refs`. `what` names the change in the title. */
  | { view: "impact"; refs: string[]; diff?: string; what: string };

/** The part of the server connection the models need. */
export interface GraphServer {
  request<M extends RequestMethod>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]>;
}

/** Ask the server for what a query needs and build its model. */
export async function buildModel(server: GraphServer, query: GraphQuery): Promise<GraphModel> {
  const model = await queryModel(server, query);
  await markDeclarations(server, model);
  return model;
}

/**
 * Project nodes that are not units (a class called as a constructor, an interface member) have
 * no logic to open: mark them as declarations, from each file's extraction.
 */
export async function markDeclarations(server: GraphServer, model: GraphModel): Promise<void> {
  const byFile = new Map<string, GraphNode[]>();
  for (const n of model.nodes) {
    if (n.kind !== "unit") continue;
    const file = n.id.slice(0, n.id.indexOf("#"));
    byFile.set(file, [...(byFile.get(file) ?? []), n]);
  }
  await Promise.all(
    [...byFile].map(async ([file, nodes]) => {
      const extraction = await server.request("sift/extraction", { source: file }).catch(() => null);
      const symbols = new Set(extraction?.units.map((u) => u.symbol) ?? []);
      for (const n of nodes) {
        if (symbols.has(n.id.slice(n.id.indexOf("#") + 1))) continue;
        n.kind = "declaration";
        n.tooltip = `${n.tooltip}
a declaration, not a unit Sift describes`;
      }
    }),
  );
}

async function queryModel(server: GraphServer, query: GraphQuery): Promise<GraphModel> {
  switch (query.view) {
    case "neighbourhood": {
      const [callers, callees] = await Promise.all([server.request("sift/callers", { query: query.ref, depth: 1 }), server.request("sift/callees", { query: query.ref, depth: 1 })]);
      return neighbourhoodModel(callers, callees);
    }
    case "flow": {
      const flows = await server.request("sift/flow", { route: query.route });
      const flow = flows.find((f) => f.route === query.route) ?? flows[0];
      if (!flow) throw new Error(`No route matches ${query.route}.`);
      return flowModel(flow);
    }
    case "impact": {
      const impact = await server.request("sift/impact", { queries: query.refs, ...(query.diff !== undefined ? { diff: query.diff } : {}) });
      return impactModel(impact, query.what);
    }
  }
}
