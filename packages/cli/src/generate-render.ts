import { TASK_TIERS, type GenerateReport, type PlannedUnit, type Route, type StatusReport } from "@sift/core";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderPlan(report: GenerateReport): string {
  const out: string[] = [];
  const work = report.planned.filter((p) => p.action !== "context-check");
  const checks = report.planned.filter((p) => p.action === "context-check");
  if (work.length === 0 && checks.length === 0) out.push("Nothing to do: every description matches the code.");
  if (work.length > 0) {
    out.push(`Would describe or update ${plural(work.length, "unit")}:`);
    for (const p of work) out.push(`  ${p.unit}  ${reasonLabel(p)} · ${p.task} · ${model(p.route)}`);
  }
  if (checks.length > 0) {
    out.push(`${plural(checks.length, "unit")} may get a context check if their callees' summaries change (${model(checks[0]!.route)}):`);
    for (const p of checks) out.push(`  ${p.unit}`);
  }
  out.push(...structuralNotes(report));
  return out.join("\n");
}

function reasonLabel(p: PlannedUnit): string {
  switch (p.reason) {
    case "new":
      return "new";
    case "forced":
      return "again (--force)";
    case "probable-rename":
      return "renamed and changed";
    default:
      return "changed";
  }
}

function model(route: Route): string {
  return `${route.choice.model}${route.choice.effort ? ` (${route.choice.effort})` : ""}`;
}

export function renderGenerateReport(report: GenerateReport): string {
  const out: string[] = [];
  const count = (action: string) => report.described.filter((d) => d.action === action);
  const described = count("describe");
  const updated = count("update");
  const checked = count("context-check");
  const reworded = checked.filter((d) => d.changed);
  const parts = [
    described.length > 0 ? `described ${plural(described.length, "new unit")}` : "",
    updated.length > 0 ? `updated ${updated.length} changed` : "",
    checked.length > 0 ? `checked ${checked.length} against new callee summaries (${reworded.length} reworded)` : "",
    report.renamed.length > 0 ? `kept ${report.renamed.length} renamed or moved` : "",
    report.deleted.length > 0 ? `removed ${report.deleted.length} deleted` : "",
  ].filter(Boolean);
  const head = parts.length > 0 ? `${parts.join(", ")}.` : "Nothing to do: every description matches the code.";
  out.push("", head.charAt(0).toUpperCase() + head.slice(1));
  if (report.failed.length > 0) out.push(`${plural(report.failed.length, "unit")} failed and kept their previous description, if any.`);
  if (report.written.length + report.removed.length > 0) {
    out.push(`Wrote ${plural(report.written.length, ".sift file")}${report.removed.length > 0 ? `, removed ${report.removed.length}` : ""}.`);
  }
  const warnings = [...described, ...updated].reduce((n, d) => n + d.warnings, 0);
  if (warnings > 0) out.push(`${plural(warnings, "warning")} in the new and updated descriptions; see them with "sift show <file>".`);
  for (const s of report.described.filter((d) => d.stale && d.uncovered.length > 0)) out.push(`  stale: ${s.unit} (no step covers ${s.uncovered.join(", ")})`);
  for (const r of report.needsReview) out.push(`  review: ${r} (a person's wording was changed; marked stale)`);
  for (const f of report.failed) {
    out.push(`  failed: ${f.unit}: ${f.reason}`);
    for (const p of f.problems.slice(0, 5)) out.push(`    - ${p}`);
  }
  const u = report.usage;
  if (u.calls > 0) {
    const cost = u.costUsd > 0 ? ` · about $${u.costUsd.toFixed(2)} at API prices (on a subscription this is an estimate, not a bill)` : "";
    out.push(`${plural(u.calls, "AI call")} · ${fmt(u.inputTokens)} tokens in, ${fmt(u.outputTokens)} out${cost}`);
  }
  if (report.redactions > 0) out.push(`Replaced ${report.redactions} possible secret${report.redactions === 1 ? "" : "s"} with "<redacted>" before sending.`);
  for (const s of report.substitutions) out.push(`Used ${s.model} (${s.to} tier) because the ${s.from} tier's model was unavailable.`);
  if (report.belowMinimum.length > 0) out.push(`${plural(report.belowMinimum.length, "unit")} ran below their task's minimum tier; consider regenerating them with a stronger model.`);
  for (const r of report.replaced) out.push(`Replaced .sift/${r}.sift, which could not be read.`);
  out.push(...structuralNotes(report));
  return out.join("\n");
}

/** Renames, moves, deletions, and renames that were not guessed: changes made without the AI. */
function structuralNotes(r: Pick<GenerateReport, "renamed" | "deleted" | "movedFiles" | "ambiguous">): string[] {
  const out: string[] = [];
  for (const m of r.movedFiles) out.push(`  file moved: ${m.from} → ${m.to}`);
  for (const m of r.renamed) out.push(`  ${renameLabel(m)}: ${m.from} → ${m.to}`);
  for (const d of r.deleted) out.push(`  deleted: ${d}`);
  for (const a of r.ambiguous) out.push(`  not matched: ${a.previous} looks like several new units (${a.candidates.join(", ")}); treated as deleted and new`);
  return out;
}

function renameLabel(m: { change: string; similarity?: number }): string {
  if (m.change === "moved") return "moved";
  if (m.change === "probable-rename") return `probably renamed (${Math.round((m.similarity ?? 0) * 100)}% similar)`;
  return "renamed";
}

export function renderStatus(r: StatusReport, inSync: boolean): string {
  const out: string[] = [];
  const list = (title: string, items: string[], hint?: string) => {
    if (items.length === 0) return;
    out.push(`${title} (${items.length})${hint ? ` — ${hint}` : ""}:`);
    for (const i of items) out.push(`  ${i}`);
  };
  const pureChanged = r.changed.filter((c) => !r.renamed.some((m) => m.to === c));
  list("Changed since described", pureChanged, "generate updates them");
  list("Not described yet", r.new, "generate describes them");
  list("Deleted from the source", r.deleted, "generate removes them");
  if (r.renamed.length > 0) {
    out.push(`Renamed or moved (${r.renamed.length}) — generate keeps their IDs:`);
    for (const m of r.renamed) out.push(`  ${renameLabel(m)}: ${m.from} → ${m.to}`);
  }
  if (r.movedFiles.length > 0) {
    out.push(`Files moved (${r.movedFiles.length}) — generate moves their .sift files:`);
    for (const m of r.movedFiles) out.push(`  ${m.from} → ${m.to}`);
  }
  list("Callee summaries changed", r.contextChanged, "generate checks their wording");
  list("Marked stale", r.stale, "incomplete or needs review; generate --force describes them again");
  list("Unreadable .sift files", r.unreadable.map((u) => `.sift/${u}.sift`), "generate replaces them");
  for (const a of r.ambiguous) out.push(`Not matched: ${a.previous} looks like several new units (${a.candidates.join(", ")}).`);
  if (r.belowTier.length > 0) out.push(`${plural(r.belowTier.length, "unit")} described below the recommended model tier.`);
  const c = r.counts;
  out.push(
    "",
    inSync ? `In sync: ${plural(c.units, "described unit")} match the code.` : 'Out of sync: run "sift generate" to update the descriptions.',
    `${c.verified} verified, ${c.userEdited} edited by a person, ${c.generated} generated and not yet verified.`,
  );
  return out.join("\n");
}

export function renderModels(provider: string, routes: Route[], local: boolean): string {
  const rows = routes.map((r) => [
    r.task,
    `${r.tier}${r.source.tier !== "default" ? ` (${r.source.tier})` : ""}`,
    `${r.choice.model}${r.source.model !== "default" ? ` (${r.source.model})` : ""}`,
    r.choice.effort ?? "-",
    `${TASK_TIERS[r.task].recommended}${r.belowMinimum ? " ! below minimum" : r.belowTier ? " · below recommended" : ""}`,
  ]);
  const header = ["Task", "Tier", "Model", "Effort", "Recommended"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [
    `Provider: ${provider}`,
    "",
    line(header),
    ...rows.map(line),
    "",
    "(config) = sift.config.yaml, (local) = .sift/models.local.yaml" + (local ? "" : " (not present)"),
  ].join("\n");
}

function fmt(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}
