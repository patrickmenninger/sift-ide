import { TASK_TIERS, type GenerateReport, type Route } from "@sift/core";

export function renderPlan(report: GenerateReport): string {
  const out: string[] = [];
  if (report.planned.length === 0) out.push("Nothing to describe: every unit in these files already has a description.");
  else {
    out.push(`Would describe ${report.planned.length} unit${report.planned.length === 1 ? "" : "s"}:`);
    for (const p of report.planned) {
      out.push(`  ${p.unit}  ${p.task} · ${p.route.choice.model}${p.route.choice.effort ? ` (${p.route.choice.effort})` : ""}${p.reason === "forced" ? " · again (--force)" : ""}`);
    }
  }
  out.push(...keptNotes(report));
  return out.join("\n");
}

export function renderGenerateReport(report: GenerateReport): string {
  const out: string[] = [];
  if (report.planned.length === 0) {
    out.push("Nothing to describe: every unit in these files already has a description.", ...keptNotes(report));
    return out.join("\n");
  }
  const stale = report.described.filter((d) => d.stale);
  out.push(
    "",
    `Described ${report.described.length} of ${report.planned.length} unit${report.planned.length === 1 ? "" : "s"}` +
      `${stale.length > 0 ? ` (${stale.length} incomplete, marked stale)` : ""}` +
      `${report.failed.length > 0 ? `; ${report.failed.length} failed` : ""}.` +
      ` Wrote ${report.written.length} .sift file${report.written.length === 1 ? "" : "s"}.`,
  );
  const warnings = report.described.reduce((n, d) => n + d.warnings, 0);
  if (warnings > 0) out.push(`${warnings} warning${warnings === 1 ? "" : "s"} raised; see them with "sift show <file>".`);
  for (const s of stale) out.push(`  stale: ${s.unit} (no step covers ${s.uncovered.join(", ")})`);
  for (const f of report.failed) {
    out.push(`  failed: ${f.unit}: ${f.reason}`);
    for (const p of f.problems.slice(0, 5)) out.push(`    - ${p}`);
  }
  const u = report.usage;
  if (u.calls > 0) {
    const cost = u.costUsd > 0 ? ` · about $${u.costUsd.toFixed(2)} at API prices (on a subscription this is an estimate, not a bill)` : "";
    out.push(`${u.calls} AI call${u.calls === 1 ? "" : "s"} · ${fmt(u.inputTokens)} tokens in, ${fmt(u.outputTokens)} out${cost}`);
  }
  if (report.redactions > 0) out.push(`Replaced ${report.redactions} possible secret${report.redactions === 1 ? "" : "s"} with "<redacted>" before sending.`);
  for (const s of report.substitutions) out.push(`Used ${s.model} (${s.to} tier) because the ${s.from} tier's model was unavailable.`);
  if (report.belowMinimum.length > 0) out.push(`${report.belowMinimum.length} unit(s) were described below their task's minimum tier; consider regenerating them with a stronger model.`);
  for (const r of report.replaced) out.push(`Replaced .sift/${r}.sift, which could not be read.`);
  out.push(...keptNotes(report));
  return out.join("\n");
}

function keptNotes(report: GenerateReport): string[] {
  const out: string[] = [];
  const changed = report.kept.filter((k) => k.changed);
  if (report.kept.length > 0) {
    out.push(`Kept ${report.kept.length} unit${report.kept.length === 1 ? "" : "s"} that already have descriptions (--force describes them again).`);
  }
  if (changed.length > 0) {
    out.push(`${changed.length} of them changed since they were described; updating them arrives with "sift status" and sync (milestone 7):`);
    for (const c of changed) out.push(`  changed: ${c.unit}`);
  }
  if (report.orphaned.length > 0) {
    out.push(`${report.orphaned.length} described unit(s) no longer exist in the source and were left in place for sync (milestone 7):`);
    for (const o of report.orphaned) out.push(`  gone: ${o}`);
  }
  return out;
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
