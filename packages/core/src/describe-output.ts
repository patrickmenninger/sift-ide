import { createHash } from "node:crypto";
import type { CallSite, ExtractedUnit, StructureNode } from "./adapter.js";
import { flatten } from "./describe-input.js";
import { sortEffects } from "./effects.js";
import { newId } from "./ids.js";
import { STEP_KINDS, type Effect, type GeneratedBy, type SiftStep, type SiftUnit, type SiftWarning, type StepKind } from "./schema.js";

/** What the model returns for `describe` (design §7.4). */
export interface DescribeResponse {
  summary: string;
  inputs: { name: string; meaning: string }[];
  returns: { meaning: string } | null;
  steps: ResponseStep[];
  warnings: { kind: string; text: string; covers: string[] }[];
}

export interface ResponseStep {
  /** Update responses only: the ID of the previous step this one keeps, or absent for a new step. */
  id?: string;
  kind: StepKind | null;
  text: string;
  covers: string[];
  steps: ResponseStep[];
}

const STEP_SCHEMA = {
  type: "object",
  properties: {
    kind: { enum: [...STEP_KINDS, null] },
    text: { type: "string" },
    covers: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
  },
  required: ["kind", "text", "covers", "steps"],
  additionalProperties: false,
};

const COMMON = {
  summary: { type: "string" },
  inputs: {
    type: "array",
    items: { type: "object", properties: { name: { type: "string" }, meaning: { type: "string" } }, required: ["name", "meaning"], additionalProperties: false },
  },
  returns: {
    anyOf: [{ type: "object", properties: { meaning: { type: "string" } }, required: ["meaning"], additionalProperties: false }, { type: "null" }],
  },
};

export const DESCRIBE_SCHEMA = {
  type: "object",
  $defs: { step: STEP_SCHEMA },
  properties: {
    ...COMMON,
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string" }, text: { type: "string" }, covers: { type: "array", items: { type: "string" } } },
        required: ["kind", "text", "covers"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "inputs", "returns", "steps", "warnings"],
  additionalProperties: false,
} as const;

export const DESCRIBE_LITE_SCHEMA = {
  type: "object",
  properties: {
    ...COMMON,
    warnings: {
      type: "array",
      items: { type: "object", properties: { kind: { type: "string" }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false },
    },
  },
  required: ["summary", "inputs", "returns", "warnings"],
  additionalProperties: false,
} as const;

/** The update prompt's output (design §7.4): the describe output, with each step's previous `id` or null. */
export const UPDATE_SCHEMA = {
  ...DESCRIBE_SCHEMA,
  $defs: {
    step: {
      ...STEP_SCHEMA,
      properties: { id: { type: ["string", "null"] }, ...STEP_SCHEMA.properties },
      required: ["id", ...STEP_SCHEMA.required],
    },
  },
} as const;

/** The context-check output (design §7.3): only the wording that has to change. */
export interface ContextCheckResponse {
  summary: string | null;
  steps: { id: string; text: string }[];
}

export const CONTEXT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: ["string", "null"] },
    steps: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
    },
  },
  required: ["summary", "steps"],
  additionalProperties: false,
} as const;

/** Check a context-check response against the unit's step IDs. */
export function validateContextCheckResponse(json: unknown, stepIds: ReadonlySet<string>): { response: ContextCheckResponse | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(json)) return { response: null, problems: ["The response must be a single JSON object."] };
  for (const key of Object.keys(json)) if (key !== "summary" && key !== "steps") problems.push(`Unexpected field "${key}"; allowed fields are summary, steps.`);
  let summary: string | null = null;
  if (json.summary !== null && json.summary !== undefined) summary = text(json.summary, "summary", problems);
  const seen = new Set<string>();
  const steps = list(json.steps ?? [], "steps", problems).map((v, i) => {
    const r = isRecord(v) ? v : {};
    const id = typeof r.id === "string" ? r.id : "";
    if (!stepIds.has(id)) problems.push(`steps[${i}].id "${id}" is not a step of this unit.`);
    else if (seen.has(id)) problems.push(`steps[${i}].id "${id}" is listed twice.`);
    seen.add(id);
    return { id, text: text(r.text, `steps[${i}].text`, problems) };
  });
  return problems.length > 0 ? { response: null, problems } : { response: { summary, steps }, problems };
}

export interface ValidationResult {
  /** Parsed and normalized response, when its shape is usable. */
  response: DescribeResponse | null;
  /** Problems, phrased so they can be sent back to the model in the retry. */
  problems: string[];
  /** Structure keys no step covers. Coverage is the one problem a unit may still be written with (as stale). */
  uncovered: string[];
}

/**
 * Check a describe or describe-lite response against the unit (design §8): shape, input names,
 * returns, valid keys, coverage, and that control-flow steps cover control flow.
 */
export function validateDescribeResponse(
  json: unknown,
  unit: ExtractedUnit,
  lite: boolean,
  /** For update responses: the previous description's step IDs, which steps may keep. */
  previousStepIds?: ReadonlySet<string>,
): ValidationResult {
  const problems: string[] = [];
  const response = parseShape(json, lite, problems, previousStepIds !== undefined);
  if (!response) return { response: null, problems, uncovered: [] };
  if (previousStepIds) {
    const seen = new Set<string>();
    const check = (steps: ResponseStep[], path: string) =>
      steps.forEach((s, i) => {
        const at = `${path}[${i}]`;
        if (s.id !== undefined) {
          if (!previousStepIds.has(s.id)) problems.push(`${at}.id "${s.id}" is not a step of the previous description; use null for a new step.`);
          else if (seen.has(s.id)) problems.push(`${at}.id "${s.id}" is used twice; a previous step can be kept only once.`);
          seen.add(s.id);
        }
        check(s.steps, `${at}.steps`);
      });
    check(response.steps, "steps");
  }

  response.inputs = foldDestructured(unit.inputs.map((i) => i.name), response.inputs);
  const expected = unit.inputs.map((i) => normalizeName(i.name));
  const got = response.inputs.map((i) => normalizeName(i.name));
  if (expected.join(",") !== got.join(",")) {
    problems.push(`"inputs" must list exactly these parameters, in order: [${expected.join(", ")}]; got [${got.join(", ")}].`);
  }
  if (unit.returns && unit.returns.type !== "void" && unit.returns.type !== "Promise<void>" && response.returns === null) {
    problems.push(`"returns" must describe the returned ${unit.returns.type}.`);
  }
  if (lite) return { response, problems, uncovered: [] };

  const nodes = flatten(unit.body);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const coveredKeys = new Set<string>();
  const walk = (steps: ResponseStep[], path: string) => {
    steps.forEach((s, i) => {
      const at = `${path}[${i}]`;
      if (s.covers.length === 0) problems.push(`${at} covers no keys; every step must cover at least one key.`);
      for (const key of s.covers) {
        if (!byKey.has(key)) problems.push(`${at} covers "${key}", which is not a structure key of this unit.`);
        else coveredKeys.add(key);
      }
      if (s.kind !== null && !s.covers.some((k) => byKey.get(k)?.kind === s.kind)) {
        problems.push(`${at} has kind "${s.kind}" but covers no "${s.kind}" key; use kind null or cover the ${s.kind} key.`);
      }
      walk(s.steps, `${at}.steps`);
    });
  };
  walk(response.steps, "steps");
  response.warnings.forEach((w, i) => {
    for (const key of w.covers) if (!byKey.has(key)) problems.push(`warnings[${i}] covers "${key}", which is not a structure key of this unit.`);
  });

  // Only the outermost uncovered keys are reported: covering a key covers what is nested in it.
  const missing = new Set(nodes.filter((n) => !isCovered(n.key, coveredKeys)).map((n) => n.key));
  const uncovered = [...missing].filter((k) => ![...missing].some((m) => m !== k && k.startsWith(`${m}.`)));
  if (uncovered.length > 0) problems.push(`These structure keys are not covered by any step: ${uncovered.join(", ")}.`);
  return { response, problems, uncovered };
}

/**
 * Models often describe a destructured parameter (`{ account, highlight }`, typical for React props)
 * as one input per name. That is a fair reading, so instead of spending a retry on it, consecutive
 * inputs that name exactly the pattern's elements, in order, are folded into the one parameter.
 */
export function foldDestructured(params: string[], inputs: { name: string; meaning: string }[]): { name: string; meaning: string }[] {
  const out: { name: string; meaning: string }[] = [];
  let at = 0;
  for (const param of params) {
    const elements = patternElements(param);
    const next = inputs.slice(at, at + (elements?.length ?? 0));
    if (elements && elements.length > 1 && next.length === elements.length && next.every((i, k) => normalizeName(i.name) === elements[k])) {
      out.push({ name: param, meaning: next.map((i, k) => `\`${elements[k]}\`: ${i.meaning}`).join(" ") });
      at += elements.length;
    } else if (at < inputs.length) {
      out.push(inputs[at++]!);
    }
  }
  return [...out, ...inputs.slice(at)];
}

/** The names bound by a simple object or array pattern (`{ a, b: c, d = 1, ...e }` → a, b, d, e), or null. */
function patternElements(param: string): string[] | null {
  const m = /^\s*[{[]([\s\S]*)[}\]]\s*$/.exec(param);
  if (!m) return null;
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]!) {
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) (parts.push(cur), (cur = ""));
    else cur += ch;
  }
  parts.push(cur);
  const names = parts.map((p) => p.trim()).filter((p) => p !== "").map((p) => /^(?:\.\.\.)?\s*([\w$]+)/.exec(p)?.[1] ?? "");
  return names.every((n) => n !== "") ? names : null;
}

/** Parameter names compare without whitespace differences (destructuring patterns such as `{ a, b }`). */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, "").replace(/^`|`$/g, "");
}

/** A key is covered if it, or a key it is nested in, is in a step's `covers`. */
function isCovered(key: string, covered: Set<string>): boolean {
  for (let k: string | null = key; k !== null; k = parentKey(k)) if (covered.has(k)) return true;
  return false;
}

/** "1.then.0" → "1.then" → "1" → null. */
export function parentKey(key: string): string | null {
  const dot = key.lastIndexOf(".");
  return dot < 0 ? null : key.slice(0, dot);
}

function parseShape(json: unknown, lite: boolean, problems: string[], withIds = false): DescribeResponse | null {
  if (!isRecord(json)) {
    problems.push("The response must be a single JSON object.");
    return null;
  }
  const allowed = lite ? ["summary", "inputs", "returns", "warnings"] : ["summary", "inputs", "returns", "steps", "warnings"];
  for (const key of Object.keys(json)) if (!allowed.includes(key)) problems.push(`Unexpected field "${key}"; allowed fields are ${allowed.join(", ")}.`);
  const before = problems.length;

  const summary = text(json.summary, "summary", problems);
  const inputs = list(json.inputs, "inputs", problems).map((v, i) => {
    const r = isRecord(v) ? v : {};
    if (!isRecord(v)) problems.push(`inputs[${i}] must be an object with "name" and "meaning".`);
    return { name: text(r.name, `inputs[${i}].name`, problems), meaning: text(r.meaning, `inputs[${i}].meaning`, problems) };
  });
  let returns: { meaning: string } | null = null;
  if (json.returns !== null && json.returns !== undefined) {
    if (isRecord(json.returns)) returns = { meaning: text(json.returns.meaning, "returns.meaning", problems) };
    else problems.push('"returns" must be an object with "meaning", or null.');
  }
  const steps = lite ? [] : list(json.steps, "steps", problems).map((s, i) => parseStep(s, `steps[${i}]`, problems, withIds));
  const warnings = list(json.warnings, "warnings", problems).map((v, i) => {
    const r = isRecord(v) ? v : {};
    if (!isRecord(v)) problems.push(`warnings[${i}] must be an object.`);
    const kind = text(r.kind, `warnings[${i}].kind`, problems);
    if (kind && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kind)) problems.push(`warnings[${i}].kind must be kebab-case, such as "missing-check".`);
    const covers = lite ? [] : stringList(r.covers, `warnings[${i}].covers`, problems);
    return { kind, text: text(r.text, `warnings[${i}].text`, problems), covers };
  });
  return problems.length > before ? null : { summary, inputs, returns, steps, warnings };
}

function parseStep(value: unknown, at: string, problems: string[], withIds: boolean): ResponseStep {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object with "kind", "text", "covers", and "steps".`);
    return { kind: null, text: "", covers: [], steps: [] };
  }
  let kind: StepKind | null = null;
  if (value.kind !== null && value.kind !== undefined) {
    if ((STEP_KINDS as readonly unknown[]).includes(value.kind)) kind = value.kind as StepKind;
    else problems.push(`${at}.kind must be null or one of ${STEP_KINDS.join(", ")}.`);
  }
  const step: ResponseStep = {
    kind,
    text: text(value.text, `${at}.text`, problems),
    covers: stringList(value.covers, `${at}.covers`, problems),
    steps: list(value.steps ?? [], `${at}.steps`, problems).map((s, i) => parseStep(s, `${at}.steps[${i}]`, problems, withIds)),
  };
  if (withIds && value.id !== null && value.id !== undefined) {
    if (typeof value.id === "string") step.id = value.id;
    else problems.push(`${at}.id must be a previous step ID or null.`);
  }
  return step;
}

function text(value: unknown, at: string, problems: string[]): string {
  if (typeof value === "string" && value.trim() !== "") return value.replace(/\s+/g, " ").trim();
  problems.push(`${at} must be a non-empty string.`);
  return "";
}

function list(value: unknown, at: string, problems: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  problems.push(`${at} must be a list.`);
  return [];
}

function stringList(value: unknown, at: string, problems: string[]): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  problems.push(`${at} must be a list of structure keys (strings).`);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Deriving the .sift unit (design §7.1 step 9)

export interface DeriveOptions {
  unit: ExtractedUnit;
  response: DescribeResponse;
  id: string;
  lite: boolean;
  /** Keys not covered after the retry; the unit is written as stale. */
  uncovered: string[];
  /** Direct effects of each node, from the rule packs. */
  nodeEffects: Map<string, Effect[]>;
  /** `.sift` call references for a call site: a unit ID, implementation IDs, or "ext:module#name". */
  callRefs(call: CallSite): string[];
  /** Effects a call brings in from the project unit(s) it calls (one level, design §9). */
  calleeEffects(call: CallSite): Effect[];
  generatedBy: GeneratedBy;
  contextHash?: string;
  /** The previous description's warnings, whose IDs are kept when kind and text are unchanged. */
  previousWarnings?: SiftWarning[];
}

type FactSources = Pick<DeriveOptions, "nodeEffects" | "callRefs" | "calleeEffects">;

/**
 * Fill each step's `calls` and `effects` from the code it owns, and return the unit's effects. Each
 * structure node belongs to the deepest step covering it or its nearest covered ancestor.
 */
function fillFacts(steps: SiftStep[], unit: ExtractedUnit, o: FactSources): { effects: Effect[]; ownerOf: (key: string) => SiftStep | undefined } {
  const owner = new Map<string, SiftStep>();
  const index = (list: SiftStep[]): void =>
    list.forEach((s) => {
      for (const key of s.covers) owner.set(key, s); // nested steps are indexed after, so deeper steps win
      index(s.steps);
    });
  index(steps);
  const ownerOf = (key: string): SiftStep | undefined => {
    for (let k: string | null = key; k !== null; k = parentKey(k)) {
      const s = owner.get(k);
      if (s) return s;
    }
    return undefined;
  };

  const clear = (list: SiftStep[]): void => list.forEach((s) => ((s.calls = []), (s.effects = []), clear(s.steps)));
  clear(steps);
  const unitEffects = new Set<Effect>();
  const stepEffects = new Map<SiftStep, Set<Effect>>();
  const visit = (node: StructureNode) => {
    const effects = new Set<Effect>(o.nodeEffects.get(node.key) ?? []);
    const refs: string[] = [];
    for (const call of node.calls) {
      refs.push(...o.callRefs(call));
      for (const e of o.calleeEffects(call)) effects.add(e);
    }
    for (const e of effects) unitEffects.add(e);
    const step = ownerOf(node.key);
    if (step) {
      for (const r of refs) if (!step.calls.includes(r)) step.calls.push(r);
      const set = stepEffects.get(step) ?? new Set<Effect>();
      for (const e of effects) set.add(e);
      stepEffects.set(step, set);
    }
    node.children.forEach(visit);
  };
  unit.body.forEach(visit);
  for (const [step, set] of stepEffects) step.effects = sortEffects(set);
  return { effects: sortEffects(unitEffects), ownerOf };
}

/**
 * Recompute the facts of a unit whose code has not changed (design §6.2): calls and effects come
 * from the code, so they follow renamed callees, changed rule packs, and callees' new effects
 * without asking the AI. Prose, IDs, and status are kept. Returns a new unit; the input is not changed.
 */
export function rederiveFacts(previous: SiftUnit, unit: ExtractedUnit, o: FactSources): SiftUnit {
  const copy: SiftUnit = structuredClone(previous);
  const { effects } = fillFacts(copy.steps, unit, o);
  copy.effects = effects;
  copy.symbol = unit.symbol;
  copy.kind = unit.kind;
  copy.bodyHash = unit.bodyHash;
  copy.inputs = unit.inputs.map((i, k) => {
    const meaning = previous.inputs.find((p) => normalizeName(p.name) === normalizeName(i.name))?.meaning ?? previous.inputs[k]?.meaning ?? "";
    return { name: i.name, type: i.type, ...(i.typeInferred ? { typeInferred: true } : {}), meaning };
  });
  if (unit.returns && previous.returns) {
    copy.returns = { type: unit.returns.type, ...(unit.returns.typeInferred ? { typeInferred: true } : {}), meaning: previous.returns.meaning };
  } else delete copy.returns;
  return copy;
}

/**
 * Build the `.sift` unit: prose from the model, everything else from the code. Each structure node
 * belongs to the deepest step covering it or its nearest covered ancestor; a step's `calls` and
 * `effects` come from the nodes it owns, never from the model.
 */
export function deriveSiftUnit(o: DeriveOptions): SiftUnit {
  // Kept step IDs (update responses) are reserved first, so new IDs never collide with them.
  const stepIds = new Set<string>();
  const reserve = (steps: ResponseStep[]): void => steps.forEach((s) => (s.id && stepIds.add(s.id), reserve(s.steps)));
  reserve(o.response.steps);
  const build = (steps: ResponseStep[]): SiftStep[] =>
    steps.map((s) => {
      const id = s.id ?? newId("step", stepIds);
      stepIds.add(id);
      const step: SiftStep = { id, text: s.text, covers: s.covers, calls: [], effects: [], steps: [] };
      if (s.kind) step.kind = s.kind;
      step.steps = build(s.steps);
      return step;
    });
  const steps = o.lite ? [] : build(o.response.steps);
  const { effects, ownerOf } = fillFacts(steps, o.unit, o);

  // A warning with the same kind and text as a previous one keeps its ID.
  const previous = new Map((o.previousWarnings ?? []).map((w) => [`${w.kind}\n${w.text}`, w.id]));
  const warningIds = new Set<string>(previous.values());
  const warnings: SiftWarning[] = o.response.warnings.map((w) => {
    const kept = previous.get(`${w.kind}\n${w.text}`);
    if (kept) previous.delete(`${w.kind}\n${w.text}`);
    const id = kept ?? newId("warning", warningIds);
    warningIds.add(id);
    const refs: string[] = [];
    for (const key of w.covers) {
      const s = ownerOf(key);
      if (s && !refs.includes(s.id)) refs.push(s.id);
    }
    return { id, kind: w.kind, text: w.text, steps: refs };
  });

  const meaning = new Map(o.response.inputs.map((i) => [normalizeName(i.name), i.meaning]));
  const unit: SiftUnit = {
    id: o.id,
    symbol: o.unit.symbol,
    kind: o.unit.kind,
    status: o.uncovered.length > 0 ? "stale" : "generated",
    bodyHash: o.unit.bodyHash,
    generatedBy: o.generatedBy,
    summary: o.response.summary,
    inputs: o.unit.inputs.map((i) => ({ name: i.name, type: i.type, ...(i.typeInferred ? { typeInferred: true } : {}), meaning: meaning.get(normalizeName(i.name)) ?? "" })),
    effects,
    steps,
    warnings,
    tests: [],
  };
  if (o.lite) unit.lite = true;
  if (o.contextHash) unit.contextHash = o.contextHash;
  if (o.unit.returns && o.response.returns) {
    unit.returns = { type: o.unit.returns.type, ...(o.unit.returns.typeInferred ? { typeInferred: true } : {}), meaning: o.response.returns.meaning };
  }
  return unit;
}

/** Hash of the callees' summaries (design §5): when one changes, callers are re-checked (§7.3). */
export function contextHashOf(callees: { id: string; summary: string }[]): string | undefined {
  if (callees.length === 0) return undefined;
  const text = [...new Map(callees.map((c) => [c.id, c.summary]))].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => `${id}\n${s}`).join("\n\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
