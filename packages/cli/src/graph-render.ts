import type { CodeGraph, GapNote, ImpactResult, QueryHit } from "@sift/core";

/** Short readable name for a graph node. */
export function nodeName(graph: CodeGraph, id: string): string {
  switch (graph.kindOf(id)) {
    case "external":
      return id.slice(4).replace("#", ": ");
    case "route":
      return `route ${id.slice(6)}`;
    case "event":
      return `event ${id.slice(6)}`;
    default:
      return id.slice(id.indexOf("#") + 1);
  }
}

function fileOf(id: string): string {
  return id.slice(0, id.indexOf("#"));
}

function lines(hit: QueryHit): string {
  const nums = [...new Set(hit.via.sites.map((s) => s.range.start.line))].sort((a, b) => a - b);
  return `${hit.via.file}:${nums.join(",")}`;
}

function describeVia(graph: CodeGraph, hit: QueryHit): string {
  const parts: string[] = [hit.via.kind];
  if (hit.via.dispatch) parts.push(`via ${nodeName(graph, hit.via.dispatch)}`);
  if (hit.via.event) parts.push(`via ${nodeName(graph, hit.via.event)}`);
  return `${parts.join(" ")} · ${hit.via.confidence}`;
}

function tree(hits: QueryHit[], root: string, render: (hit: QueryHit) => string): string[] {
  const out: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const hit of hits.filter((h) => h.parent === parent && h.depth === depth)) {
      out.push(`${"  ".repeat(depth)}${render(hit)}`);
      walk(hit.id, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

function subjectLine(graph: CodeGraph, id: string): string {
  const kind = graph.kindOf(id);
  const where = kind === "unit" || kind === "declaration" ? `  (${fileOf(id)}${kind === "declaration" ? ", not a unit" : ""})` : "";
  return `${nodeName(graph, id)}${where}`;
}

export function renderCallers(graph: CodeGraph, id: string, hits: QueryHit[], gaps: GapNote[]): string {
  const out = [`Callers of ${subjectLine(graph, id)}`];
  if (hits.length === 0) out.push("  (none found)");
  out.push(
    ...tree(hits, id, (hit) =>
      graph.kindOf(hit.id) === "route"
        ? `${nodeName(graph, hit.id)}  ${lines(hit)} · ${hit.via.kind} · ${hit.via.confidence}`
        : `${nodeName(graph, hit.id)}  ${lines(hit)} · ${describeVia(graph, hit)}`,
    ),
  );
  out.push(...renderPossibleCallers(gaps));
  return out.join("\n");
}

export function renderCallees(graph: CodeGraph, id: string, hits: QueryHit[], gaps: GapNote[]): string {
  const out = [`Calls made by ${subjectLine(graph, id)}`];
  const effects = graph.effectsOf(id, { propagated: true });
  if (effects.length > 0) out.push(`  Effects: ${effects.join(", ")}`);
  if (hits.length === 0) out.push("  (none found)");
  out.push(
    ...tree(hits, id, (hit) => {
      const kind = graph.kindOf(hit.id);
      const effects = kind === "external" ? (hit.via.effects ?? []) : graph.effectsOf(hit.id, { propagated: true });
      const where = kind === "unit" || kind === "declaration" ? `  ${fileOf(hit.id)}` : "";
      const label = kind === "declaration" ? " (declaration)" : kind === "event" ? " (no listeners)" : "";
      const at = `line ${[...new Set(hit.via.sites.map((s) => s.range.start.line))].join(",")}`;
      return `${nodeName(graph, hit.id)}${label}${where} · ${at} · ${describeVia(graph, hit)}${effects.length > 0 ? `  [${effects.join(", ")}]` : ""}`;
    }),
  );
  if (gaps.length > 0) {
    out.push("", "  Not resolved (these calls may lead anywhere):");
    for (const g of gaps) out.push(`    ${g.kind}: ${oneLine(g.expression)}  ${g.file}:${g.site.range.start.line}`);
  }
  return out.join("\n");
}

export function renderImpact(graph: CodeGraph, subjects: string[], result: ImpactResult): string {
  const out = [`Impact of changing ${subjects.map((s) => nodeName(graph, s)).join(", ")}`];
  const how = (u: ImpactResult["units"][number]) => {
    const prev = nodeName(graph, u.path[u.path.length - 2] ?? u.path[0]!);
    if (u.via.kind === "emits") return `emits ${nodeName(graph, u.via.event ?? "")}, handled by ${prev}`;
    return u.via.dispatch ? `calls ${prev} via ${nodeName(graph, u.via.dispatch)}` : `calls ${prev}`;
  };

  out.push("", "  Routes");
  if (result.routes.length === 0) out.push("    (none)");
  for (const r of result.routes) out.push(`    ${r.id.slice(6)}  · handled in ${nodeName(graph, r.handler)} · ${r.confidence}`);

  out.push("", "  Units");
  if (result.units.length === 0) out.push("    (none)");
  for (const u of result.units) out.push(`    ${nodeName(graph, u.id)}  ${fileOf(u.id)} · ${how(u)} · ${u.confidence}${u.depth > 1 ? ` · ${u.depth} levels up` : ""}`);

  out.push("", "  Tests", "    (not tracked yet: tests join the graph in Phase 3)");
  out.push(...renderPossibleCallers(result.gaps.filter((g) => g.kind === "unresolved-call")));
  const other = result.gaps.filter((g) => g.kind !== "unresolved-call");
  if (other.length > 0) {
    out.push("", "  Registrations Sift could not read (routes or events may be missing):");
    for (const g of other) out.push(`    ${g.kind}: ${oneLine(g.expression)}  ${g.file}:${g.site.range.start.line}`);
  }
  return out.join("\n");
}

function renderPossibleCallers(gaps: GapNote[]): string[] {
  if (gaps.length === 0) return [];
  const out = ["", "  May be incomplete: these calls could not be resolved but have a matching name:"];
  for (const g of gaps) out.push(`    ${oneLine(g.expression)}  ${g.file}:${g.site.range.start.line} (in ${g.unit.slice(g.unit.indexOf("#") + 1)})`);
  return out;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
