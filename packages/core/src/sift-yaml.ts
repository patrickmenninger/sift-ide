import { Document, isScalar, isSeq, parseDocument, Scalar, visit, type ToStringOptions } from "yaml";
import { SiftError } from "./errors.js";
import { requiredSchemaVersion, type SiftFile, type SiftStep, type SiftUnit } from "./schema.js";
import { validateSiftFile } from "./validate.js";

/** Prose fields: written as folded block scalars when long (design §6.3). */
const PROSE_KEYS = new Set(["summary", "meaning", "text"]);
const FOLD_OVER = 60;

const STRINGIFY: ToStringOptions = { lineWidth: 80, minContentWidth: 20, flowCollectionPadding: false, indentSeq: true };

type Plain = Record<string, unknown>;

/** Parse and validate `.sift` text. */
export function parseSiftText(text: string, name: string): SiftFile {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new SiftError("SIFT_INVALID", `${name} is not valid YAML.`, doc.errors.map((e) => e.message));
  }
  return validateSiftFile(doc.toJS(), name);
}

/** Serialize a `.sift` file from scratch. The same data always produces the same bytes. */
export function serializeSiftFile(file: SiftFile): string {
  const doc = new Document(filePlain(file));
  visit(doc, {
    Pair(_, pair) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const value = pair.value;
      if (typeof key === "string" && PROSE_KEYS.has(key) && isScalar(value) && typeof value.value === "string") {
        if (value.value.length > FOLD_OVER || value.value.includes("\n")) value.type = Scalar.BLOCK_FOLDED;
      }
    },
    Seq(_, seq) {
      // Lists of plain values (effects, covers, calls, warning steps, tests) go on one line.
      if (seq.items.length > 0 && seq.items.every((item) => isScalar(item))) seq.flow = true;
    },
  });
  return doc.toString(STRINGIFY);
}

/**
 * Produce the new text for a `.sift` file, given the text currently on disk (design §6.3).
 *
 * Units whose content is unchanged keep their exact existing text, including any comments or
 * formatting around them, so diffs show only what really changed. Everything else is written by
 * `serializeSiftFile`. If the existing text can't be reused safely, the whole file is rewritten.
 */
export function updateSiftText(existing: string | null, next: SiftFile): string {
  const fresh = serializeSiftFile(next);
  if (existing === null || next.units.length === 0) return fresh;

  let previous: SiftFile;
  const doc = parseDocument(existing);
  try {
    if (doc.errors.length > 0) return fresh;
    previous = validateSiftFile(doc.toJS(), "existing file");
  } catch {
    return fresh;
  }
  const seq = doc.get("units", true);
  if (!isSeq(seq) || seq.items.length !== previous.units.length) return fresh;

  // Split the existing units into text chunks. Each chunk starts at its "- id:" line, or earlier
  // if comment or blank lines sit directly above it, and runs to the start of the next chunk.
  const starts: number[] = [];
  for (const item of seq.items) {
    const range = (item as { range?: [number, number, number] }).range;
    if (!range) return fresh;
    let start = lineStart(existing, range[0]);
    const floor = starts.length > 0 ? starts[starts.length - 1]! + 1 : 0;
    while (start > floor) {
      const prev = lineStart(existing, start - 1);
      const line = existing.slice(prev, start).trim();
      if (line !== "" && !line.startsWith("#")) break;
      start = prev;
    }
    starts.push(start);
  }
  const oldChunks = new Map<string, string>();
  previous.units.forEach((unit, i) => {
    const chunk = existing.slice(starts[i], starts[i + 1] ?? existing.length);
    if (sameUnit(unit, next.units.find((u) => u.id === unit.id))) oldChunks.set(unit.id, chunk.endsWith("\n") ? chunk : `${chunk}\n`);
  });
  if (oldChunks.size === 0) return fresh;

  // Fresh chunks come from serializing the whole new file, so indentation always matches.
  const freshDoc = parseDocument(fresh);
  const freshSeq = freshDoc.get("units", true);
  if (!isSeq(freshSeq)) return fresh;
  const freshStarts = freshSeq.items.map((item) => lineStart(fresh, (item as { range: [number, number, number] }).range[0]));
  const header = fresh.slice(0, freshStarts[0]);

  const body = next.units
    .map((unit, i) => oldChunks.get(unit.id) ?? fresh.slice(freshStarts[i], freshStarts[i + 1] ?? fresh.length))
    .join("");
  const merged = header + body;

  // Reused chunks might have been hand-formatted in a way that doesn't splice cleanly; verify.
  try {
    return JSON.stringify(filePlain(parseSiftText(merged, "merged file"))) === JSON.stringify(filePlain(next)) ? merged : fresh;
  } catch {
    return fresh;
  }
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function sameUnit(a: SiftUnit, b: SiftUnit | undefined): boolean {
  return b !== undefined && JSON.stringify(unitPlain(a)) === JSON.stringify(unitPlain(b));
}

// ---------------------------------------------------------------- plain objects in fixed key order

function filePlain(file: SiftFile): Plain {
  // A file is upgraded only when it holds something its declared version cannot (phase-2-design §7).
  return { sift: Math.max(file.sift, requiredSchemaVersion(file)), source: file.source, language: file.language, fileHash: file.fileHash, units: file.units.map(unitPlain) };
}

function unitPlain(u: SiftUnit): Plain {
  return compact({
    id: u.id,
    symbol: u.symbol,
    kind: u.kind,
    lite: u.lite ? true : undefined,
    status: u.status,
    userEdited: u.userEdited,
    bodyHash: u.bodyHash,
    contextHash: u.contextHash,
    generatedBy: u.generatedBy && {
      provider: u.generatedBy.provider,
      model: u.generatedBy.model,
      prompt: u.generatedBy.prompt,
      belowTier: u.generatedBy.belowTier,
    },
    summary: u.summary,
    inputs: u.inputs.map((i) => compact({ name: i.name, type: i.type, typeInferred: i.typeInferred ? true : undefined, meaning: i.meaning })),
    returns: u.returns && compact({ type: u.returns.type, typeInferred: u.returns.typeInferred ? true : undefined, meaning: u.returns.meaning }),
    effects: u.effects,
    steps: u.steps.map(stepPlain),
    warnings: u.warnings.map((w) =>
      compact({ id: w.id, kind: w.kind, text: w.text, steps: w.steps, resolved: w.resolved && { by: w.resolved.by, note: w.resolved.note } }),
    ),
    tests: u.tests,
  });
}

function stepPlain(s: SiftStep): Plain {
  return compact({ id: s.id, kind: s.kind, status: s.status, text: s.text, covers: s.covers, calls: s.calls, effects: s.effects, steps: s.steps.map(stepPlain) });
}

/** Drop undefined values and empty lists, keeping key order. */
function compact(obj: Plain): Plain {
  const out: Plain = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}
