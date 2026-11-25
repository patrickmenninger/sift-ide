import { SiftError } from "./errors.js";
import type { SiftStep, SiftUnit, StepKind } from "./schema.js";

/**
 * A person's edits to a unit's description (phase-2-design §8.1), and the draft they make. No
 * Node APIs here: the logic document's webview applies drafts with the same code.
 */

/**
 * One change a person made to a description (phase-2-design §8.1). Paths for `set`: `summary`,
 * `returns.meaning`, `inputs[<name>].meaning`, or `steps[<id>].text`.
 */
export type DescriptionEdit =
  | { op: "set"; path: string; before: string; after: string }
  /** A new step after step `after` (same level), or first inside step `parent`, or first in the unit. */
  | { op: "add"; id: string; text: string; after?: string; parent?: string; kind?: StepKind }
  | { op: "delete"; step: string };

/**
 * The description as the person wants it: `base` with the edits applied. Pieces they wrote are
 * marked as theirs (`user-edited`), so the re-derivation keeps their wording where it is accurate.
 * Throws when an edit does not fit the description (an unknown step, or a `before` that no longer matches).
 */
export function applyDescriptionEdits(base: SiftUnit, edits: DescriptionEdit[]): SiftUnit {
  const unit = structuredClone(base);
  const problems: string[] = [];
  const mark = (field: string) => {
    unit.userEdited = [...new Set([...(unit.userEdited ?? []), field])];
  };
  for (const [i, edit] of edits.entries()) {
    const at = `edits[${i}]`;
    if (edit.op === "set") {
      const step = /^steps\[(s_[a-z2-7]{4})\]\.text$/.exec(edit.path);
      const input = /^inputs\[([^\]]+)\]\.meaning$/.exec(edit.path);
      if (edit.after.trim() === "") problems.push(`${at}: the new text for ${edit.path} is empty`);
      if (edit.path === "summary") {
        if (unit.summary !== edit.before) problems.push(`${at}: the summary is no longer "${edit.before}"`);
        unit.summary = edit.after;
        mark("summary");
      } else if (edit.path === "returns.meaning") {
        if (!unit.returns) problems.push(`${at}: ${unit.symbol} returns nothing`);
        else {
          if (unit.returns.meaning !== edit.before) problems.push(`${at}: the returns meaning is no longer "${edit.before}"`);
          unit.returns.meaning = edit.after;
          mark("returns");
        }
      } else if (input) {
        const found = unit.inputs.find((x) => x.name === input[1]);
        if (!found) problems.push(`${at}: ${unit.symbol} has no input "${input[1]}"`);
        else {
          if (found.meaning !== edit.before) problems.push(`${at}: the meaning of input "${input[1]}" is no longer "${edit.before}"`);
          found.meaning = edit.after;
          mark(`inputs.${found.name}`);
        }
      } else if (step) {
        const found = findStep(unit.steps, step[1]!);
        if (!found) problems.push(`${at}: ${unit.symbol} has no step ${step[1]}`);
        else {
          if (found.step.text !== edit.before) problems.push(`${at}: step ${step[1]} no longer reads "${edit.before}"`);
          found.step.text = edit.after;
          found.step.status = "user-edited";
        }
      } else problems.push(`${at}: unknown path "${edit.path}" (expected summary, returns.meaning, inputs[<name>].meaning, or steps[<id>].text)`);
    } else if (edit.op === "add") {
      if (edit.text.trim() === "") problems.push(`${at}: the new step has no text`);
      if (findStep(unit.steps, edit.id)) problems.push(`${at}: step ID ${edit.id} is already used`);
      const step: SiftStep = { id: edit.id, status: "user-edited", text: edit.text, covers: [], calls: [], effects: [], steps: [] };
      if (edit.kind) step.kind = edit.kind;
      if (edit.after !== undefined) {
        const found = findStep(unit.steps, edit.after);
        if (!found) problems.push(`${at}: ${unit.symbol} has no step ${edit.after}`);
        else found.list.splice(found.list.indexOf(found.step) + 1, 0, step);
      } else if (edit.parent !== undefined) {
        const found = findStep(unit.steps, edit.parent);
        if (!found) problems.push(`${at}: ${unit.symbol} has no step ${edit.parent}`);
        else found.step.steps.unshift(step);
      } else unit.steps.unshift(step);
    } else {
      const found = findStep(unit.steps, edit.step);
      if (!found) problems.push(`${at}: ${unit.symbol} has no step ${edit.step}`);
      else found.list.splice(found.list.indexOf(found.step), 1);
    }
  }
  if (problems.length > 0) throw new SiftError("EDIT_INVALID_STATE", `The edits do not fit the description of ${unit.symbol}.`, problems);
  return unit;
}

export function findStep(steps: SiftStep[], id: string): { step: SiftStep; list: SiftStep[] } | undefined {
  for (const s of steps) {
    if (s.id === id) return { step: s, list: steps };
    const inner = findStep(s.steps, id);
    if (inner) return inner;
  }
  return undefined;
}

