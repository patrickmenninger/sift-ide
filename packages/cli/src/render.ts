import { displayStatus, type CallSite, type ExtractedUnit, type FileExtraction, type SiftFile, type SiftStep, type SiftUnit, type StructureNode, type SymbolRef } from "@sift/core";

/**
 * Readable rendering of a `.sift` file for `sift show`: a nested outline of steps with warnings.
 * `unitNames` maps unit IDs from any file to "file#symbol" so calls read as names, not IDs.
 */
export function renderSift(file: SiftFile, units: SiftUnit[], unitNames: Map<string, string>): string {
  const lines = [`${file.source} · ${file.units.length} unit${file.units.length === 1 ? "" : "s"}`];
  for (const unit of units) lines.push("", ...renderSiftUnit(unit, file.source, unitNames));
  return lines.join("\n");
}

function renderSiftUnit(u: SiftUnit, source: string, unitNames: Map<string, string>): string[] {
  const shown = displayStatus(u);
  const status = shown === "generated" ? "generated, not verified" : shown === "user-edited" && u.status !== "user-edited" ? "partly written by a person" : shown;
  const lines = [`${u.symbol}  · ${u.kind}${u.lite ? " (lite)" : ""} · ${status}`, ...wrap(u.summary, "  ")];
  if (u.inputs.length > 0) {
    lines.push("  Inputs");
    for (const i of u.inputs) lines.push(...wrap(`${i.name} (${i.type}${i.typeInferred ? ", inferred" : ""}): ${i.meaning}`, "    "));
  }
  if (u.returns) lines.push(...wrap(`Returns ${u.returns.type}${u.returns.typeInferred ? " (inferred)" : ""}: ${u.returns.meaning}`, "  ", "    "));
  if (u.effects.length > 0) lines.push(`  Effects: ${u.effects.join(", ")}`);

  const numbers = new Map<string, string>();
  if (u.steps.length > 0) {
    lines.push("  Steps");
    const walk = (steps: SiftStep[], prefix: string, depth: number) => {
      steps.forEach((s, i) => {
        const n = prefix === "" ? `${i + 1}` : `${prefix}.${i + 1}`;
        numbers.set(s.id, n);
        const pad = "    " + "   ".repeat(depth);
        const mark = s.status === "user-edited" ? " (person)" : s.status === "verified" ? " (verified)" : "";
        lines.push(...wrap(`${n}. ${s.text}${mark}`, pad, pad + " ".repeat(n.length + 2)));
        const calls = s.calls.map((c) => callName(c, source, unitNames));
        if (calls.length > 0) lines.push(`${pad}${" ".repeat(n.length + 2)}→ ${calls.join(", ")}`);
        walk(s.steps, n, depth + 1);
      });
    };
    walk(u.steps, "", 0);
  }
  if (u.warnings.length > 0) {
    lines.push("  Warnings");
    for (const w of u.warnings) {
      const where = w.steps.map((id) => numbers.get(id)).filter(Boolean);
      lines.push(...wrap(`! ${w.kind}${where.length > 0 ? ` (step ${where.join(", ")})` : ""}: ${w.text}`, "    ", "      "));
    }
  }
  return lines;
}

function callName(ref: string, source: string, unitNames: Map<string, string>): string {
  if (ref.startsWith("ext:")) return ref.slice(4).replace("#", ": ");
  const name = unitNames.get(ref);
  if (!name) return `${ref} (unknown unit)`;
  return name.startsWith(`${source}#`) ? name.slice(source.length + 1) : name;
}

/** Word-wrap to 100 columns with a first-line and continuation indent. */
function wrap(text: string, first: string, rest = first, width = 100): string[] {
  const lines: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line.trim() === "" || line === first ? line + word : `${line} ${word}`;
    if (candidate.length > width && line !== first) {
      lines.push(line);
      line = rest + word;
    } else line = candidate;
  }
  lines.push(line);
  return lines;
}

const ref = (r: SymbolRef) => `${r.file}#${r.symbol}`;

/** Human-readable rendering of an adapter extraction, for `sift show --structure`. */
export function renderStructure(file: FileExtraction, units: ExtractedUnit[] = file.units): string {
  const lines: string[] = [`${file.path} · ${file.language} · ${file.units.length} units · file hash ${file.fileHash}`];
  for (const unit of units) lines.push("", ...renderUnit(unit));
  return lines.join("\n");
}

function renderUnit(u: ExtractedUnit): string[] {
  const lines = [
    `${u.symbol}  (${u.kind}${u.isSmall ? ", lite" : ""})  lines ${u.range.start.line}–${u.range.end.line}  hash ${u.bodyHash}`,
    `  ${u.signature}`,
  ];
  if (u.inputs.length > 0) {
    lines.push(`  inputs:  ${u.inputs.map((i) => `${i.name}: ${i.type}${i.typeInferred ? " (inferred)" : ""}`).join(" · ")}`);
  }
  if (u.returns) lines.push(`  returns: ${u.returns.type}${u.returns.typeInferred ? " (inferred)" : ""}`);
  if (u.implementsMember) lines.push(`  implements: ${ref(u.implementsMember)}`);
  if (u.typeRefs.length > 0) lines.push(`  types:   ${u.typeRefs.map((t) => t.symbol).join(", ")}`);
  if (u.docComment) lines.push(`  comment: ${u.docComment.replace(/\s+/g, " ").slice(0, 120)}`);
  for (const node of u.body) lines.push(...renderNode(node, 1));
  return lines;
}

function renderNode(n: StructureNode, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const lines = [`${pad}[${n.key}] ${n.kind}: ${n.text}`];
  for (const call of n.calls) lines.push(...renderCall(call, `${pad}    `));
  for (const child of n.children) lines.push(...renderNode(child, depth + 1));
  return lines;
}

function renderCall(c: CallSite, pad: string): string[] {
  const flags = [c.confidence, c.awaited ? "awaited" : null].filter(Boolean).join(", ");
  const target = c.external
    ? `external ${c.external.module}: ${c.external.name}`
    : c.target
      ? ref(c.target)
      : "unresolved";
  const lines = [`${pad}call ${c.expression} → ${target}${flags ? ` (${flags})` : ""}`];
  if (c.implementations.length > 0) lines.push(`${pad}  implemented by: ${c.implementations.map(ref).join(", ")}`);
  const args = c.args
    .map((a) => (a.kind === "string" ? JSON.stringify(a.value) : a.kind === "unit" ? ref(a.ref) : a.kind === "callback" ? `callback ${a.key}` : null))
    .filter((a): a is string => a !== null);
  if (args.length > 0) lines.push(`${pad}  args: ${args.join(", ")}`);
  return lines;
}
