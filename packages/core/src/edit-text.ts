import { createHash } from "node:crypto";
import type { ExtractedUnit, FileExtraction, SourcePosition } from "./adapter.js";
import { SiftError } from "./errors.js";
import { newId } from "./ids.js";
import type { Effect, SiftStep, SiftUnit } from "./schema.js";

/**
 * Text work for editing (phase-2-design §8): applying whole-unit replacements and insertions to a
 * file, the source diff shown for review, the draft description a person's edits make, and the
 * logic diff between two descriptions. No AI and no file access here.
 */

export { applyDescriptionEdits, findStep, type DescriptionEdit } from "./description-edits.js";

/** A new step ID for an added step, unused in the unit. */
export function newStepId(unit: SiftUnit): string {
  const taken = new Set<string>();
  const walk = (steps: SiftStep[]): void => steps.forEach((s) => (taken.add(s.id), walk(s.steps)));
  walk(unit.steps);
  return newId("step", taken);
}

// ------------------------------------------------------------------ logic diff

export type LogicChange =
  | { field: "summary"; before: string; after: string }
  | { field: "returns"; before: string | null; after: string | null }
  | { field: "input"; name: string; before: string | null; after: string | null }
  | { field: "step"; change: "changed" | "added" | "removed"; id: string; before?: string; after?: string }
  | { field: "effects"; added: Effect[]; removed: Effect[] }
  | { field: "warning"; change: "added" | "removed" | "resolved"; kind: string; text: string };

/** What changed between two descriptions of a unit, for review (phase-2-design §8.7). Steps are matched by ID. */
export function logicDiff(before: SiftUnit | null, after: SiftUnit): LogicChange[] {
  const out: LogicChange[] = [];
  const b: Pick<SiftUnit, "summary" | "inputs" | "steps" | "effects" | "warnings"> = before ?? { summary: "", inputs: [], steps: [], effects: [], warnings: [] };
  if (b.summary !== after.summary) out.push({ field: "summary", before: b.summary, after: after.summary });
  const br = before?.returns?.meaning ?? null;
  const ar = after.returns?.meaning ?? null;
  if (br !== ar) out.push({ field: "returns", before: br, after: ar });
  for (const name of new Set([...b.inputs.map((i) => i.name), ...after.inputs.map((i) => i.name)])) {
    const x = b.inputs.find((i) => i.name === name)?.meaning ?? null;
    const y = after.inputs.find((i) => i.name === name)?.meaning ?? null;
    if (x !== y) out.push({ field: "input", name, before: x, after: y });
  }
  const old = new Map<string, string>();
  const walk = (steps: SiftStep[], into: Map<string, string>): void => steps.forEach((s) => (into.set(s.id, s.text), walk(s.steps, into)));
  walk(b.steps, old);
  const now = new Map<string, string>();
  walk(after.steps, now);
  for (const [id, text] of now) {
    const was = old.get(id);
    if (was === undefined) out.push({ field: "step", change: "added", id, after: text });
    else if (was !== text) out.push({ field: "step", change: "changed", id, before: was, after: text });
  }
  for (const [id, text] of old) if (!now.has(id)) out.push({ field: "step", change: "removed", id, before: text });
  const added = after.effects.filter((e) => !b.effects.includes(e));
  const removed = b.effects.filter((e) => !after.effects.includes(e));
  if (added.length > 0 || removed.length > 0) out.push({ field: "effects", added, removed });
  for (const w of after.warnings) {
    const was = b.warnings.find((x) => x.id === w.id);
    if (w.resolved && !was?.resolved) out.push({ field: "warning", change: "resolved", kind: w.kind, text: w.text });
    else if (!was && !w.resolved) out.push({ field: "warning", change: "added", kind: w.kind, text: w.text });
  }
  for (const w of b.warnings) if (!w.resolved && !after.warnings.some((x) => x.id === w.id)) out.push({ field: "warning", change: "removed", kind: w.kind, text: w.text });
  return out;
}

// ------------------------------------------------------------------ source changes

/** Where new code goes in a file (phase-2-design §8.5). Units are named `file#Symbol`. */
export type InsertionPoint = "imports" | "end" | { before: string } | { after: string };

export interface SourceReplacement {
  /** The unit's symbol in this file. */
  symbol: string;
  /** The unit's whole new text, from the first line of its declaration to its last. */
  text: string;
}

export interface SourceInsertion {
  at: InsertionPoint;
  text: string;
}

/**
 * Apply whole-unit replacements and insertions to a file's text. New text is re-indented to the
 * unit's place and takes the file's line endings. Everything outside the replaced ranges and the
 * insertion points is kept byte for byte.
 */
export function applySourceChanges(fileText: string, extraction: FileExtraction, replacements: SourceReplacement[], insertions: SourceInsertion[]): string {
  const crlf = fileText.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const starts = lineStarts(fileText);
  const unitOf = (symbol: string): ExtractedUnit => {
    const u = extraction.units.find((x) => x.symbol === symbol);
    if (!u) throw new SiftError("EDIT_INVALID_STATE", `${extraction.path} has no unit ${symbol}.`);
    return u;
  };
  const indentAt = (pos: SourcePosition) => /^[ \t]*/.exec(fileText.slice(starts[pos.line - 1]!))![0];
  /** Ties at one offset: text inserted after a unit goes first, then replacements, then text inserted before a unit. */
  const changes: { from: number; to: number; text: string; order: number }[] = [];

  for (const r of replacements) {
    const u = unitOf(r.symbol);
    const indent = indentAt(u.range.start);
    const lines = dedent(r.text).split("\n");
    const text = lines.map((l, i) => (i === 0 ? l : l.trim() === "" ? "" : indent + l)).join(eol);
    changes.push({ from: offsetOf(starts, u.range.start), to: offsetOf(starts, u.range.end), text, order: 1 });
  }
  for (const ins of insertions) {
    const block = (indent: string) =>
      dedent(ins.text)
        .split("\n")
        .map((l) => (l.trim() === "" ? "" : indent + l))
        .join(eol);
    if (ins.at === "imports") {
      const at = endOfImports(fileText);
      changes.push({ from: at, to: at, text: block("") + eol, order: 2 });
    } else if (ins.at === "end") {
      const trimmed = fileText.replace(/\s*$/, "");
      changes.push({ from: trimmed.length, to: fileText.length, text: eol + eol + block("") + eol, order: 0 });
    } else if ("before" in ins.at) {
      const u = unitOf(symbolOf(ins.at.before));
      let at = starts[u.range.start.line - 1]!;
      if (u.docComment) {
        const doc = fileText.lastIndexOf(u.docComment.replace(/\r?\n/g, eol), offsetOf(starts, u.range.start));
        if (doc >= 0) at = fileText.lastIndexOf("\n", doc) + 1;
      }
      changes.push({ from: at, to: at, text: block(indentAt(u.range.start)) + eol + eol, order: 2 });
    } else {
      const u = unitOf(symbolOf(ins.at.after));
      const at = offsetOf(starts, u.range.end);
      changes.push({ from: at, to: at, text: eol + eol + block(indentAt(u.range.start)), order: 0 });
    }
  }
  changes.sort((a, b) => b.from - a.from || a.order - b.order);
  for (let i = 1; i < changes.length; i++) {
    const later = changes[i - 1]!;
    const earlier = changes[i]!;
    if (earlier.to > later.from) throw new SiftError("EDIT_INVALID_STATE", `Two changes to ${extraction.path} overlap.`);
  }
  let text = fileText;
  for (const c of changes) text = text.slice(0, c.from) + c.text + text.slice(c.to);
  return text;
}

function symbolOf(ref: string): string {
  const hash = ref.indexOf("#");
  return hash >= 0 ? ref.slice(hash + 1) : ref;
}

/** Offset just after the file's leading import statements (and the comments among them), or 0. */
export function endOfImports(text: string): number {
  const re = /(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*import\b(?:[^;'"`]|'[^'\n]*'|"[^"\n]*")*?(?:from\s*)?(?:'[^'\n]*'|"[^"\n]*")\s*;?[ \t]*(?:\r?\n|$)/y;
  let end = 0;
  for (;;) {
    re.lastIndex = end;
    const m = re.exec(text);
    if (!m || m[0].length === 0) return end;
    end = re.lastIndex;
  }
}

/** Short hash of a file's text, to tell whether it changed since a proposal was made. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** A unified diff of two versions of a file, with `context` unchanged lines around each change. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  // Common prefix and suffix first, so the quadratic part only sees the changed region.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (midA.length === 0 && midB.length === 0) return "";
  const ops: { op: " " | "-" | "+"; line: string }[] = [];
  for (let i = 0; i < pre; i++) ops.push({ op: " ", line: a[i]! });
  ops.push(...lcsOps(midA, midB));
  for (let i = a.length - suf; i < a.length; i++) ops.push({ op: " ", line: a[i]! });

  const out = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  while (i < ops.length) {
    if (ops[i]!.op === " ") {
      i++, lineA++, lineB++;
      continue;
    }
    // A hunk: from `context` lines before this change to `context` lines after the last change near it.
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end]!.op !== " " || end - lastChange <= context * 2)) {
      if (ops[end]!.op !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const back = i - start;
    const hunk = ops.slice(start, end);
    const fromA = lineA - back;
    const fromB = lineB - back;
    const countA = hunk.filter((o) => o.op !== "+").length;
    const countB = hunk.filter((o) => o.op !== "-").length;
    out.push(`@@ -${countA === 0 ? fromA - 1 : fromA},${countA} +${countB === 0 ? fromB - 1 : fromB},${countB} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    for (const o of ops.slice(i, end)) {
      if (o.op !== "+") lineA++;
      if (o.op !== "-") lineB++;
    }
    i = end;
  }
  return out.join("\n");
}

function lcsOps(a: string[], b: string[]): { op: " " | "-" | "+"; line: string }[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ op: " ", line: a[i]! }), i++, j++;
    else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) out.push({ op: "+", line: b[j++]! });
    else out.push({ op: "-", line: a[i++]! });
  }
  // Removed lines read better before the lines that replace them.
  for (let k = 1; k < out.length; k++) {
    if (out[k]!.op === "-" && out[k - 1]!.op === "+") {
      let s = k - 1;
      while (s > 0 && out[s - 1]!.op === "+") s--;
      const minus = out.splice(k, 1)[0]!;
      out.splice(s, 0, minus);
    }
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetOf(starts: number[], pos: SourcePosition): number {
  return (starts[pos.line - 1] ?? 0) + pos.col - 1;
}

/** Normalize line endings, drop surrounding blank lines, and remove the indentation the lines after the first share. */
export function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const rest = lines.slice(1).filter((l) => l.trim() !== "");
  // The first line may be given with or without its indentation; the rest decide the common indent.
  const firstIndent = indent(lines[0] ?? "");
  const cut = rest.length > 0 ? Math.min(firstIndent > 0 ? firstIndent : Infinity, ...rest.map(indent)) : firstIndent;
  const common = Number.isFinite(cut) ? cut : 0;
  return lines.map((l, i) => (i === 0 ? l.trimStart() : l.slice(Math.min(common, indent(l))))).join("\n");
}
