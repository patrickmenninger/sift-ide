import { effectsOfUnit, flatten, parentKey, tokenize, type ExtractedUnit, type RuleSet, type SiftStep, type SiftUnit } from "@sift/core";
import type { UnitExpectation } from "./files.js";

/** Warning kinds the describe prompt names; others are the model's own (design §7.4). */
export const STANDARD_WARNINGS = ["missing-transaction", "missing-check", "missing-auth", "unhandled-error", "unawaited-promise", "comment-contradicts-code"];

/** One check of an expectation; `pass` is null when it needs the judge and the judge did not run. */
export interface Check {
  kind: "mention" | "warn" | "not-warn" | "lite";
  subject: string;
  pass: boolean | null;
  /** For mentions: where the judge found the idea. */
  where?: string;
}

/**
 * Effect-bearing structure nodes that no step covers (design §13.3), as "key: effects". Logging is
 * left out: it rarely matters to a reader. Lite units have no steps and are not counted.
 */
export function missedEffects(described: SiftUnit, unit: ExtractedUnit, rules: RuleSet): string[] {
  if (described.lite) return [];
  const covered = new Set<string>();
  const collect = (steps: SiftStep[]): void => steps.forEach((s) => (s.covers.forEach((k) => covered.add(k)), collect(s.steps)));
  collect(described.steps);
  const isCovered = (key: string) => {
    for (let k: string | null = key; k !== null; k = parentKey(k)) if (covered.has(k)) return true;
    return false;
  };
  const { nodes } = effectsOfUnit(unit, rules);
  const out: string[] = [];
  for (const node of flatten(unit.body)) {
    const effects = (nodes.get(node.key) ?? []).filter((e) => e !== "log");
    if (effects.length > 0 && !isCovered(node.key)) out.push(`${node.key}: ${effects.join(", ")}`);
  }
  return out;
}

/** The deterministic checks of an expectation; mentions come from the judge (`ideas`), if it ran. */
export function expectationChecks(e: UnitExpectation, described: SiftUnit | undefined, ideas: { present: boolean; where: string }[] | null): Check[] {
  const kinds = new Set((described?.warnings ?? []).map((w) => w.kind));
  const checks: Check[] = [];
  e.mustMention.forEach((idea, i) => {
    const verdict = described ? ideas?.[i] : undefined;
    const check: Check = { kind: "mention", subject: idea, pass: !described ? false : verdict ? verdict.present : null };
    if (verdict?.present && verdict.where) check.where = verdict.where;
    checks.push(check);
  });
  for (const k of e.mustWarn) checks.push({ kind: "warn", subject: k, pass: described ? kinds.has(k) : false });
  for (const k of e.mustNotWarn) checks.push({ kind: "not-warn", subject: k, pass: described ? !kinds.has(k) : false });
  if (e.lite !== undefined) checks.push({ kind: "lite", subject: String(e.lite), pass: described ? (described.lite ?? false) === e.lite : false });
  return checks;
}

const KEYWORDS = new Set(
  "if else for while do return const let var await async throw new try catch finally switch case default break continue function class this typeof instanceof in of true false null undefined void delete yield".split(" "),
);

/** A node's code with identifiers replaced, so a renamed variable does not count as a change. */
export function shapeOf(text: string): string {
  return tokenize(text).map((t) => (/^[A-Za-z_$][\w$]*$/.test(t) && !KEYWORDS.has(t) ? "_" : t)).join(" ");
}

export interface UnitChurn {
  unit: string;
  /** Previous steps whose covered code kept its shape (identifiers aside). */
  unaffected: number;
  /** Of those, the steps whose text changed or that were dropped. */
  changed: { id: string; before: string; after: string | null }[];
}

/**
 * Churn of an updated unit (design §13.3): of the steps whose covered code did not change (apart
 * from identifier names), how many changed wording or disappeared.
 */
export function stepChurn(unit: string, before: SiftUnit, beforeCode: ExtractedUnit, after: SiftUnit, afterCode: ExtractedUnit): UnitChurn {
  const oldShape = new Map(flatten(beforeCode.body).map((n) => [n.key, shapeOf(n.text)]));
  const newShapes = new Set(flatten(afterCode.body).map((n) => shapeOf(n.text)));
  const newSteps = new Map<string, string>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => (newSteps.set(s.id, s.text), index(s.steps)));
  index(after.steps);
  const result: UnitChurn = { unit, unaffected: 0, changed: [] };
  const visit = (steps: SiftStep[]): void =>
    steps.forEach((s) => {
      const unaffected = s.covers.every((k) => {
        const shape = oldShape.get(k);
        return shape !== undefined && newShapes.has(shape);
      });
      if (unaffected) {
        result.unaffected++;
        const now = newSteps.get(s.id);
        if (now !== s.text) result.changed.push({ id: s.id, before: s.text, after: now ?? null });
      }
      visit(s.steps);
    });
  visit(before.steps);
  return result;
}

/** The AI-written wording of a unit, to tell whether anything was reworded. */
export function prose(u: SiftUnit): string {
  const steps = (list: SiftStep[]): string[] => list.flatMap((s) => [s.text, ...steps(s.steps)]);
  return JSON.stringify([u.summary, u.inputs.map((i) => i.meaning), u.returns?.meaning ?? null, steps(u.steps)]);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
