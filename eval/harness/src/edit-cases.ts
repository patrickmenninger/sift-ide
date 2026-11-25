import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { flatten, newId, parentKey, SiftError, type DescriptionEdit, type ExtractedUnit, type SiftStep, type SiftUnit } from "@sift/core";

/** What a change request must lead to (phase-2-design §9). */
export interface EditExpectation {
  kind?: "behavior" | "reword";
  /** true: accepted as a rewording with no code change; false: never accepted as one. */
  reword?: boolean;
  /** Exactly the units whose code changes, as "file#Symbol". */
  changedUnits?: string[];
  broader?: boolean;
  effectsAdded: string[];
  effectsRemoved: string[];
  /** Topics of questions that must be asked (matched by the judge). */
  asks: string[];
  /** Questions are neither expected nor counted as unneeded. */
  questionsOk: boolean;
  /** What the change must do (judged). */
  mustMention: string[];
}

/** One scripted change request. Steps are named by a piece of the code they cover. */
export interface EditCase {
  id: string;
  /** "file#Symbol" */
  unit: string;
  request?: string;
  set: { step: string; text: string }[];
  summary?: string;
  returns?: string;
  inputs: Record<string, string>;
  add: { after?: string; inside?: string; first?: boolean; text: string }[];
  delete: string[];
  /** What the person answers to any question. */
  answers: string[];
  expect: EditExpectation;
}

export async function loadEditCases(evalDir: string, fixture: string): Promise<EditCase[]> {
  const path = join(evalDir, "edits", `${fixture}.yaml`);
  if (!existsSync(path)) throw new SiftError("SOURCE_NOT_FOUND", `${path} does not exist.`);
  return parseEditCases(parse(await readFile(path, "utf8")) as unknown, path);
}

export function parseEditCases(raw: unknown, path: string): EditCase[] {
  if (!isRecord(raw) || !Array.isArray(raw.cases)) throw invalid(path, ['expected a "cases" list']);
  const problems: string[] = [];
  const ids = new Set<string>();
  const cases = raw.cases.map((c: unknown, i: number): EditCase => {
    const at = `cases[${i}]`;
    const empty: EditCase = { id: "", unit: "", set: [], inputs: {}, add: [], delete: [], answers: [], expect: emptyExpectation() };
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.unit !== "string" || !c.unit.includes("#")) {
      problems.push(`${at} must have an "id" and a "unit" ("file#Symbol")`);
      return empty;
    }
    const where = `${at} (${c.id})`;
    if (ids.has(c.id)) problems.push(`${where}: duplicate id`);
    ids.add(c.id);
    for (const key of Object.keys(c)) {
      if (!["id", "unit", "request", "set", "summary", "returns", "inputs", "add", "delete", "answers", "expect"].includes(key)) problems.push(`${where}: unknown field "${key}"`);
    }
    const file = c.unit.slice(0, c.unit.indexOf("#"));
    const str = (v: unknown, name: string): string | undefined => {
      if (v === undefined) return undefined;
      if (typeof v === "string" && v.trim() !== "") return v;
      problems.push(`${where}.${name} must be a non-empty string`);
      return undefined;
    };
    const strings = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
      problems.push(`${where}.${name} must be a list of strings`);
      return [];
    };
    const list = (v: unknown, name: string): Record<string, unknown>[] => {
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every(isRecord)) return v;
      problems.push(`${where}.${name} must be a list of mappings`);
      return [];
    };
    const out: EditCase = { ...empty, id: c.id, unit: c.unit, answers: strings(c.answers, "answers"), delete: strings(c.delete, "delete") };
    const request = str(c.request, "request");
    if (request) out.request = request;
    const summary = str(c.summary, "summary");
    if (summary) out.summary = summary;
    const returns = str(c.returns, "returns");
    if (returns) out.returns = returns;
    out.set = list(c.set, "set").map((s, j) => {
      if (typeof s.step !== "string" || typeof s.text !== "string") problems.push(`${where}.set[${j}] must have "step" (code) and "text"`);
      return { step: String(s.step), text: String(s.text) };
    });
    out.add = list(c.add, "add").map((s, j) => {
      const anchors = [s.after, s.inside, s.first].filter((v) => v !== undefined).length;
      if (typeof s.text !== "string" || anchors !== 1 || (s.first !== undefined && s.first !== true)) {
        problems.push(`${where}.add[${j}] must have "text" and one of "after" (code), "inside" (code), or "first: true"`);
      }
      const a: EditCase["add"][number] = { text: String(s.text) };
      if (typeof s.after === "string") a.after = s.after;
      if (typeof s.inside === "string") a.inside = s.inside;
      if (s.first === true) a.first = true;
      return a;
    });
    if (c.inputs !== undefined) {
      if (isRecord(c.inputs) && Object.values(c.inputs).every((v) => typeof v === "string")) out.inputs = c.inputs as Record<string, string>;
      else problems.push(`${where}.inputs must map input names to text`);
    }
    if (!out.request && out.set.length + out.add.length + out.delete.length + Object.keys(out.inputs).length === 0 && !out.summary && !out.returns) {
      problems.push(`${where}: asks for nothing (give a request or an edit)`);
    }
    out.expect = parseExpectation(c.expect, where, file, problems);
    return out;
  });
  if (problems.length > 0) throw invalid(path, problems);
  return cases;
}

function emptyExpectation(): EditExpectation {
  return { effectsAdded: [], effectsRemoved: [], asks: [], questionsOk: false, mustMention: [] };
}

function parseExpectation(raw: unknown, where: string, file: string, problems: string[]): EditExpectation {
  const e = emptyExpectation();
  if (!isRecord(raw)) {
    problems.push(`${where}.expect must be a mapping`);
    return e;
  }
  for (const key of Object.keys(raw)) {
    if (!["kind", "reword", "changedUnits", "broader", "effectsAdded", "effectsRemoved", "asks", "questionsOk", "mustMention"].includes(key)) problems.push(`${where}.expect: unknown field "${key}"`);
  }
  const strings = (key: string): string[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
    problems.push(`${where}.expect.${key} must be a list of strings`);
    return [];
  };
  const bool = (key: string): boolean | undefined => {
    const v = raw[key];
    if (v === undefined || typeof v === "boolean") return v;
    problems.push(`${where}.expect.${key} must be true or false`);
    return undefined;
  };
  if (raw.kind !== undefined) {
    if (raw.kind === "behavior" || raw.kind === "reword") e.kind = raw.kind;
    else problems.push(`${where}.expect.kind must be behavior or reword`);
  }
  const reword = bool("reword");
  if (reword !== undefined) e.reword = reword;
  const broader = bool("broader");
  if (broader !== undefined) e.broader = broader;
  if (raw.changedUnits !== undefined) e.changedUnits = strings("changedUnits").map((u) => (u.includes("#") ? u : `${file}#${u}`));
  e.effectsAdded = strings("effectsAdded");
  e.effectsRemoved = strings("effectsRemoved");
  e.asks = strings("asks");
  e.mustMention = strings("mustMention");
  e.questionsOk = bool("questionsOk") ?? false;
  return e;
}

/**
 * The person's edits for a case, against the unit's current description: each step is the one that
 * covers the innermost statement whose code contains the given text.
 */
export function caseEdits(c: EditCase, description: SiftUnit, code: ExtractedUnit): DescriptionEdit[] {
  const edits: DescriptionEdit[] = [];
  for (const s of c.set) {
    const step = stepFor(description, code, s.step);
    edits.push({ op: "set", path: `steps[${step.id}].text`, before: step.text, after: s.text });
  }
  if (c.summary) edits.push({ op: "set", path: "summary", before: description.summary, after: c.summary });
  if (c.returns) {
    if (!description.returns) throw new SiftError("CONFIG_INVALID", `${c.id}: ${c.unit} has no returns meaning to change.`);
    edits.push({ op: "set", path: "returns.meaning", before: description.returns.meaning, after: c.returns });
  }
  for (const [name, text] of Object.entries(c.inputs)) {
    const input = description.inputs.find((i) => i.name === name);
    if (!input) throw new SiftError("CONFIG_INVALID", `${c.id}: ${c.unit} has no input "${name}".`);
    edits.push({ op: "set", path: `inputs[${name}].meaning`, before: input.meaning, after: text });
  }
  const taken = new Set(allSteps(description.steps).map((s) => s.step.id));
  for (const a of c.add) {
    const id = newId("step", taken);
    taken.add(id);
    const edit: DescriptionEdit = { op: "add", id, text: a.text };
    if (a.after) edit.after = stepFor(description, code, a.after).id;
    if (a.inside) edit.parent = stepFor(description, code, a.inside).id;
    edits.push(edit);
  }
  for (const d of c.delete) edits.push({ op: "delete", step: stepFor(description, code, d).id });
  return edits;
}

function allSteps(steps: SiftStep[], depth = 0): { step: SiftStep; depth: number }[] {
  return steps.flatMap((s) => [{ step: s, depth }, ...allSteps(s.steps, depth + 1)]);
}

/** The step covering the innermost statement whose code contains `snippet` (or the nearest enclosing one a step covers). */
export function stepFor(description: SiftUnit, code: ExtractedUnit, snippet: string): SiftStep {
  const nodes = flatten(code.body).filter((n) => n.text.includes(snippet));
  if (nodes.length === 0) throw new SiftError("CONFIG_INVALID", `No statement in ${code.symbol} contains "${snippet}".`);
  const node = nodes.reduce((a, b) => (b.text.length < a.text.length ? b : a));
  const steps = allSteps(description.steps);
  for (let k: string | null = node.key; k !== null; k = parentKey(k)) {
    const owners = steps.filter((s) => s.step.covers.includes(k!));
    if (owners.length > 0) return owners.reduce((a, b) => (b.depth > a.depth ? b : a)).step;
  }
  throw new SiftError("CONFIG_INVALID", `No step of ${code.symbol} covers "${snippet}" (key ${node.key}).`);
}

function invalid(path: string, problems: string[]): SiftError {
  return new SiftError("CONFIG_INVALID", `${path} is not valid:`, problems);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
