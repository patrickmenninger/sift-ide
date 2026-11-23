import type { EdgeConfidence, GapNote, QueryHit } from "@sift/core";

/** How a graph node ID reads in a tree: `src/a.ts#Foo.bar` → "Foo.bar" with "src/a.ts" beside it. */
export function nodeLabel(id: string): { label: string; description: string; kind: "unit" | "route" | "event" | "other" } {
  if (id.startsWith("route:")) return { label: id.slice("route:".length), description: "route", kind: "route" };
  if (id.startsWith("event:")) return { label: id.slice("event:".length), description: "event", kind: "event" };
  const hash = id.indexOf("#");
  if (hash > 0) return { label: id.slice(hash + 1), description: id.slice(0, hash), kind: "unit" };
  return { label: id, description: "", kind: "other" };
}

/**
 * Codicon and wording for an edge's confidence (design §10.1). Weaker edges get a distinct icon,
 * so a name match never looks like a compiler-resolved call.
 */
export function confidenceIcon(confidence: EdgeConfidence): { icon: string; text: string } {
  switch (confidence) {
    case "resolved":
      return { icon: "pass-filled", text: "resolved by the compiler" };
    case "language-server":
      return { icon: "pass", text: "resolved by the language server" };
    case "rule":
      return { icon: "symbol-ruler", text: "from a rule pack (framework convention)" };
    case "name-match":
      return { icon: "question", text: "matched by name only" };
    case "inferred":
      return { icon: "question", text: "inferred" };
  }
}

/** Tooltip for a caller or callee hit: how it is connected. */
export function hitTooltip(hit: QueryHit, direction: "callers" | "callees"): string {
  const how = confidenceIcon(hit.via.confidence).text;
  const kind = hit.via.kind === "calls" ? (direction === "callers" ? "calls it" : "called") : hit.via.kind;
  const lines = [`${hit.id}`, `${kind} · ${how}`];
  if (hit.via.dispatch) lines.push(`through ${hit.via.dispatch}`);
  if (hit.via.event) lines.push(`through ${hit.via.event}`);
  if (hit.via.sites.length > 1) lines.push(`${hit.via.sites.length} call sites`);
  return lines.join("\n");
}

/** "Possible callers not resolved" and "unresolved calls" (phase-2-design §6.5): listed, not hidden. */
export function gapLabel(gap: GapNote): { label: string; description: string } {
  const unit = nodeLabel(gap.unit);
  switch (gap.kind) {
    case "unresolved-call":
      return { label: gap.expression, description: `unresolved call in ${unit.label}` };
    case "unknown-route":
      return { label: gap.expression, description: `route not recognised, in ${unit.label}` };
    case "unknown-event":
      return { label: gap.expression, description: `event not recognised, in ${unit.label}` };
    case "unknown-handler":
      return { label: gap.expression, description: `handler not resolved, in ${unit.label}` };
  }
}
