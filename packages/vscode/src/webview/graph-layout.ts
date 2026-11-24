import * as elkModule from "elkjs/lib/elk.bundled.js";
import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { GraphModel, GraphNode } from "./graph-protocol.js";

/**
 * Lays out a graph model with elkjs (layered, top to bottom: callers above, callees below), so
 * the webview only draws boxes and lines. Node sizes come from measured text.
 */

export interface Size {
  width: number;
  height: number;
}

/** Text width in pixels, for the given role of text. */
export type Measure = (text: string, font: "label" | "detail" | "chip") => number;

export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  id: string;
  /** Polyline: start, bends, end. */
  points: { x: number; y: number }[];
  weak: boolean;
  kind: string;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

export const METRICS = {
  padX: 10,
  padY: 6,
  label: 18,
  detail: 16,
  chip: 18,
  chipGap: 4,
  chipPad: 6,
  gapLine: 17,
  minWidth: 90,
  maxWidth: 360,
};

/** A rough width for when no canvas is available (tests): average glyph widths for the fonts used. */
export const estimate: Measure = (text, font) => text.length * (font === "label" ? 7.4 : font === "detail" ? 6.4 : 6);

/** Gap lines shown inside a gaps node. */
export function gapLines(node: GraphNode, limit: number): { shown: number; more: number } {
  const n = node.gaps?.length ?? 0;
  const shown = Math.min(n, limit);
  return { shown, more: n - shown };
}

/** Chips are drawn from the same estimate everywhere, so their row fits the node it was sized for. */
export function chipWidth(effect: string): number {
  return Math.max(24, Math.ceil(estimate(effect, "chip") + METRICS.chipPad * 2));
}

export function nodeSize(node: GraphNode, measure: Measure, gapLimit: number): Size {
  const m = METRICS;
  const second = node.note ? `${node.detail} · ${node.note}` : node.detail;
  let width = Math.max(measure(node.label, "label"), measure(second, "detail"));
  let height = m.padY * 2 + m.label + (second ? m.detail : 0);
  if (node.effects.length > 0) {
    const chips = node.effects.reduce((w, e) => w + chipWidth(e) + m.chipGap, -m.chipGap);
    width = Math.max(width, chips);
    height += m.chip + 4;
  }
  if (node.gaps) {
    const { shown, more } = gapLines(node, gapLimit);
    for (const g of node.gaps.slice(0, shown)) width = Math.max(width, measure(`${g.label}  ${g.description}`, "detail"));
    height += (shown + (more > 0 ? 1 : 0)) * m.gapLine + 4;
  }
  return { width: Math.ceil(Math.min(m.maxWidth, Math.max(m.minWidth, width + m.padX * 2))), height: Math.ceil(height) };
}

// elk.bundled.js is CommonJS (`module.exports = ELK`); bundlers and Node expose it as the default export.
const ElkConstructor = ((elkModule as unknown as { default?: unknown }).default ?? elkModule) as new () => ELK;
const elk = new ElkConstructor();

export async function layoutGraph(model: GraphModel, measure: Measure, gapLimit: number): Promise<Layout> {
  const sizes = new Map(model.nodes.map((n) => [n.id, nodeSize(n, measure, gapLimit)]));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
      "elk.layered.spacing.edgeNodeBetweenLayers": "16",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      // Keep the order the model lists things in (nearest first), so a refresh does not reshuffle.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
    },
    children: model.nodes.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
    edges: model.edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const result = await elk.layout(graph);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(model.edges.map((e) => [e.id, e]));
  const nodes: PlacedNode[] = (result.children ?? []).map((c) => ({ node: byId.get(c.id)!, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 }));
  const edges: PlacedEdge[] = (result.edges ?? []).flatMap((e) => {
    const model = edgeById.get(e.id)!;
    return (e.sections ?? []).map((s, i) => ({
      id: i === 0 ? e.id : `${e.id}#${i}`,
      points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint],
      weak: model.weak,
      kind: model.kind,
    }));
  });
  return { width: Math.ceil(result.width ?? 0), height: Math.ceil(result.height ?? 0), nodes, edges };
}
