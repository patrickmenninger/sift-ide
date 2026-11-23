import type { SiftStep, SiftUnit, UnitStatus } from "./schema.js";

/**
 * Which wording in a unit a person wrote (phase-2-design §7).
 *
 * A unit with `status: user-edited` and no finer detail is a schema v0 unit: the whole description
 * counts as the person's. Otherwise only the fields in `userEdited` and the steps with
 * `status: user-edited` do.
 */
export interface PersonWording {
  whole: boolean;
  summary: boolean;
  returns: boolean;
  inputs: Set<string>;
  steps: Set<string>;
}

export function personWording(unit: SiftUnit): PersonWording {
  const steps = new Set<string>();
  const walk = (list: SiftStep[]): void => list.forEach((s) => (s.status === "user-edited" && steps.add(s.id), walk(s.steps)));
  walk(unit.steps);
  const fields = new Set(unit.userEdited ?? []);
  const fine = fields.size > 0 || steps.size > 0;
  return {
    whole: unit.status === "user-edited" && !fine,
    summary: fields.has("summary"),
    returns: fields.has("returns"),
    inputs: new Set([...fields].filter((f) => f.startsWith("inputs.")).map((f) => f.slice("inputs.".length))),
    steps,
  };
}

export function hasPersonWording(unit: SiftUnit): boolean {
  const p = personWording(unit);
  return p.whole || p.summary || p.returns || p.inputs.size > 0 || p.steps.size > 0;
}

/**
 * True when every piece of a person's wording in `previous` that `next` still has is unchanged.
 * Pieces `next` dropped (a removed step or input) do not count: the code they described is gone.
 */
export function keepsPersonWording(previous: SiftUnit, next: SiftUnit): boolean {
  const p = personWording(previous);
  if ((p.whole || p.summary) && previous.summary !== next.summary) return false;
  if ((p.whole || p.returns) && previous.returns && next.returns && previous.returns.meaning !== next.returns.meaning) return false;
  for (const i of previous.inputs) {
    if (!p.whole && !p.inputs.has(i.name)) continue;
    const now = next.inputs.find((n) => n.name === i.name);
    if (now && now.meaning !== i.meaning) return false;
  }
  const old = new Map<string, string>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => ((p.whole || p.steps.has(s.id)) && old.set(s.id, s.text), index(s.steps)));
  index(previous.steps);
  const check = (steps: SiftStep[]): boolean => steps.every((s) => (!old.has(s.id) || old.get(s.id) === s.text) && check(s.steps));
  return check(next.steps);
}

/**
 * Carry step and field provenance from `previous` to `next` after the AI rewrote a unit. A piece
 * keeps `user-edited` only while its text is unchanged. `verified` is kept only when `keepVerified`
 * (the code did not change) and the text is unchanged.
 */
export function carryProvenance(previous: SiftUnit, next: SiftUnit, options: { keepVerified: boolean }): void {
  const p = personWording(previous);
  if (!p.whole) {
    const fields: string[] = [];
    if (p.summary && previous.summary === next.summary) fields.push("summary");
    if (p.returns && previous.returns && next.returns && previous.returns.meaning === next.returns.meaning) fields.push("returns");
    for (const name of p.inputs) {
      const before = previous.inputs.find((i) => i.name === name);
      const now = next.inputs.find((i) => i.name === name);
      if (before && now && before.meaning === now.meaning) fields.push(`inputs.${name}`);
    }
    if (fields.length > 0) next.userEdited = fields;
    else delete next.userEdited;
  }
  const old = new Map<string, SiftStep>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => (old.set(s.id, s), index(s.steps)));
  index(previous.steps);
  const apply = (steps: SiftStep[]): void =>
    steps.forEach((s) => {
      const before = old.get(s.id);
      delete s.status;
      if (before?.status && before.text === s.text && (before.status === "user-edited" || options.keepVerified)) s.status = before.status;
      apply(s.steps);
    });
  apply(next.steps);
}

/**
 * The status to show for a unit: `stale` wins; a unit whose stored status is `generated` but that
 * holds a person's wording shows as `user-edited`.
 */
export function displayStatus(unit: SiftUnit): UnitStatus {
  if (unit.status === "generated" && hasPersonWording(unit)) return "user-edited";
  return unit.status;
}

/** A sentence for the update and context-check prompts naming the parts a person wrote, or null. */
export function personWordingNote(unit: SiftUnit): string | null {
  const p = personWording(unit);
  if (p.whole) return "A person edited this description. Keep their wording wherever it is still accurate.";
  const parts: string[] = [];
  if (p.summary) parts.push("the summary");
  for (const name of p.inputs) parts.push(`the meaning of input \`${name}\``);
  if (p.returns) parts.push("the returns meaning");
  if (p.steps.size > 0) parts.push(`step${p.steps.size === 1 ? "" : "s"} ${[...p.steps].join(", ")}`);
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `A person wrote ${list}. Keep their wording wherever it is still accurate.`;
}
