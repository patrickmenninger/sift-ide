import type { ExtractedUnit, StructureNode } from "./adapter.js";
import { redactSecrets } from "./redact.js";
import type { Effect, SiftStep, SiftUnit } from "./schema.js";

/**
 * The user-prompt half of a describe request (design §7.4): the unit's code with structure-key
 * markers, its signature and types, what it calls, and the effects detected per key. The
 * instructions and examples are the system prompt (prompts/describe.md).
 */

export interface CalleeInfo {
  /** The call as written, e.g. "this.repo.save(from)". */
  expression: string;
  /** Structure key of the node making the call. */
  key: string;
  /** "file#Symbol", "ext:module#name", or null when unresolved. */
  target: string | null;
  kind: "unit" | "declaration" | "external" | "unresolved";
  signature?: string;
  summary?: string;
  /** For calls to an interface member: the implementations, with their summaries when known. */
  implementations?: { target: string; summary?: string }[];
  effects: Effect[];
}

export interface DescribeInput {
  file: string;
  unit: ExtractedUnit;
  /** Full text of the source file, used to cut out the unit with markers. */
  fileText: string;
  lite: boolean;
  nodeEffects: Map<string, Effect[]>;
  callees: CalleeInfo[];
  /** For a changed unit (design §7.4): the previous description and the code changes since. */
  previous?: PreviousDescription;
}

export interface PreviousDescription {
  unit: SiftUnit;
  /** `lineDiff` of the old and new unit source, or null when the old source is no longer known. */
  diff: string | null;
}

export interface RenderedInput {
  prompt: string;
  /** Number of secrets replaced by "<redacted>". */
  redactions: number;
}

export function renderDescribeInput(input: DescribeInput): RenderedInput {
  const { unit, file } = input;
  const code = redactSecrets(input.lite ? unitText(input.fileText, unit) : annotatedSource(input.fileText, unit));
  const doc = unit.docComment ? redactSecrets(unit.docComment) : null;
  const lines: string[] = [];

  lines.push(`File: ${file}`, `Unit: ${unit.symbol} (${unit.kind})`, `Signature: ${unit.signature}`, "");
  lines.push("Inputs (use these names exactly):");
  if (unit.inputs.length === 0) lines.push("- (none)");
  for (const i of unit.inputs) lines.push(`- \`${i.name}\`: ${i.type}${i.typeInferred ? " (type inferred)" : ""}`);
  lines.push("", `Returns: ${unit.returns ? `${unit.returns.type}${unit.returns.typeInferred ? " (type inferred)" : ""}` : "nothing"}`);
  if (doc) lines.push("", "Doc comment:", doc.text);

  lines.push("", "Code:", "```" + fence(file), code.text, "```");

  if (!input.lite) {
    lines.push("", "Structure keys (every key must be covered by a step):");
    for (const node of flatten(unit.body)) {
      const effects = input.nodeEffects.get(node.key);
      lines.push(`- ${node.key}: ${node.kind}${effects ? ` — effects: ${effects.join(", ")}` : ""}`);
    }
  }

  lines.push("", "Calls:");
  if (input.callees.length === 0) lines.push("- (none)");
  for (const c of input.callees) lines.push(...renderCallee(c, input.lite));

  let redactions = code.count + (doc?.count ?? 0);
  if (input.previous) {
    const { unit: prev, diff } = input.previous;
    lines.push("", "Previous description (its `covers` keys refer to the previous version of the code):", "```json", previousJson(prev, input.lite), "```");
    if (prev.status === "user-edited") lines.push("", "A person edited this description. Keep their wording wherever it is still accurate.");
    if (diff !== null) {
      const changes = redactSecrets(diff);
      redactions += changes.count;
      lines.push("", "Changes to the code since the previous description (`-` removed, `+` added):", "```text", changes.text, "```");
    } else {
      lines.push("", "The previous version of the code is not available; compare the previous description with the code above.");
    }
  }
  return { prompt: lines.join("\n"), redactions };
}

/** The previous description in the shape the model returns, with step IDs. */
function previousJson(unit: SiftUnit, lite: boolean): string {
  const step = (s: SiftStep): object => ({ id: s.id, kind: s.kind ?? null, text: s.text, covers: s.covers, steps: s.steps.map(step) });
  const covers = new Map<string, string[]>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => (covers.set(s.id, s.covers), index(s.steps)));
  index(unit.steps);
  const data = {
    summary: unit.summary,
    inputs: unit.inputs.map((i) => ({ name: i.name, meaning: i.meaning })),
    returns: unit.returns ? { meaning: unit.returns.meaning } : null,
    ...(lite ? {} : { steps: unit.steps.map(step) }),
    warnings: unit.warnings.map((w) => ({ kind: w.kind, text: w.text, ...(lite ? {} : { covers: w.steps.flatMap((id) => covers.get(id) ?? []) }) })),
  };
  return JSON.stringify(data, null, 1);
}

export interface ContextCheckInput {
  file: string;
  unit: SiftUnit;
  /** Callees whose summary changed: name, the summary the description was written with (if known), and the new one. */
  changes: { name: string; before?: string; after: string }[];
}

/** The user prompt for a context check (design §7.3): the description, and the callee summaries that changed. */
export function renderContextCheckInput(input: ContextCheckInput): string {
  const step = (s: SiftStep): object => ({ id: s.id, text: s.text, steps: s.steps.map(step) });
  const description = { summary: input.unit.summary, ...(input.unit.lite ? {} : { steps: input.unit.steps.map(step) }) };
  const lines = [`File: ${input.file}`, `Unit: ${input.unit.symbol} (${input.unit.kind})`, "", "Current description:", "```json", JSON.stringify(description, null, 1), "```", "", "Changed callees:"];
  for (const c of input.changes) lines.push(`- \`${c.name}\``, `  before: ${c.before ?? "(not known)"}`, `  now: ${c.after}`);
  return lines.join("\n");
}

function renderCallee(c: CalleeInfo, lite: boolean): string[] {
  const at = lite ? "" : `[${c.key}] `;
  const expr = oneLine(c.expression);
  const effects = c.effects.length > 0 ? ` — effects: ${c.effects.join(", ")}` : "";
  if (c.kind === "external") return [`- ${at}\`${expr}\` → library ${c.target!.slice(4).replace("#", ": ")}${effects}`];
  if (c.kind === "unresolved") return [`- ${at}\`${expr}\` → not resolved (a dynamic call)`];
  const name = c.target!.slice(c.target!.indexOf("#") + 1);
  const out = [`- ${at}\`${expr}\` → ${name}${c.kind === "declaration" ? " (declaration)" : ""}${effects}`];
  if (c.signature) out.push(`  signature: ${oneLine(c.signature)}`);
  if (c.summary) out.push(`  summary: ${c.summary}`);
  for (const impl of c.implementations ?? []) {
    const implName = impl.target.slice(impl.target.indexOf("#") + 1);
    out.push(`  implemented by ${implName}${impl.summary ? `: ${impl.summary}` : ""}`);
  }
  return out;
}

export function flatten(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Offsets of each line start, for converting 1-based line/col positions. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts: number[], pos: { line: number; col: number }): number {
  return (starts[pos.line - 1] ?? 0) + pos.col - 1;
}

/** The unit's text as it appears in the file. */
export function unitText(fileText: string, unit: ExtractedUnit): string {
  const starts = lineStarts(fileText);
  return dedent(" ".repeat(unit.range.start.col - 1) + fileText.slice(offsetOf(starts, unit.range.start), offsetOf(starts, unit.range.end)));
}

/**
 * The unit's text with a `/*[key]*\/` marker before every structure node (design §7.4). Markers at
 * the same position are written outermost first.
 */
export function annotatedSource(fileText: string, unit: ExtractedUnit): string {
  const starts = lineStarts(fileText);
  const begin = offsetOf(starts, unit.range.start);
  const end = offsetOf(starts, unit.range.end);
  const marks = flatten(unit.body)
    .map((n, order) => ({ at: offsetOf(starts, n.range.start), key: n.key, order }))
    .filter((m) => m.at >= begin && m.at <= end)
    .sort((a, b) => b.at - a.at || b.order - a.order);
  let text = fileText.slice(begin, end);
  for (const m of marks) {
    const i = m.at - begin;
    text = `${text.slice(0, i)}/*[${m.key}]*/ ${text.slice(i)}`;
  }
  return dedent(" ".repeat(unit.range.start.col - 1) + text);
}

/** Normalize line endings and remove the indentation that all non-blank lines share. */
function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const nonBlank = lines.filter((l) => l.trim() !== "");
  const cut = nonBlank.length > 0 ? Math.min(...nonBlank.map(indent)) : 0;
  return lines.map((l) => l.slice(Math.min(cut, indent(l)))).join("\n");
}

function fence(file: string): string {
  if (/\.tsx?$|\.[cm]ts$/.test(file)) return file.endsWith("x") ? "tsx" : "ts";
  return file.endsWith("x") ? "jsx" : "js";
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
