import type { GenerateReport, PlannedUnit } from "@sift/core";
import { plural } from "./status-model.js";

export interface PlanSummary {
  /** Nothing would call the AI. */
  nothing: boolean;
  /** One sentence for the confirmation dialog. */
  message: string;
  /** The estimate: units, files, and models per task; what is sent where. */
  detail: string;
}

/**
 * The confirmation shown before generating (phase-2-design §6.4), from a dry run. It names what
 * will be sent to which models; Sift has no price table, so the estimate is in units and calls,
 * not money.
 */
export function planSummary(report: GenerateReport, options: { local: boolean; providerId: string }): PlanSummary {
  const work = report.planned.filter((p) => p.action !== "context-check");
  const checks = report.planned.filter((p) => p.action === "context-check");
  const structural = structuralChanges(report);
  if (work.length === 0) {
    const message = structural.length > 0 ? `No AI calls needed: ${structural.join(", ")}.` : "Nothing to do: every description matches the code.";
    return { nothing: true, message, detail: checks.length > 0 ? contextCheckLine(checks) : "" };
  }
  const describe = work.filter((p) => p.action === "describe").length;
  const update = work.length - describe;
  const files = new Set(work.map((p) => p.unit.slice(0, p.unit.indexOf("#")))).size;
  const verbs = [describe > 0 ? `describe ${plural(describe, "unit")}` : "", update > 0 ? `update ${update} changed` : ""].filter(Boolean).join(" and ");
  const message = `${verbs.charAt(0).toUpperCase()}${verbs.slice(1)} in ${plural(files, "file")}?`;

  const lines: string[] = [];
  for (const [label, units] of byModel(work)) lines.push(`${label}: ${plural(units.length, "unit")}`);
  if (checks.length > 0) lines.push(contextCheckLine(checks));
  if (structural.length > 0) lines.push(`Without AI: ${structural.join(", ")}.`);
  lines.push(
    options.local
      ? `Using ${options.providerId}; code stays on this machine.`
      : `Using ${options.providerId}: each unit's code is sent to Anthropic through Claude Code, on your own login, and counts against its usage.`,
  );
  return { nothing: false, message, detail: lines.join("\n") };
}

function contextCheckLine(checks: PlannedUnit[]): string {
  return `Up to ${plural(checks.length, "more unit")} may get a short context check if their callees' summaries change (${modelLabel(checks[0]!)}).`;
}

function byModel(planned: PlannedUnit[]): Map<string, PlannedUnit[]> {
  const groups = new Map<string, PlannedUnit[]>();
  for (const p of planned) {
    const key = `${p.task} on ${modelLabel(p)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return groups;
}

function modelLabel(p: PlannedUnit): string {
  return `${p.route.choice.model}${p.route.choice.effort ? ` (${p.route.choice.effort} effort)` : ""}`;
}

function structuralChanges(report: GenerateReport): string[] {
  return [
    report.renamed.length > 0 ? `follow ${plural(report.renamed.length, "rename")}` : "",
    report.deleted.length > 0 ? `remove ${plural(report.deleted.length, "deleted unit")}` : "",
    report.movedFiles.length > 0 ? `follow ${plural(report.movedFiles.length, "moved file")}` : "",
  ].filter(Boolean);
}

/** One line after a run, plus whether it needs attention (failures, stale units, cancelled). */
export function resultSummary(report: GenerateReport): { message: string; problem: boolean } {
  const describedCount = report.described.filter((d) => d.action === "describe").length;
  const updated = report.described.filter((d) => d.action === "update").length;
  const reworded = report.described.filter((d) => d.action === "context-check" && d.changed).length;
  const stale = report.described.filter((d) => d.stale).length;
  const parts = [
    describedCount > 0 ? `described ${plural(describedCount, "unit")}` : "",
    updated > 0 ? `updated ${updated}` : "",
    reworded > 0 ? `reworded ${reworded} after callee changes` : "",
    report.renamed.length > 0 ? `followed ${plural(report.renamed.length, "rename")}` : "",
    report.deleted.length > 0 ? `removed ${report.deleted.length}` : "",
  ].filter(Boolean);
  let message = parts.length > 0 ? `Sift ${parts.join(", ")}.` : "Sift: nothing to do.";
  if (report.cancelled) message = `Cancelled. ${message} Units not reached keep their previous description.`;
  if (report.failed.length > 0) message += ` ${plural(report.failed.length, "unit")} failed: ${report.failed[0]!.unit} (${report.failed[0]!.reason})${report.failed.length > 1 ? " and others; see the Sift output" : ""}.`;
  if (stale > 0) message += ` ${plural(stale, "unit")} came back stale; review them.`;
  if (report.needsReview.length > 0) message += ` ${plural(report.needsReview.length, "unit")} had a person's wording changed; review them.`;
  return { message, problem: report.failed.length > 0 || stale > 0 || report.needsReview.length > 0 || report.cancelled === true };
}
