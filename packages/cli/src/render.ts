import type { CallSite, ExtractedUnit, FileExtraction, StructureNode, SymbolRef } from "@sift/core";

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
