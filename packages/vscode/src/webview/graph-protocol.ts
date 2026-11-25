import type { EdgeConfidence, SourceRange } from "@sift/core";

/**
 * Messages and the model for the graph views (phase-2-design §6.5): neighbourhood, flow, and
 * impact. The host builds a `GraphModel` from the server's query results (graph-model.ts); the
 * webview lays it out with elkjs and draws it. Types only, shared by both sides.
 */

export type GraphViewKind = "neighbourhood" | "flow" | "impact";

/**
 * - `unit`: a project unit (opens its logic)
 * - `declaration`: an interface or abstract member, reached through dispatch (opens its code)
 * - `external`: a library call, with its rule-pack effects
 * - `route`, `event`: edge-rule nodes
 * - `gaps`: call sites Sift could not connect ("possible callers not resolved"), listed in the node
 */
export type GraphNodeKind = "unit" | "declaration" | "external" | "route" | "event" | "gaps";

/** Where a node stands in its view: what it is about, what changed, or a route's handler. */
export type GraphNodeRole = "subject" | "changed" | "handler";

export interface GapItem {
  label: string;
  description: string;
  file: string;
  range: SourceRange;
}

export interface GraphNode {
  /** Graph node ID (`file#Symbol`, `ext:module#name`, `route:…`, `event:…`), or `gaps:<where>`. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Second line: the file, the module, or what the node is. */
  detail: string;
  role?: GraphNodeRole;
  /** Shown as chips on the node. */
  effects: string[];
  /** Impact: the weakest edge on the path to this node. */
  confidence?: EdgeConfidence;
  /** Impact: calls away from the nearest changed unit. */
  depth?: number;
  /** One line on how the node was reached ("through AccountRepository.save"). */
  note?: string;
  /** For `gaps` nodes. */
  gaps?: GapItem[];
  /** A place in the code for nodes that are not units (a route's registration). */
  site?: { file: string; range: SourceRange };
  tooltip: string;
}

/**
 * - `calls`: from caller to callee
 * - `implements`: from an interface member to an implementation of it
 * - `handles-route`: from a route to its handler
 * - `emits` / `listens`: from emitter to event, from event to listener
 * - `possible`: from a gaps node, or to one
 */
export type GraphEdgeKind = "calls" | "implements" | "handles-route" | "emits" | "listens" | "possible";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  confidence?: EdgeConfidence;
  /** Drawn dashed: matched by name, from a rule pack, inferred, or a gap (§6.5). */
  weak: boolean;
}

export interface GraphModel {
  view: GraphViewKind;
  title: string;
  subtitle: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Shown above the view (for impact: what in the diff was not a unit). */
  notes: string[];
  /** Shown instead of a diagram when there is nothing to draw. */
  empty?: string;
}

export interface GraphViewState {
  model: GraphModel | null;
  error: string | null;
  loading: boolean;
  /** The source of some file in the view has unsaved changes; the view reflects saved files. */
  dirty: boolean;
}

export type GraphHostMessage = { type: "state"; state: GraphViewState };

export type GraphWebviewMessage =
  | { type: "ready" }
  /** Click: open a node's logic. `source` (Alt+click): its code instead. */
  | { type: "open"; nodeId: string; source: boolean }
  /** Shift+click on a unit: show its neighbourhood. */
  | { type: "neighbourhood"; nodeId: string }
  /** A listed gap: open the call site. */
  | { type: "openSite"; file: string; range: SourceRange }
  | { type: "refresh" }
  /** A diagram was drawn (or could not be laid out): how many nodes. */
  | { type: "drawn"; nodes: number; error?: string };
