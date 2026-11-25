// Through core-runtime, not @sift/core: core's index reads files when it loads.
import { applyDescriptionEdits } from "../core-runtime.js";
import type { ChangeRequest, DescriptionEdit, EditState, LogicUnit, SiftStep, SiftUnit, StepKind } from "@sift/core";
import type { EditActivity, UnitEdit } from "./protocol.js";

/**
 * Drafts in the logic document (phase-2-design §8.1): a person's edits to one unit's description
 * as a list of `DescriptionEdit`s on top of a base description. One `set` per field, added steps
 * as `add`, removed ones as `delete`; the draft shown is the base with the edits applied, by the
 * same code the engine uses. DOM-free, so it is tested on its own.
 */

/** Requests the document shows on their unit; the rest are finished (applied, rejected, undone). */
export const SHOWN_STATES: EditState[] = ["draft", "planning", "needs-answers", "proposing", "ready", "needs-review", "failed"];

/** States in which the person can still change the draft (changing a ready proposal sends it back to draft). */
const EDITABLE_STATES: EditState[] = ["draft", "needs-answers", "ready", "failed"];

/** The unit's open change request, if any (the newest, when there are several). */
export function editOf(edits: readonly UnitEdit[], unitId: string): UnitEdit | undefined {
  return edits.find((e) => e.request.unitId === unitId && SHOWN_STATES.includes(e.request.state));
}

export function isEditable(edit: UnitEdit | undefined): boolean {
  return !edit || (edit.activity === null && EDITABLE_STATES.includes(edit.request.state));
}

/** An edit starts from what the code does now, so only a current, unflagged description can be edited. */
export function canEdit(u: LogicUnit): boolean {
  return u.freshness === "fresh" && u.status !== "stale";
}

/** The description the person is editing: the request's base, or the unit as it is. */
export function baseOf(u: LogicUnit, edit: UnitEdit | undefined): SiftUnit {
  return edit?.request.base.description ?? u.unit;
}

/** The base with the edits applied. Edits that no longer fit leave the base as it was. */
export function draftOf(base: SiftUnit, edits: readonly DescriptionEdit[]): SiftUnit {
  if (edits.length === 0) return base;
  try {
    return applyDescriptionEdits(base, [...edits]);
  } catch {
    return base;
  }
}

/** Field paths, as `set` uses them. */
export const fieldPath = {
  summary: "summary",
  returns: "returns.meaning",
  input: (name: string) => `inputs[${name}].meaning`,
  step: (id: string) => `steps[${id}].text`,
};

/** The text of a field in a description. */
function fieldText(unit: SiftUnit, path: string): string | undefined {
  if (path === "summary") return unit.summary;
  if (path === "returns.meaning") return unit.returns?.meaning;
  const input = /^inputs\[(.+)\]\.meaning$/.exec(path);
  if (input) return unit.inputs.find((i) => i.name === input[1])?.meaning;
  const step = /^steps\[(.+)\]\.text$/.exec(path);
  if (step) return findStep(unit.steps, step[1]!)?.text;
  return undefined;
}

/** Set a field's text. Back to the base text removes the edit; a step the person added just changes its text. */
export function setText(base: SiftUnit, edits: readonly DescriptionEdit[], path: string, text: string): DescriptionEdit[] {
  const after = text.trim();
  const stepId = /^steps\[(.+)\]\.text$/.exec(path)?.[1];
  const added = stepId ? edits.find((e) => e.op === "add" && e.id === stepId) : undefined;
  if (added) {
    if (after === "") return removeStep(base, edits, stepId!);
    return edits.map((e) => (e === added ? { ...added, text: after } : e));
  }
  const before = fieldText(base, path);
  if (before === undefined) return [...edits];
  const rest = edits.filter((e) => !(e.op === "set" && e.path === path));
  if (after === "" || after === before) return rest;
  return [...rest, { op: "set", path, before, after }];
}

/** Add a step after `after` (same level), first inside `parent`, or first in the unit. Returns the edits and the new step's ID. */
export function addStep(
  base: SiftUnit,
  edits: readonly DescriptionEdit[],
  place: { after?: string; parent?: string },
  text: string,
  kind?: StepKind,
): { edits: DescriptionEdit[]; id: string } {
  const id = newStepId(base, edits);
  const add: DescriptionEdit = { op: "add", id, text: text.trim(), ...(place.after ? { after: place.after } : place.parent ? { parent: place.parent } : {}), ...(kind ? { kind } : {}) };
  // Adds go before deletes, so a step added after one that is later deleted still has its anchor.
  const firstDelete = edits.findIndex((e) => e.op === "delete");
  const next = [...edits];
  next.splice(firstDelete < 0 ? next.length : firstDelete, 0, add);
  return { edits: next, id };
}

/** Remove a step from the draft: an added step is dropped (with steps placed relative to it), a base step is deleted. */
export function removeStep(base: SiftUnit, edits: readonly DescriptionEdit[], stepId: string): DescriptionEdit[] {
  if (edits.some((e) => e.op === "add" && e.id === stepId)) {
    // Steps added after or inside this one go with it.
    const gone = new Set([stepId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edits) {
        if (e.op === "add" && !gone.has(e.id) && ((e.after && gone.has(e.after)) || (e.parent && gone.has(e.parent)))) {
          gone.add(e.id);
          grew = true;
        }
      }
    }
    return edits.filter((e) => !(e.op === "add" && gone.has(e.id)));
  }
  const step = findStep(base.steps, stepId);
  if (!step) return [...edits];
  // Edits to the step or anything inside it no longer matter.
  const inside = new Set(allSteps([step]).map((s) => s.id));
  const kept = edits.filter((e) => !(e.op === "set" && [...inside].some((id) => e.path === fieldPath.step(id))) && !(e.op === "delete" && inside.has(e.step)));
  return [...kept, { op: "delete", step: stepId }];
}

/** Undo the person's change to a field or step: its `set`, its `add` (with what hangs off it), or its `delete`. */
export function revert(base: SiftUnit, edits: readonly DescriptionEdit[], target: { path: string } | { stepId: string }): DescriptionEdit[] {
  if ("path" in target) return edits.filter((e) => !(e.op === "set" && e.path === target.path));
  if (edits.some((e) => e.op === "add" && e.id === target.stepId)) return removeStep(base, edits, target.stepId);
  return edits.filter((e) => !(e.op === "delete" && e.step === target.stepId));
}

/** What the draft changed, for marking it: paths set, steps added, base steps deleted. */
export function changes(base: SiftUnit, edits: readonly DescriptionEdit[]): { set: Set<string>; added: Set<string>; deleted: SiftStep[] } {
  const set = new Set<string>();
  const added = new Set<string>();
  const deleted: SiftStep[] = [];
  for (const e of edits) {
    if (e.op === "set") set.add(e.path);
    else if (e.op === "add") added.add(e.id);
    else {
      const s = findStep(base.steps, e.step);
      if (s) deleted.push(s);
    }
  }
  return { set, added, deleted };
}

/** Whether a draft asks for anything. */
export function asksForSomething(edits: readonly DescriptionEdit[], request: string): boolean {
  return edits.length > 0 || request.trim() !== "";
}

/** A step ID (`s_` and 4 base32 characters) unused in the base and the draft. */
export function newStepId(base: SiftUnit, edits: readonly DescriptionEdit[]): string {
  const taken = new Set(allSteps(base.steps).map((s) => s.id));
  for (const e of edits) if (e.op === "add") taken.add(e.id);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = `s_${[...bytes].map((b) => alphabet[b % 32]).join("")}`;
    if (!taken.has(id)) return id;
  }
}

export function findStep(steps: readonly SiftStep[], id: string): SiftStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = findStep(s.steps, id);
    if (inner) return inner;
  }
  return undefined;
}

export function allSteps(steps: readonly SiftStep[]): SiftStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.steps)]);
}

/** What the host is doing, in words. */
export function activityLabel(activity: EditActivity): string {
  switch (activity) {
    case "starting":
      return "Starting…";
    case "planning":
      return "Planning the change…";
    case "coding":
      return "Writing the code…";
    case "fixing":
      return "Fixing the errors the type-check found…";
    case "validating":
      return "Checking the code…";
    case "describing":
      return "Describing the new code…";
    case "verifying":
      return "Comparing it with what you asked…";
    case "checks":
      return "Running the configured checks…";
    case "applying":
      return "Applying…";
    case "undoing":
      return "Undoing…";
  }
}

/** The request in one line, for lists. */
export function requestTitle(req: ChangeRequest): string {
  if (req.plan?.interpretation) return req.plan.interpretation;
  if (req.request) return req.request;
  const n = req.edits.length;
  return `${n} edit${n === 1 ? "" : "s"} to the description`;
}

// ── Word-level diff (phase-2-design §8.8: the logic diff is shown inline, word by word) ────

export interface DiffPart {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Words that differ between two texts, as parts in reading order (removed before added). */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  // Longest common subsequence over tokens; the texts are sentences, so the table stays small.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      // On a tie, removed words come first, so a change reads old → new.
      push("removed", a[i]!);
      i++;
    } else {
      push("added", b[j]!);
      j++;
    }
  }
  return parts;
}

/** Words with the space after them, so joining the tokens gives the text back. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}
