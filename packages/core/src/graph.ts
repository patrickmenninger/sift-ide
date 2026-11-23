import type { CallArg, CallSite, EdgeConfidence, FileExtraction, SourceRange, StructureNode, UnitKind } from "./adapter.js";
import { clearsLite, effectsOfUnit, sortEffects } from "./effects.js";
import type { EdgeRuleHit, RuleSet } from "./rules.js";
import type { Effect } from "./schema.js";

/**
 * The code graph (design §10): every unit and the relationships between them, built from adapter
 * output and rule packs only. Stored per source file in `.sift/.cache/graph.json`.
 *
 * Node IDs are strings:
 * - `file#Symbol` — a unit, or another project declaration (an interface member, a class)
 * - `ext:module#name` — a library or platform API, as in `.sift` step calls
 * - `route:METHOD /path` — an HTTP route (edge rules)
 * - `event:key` — an event name (edge rules); `emits` edges point at it, `listens` edges leave it
 */

export const GRAPH_VERSION = 1;

export type GraphEdgeKind = "calls" | "implements" | "uses-type" | "handles-route" | "emits" | "listens";

export interface GraphSite {
  /** Structure key of the node holding the call, within the `from` unit (or the registering unit). */
  stepKey?: string;
  range: SourceRange;
}

export interface GraphEdge {
  kind: GraphEdgeKind;
  from: string;
  to: string;
  confidence: EdgeConfidence;
  /** Where in the code; one entry per call site. */
  sites: GraphSite[];
  /** Effects the rule packs give the call (calls edges only). */
  effects?: Effect[];
  /**
   * handles-route / listens: when the handler is an inline callback, its structure key inside the
   * `to` unit. Absent when the handler is the whole unit.
   */
  handlerKey?: string;
}

export interface GraphUnit {
  symbol: string;
  kind: UnitKind;
  range: SourceRange;
  /** Adapter's lite heuristic, cleared when the unit has effects (design §6.4). */
  lite: boolean;
  /** Direct effects (not propagated). */
  effects: Effect[];
}

export type GraphGapKind = "unresolved-call" | "unknown-route" | "unknown-event" | "unknown-handler";

export interface GraphGap {
  kind: GraphGapKind;
  /** Unit containing the site. */
  unit: string;
  expression: string;
  site: GraphSite;
}

export interface GraphFile {
  fileHash: string;
  adapter: string;
  units: GraphUnit[];
  edges: GraphEdge[];
  gaps: GraphGap[];
}

export interface GraphData {
  version: number;
  /** `RuleSet.hash` the graph was built with. */
  rules: string;
  files: Record<string, GraphFile>;
}

export const unitId = (file: string, symbol: string) => `${file}#${symbol}`;
export const externalId = (module: string, name: string) => `ext:${module}#${name}`;
export const routeId = (method: string, path: string) => `route:${method} ${path}`;
export const eventId = (key: string) => `event:${key}`;

export type NodeKind = "unit" | "declaration" | "external" | "route" | "event";

export function nodeKind(id: string): NodeKind {
  if (id.startsWith("ext:")) return "external";
  if (id.startsWith("route:")) return "route";
  if (id.startsWith("event:")) return "event";
  return "unit"; // CodeGraph refines this to "declaration" for project symbols that are not units
}

/** The project file of a `file#Symbol` ID, or null for external, route, and event nodes. */
export function fileOfId(id: string): string | null {
  if (nodeKind(id) !== "unit") return null;
  const hash = id.indexOf("#");
  return hash > 0 ? id.slice(0, hash) : null;
}

/** Build one file's part of the graph from its extraction. */
export function buildFileGraph(extraction: FileExtraction, rules: RuleSet, adapter: string): GraphFile {
  const edges = new Map<string, GraphEdge>();
  const gaps: GraphGap[] = [];
  const units: GraphUnit[] = [];

  const addEdge = (edge: Omit<GraphEdge, "sites">, site: GraphSite) => {
    const id = `${edge.kind} ${edge.from} ${edge.to} ${edge.handlerKey ?? ""}`;
    const existing = edges.get(id);
    if (existing) existing.sites.push(site);
    else edges.set(id, { ...edge, sites: [site] });
  };

  for (const unit of extraction.units) {
    const from = unitId(extraction.path, unit.symbol);
    const { effects } = effectsOfUnit(unit, rules);
    units.push({ symbol: unit.symbol, kind: unit.kind, range: unit.range, lite: unit.isSmall && !clearsLite(effects), effects });

    if (unit.implementsMember) {
      addEdge({ kind: "implements", from, to: unitId(unit.implementsMember.file, unit.implementsMember.symbol), confidence: "resolved" }, { range: unit.range });
    }
    for (const t of unit.typeRefs) {
      addEdge({ kind: "uses-type", from, to: unitId(t.file, t.symbol), confidence: "resolved" }, { range: unit.range });
    }

    const visit = (node: StructureNode) => {
      for (const call of node.calls) {
        const site: GraphSite = { stepKey: node.key, range: call.range };
        const callEffects = rules.effectsFor(call);
        const to = call.external
          ? externalId(call.external.module, call.external.name)
          : call.target
            ? unitId(call.target.file, call.target.symbol)
            : null;
        if (to) {
          const edge: Omit<GraphEdge, "sites"> = { kind: "calls", from, to, confidence: call.confidence ?? "resolved" };
          if (callEffects.length > 0) edge.effects = callEffects;
          addEdge(edge, site);
        } else {
          gaps.push({ kind: "unresolved-call", unit: from, expression: call.expression, site });
        }
        for (const hit of rules.edgesFor(call)) applyEdgeRule(hit, call, from, site, addEdge, gaps);
      }
      node.children.forEach(visit);
    };
    unit.body.forEach(visit);
  }

  return { fileHash: extraction.fileHash, adapter, units, edges: [...edges.values()], gaps };
}

function argAt(args: CallArg[], ref: { arg: number }): CallArg | undefined {
  return ref.arg === -1 ? args[args.length - 1] : args[ref.arg];
}

/** The handler a rule names: a project unit, or an inline callback in the registering unit. */
function handlerOf(arg: CallArg | undefined, from: string): { to: string; handlerKey?: string } | null {
  if (arg?.kind === "unit") return { to: unitId(arg.ref.file, arg.ref.symbol) };
  if (arg?.kind === "callback") return { to: from, handlerKey: arg.key };
  return null;
}

function applyEdgeRule(
  hit: EdgeRuleHit,
  call: CallSite,
  from: string,
  site: GraphSite,
  addEdge: (edge: Omit<GraphEdge, "sites">, site: GraphSite) => void,
  gaps: GraphGap[],
): void {
  const { rule } = hit;
  const gap = (kind: GraphGapKind) => gaps.push({ kind, unit: from, expression: call.expression, site });

  if (rule.edge === "handles-route" && rule.route && rule.from) {
    const path = argAt(call.args, rule.route.path);
    if (path?.kind !== "string") return void gap("unknown-route");
    const handler = handlerOf(argAt(call.args, rule.from), from);
    if (!handler) return void gap("unknown-handler");
    const method = (rule.route.method === "member" ? (hit.matchedName.split(".").pop() ?? "") : rule.route.method).toUpperCase();
    addEdge({ kind: "handles-route", from: routeId(method, path.value), to: handler.to, confidence: "rule", ...(handler.handlerKey ? { handlerKey: handler.handlerKey } : {}) }, site);
    return;
  }

  if (!rule.key) return;
  const key = argAt(call.args, rule.key);
  if (key?.kind !== "string") return void gap("unknown-event");

  if (rule.edge === "emits") {
    addEdge({ kind: "emits", from, to: eventId(key.value), confidence: "rule" }, site);
  } else if (rule.edge === "listens" && rule.from) {
    const handler = handlerOf(argAt(call.args, rule.from), from);
    if (!handler) return void gap("unknown-handler");
    addEdge({ kind: "listens", from: eventId(key.value), to: handler.to, confidence: "rule", ...(handler.handlerKey ? { handlerKey: handler.handlerKey } : {}) }, site);
  }
}

// ---------------------------------------------------------------------------------------------
// Queries (design §10.4)

/** A graph edge with the file it was recorded in. */
export interface LocatedEdge extends GraphEdge {
  file: string;
}

export interface UnitInfo extends GraphUnit {
  id: string;
  file: string;
}

/** How a query result was reached from its parent. */
export interface Via {
  kind: GraphEdgeKind;
  confidence: EdgeConfidence;
  /** Reached through an interface or abstract member that this unit implements (or that the parent calls). */
  dispatch?: string;
  /** Reached through an event: the event node. */
  event?: string;
  file: string;
  sites: GraphSite[];
  effects?: Effect[];
}

export interface QueryHit {
  id: string;
  /** The node this one was reached from: the query's subject for depth 1. */
  parent: string;
  depth: number;
  via: Via;
}

export interface GapNote {
  kind: GraphGapKind;
  unit: string;
  expression: string;
  file: string;
  site: GraphSite;
}

/** The last hop of an impact path: a call (possibly through an interface member) or an event. */
export interface ImpactVia {
  kind: "calls" | "emits";
  dispatch?: string;
  event?: string;
}

export interface ImpactResult {
  /** Units that may be affected, nearest first. Confidence is the weakest edge on the path. */
  units: { id: string; depth: number; confidence: EdgeConfidence; path: string[]; via: ImpactVia }[];
  /** Routes whose handlers reach a changed unit. */
  routes: { id: string; handler: string; confidence: EdgeConfidence; path: string[] }[];
  /** Phase 3. */
  tests: string[];
  gaps: GapNote[];
}

/** `flow(route)`: what a route reaches. */
export interface FlowResult {
  route: string;
  /** The units registered as the route's handler; `handlerKey` when the handler is an inline callback. */
  handlers: { id: string; handlerKey?: string }[];
  /** Units, declarations, and library calls reached, nearest first. Library calls carry their effects in `via.effects`. */
  hits: QueryHit[];
  /** Direct effects of each project unit reached (and of whole-unit handlers). */
  effects: Record<string, Effect[]>;
}

const CONFIDENCE_ORDER: EdgeConfidence[] = ["resolved", "rule", "language-server", "name-match", "inferred"];

export function weakest(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

export class CodeGraph {
  private readonly unitsById = new Map<string, UnitInfo>();
  private readonly outgoing = new Map<string, LocatedEdge[]>();
  private readonly incoming = new Map<string, LocatedEdge[]>();
  private readonly gapList: GapNote[] = [];

  constructor(readonly data: GraphData) {
    for (const [file, entry] of Object.entries(data.files)) {
      for (const u of entry.units) this.unitsById.set(unitId(file, u.symbol), { ...u, id: unitId(file, u.symbol), file });
      for (const e of entry.edges) {
        const located: LocatedEdge = { ...e, file };
        push(this.outgoing, e.from, located);
        push(this.incoming, e.to, located);
      }
      for (const g of entry.gaps) this.gapList.push({ ...g, file });
    }
  }

  get files(): string[] {
    return Object.keys(this.data.files).sort();
  }

  units(): UnitInfo[] {
    return [...this.unitsById.values()];
  }

  unit(id: string): UnitInfo | undefined {
    return this.unitsById.get(id);
  }

  gaps(): GapNote[] {
    return this.gapList;
  }

  kindOf(id: string): NodeKind {
    const k = nodeKind(id);
    return k === "unit" && !this.unitsById.has(id) ? "declaration" : k;
  }

  edgesFrom(id: string, kind?: GraphEdgeKind): LocatedEdge[] {
    const all = this.outgoing.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  edgesTo(id: string, kind?: GraphEdgeKind): LocatedEdge[] {
    const all = this.incoming.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  /**
   * Find project symbols by name: an exact `file#Symbol`, a qualified name (`AccountService.transferFunds`),
   * or its last part(s) (`transferFunds`). Exact symbol matches win over suffix matches.
   */
  find(query: string): string[] {
    const ids = new Set<string>([...this.unitsById.keys()]);
    for (const id of [...this.outgoing.keys(), ...this.incoming.keys()]) if (nodeKind(id) === "unit") ids.add(id);
    if (query.includes("#")) return ids.has(query) ? [query] : [];
    const exact: string[] = [];
    const suffix: string[] = [];
    for (const id of ids) {
      const symbol = id.slice(id.indexOf("#") + 1);
      if (symbol === query) exact.push(id);
      else if (symbol.endsWith(`.${query}`)) suffix.push(id);
    }
    return (exact.length > 0 ? exact : suffix).sort();
  }

  /** Units whose range overlaps any of the given line ranges in a file. */
  unitsAt(file: string, lines: { start: number; end: number }[]): string[] {
    const found: string[] = [];
    for (const u of this.unitsById.values()) {
      if (u.file !== file) continue;
      if (lines.some((l) => l.start <= u.range.end.line && l.end >= u.range.start.line)) found.push(u.id);
    }
    return found;
  }

  /** Interface or abstract members the unit implements. */
  implementedMembers(id: string): string[] {
    return this.edgesFrom(id, "implements").map((e) => e.to);
  }

  implementers(memberId: string): string[] {
    return this.edgesTo(memberId, "implements").map((e) => e.from);
  }

  /**
   * Units that call `id`, transitively up to `depth`. Includes callers of an interface member the
   * unit implements (dispatch), emitters of events it listens to, and routes it handles.
   */
  callers(id: string, depth = 1): QueryHit[] {
    const hits: QueryHit[] = [];
    const seen = new Set([id]);
    // Each frontier entry remembers the call sites it was reached through, so a route or listener
    // registered with an inline callback is reported only if one of those sites is inside the callback.
    let frontier: { id: string; reachedAt: string[] | null }[] = [{ id, reachedAt: null }];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: typeof frontier = [];
      for (const target of frontier) {
        for (const hit of this.directCallers(target.id, target.reachedAt)) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          hits.push({ ...hit, parent: target.id, depth: d });
          if (this.kindOf(hit.id) !== "route") next.push({ id: hit.id, reachedAt: hit.via.sites.map((s) => s.stepKey ?? "") });
        }
      }
      frontier = next;
    }
    return hits;
  }

  private directCallers(id: string, reachedAt: string[] | null): Omit<QueryHit, "parent" | "depth">[] {
    const out: Omit<QueryHit, "parent" | "depth">[] = [];
    const add = (edge: LocatedEdge, extra: Partial<Via> = {}) =>
      out.push({ id: edge.from, via: { kind: edge.kind, confidence: edge.confidence, file: edge.file, sites: edge.sites, ...extra } });
    const reached = (handlerKey: string | undefined) => reachedAt === null || reachedAt.some((k) => within(k, handlerKey));

    for (const e of this.edgesTo(id, "calls")) add(e);
    for (const member of this.implementedMembers(id)) {
      for (const e of this.edgesTo(member, "calls")) add(e, { dispatch: member });
    }
    for (const listen of this.edgesTo(id, "listens")) {
      if (!reached(listen.handlerKey)) continue;
      for (const e of this.edgesTo(listen.from, "emits")) add(e, { event: listen.from });
    }
    for (const e of this.edgesTo(id, "handles-route")) if (reached(e.handlerKey)) add(e);
    return out;
  }

  /**
   * What `id` calls, transitively up to `depth`: project units, interface members (with their
   * implementations as dispatch hits), library calls with their effects, and event listeners.
   */
  callees(id: string, depth = 1): QueryHit[] {
    const hits: QueryHit[] = [];
    const seen = new Set([id]);
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const source of frontier) {
        for (const hit of this.directCallees(source)) {
          const key = `${hit.id}|${hit.via.dispatch ?? ""}`;
          if (seen.has(key) || seen.has(hit.id)) continue;
          seen.add(key);
          seen.add(hit.id);
          hits.push({ ...hit, parent: source, depth: d });
          if (this.unitsById.has(hit.id)) next.push(hit.id);
        }
      }
      frontier = next;
    }
    return hits;
  }

  private directCallees(id: string): Omit<QueryHit, "parent" | "depth">[] {
    const out: Omit<QueryHit, "parent" | "depth">[] = [];
    for (const e of this.edgesFrom(id)) {
      const via: Via = { kind: e.kind, confidence: e.confidence, file: e.file, sites: e.sites, ...(e.effects ? { effects: e.effects } : {}) };
      if (e.kind === "calls") {
        out.push({ id: e.to, via });
        for (const impl of this.implementers(e.to)) out.push({ id: impl, via: { ...via, dispatch: e.to } });
      } else if (e.kind === "emits") {
        const listeners = this.edgesFrom(e.to, "listens");
        if (listeners.length === 0) out.push({ id: e.to, via });
        for (const l of listeners) out.push({ id: l.to, via: { ...via, event: e.to } });
      }
    }
    return out;
  }

  /**
   * Effects of a unit: its own, plus — one level (design §9) — the direct effects of the project
   * units it calls, including every implementation of an interface member it calls. `throws` is not
   * propagated: a callee that throws is described at the callee.
   */
  effectsOf(id: string, options: { propagated?: boolean } = {}): Effect[] {
    const own = this.unitsById.get(id)?.effects ?? [];
    if (!options.propagated) return own;
    const all = new Set<Effect>(own);
    for (const e of this.edgesFrom(id, "calls")) {
      for (const target of [e.to, ...this.implementers(e.to)]) {
        for (const effect of this.unitsById.get(target)?.effects ?? []) if (effect !== "throws") all.add(effect);
      }
    }
    return sortEffects(all);
  }

  /**
   * Everything upstream of the given units (design §10.4): callers, emitters of events they handle,
   * and the routes reached. A route whose handler is an inline callback is reached only through a
   * call inside that callback, so other routes registered by the same function are not reported.
   */
  impact(ids: string[]): ImpactResult {
    type Entry = { id: string; stepKey: string | null; depth: number; confidence: EdgeConfidence; path: string[]; via: ImpactVia };
    const result: ImpactResult = { units: [], routes: [], tests: [], gaps: [] };
    const unitsSeen = new Map<string, Entry>();
    const entriesSeen = new Set<string>();
    const routesSeen = new Set<string>();
    const queue: Entry[] = ids.map((id) => ({ id, stepKey: null, depth: 0, confidence: "resolved", path: [id], via: { kind: "calls" } }));

    const rank = (c: EdgeConfidence) => CONFIDENCE_ORDER.indexOf(c);
    while (queue.length > 0) {
      // Nearest first, and at equal distance the strongest path first, so each unit is reported with its best path.
      queue.sort((a, b) => a.depth - b.depth || rank(a.confidence) - rank(b.confidence));
      const entry = queue.shift()!;
      const entryKey = `${entry.id}|${entry.stepKey ?? ""}`;
      if (entriesSeen.has(entryKey)) continue;
      entriesSeen.add(entryKey);
      if (entry.depth > 0 && !unitsSeen.has(entry.id)) unitsSeen.set(entry.id, entry);

      const enqueue = (id: string, stepKey: string | null, confidence: EdgeConfidence, via: ImpactVia) => {
        if (ids.includes(id) && stepKey === null) return;
        queue.push({ id, stepKey, depth: entry.depth + 1, confidence: weakest(entry.confidence, confidence), path: [...entry.path, id], via });
      };

      for (const e of this.edgesTo(entry.id, "handles-route")) {
        if (!within(entry.stepKey, e.handlerKey) || routesSeen.has(e.from)) continue;
        routesSeen.add(e.from);
        result.routes.push({ id: e.from, handler: entry.id, confidence: weakest(entry.confidence, e.confidence), path: [...entry.path, e.from] });
      }
      for (const listen of this.edgesTo(entry.id, "listens")) {
        if (!within(entry.stepKey, listen.handlerKey)) continue;
        for (const emit of this.edgesTo(listen.from, "emits")) enqueue(emit.from, null, "rule", { kind: "emits", event: listen.from });
      }
      const targets = [entry.id, ...this.implementedMembers(entry.id)];
      for (const target of targets) {
        const via: ImpactVia = target === entry.id ? { kind: "calls" } : { kind: "calls", dispatch: target };
        for (const e of this.edgesTo(target, "calls")) {
          for (const site of e.sites) enqueue(e.from, site.stepKey ?? null, e.confidence, via);
        }
      }
    }

    result.units = [...unitsSeen.values()]
      .filter((e) => !ids.includes(e.id))
      .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
      .map(({ id, depth, confidence, path, via }) => ({ id, depth, confidence, path, via }));
    result.routes.sort((a, b) => a.id.localeCompare(b.id));
    const touched = new Set([...ids, ...result.units.map((u) => u.id)]);
    result.gaps = [...ids.flatMap((id) => this.possibleCallers(id)), ...this.gapList.filter((g) => g.kind !== "unresolved-call" && touched.has(g.unit))];
    return result;
  }

  /** Every route node, sorted. */
  routes(): string[] {
    const ids = new Set<string>();
    for (const id of this.outgoing.keys()) if (nodeKind(id) === "route") ids.add(id);
    return [...ids].sort();
  }

  /**
   * Routes matching a query: a route ID (`route:POST /transfers`), `POST /transfers`, or a path
   * (`/transfers`, every method). Method names are matched without regard to case.
   */
  findRoutes(query: string): string[] {
    const q = query.trim().replace(/^route:/, "");
    const space = q.indexOf(" ");
    const method = space > 0 ? q.slice(0, space).toUpperCase() : null;
    const path = space > 0 ? q.slice(space + 1).trim() : q;
    return this.routes().filter((id) => {
      const [m, ...rest] = id.slice("route:".length).split(" ");
      return rest.join(" ") === path && (method === null || m!.toUpperCase() === method);
    });
  }

  /**
   * What a route does (phase-2-design §1): its handlers, then every unit and library call reachable
   * from them, nearest first, up to `depth` calls down. A handler that is an inline callback is
   * followed only through the calls inside that callback.
   */
  flow(route: string, depth = 10): FlowResult {
    const handlers = this.edgesFrom(route, "handles-route").map((e) => ({ id: e.to, ...(e.handlerKey ? { handlerKey: e.handlerKey } : {}) }));
    const hits: QueryHit[] = [];
    const seen = new Set<string>();
    let frontier: { id: string; handlerKey?: string }[] = handlers;
    for (const h of handlers) seen.add(h.handlerKey ? `${h.id}|${h.handlerKey}` : h.id);
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: { id: string }[] = [];
      for (const source of frontier) {
        for (const hit of this.directCallees(source.id)) {
          let via = hit.via;
          if (source.handlerKey !== undefined) {
            const key = source.handlerKey;
            const sites = via.sites.filter((s) => s.stepKey !== undefined && within(s.stepKey, key));
            if (sites.length === 0) continue;
            via = { ...via, sites };
          }
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          hits.push({ id: hit.id, via, parent: source.id, depth: d });
          if (this.unitsById.has(hit.id)) next.push({ id: hit.id });
        }
      }
      frontier = next;
    }
    const effects: Record<string, Effect[]> = {};
    for (const id of [...handlers.filter((h) => !h.handlerKey).map((h) => h.id), ...hits.map((h) => h.id)]) {
      const own = this.unitsById.has(id) ? this.effectsOf(id) : [];
      if (own.length > 0) effects[id] = own;
    }
    return { route, handlers, hits, effects };
  }

  /**
   * Unresolved call sites that might call `id`: their callee name matches the symbol's last part.
   * A query that finds no callers is not proof there are none while such sites exist (design §10.3).
   */
  possibleCallers(id: string): GapNote[] {
    const name = id.slice(id.lastIndexOf("#") + 1).split(".").pop();
    if (!name) return [];
    return this.gapList.filter((g) => g.kind === "unresolved-call" && g.unit !== id && calleeName(g.expression) === name);
  }

  /** Gaps inside a unit: unresolved calls and rule sites with unknown arguments. */
  gapsIn(id: string): GapNote[] {
    return this.gapList.filter((g) => g.unit === id);
  }

  /** Event keys that are emitted but never listened to, and listened to but never emitted. */
  unmatchedEvents(): { emittedOnly: string[]; listenedOnly: string[] } {
    const emitted = new Set<string>();
    const listened = new Set<string>();
    for (const edges of this.outgoing.values()) {
      for (const e of edges) {
        if (e.kind === "emits") emitted.add(e.to);
        if (e.kind === "listens") listened.add(e.from);
      }
    }
    return {
      emittedOnly: [...emitted].filter((k) => !listened.has(k)).sort(),
      listenedOnly: [...listened].filter((k) => !emitted.has(k)).sort(),
    };
  }
}

/** True if a site with structure key `stepKey` lies inside the callback `handlerKey`, or the handler is the whole unit. */
function within(stepKey: string | null, handlerKey: string | undefined): boolean {
  return handlerKey === undefined || stepKey === null || stepKey === handlerKey || stepKey.startsWith(`${handlerKey}.`);
}

/** "this.repo.save(x)" → "save"; "handler(payload)" → "handler". */
export function calleeName(expression: string): string {
  const head = expression.replace(/^new\s+/, "").split("(")[0] ?? "";
  return head.trim().split(/[.?!]+/).filter(Boolean).pop() ?? "";
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
