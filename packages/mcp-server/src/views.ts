import type { Effect, LogicUnit, SiftStep, UnitStatus } from "@sift/core";

/**
 * Compact, agent-facing shapes of Sift's results (phase-2-design §5). They drop what only the
 * engine needs (hashes, structure keys, provenance) and keep what an agent reasons with.
 */

/** Most items any list in a response holds; the rest are counted in `truncated`. */
export const MAX_RESULTS = 50;
export const DEFAULT_DEPTH = 2;

/** How many items each truncated list left out, by field name. */
export type Truncated = Record<string, number>;

export function cap<T>(items: T[], field: string, truncated: Truncated, limit = MAX_RESULTS): T[] {
  if (items.length <= limit) return items;
  truncated[field] = (truncated[field] ?? 0) + items.length - limit;
  return items.slice(0, limit);
}

export interface UnitView {
  /** `file#Symbol`. */
  ref: string;
  id: string;
  kind: string;
  lite?: true;
  status: UnitStatus;
  freshness: LogicUnit["freshness"];
  /** Set when the description may not match the code; the same sentence starts `summary`. */
  stale?: string;
  summary: string;
  inputs: { name: string; type: string; meaning: string }[];
  returns?: { type: string; meaning: string };
  effects: Effect[];
  steps: StepView[];
  warnings: { kind: string; text: string; steps: string[] }[];
}

export interface StepView {
  id: string;
  kind?: string;
  /** "user-edited" or "verified" when it differs from the unit. */
  status?: string;
  text: string;
  /** `file#Symbol` for project units, `ext:module#name` for library calls. */
  calls: string[];
  effects: Effect[];
  steps: StepView[];
}

/**
 * Why a description may not match the code, or undefined when it does. Every sentence starts
 * with "Stale:" so an agent cannot read a stale description as current (requirements §8.9).
 */
export function staleNote(u: Pick<LogicUnit, "status" | "freshness">): string | undefined {
  if (u.freshness === "code-changed") return "Stale: the code changed after this was written.";
  if (u.freshness === "not-in-code") return "Stale: this code no longer exists (it was removed or renamed) after this was written.";
  if (u.status === "stale") return "Stale: marked for review; this description may not match the code.";
  return undefined;
}

export function unitView(logic: LogicUnit, names: Map<string, string>): UnitView {
  const u = logic.unit;
  const stale = staleNote(logic);
  const step = (s: SiftStep): StepView => ({
    id: s.id,
    ...(s.kind ? { kind: s.kind } : {}),
    ...(s.status ? { status: s.status } : {}),
    text: s.text,
    calls: s.calls.map((c) => (c.startsWith("ext:") ? c : (names.get(c) ?? `${c} (no longer described)`))),
    effects: s.effects,
    steps: s.steps.map(step),
  });
  return {
    ref: logic.ref,
    id: u.id,
    kind: u.kind,
    ...(u.lite ? { lite: true as const } : {}),
    status: logic.status,
    freshness: logic.freshness,
    ...(stale ? { stale } : {}),
    summary: stale ? `${stale} ${u.summary}` : u.summary,
    inputs: u.inputs.map((i) => ({ name: i.name, type: i.type, meaning: i.meaning })),
    ...(u.returns ? { returns: { type: u.returns.type, meaning: u.returns.meaning } } : {}),
    effects: u.effects,
    steps: u.steps.map(step),
    warnings: u.warnings.filter((w) => !w.resolved).map((w) => ({ kind: w.kind, text: w.text, steps: w.steps })),
  };
}

const STATUS_TEXT: Record<UnitStatus, string> = {
  generated: "generated, not verified",
  "user-edited": "edited by a person",
  verified: "verified by a person",
  stale: "stale",
};

export function renderUnit(v: UnitView): string {
  const lines = [`${v.ref} · ${v.kind}${v.lite ? " (lite)" : ""} · ${STATUS_TEXT[v.status]}`, `  ${v.summary}`];
  if (v.inputs.length > 0) lines.push("  Inputs", ...v.inputs.map((i) => `    ${i.name} (${i.type}): ${i.meaning}`));
  if (v.returns) lines.push(`  Returns ${v.returns.type}: ${v.returns.meaning}`);
  if (v.effects.length > 0) lines.push(`  Effects: ${v.effects.join(", ")}`);
  const numbers = new Map<string, string>();
  if (v.steps.length > 0) {
    lines.push("  Steps");
    const walk = (steps: StepView[], prefix: string, pad: string) =>
      steps.forEach((s, i) => {
        const n = prefix === "" ? `${i + 1}` : `${prefix}.${i + 1}`;
        numbers.set(s.id, n);
        const mark = s.status === "user-edited" ? " (written by a person)" : s.status === "verified" ? " (verified)" : "";
        lines.push(`${pad}${n}. ${s.text}${mark}`);
        if (s.calls.length > 0) lines.push(`${pad}   → ${s.calls.map(callName).join(", ")}`);
        walk(s.steps, n, `${pad}  `);
      });
    walk(v.steps, "", "    ");
  }
  if (v.warnings.length > 0) {
    lines.push("  Warnings");
    for (const w of v.warnings) {
      const where = w.steps.map((id) => numbers.get(id)).filter(Boolean);
      lines.push(`    ! ${w.kind}${where.length > 0 ? ` (step ${where.join(", ")})` : ""}: ${w.text}`);
    }
  }
  return lines.join("\n");
}

function callName(ref: string): string {
  return ref.startsWith("ext:") ? ref.slice(4).replace("#", ": ") : ref;
}

export function truncationNote(truncated: Truncated): string[] {
  const parts = Object.entries(truncated).map(([field, n]) => `${n} more ${field}`);
  return parts.length > 0 ? [`Truncated: ${parts.join(", ")} not shown. Narrow the query or lower the depth.`] : [];
}
