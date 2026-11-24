import { useEffect, useRef, useState } from "preact/hooks";
import type { EdgeConfidence } from "@sift/core";
import { chipWidth, estimate, gapLines, layoutGraph, METRICS, type Layout, type Measure, type PlacedNode } from "./graph-layout.js";
import type { GapItem, GraphHostMessage, GraphModel, GraphNode, GraphViewState, GraphWebviewMessage } from "./graph-protocol.js";

/**
 * The graph views (phase-2-design §6.5): a diagram for neighbourhood and flow, and for impact a
 * grouped list with the diagram on request. Every unit opens its logic on click (Alt+click: its
 * code, Shift+click: its neighbourhood); weaker connections are dashed; gaps are listed, not hidden.
 */

const VIEW_NAMES = { neighbourhood: "Neighbourhood", flow: "Flow", impact: "Impact" } as const;
const GAP_LIMIT = 6;

const CONFIDENCE_TEXT: Record<EdgeConfidence, string> = {
  resolved: "resolved",
  "language-server": "language server",
  rule: "rule pack",
  "name-match": "name match",
  inferred: "inferred",
};

export interface GraphAppProps {
  post: (message: GraphWebviewMessage) => void;
  /** Text measurement; tests pass `estimate`. */
  measure?: Measure;
  /** Impact: whether the diagram is shown under the list. */
  diagram?: boolean;
  onDiagram?: (shown: boolean) => void;
}

const EMPTY: GraphViewState = { model: null, error: null, loading: true, dirty: false };

export function GraphApp({ post, measure, diagram: initialDiagram = false, onDiagram }: GraphAppProps) {
  const [state, setState] = useState<GraphViewState>(EMPTY);
  const [diagram, setDiagram] = useState(initialDiagram);

  useEffect(() => {
    const listener = (event: MessageEvent<GraphHostMessage>) => {
      if (event.data?.type === "state") setState(event.data.state);
    };
    window.addEventListener("message", listener);
    post({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const { model } = state;
  const toggle = () => {
    setDiagram(!diagram);
    onDiagram?.(!diagram);
  };
  return (
    <div class="graph-page">
      <header class="graph-header">
        <div class="titles">
          <span class="view-name">{model ? VIEW_NAMES[model.view] : "Graph"}</span>
          <h1 title={model?.title}>{model?.title ?? ""}</h1>
          {model && <span class="muted subtitle">{model.subtitle}</span>}
        </div>
        {model?.view === "impact" && !model.empty && (
          <button class="secondary small" aria-pressed={diagram} onClick={toggle}>
            {diagram ? "Hide diagram" : "Show diagram"}
          </button>
        )}
        <button class="secondary small" title="Run the query again" onClick={() => post({ type: "refresh" })}>
          Refresh
        </button>
      </header>
      {state.error && <div class="banner error">{state.error}</div>}
      {state.dirty && <div class="banner warning">Some files have unsaved changes. This shows the saved code.</div>}
      {model?.notes.map((n) => (
        <div class="banner info" key={n}>
          {n}
        </div>
      ))}
      {state.loading && !model && <p class="muted">Loading…</p>}
      {model && model.empty && <p class="muted empty">{model.empty}</p>}
      {model && !model.empty && model.view === "impact" && <ImpactList model={model} post={post} />}
      {model && !model.empty && (model.view !== "impact" || diagram) && <Diagram model={model} post={post} measure={measure} />}
    </div>
  );
}

// ── Opening nodes ───────────────────────────────────────────────────────────────────────────

function opens(node: GraphNode): boolean {
  return node.kind !== "external" && node.kind !== "gaps" && (node.kind !== "event" || node.site !== undefined);
}

function activate(node: GraphNode, e: { altKey: boolean; shiftKey: boolean }, post: GraphAppProps["post"]): void {
  if (!opens(node)) return;
  if (e.shiftKey && node.kind === "unit") post({ type: "neighbourhood", nodeId: node.id });
  else post({ type: "open", nodeId: node.id, source: e.altKey });
}

function onKey(node: GraphNode, post: GraphAppProps["post"]) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(node, e, post);
  };
}

function nodeTitle(node: GraphNode): string {
  if (!opens(node)) return node.tooltip;
  const how = node.kind === "unit" ? "Click: open logic · Alt+click: open code · Shift+click: show its neighbourhood" : node.kind === "route" ? "Click: show the route's flow" : "Click: open code";
  return `${node.tooltip}\n\n${how}`;
}

// ── Diagram ─────────────────────────────────────────────────────────────────────────────────

let canvas: CanvasRenderingContext2D | null | undefined;

/** Measures with a canvas in the editor's fonts; falls back to an estimate. */
const canvasMeasure: Measure = (text, font) => {
  if (canvas === undefined) {
    try {
      canvas = document.createElement("canvas").getContext("2d");
    } catch {
      canvas = null;
    }
  }
  if (!canvas) return estimate(text, font);
  const style = getComputedStyle(document.body);
  const editorFont = style.getPropertyValue("--vscode-editor-font-family") || "monospace";
  const uiFont = style.getPropertyValue("--vscode-font-family") || "sans-serif";
  const size = parseFloat(style.getPropertyValue("--vscode-font-size")) || 13;
  canvas.font = font === "label" ? `600 ${size}px ${editorFont}` : `${font === "chip" ? size - 2 : size - 1}px ${uiFont}`;
  return canvas.measureText(text).width;
};

function Diagram({ model, post, measure }: { model: GraphModel; post: GraphAppProps["post"]; measure: Measure | undefined }) {
  const [layout, setLayout] = useState<{ model: GraphModel; layout: Layout } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    layoutGraph(model, measure ?? canvasMeasure, GAP_LIMIT).then(
      (l) => {
        if (!current) return;
        setLayout({ model, layout: l });
        setError(null);
        post({ type: "drawn", nodes: l.nodes.length });
      },
      (err: unknown) => {
        if (!current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        post({ type: "drawn", nodes: 0, error: message });
      },
    );
    return () => {
      current = false;
    };
  }, [model]);

  if (error) return <div class="banner error">Could not lay out the diagram: {error}</div>;
  if (!layout) return <p class="muted">Laying out…</p>;
  const { width, height, nodes, edges } = layout.layout;
  const fit = () => {
    const available = (box.current?.clientWidth ?? width) - 4;
    setScale(Math.min(1, available / Math.max(1, width)));
  };
  return (
    <section class="diagram-section">
      <div class="diagram-tools">
        <Legend />
        <span class="spacer" />
        <button class="secondary small" title="Zoom out" aria-label="Zoom out" onClick={() => setScale(Math.max(0.2, scale / 1.25))}>
          −
        </button>
        <button class="secondary small" title="Fit to width" onClick={fit}>
          Fit
        </button>
        <button class="secondary small" title="Actual size" onClick={() => setScale(1)}>
          100%
        </button>
        <button class="secondary small" title="Zoom in" aria-label="Zoom in" onClick={() => setScale(Math.min(3, scale * 1.25))}>
          +
        </button>
      </div>
      <div class="diagram" ref={box}>
        <svg width={Math.ceil(width * scale)} height={Math.ceil(height * scale)} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${VIEW_NAMES[model.view]} of ${model.title}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head" />
            </marker>
          </defs>
          <g class="edges">
            {edges.map((e) => (
              <path key={e.id} class={`edge edge-${e.kind}${e.weak ? " weak" : ""}`} d={e.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")} marker-end="url(#arrow)" />
            ))}
          </g>
          <g class="nodes">
            {nodes.map((n) => (
              <DiagramNode key={n.node.id} placed={n} post={post} />
            ))}
          </g>
        </svg>
      </div>
    </section>
  );
}

function Legend() {
  return (
    <span class="legend muted">
      <svg width="28" height="8" aria-hidden="true">
        <line x1="0" y1="4" x2="28" y2="4" class="edge" />
      </svg>
      resolved
      <svg width="28" height="8" aria-hidden="true">
        <line x1="0" y1="4" x2="28" y2="4" class="edge weak" />
      </svg>
      rule pack, name match, or not resolved
    </span>
  );
}

function DiagramNode({ placed, post }: { placed: PlacedNode; post: GraphAppProps["post"] }) {
  const { node, x, y, width, height } = placed;
  const m = METRICS;
  const second = node.note ? `${node.detail} · ${node.note}` : node.detail;
  const classes = ["node", `kind-${node.kind}`, node.role ? `role-${node.role}` : "", opens(node) ? "openable" : "", node.confidence && node.confidence !== "resolved" ? "weak-path" : ""].filter(Boolean).join(" ");
  let line = m.padY + m.label - 5;
  const chipsY = m.padY + m.label + (second ? m.detail : 0) + 2;
  const gapsY = chipsY + (node.effects.length > 0 ? m.chip + 4 : 0);
  const { shown, more } = gapLines(node, GAP_LIMIT);
  let chipX = m.padX;
  return (
    <g
      class={classes}
      transform={`translate(${x} ${y})`}
      data-id={node.id}
      tabindex={opens(node) ? 0 : undefined}
      role={opens(node) ? "button" : "img"}
      aria-label={`${node.label}${node.detail ? `, ${node.detail}` : ""}`}
      onClick={(e) => activate(node, e, post)}
      onKeyDown={onKey(node, post)}
    >
      <title>{nodeTitle(node)}</title>
      <rect width={width} height={height} rx={node.kind === "route" || node.kind === "event" ? height / 2 : 4} />
      <text class="label" x={m.padX} y={line}>
        {clip(node.label, width)}
      </text>
      {second && (
        <text class="detail" x={m.padX} y={(line += m.detail)}>
          {clip(second, width)}
        </text>
      )}
      {node.effects.map((effect) => {
        const w = chipWidth(effect);
        const chip = (
          <g key={effect} class={`chip effect-${effect.split(".")[0]}`} transform={`translate(${chipX} ${chipsY})`}>
            <rect width={w} height={m.chip} rx={m.chip / 2} />
            <text x={w / 2} y={m.chip - 5} text-anchor="middle">
              {effect}
            </text>
          </g>
        );
        chipX += w + m.chipGap;
        return chip;
      })}
      {node.gaps?.slice(0, shown).map((g, i) => (
        <GapLine key={i} gap={g} y={gapsY + (i + 1) * m.gapLine - 4} width={width} post={post} />
      ))}
      {more > 0 && (
        <text class="detail" x={m.padX} y={gapsY + (shown + 1) * m.gapLine - 4}>
          {`and ${more} more`}
        </text>
      )}
    </g>
  );
}

function GapLine({ gap, y, width, post }: { gap: GapItem; y: number; width: number; post: GraphAppProps["post"] }) {
  const open = (e: Event) => {
    e.stopPropagation();
    post({ type: "openSite", file: gap.file, range: gap.range });
  };
  return (
    <text
      class="gap-line"
      x={METRICS.padX}
      y={y}
      tabindex={0}
      role="button"
      onClick={open}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(e))}
    >
      <title>{`${gap.file}:${gap.range.start.line}\nClick: open the call site`}</title>
      {clip(`${gap.label}  ${gap.description}`, width)}
    </text>
  );
}

/** Keep text inside a box the layout capped at its widest; narrower boxes were sized to fit. */
function clip(text: string, width: number): string {
  if (width < METRICS.maxWidth) return text;
  const max = Math.floor((width - METRICS.padX * 2) / 7.4);
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// ── Impact list (§6.5: "Tree + optional diagram") ───────────────────────────────────────────

function ImpactList({ model, post }: { model: GraphModel; post: GraphAppProps["post"] }) {
  const changed = model.nodes.filter((n) => n.role === "changed");
  const routes = model.nodes.filter((n) => n.kind === "route");
  const units = model.nodes.filter((n) => n.kind === "unit" && n.role !== "changed" && n.depth !== undefined);
  const depths = [...new Set(units.map((u) => u.depth!))].sort((a, b) => a - b);
  const gaps = model.nodes.find((n) => n.kind === "gaps");
  const handler = new Map(model.edges.filter((e) => e.kind === "handles-route").map((e) => [e.from, e.to]));
  const label = (id: string | undefined) => model.nodes.find((n) => n.id === id)?.label ?? id ?? "";
  return (
    <div class="impact-list">
      <ImpactGroup title="Changed" nodes={changed} post={post} />
      <ImpactGroup title="Routes reached" nodes={routes} post={post} empty="No route reaches the changes." extra={(n) => `handled by ${label(handler.get(n.id))}`} />
      {depths.map((d) => (
        <ImpactGroup key={d} title={d === 1 ? "Direct callers" : `${d} calls away`} nodes={units.filter((u) => u.depth === d)} post={post} />
      ))}
      {units.length === 0 && <p class="muted">Nothing in the project calls the changed units.</p>}
      {gaps?.gaps && (
        <section class="impact-group">
          <h2>
            Possible callers not resolved <span class="muted">{gaps.gaps.length}</span>
          </h2>
          <p class="muted hint">{gaps.tooltip}</p>
          <ul>
            {gaps.gaps.map((g, i) => (
              <li key={i}>
                <a href="#" onClick={(e) => (e.preventDefault(), post({ type: "openSite", file: g.file, range: g.range }))}>
                  <code>{g.label}</code>
                </a>{" "}
                <span class="muted">{g.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ImpactGroup({ title, nodes, post, empty, extra }: { title: string; nodes: GraphNode[]; post: GraphAppProps["post"]; empty?: string; extra?: (n: GraphNode) => string }) {
  if (nodes.length === 0 && !empty) return null;
  return (
    <section class="impact-group">
      <h2>
        {title} <span class="muted">{nodes.length}</span>
      </h2>
      {nodes.length === 0 ? (
        <p class="muted">{empty}</p>
      ) : (
        <ul>
          {nodes.map((n) => (
            <li key={n.id} data-id={n.id}>
              <a href="#" title={nodeTitle(n)} onClick={(e) => (e.preventDefault(), activate(n, e, post))}>
                <code>{n.label}</code>
              </a>{" "}
              <span class="muted">{[n.detail, extra?.(n), n.note].filter(Boolean).join(" · ")}</span>
              {n.confidence && n.confidence !== "resolved" && <span class={`confidence c-${n.confidence}`}>{CONFIDENCE_TEXT[n.confidence]}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
