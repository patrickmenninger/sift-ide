import type { DescriptionEdit, InsertionPoint, LogicChange } from "./edit-text.js";
import { findStep } from "./edit-text.js";
import { personWordingNote } from "./provenance.js";
import { redactSecrets } from "./redact.js";
import type { SiftStep, SiftUnit } from "./schema.js";

/**
 * The user-prompt halves and response checks of the three editing tasks (phase-2-design §8.4–8.7).
 * The instructions and examples are the system prompts in prompts/edit-*.md.
 */

// ------------------------------------------------------------------ shared rendering

export interface UnitContext {
  /** "file#Symbol" */
  ref: string;
  kind: string;
  signature: string;
  /** The unit's code (with structure-key markers for the edited unit). */
  code: string;
}

export interface Neighbour {
  ref: string;
  summary?: string;
  signature?: string;
  effects?: string[];
  /** For a call: the expression in the code. */
  via?: string;
}

/** The change a person asked for: their edits to the description, their request, and their answers. */
export function renderRequest(edits: DescriptionEdit[], request: string | undefined, answers: { question: string; answer: string }[], base: SiftUnit): string[] {
  const lines: string[] = [];
  if (edits.length > 0) {
    lines.push("Edits the person made to the description:");
    for (const e of edits) {
      if (e.op === "set") lines.push(`- ${describePath(e.path, base)} changed from "${e.before}" to "${e.after}"`);
      else if (e.op === "add") {
        const where = e.after ? `after step ${e.after}` : e.parent ? `as the first step inside step ${e.parent}` : "as the first step";
        lines.push(`- New step ${e.id} ${where}${e.kind ? ` (${e.kind})` : ""}: "${e.text}"`);
      } else {
        const step = findStep(base.steps, e.step)?.step;
        lines.push(`- Step ${e.step} deleted: "${step?.text ?? "?"}"${step ? ` (it covered ${step.covers.join(", ")})` : ""}`);
      }
    }
  }
  if (request) lines.push(...(lines.length > 0 ? [""] : []), "Request:", request);
  if (answers.length > 0) {
    lines.push("", "Answers the person gave to earlier questions (each must be followed):");
    for (const a of answers) lines.push(`- Q: ${a.question}`, `  A: ${a.answer}`);
  }
  return lines;
}

function describePath(path: string, unit: SiftUnit): string {
  const step = /^steps\[(.+)\]\.text$/.exec(path);
  if (step) {
    const s = findStep(unit.steps, step[1]!)?.step;
    return `Step ${step[1]}${s && s.covers.length > 0 ? ` (covers ${s.covers.join(", ")})` : ""}`;
  }
  const input = /^inputs\[(.+)\]\.meaning$/.exec(path);
  if (input) return `The meaning of input \`${input[1]}\``;
  return path === "summary" ? "The summary" : "The returns meaning";
}

/** A description in the shape the prompts show it: IDs, text, and covered keys. */
export function descriptionJson(unit: SiftUnit): string {
  const step = (s: SiftStep): object => ({ id: s.id, ...(s.kind ? { kind: s.kind } : {}), text: s.text, covers: s.covers, ...(s.steps.length > 0 ? { steps: s.steps.map(step) } : {}) });
  return JSON.stringify(
    {
      summary: unit.summary,
      inputs: unit.inputs.map((i) => ({ name: i.name, meaning: i.meaning })),
      returns: unit.returns?.meaning ?? null,
      ...(unit.lite ? {} : { steps: unit.steps.map(step) }),
      effects: unit.effects,
      warnings: unit.warnings.filter((w) => !w.resolved).map((w) => ({ kind: w.kind, text: w.text, steps: w.steps })),
    },
    null,
    1,
  );
}

function neighbourLines(title: string, list: Neighbour[]): string[] {
  const lines = [title];
  if (list.length === 0) lines.push("- (none)");
  for (const n of list) {
    lines.push(`- ${n.ref}${n.via ? ` (via \`${oneLine(n.via)}\`)` : ""}${n.effects && n.effects.length > 0 ? ` — effects: ${n.effects.join(", ")}` : ""}`);
    if (n.signature) lines.push(`  signature: ${oneLine(n.signature)}`);
    if (n.summary) lines.push(`  summary: ${n.summary}`);
  }
  return lines;
}

// ------------------------------------------------------------------ edit-plan

export interface PlanInput {
  file: string;
  unit: UnitContext;
  description: SiftUnit;
  edits: DescriptionEdit[];
  request?: string;
  answers: { question: string; answer: string }[];
  callees: Neighbour[];
  callers: Neighbour[];
  implementations: Neighbour[];
  types: string[];
  routes: string[];
  /** Units elsewhere in the project, by effect, that show how the project does things. */
  examples: { effect: string; units: Neighbour[] }[];
}

export function renderPlanInput(input: PlanInput): { prompt: string; redactions: number } {
  const code = redactSecrets(input.unit.code);
  const lines = [`File: ${input.file}`, `Unit: ${input.unit.ref} (${input.unit.kind})`, `Signature: ${oneLine(input.unit.signature)}`, "", "Code:", "```" + fence(input.file), code.text, "```"];
  lines.push("", "Current description (step `covers` are the structure keys in the code markers):", "```json", descriptionJson(input.description), "```");
  const note = personWordingNote(input.description);
  if (note) lines.push("", note);
  lines.push("", ...renderRequest(input.edits, input.request, input.answers, input.description));
  lines.push("", ...neighbourLines("Calls this unit makes:", input.callees));
  lines.push("", ...neighbourLines("Callers (up to two levels):", input.callers));
  if (input.implementations.length > 0) lines.push("", ...neighbourLines("Related implementations (the interface member this implements, and the other implementations):", input.implementations));
  lines.push("", `Project types in the signature or body: ${input.types.length > 0 ? input.types.join(", ") : "(none)"}`);
  lines.push(`Routes that reach this unit: ${input.routes.length > 0 ? input.routes.join(", ") : "(none)"}`);
  if (input.examples.length > 0) {
    lines.push("", "Units elsewhere in the project, by effect (to follow the project's conventions; name any you want to imitate in `examples`):");
    for (const e of input.examples) for (const u of e.units) lines.push(`- ${e.effect}: ${u.ref}${u.summary ? ` — ${u.summary}` : ""}`);
  }
  return { prompt: lines.join("\n"), redactions: code.count };
}

export type PlanKind = "behavior" | "reword" | "unclear";

export interface EditPlan {
  kind: PlanKind;
  interpretation: string;
  questions: { id: string; text: string; options: string[] }[];
  warnings: { kind: string; text: string }[];
  /** Units whose code may change: "file#Symbol". */
  allowedUnits: { unit: string; reason: string }[];
  /** New functions or methods the code may add, by file. */
  helpers: { file: string; name: string; reason: string }[];
  /** Units whose code shows how to do what is asked here. */
  examples: string[];
  broader: { reason: string; units: string[] } | null;
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    kind: { enum: ["behavior", "reword", "unclear"] },
    interpretation: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        required: ["id", "text", "options"],
        additionalProperties: false,
      },
    },
    warnings: {
      type: "array",
      items: { type: "object", properties: { kind: { type: "string" }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false },
    },
    allowedUnits: {
      type: "array",
      items: { type: "object", properties: { unit: { type: "string" }, reason: { type: "string" } }, required: ["unit", "reason"], additionalProperties: false },
    },
    helpers: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, name: { type: "string" }, reason: { type: "string" } },
        required: ["file", "name", "reason"],
        additionalProperties: false,
      },
    },
    examples: { type: "array", items: { type: "string" } },
    broader: {
      anyOf: [
        { type: "object", properties: { reason: { type: "string" }, units: { type: "array", items: { type: "string" } } }, required: ["reason", "units"], additionalProperties: false },
        { type: "null" },
      ],
    },
  },
  required: ["kind", "interpretation", "questions", "warnings", "allowedUnits", "helpers", "examples", "broader"],
  additionalProperties: false,
} as const;

/** At most this many questions in one round (phase-2-design §8.4). */
export const MAX_QUESTIONS = 3;

/**
 * Check a plan. `unitExists` says whether a `file#Symbol` is a unit in the project; `edited` is the
 * unit being edited.
 */
export function validatePlan(json: unknown, edited: string, unitExists: (ref: string) => boolean): { plan: EditPlan | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(json)) return { plan: null, problems: ["The response must be a single JSON object."] };
  const kind = json.kind;
  if (kind !== "behavior" && kind !== "reword" && kind !== "unclear") problems.push(`kind must be "behavior", "reword", or "unclear".`);
  const interpretation = str(json.interpretation, "interpretation", problems);
  const questions = list(json.questions, "questions", problems).map((q, i) => {
    const r = isRecord(q) ? q : {};
    return { id: str(r.id, `questions[${i}].id`, problems), text: str(r.text, `questions[${i}].text`, problems), options: list(r.options, `questions[${i}].options`, problems).filter((o): o is string => typeof o === "string") };
  });
  if (questions.length > MAX_QUESTIONS) problems.push(`Ask at most ${MAX_QUESTIONS} questions at a time; keep the ones that matter most.`);
  if (new Set(questions.map((q) => q.id)).size !== questions.length) problems.push("Question IDs must be unique.");
  const warnings = list(json.warnings, "warnings", problems).map((w, i) => {
    const r = isRecord(w) ? w : {};
    return { kind: str(r.kind, `warnings[${i}].kind`, problems), text: str(r.text, `warnings[${i}].text`, problems) };
  });
  const allowedUnits = list(json.allowedUnits, "allowedUnits", problems).map((u, i) => {
    const r = isRecord(u) ? u : {};
    const unit = str(r.unit, `allowedUnits[${i}].unit`, problems);
    if (unit && !unitExists(unit)) problems.push(`allowedUnits[${i}].unit "${unit}" is not a unit in the project; use the file#Symbol names given.`);
    return { unit, reason: str(r.reason, `allowedUnits[${i}].reason`, problems) };
  });
  const helpers = list(json.helpers, "helpers", problems).map((h, i) => {
    const r = isRecord(h) ? h : {};
    return { file: str(r.file, `helpers[${i}].file`, problems), name: str(r.name, `helpers[${i}].name`, problems), reason: str(r.reason, `helpers[${i}].reason`, problems) };
  });
  const allowedFiles = new Set(allowedUnits.map((u) => u.unit.slice(0, u.unit.indexOf("#"))));
  for (const [i, h] of helpers.entries()) if (h.file && !allowedFiles.has(h.file)) problems.push(`helpers[${i}].file must be the file of a unit in allowedUnits; new code goes only into files that change anyway.`);
  const examples = list(json.examples, "examples", problems).filter((e): e is string => typeof e === "string");
  for (const e of examples) if (!unitExists(e)) problems.push(`examples: "${e}" is not a unit in the project.`);
  let broader: EditPlan["broader"] = null;
  if (json.broader !== null && json.broader !== undefined) {
    const r = isRecord(json.broader) ? json.broader : {};
    broader = { reason: str(r.reason, "broader.reason", problems), units: list(r.units, "broader.units", problems).filter((u): u is string => typeof u === "string") };
  }
  if (kind === "behavior") {
    if (!allowedUnits.some((u) => u.unit === edited)) problems.push(`allowedUnits must include the edited unit, ${edited}, for a behavior change.`);
    const others = allowedUnits.filter((u) => u.unit !== edited).map((u) => u.unit);
    const missing = others.filter((u) => !broader?.units.includes(u));
    if (missing.length > 0) problems.push(`Units other than ${edited} may change only when "broader" names them with a reason: ${missing.join(", ")}.`);
  }
  if (problems.length > 0) return { plan: null, problems };
  return { plan: { kind: kind as PlanKind, interpretation, questions, warnings, allowedUnits, helpers, examples, broader }, problems };
}

// ------------------------------------------------------------------ edit-code

export interface CodeInput {
  plan: EditPlan;
  edits: DescriptionEdit[];
  request?: string;
  answers: { question: string; answer: string }[];
  base: SiftUnit;
  /** Each unit allowed to change, with its whole current text. */
  units: (UnitContext & { file: string })[];
  /** Each changed file's import block. */
  imports: { file: string; text: string }[];
  types: { ref: string; text: string }[];
  callees: Neighbour[];
  examples: { ref: string; code: string }[];
  /** From a previous attempt: what was wrong with it. */
  retry?: { previous: string; problems: string[] };
}

export function renderCodeInput(input: CodeInput): { prompt: string; redactions: number } {
  let redactions = 0;
  const redact = (text: string) => {
    const r = redactSecrets(text);
    redactions += r.count;
    return r.text;
  };
  const lines = ["What to do:", input.plan.interpretation, "", ...renderRequest(input.edits, input.request, input.answers, input.base)];
  if (input.plan.warnings.length > 0) lines.push("", "Warnings from planning:", ...input.plan.warnings.map((w) => `- ${w.kind}: ${w.text}`));
  lines.push("", "Units you may change (return each one's whole new text, from the first line of its declaration to its last):");
  for (const u of input.units) {
    const reason = input.plan.allowedUnits.find((a) => a.unit === u.ref)?.reason;
    lines.push("", `## ${u.ref} (${u.kind})${reason ? ` — ${reason}` : ""}`, "```" + fence(u.file), redact(u.code), "```");
  }
  if (input.plan.helpers.length > 0) lines.push("", "New functions you may add (as insertions in their file):", ...input.plan.helpers.map((h) => `- ${h.name} in ${h.file}: ${h.reason}`));
  else lines.push("", "Do not add new functions; change only the units above. You may add imports.");
  for (const imp of input.imports) lines.push("", `Imports of ${imp.file}:`, "```" + fence(imp.file), imp.text.trim() === "" ? "// (no imports)" : redact(imp.text.trimEnd()), "```");
  if (input.types.length > 0) {
    lines.push("", "Project types used:");
    for (const t of input.types) lines.push("```ts", `// ${t.ref}`, redact(t.text), "```");
  }
  lines.push("", ...neighbourLines("Functions called (signatures and what they do):", input.callees));
  if (input.examples.length > 0) {
    lines.push("", "Code elsewhere in the project that does something similar (follow its conventions):");
    for (const e of input.examples) lines.push("```ts", `// ${e.ref}`, redact(e.code), "```");
  }
  if (input.retry) {
    lines.push("", "Your previous response:", "```json", redact(input.retry.previous), "```", "", "It had these problems. Fix them and return the whole corrected JSON object:", ...input.retry.problems.map((p) => `- ${p}`));
  }
  return { prompt: lines.join("\n"), redactions };
}

export interface CodeResponse {
  units: { unit: string; text: string }[];
  insertions: { file: string; at: InsertionPoint; text: string }[];
  notes: string;
}

export const CODE_SCHEMA = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: { type: "object", properties: { unit: { type: "string" }, text: { type: "string" } }, required: ["unit", "text"], additionalProperties: false },
    },
    insertions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          at: {
            anyOf: [
              { enum: ["imports", "end"] },
              { type: "object", properties: { before: { type: "string" } }, required: ["before"], additionalProperties: false },
              { type: "object", properties: { after: { type: "string" } }, required: ["after"], additionalProperties: false },
            ],
          },
          text: { type: "string" },
        },
        required: ["file", "at", "text"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
  },
  required: ["units", "insertions", "notes"],
  additionalProperties: false,
} as const;

/** Check the shape of an edit-code response against the plan: only allowed units and their files. */
export function validateCode(json: unknown, plan: EditPlan): { code: CodeResponse | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(json)) return { code: null, problems: ["The response must be a single JSON object."] };
  const allowed = new Set(plan.allowedUnits.map((u) => u.unit));
  const files = new Set([...allowed].map((u) => u.slice(0, u.indexOf("#"))));
  const units = list(json.units, "units", problems).map((u, i) => {
    const r = isRecord(u) ? u : {};
    const unit = str(r.unit, `units[${i}].unit`, problems);
    if (unit && !allowed.has(unit)) problems.push(`units[${i}].unit "${unit}" is not one of the units you may change (${[...allowed].join(", ")}).`);
    const text = str(r.text, `units[${i}].text`, problems);
    if (text.includes("<redacted>")) problems.push(`units[${i}].text contains "<redacted>": keep the original code there; write the unit out in full.`);
    return { unit, text };
  });
  if (new Set(units.map((u) => u.unit)).size !== units.length) problems.push("Each unit may be given once.");
  const insertions = list(json.insertions, "insertions", problems).map((x, i) => {
    const r = isRecord(x) ? x : {};
    const file = str(r.file, `insertions[${i}].file`, problems);
    if (file && !files.has(file)) problems.push(`insertions[${i}].file "${file}" is not a file whose units you may change.`);
    let at: InsertionPoint = "end";
    if (r.at === "imports" || r.at === "end") at = r.at;
    else if (isRecord(r.at) && typeof r.at.before === "string") at = { before: r.at.before };
    else if (isRecord(r.at) && typeof r.at.after === "string") at = { after: r.at.after };
    else problems.push(`insertions[${i}].at must be "imports", "end", {"before": "file#Symbol"}, or {"after": "file#Symbol"}.`);
    if (typeof at === "object") {
      const ref = "before" in at ? at.before : at.after;
      if (!ref.startsWith(`${file}#`)) problems.push(`insertions[${i}].at must name a unit in ${file} as "${file}#Symbol".`);
    }
    if (at !== "imports" && plan.helpers.filter((h) => h.file === file).length === 0) problems.push(`insertions[${i}]: the plan allows no new functions in ${file}; only imports may be inserted there.`);
    const text = str(r.text, `insertions[${i}].text`, problems);
    if (text.includes("<redacted>")) problems.push(`insertions[${i}].text contains "<redacted>".`);
    return { file, at, text };
  });
  const notes = typeof json.notes === "string" ? json.notes : "";
  if (units.length === 0 && insertions.length === 0) problems.push("The response changes nothing; return the new text of the units that change.");
  if (problems.length > 0) return { code: null, problems };
  return { code: { units, insertions, notes }, problems };
}

// ------------------------------------------------------------------ edit-verify

export interface VerifyInput {
  mode: "behavior" | "reword";
  interpretation: string;
  edits: DescriptionEdit[];
  request?: string;
  answers: { question: string; answer: string }[];
  before: SiftUnit;
  after: SiftUnit;
  diff: LogicChange[];
  /** For a reword: the code, to judge the new wording against. */
  code?: { file: string; text: string };
}

export function renderVerifyInput(input: VerifyInput): { prompt: string; redactions: number } {
  const lines = [`Mode: ${input.mode === "reword" ? "reword (the code does not change; is the new wording accurate for the code?)" : "behavior (the code changed; does the new description do what was asked?)"}`];
  lines.push("", "What was asked, as understood:", input.interpretation, "", ...renderRequest(input.edits, input.request, input.answers, input.before));
  lines.push("", "Description before:", "```json", descriptionJson(input.before), "```", "", "Description after:", "```json", descriptionJson(input.after), "```");
  lines.push("", "Changes:", ...renderLogicDiff(input.diff).map((l) => `  ${l}`));
  let redactions = 0;
  if (input.code) {
    const code = redactSecrets(input.code.text);
    redactions = code.count;
    lines.push("", "Code:", "```" + fence(input.code.file), code.text, "```");
  }
  return { prompt: lines.join("\n"), redactions };
}

export interface VerifyResponse {
  satisfied: boolean;
  gaps: string[];
  unrequested: string[];
}

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    satisfied: { type: "boolean" },
    gaps: { type: "array", items: { type: "string" } },
    unrequested: { type: "array", items: { type: "string" } },
  },
  required: ["satisfied", "gaps", "unrequested"],
  additionalProperties: false,
} as const;

export function validateVerify(json: unknown): { verify: VerifyResponse | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(json)) return { verify: null, problems: ["The response must be a single JSON object."] };
  if (typeof json.satisfied !== "boolean") problems.push("satisfied must be true or false.");
  const gaps = list(json.gaps, "gaps", problems).filter((g): g is string => typeof g === "string");
  const unrequested = list(json.unrequested, "unrequested", problems).filter((g): g is string => typeof g === "string");
  if (json.satisfied === false && gaps.length === 0) problems.push("When satisfied is false, gaps must say what is missing or wrong.");
  if (problems.length > 0) return { verify: null, problems };
  return { verify: { satisfied: json.satisfied as boolean, gaps, unrequested }, problems };
}

/** One line per change, for prompts and the terminal. */
export function renderLogicDiff(diff: LogicChange[]): string[] {
  if (diff.length === 0) return ["(no change)"];
  return diff.flatMap((c): string[] => {
    switch (c.field) {
      case "summary":
        return [`summary: "${c.before}" → "${c.after}"`];
      case "returns":
        return [`returns: ${c.before === null ? "(none)" : `"${c.before}"`} → ${c.after === null ? "(none)" : `"${c.after}"`}`];
      case "input":
        return [`input ${c.name}: ${c.before === null ? "(new)" : `"${c.before}"`} → ${c.after === null ? "(removed)" : `"${c.after}"`}`];
      case "step":
        return c.change === "added" ? [`+ step ${c.id}: "${c.after}"`] : c.change === "removed" ? [`- step ${c.id}: "${c.before}"`] : [`~ step ${c.id}: "${c.before}" → "${c.after}"`];
      case "effects":
        return [`effects: ${[...c.added.map((e) => `+${e}`), ...c.removed.map((e) => `-${e}`)].join(" ")}`];
      case "warning":
        return [`warning ${c.change}: ${c.kind} — ${c.text}`];
    }
  });
}

// ------------------------------------------------------------------ helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, at: string, problems: string[]): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  problems.push(`${at} must be a non-empty string.`);
  return "";
}

function list(value: unknown, at: string, problems: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  problems.push(`${at} must be an array.`);
  return [];
}

function fence(file: string): string {
  if (/\.tsx?$|\.[cm]ts$/.test(file)) return file.endsWith("x") ? "tsx" : "ts";
  return file.endsWith("x") ? "jsx" : "js";
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
