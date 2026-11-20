import type { ConfigSummary, EvalResult, RunResult } from "./run.js";

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const sd = (n: number | null) => (n === null ? "–" : `±${Math.round(n * 100)}`);

/** The Markdown summary written next to the JSON results (design §13.3, §13.4). */
export function renderMarkdown(r: EvalResult): string {
  const out: string[] = [];
  out.push(`# Evaluation: ${r.fixture}`, "");
  out.push(`- Started ${r.startedAt}; commit ${r.commit ? `${r.commit.sha}${r.commit.dirty ? " (with uncommitted changes)" : ""}` : "unknown"}`);
  out.push(`- Provider ${r.provider}; prompts ${Object.values(r.prompts).join(", ")}`);
  out.push(r.judge ? `- Judge ${r.judge.model}${r.judge.selfGraded ? " — **self-graded**: same vendor as the models tested; weigh coverage, missed effects, and warning checks more (design §13.4)" : ""}` : "- No judge: mentions and accuracy were not scored");
  out.push("", "| Config | Models (describe / lite / update / check) | Coverage | Missed effects | Expectations | Accurate | Acceptable | Churn | Variance (exp. / acc.) | Cost / unit | Latency (mean / p95) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.summary) out.push(row(s));
  out.push("", "Accurate: judged correct. Acceptable: correct or minor issues. Churn: wording changes in steps whose code did not change, after small edits. Cost is at API prices.", "");

  for (const run of r.runs) out.push(...runSection(run, r.runs.length > 1));
  return `${out.join("\n")}\n`;
}

function row(s: ConfigSummary): string {
  const m = s.models;
  return [
    `${s.config}${s.runs > 1 ? ` (×${s.runs})` : ""}`,
    [m.describe, m["describe-lite"], m.update, m["context-check"]].join(" / "),
    pct(s.coverage),
    s.missedEffects.toFixed(s.runs > 1 ? 1 : 0),
    pct(s.expectations),
    pct(s.accuracy),
    pct(s.acceptable),
    pct(s.churn),
    `${sd(s.runs > 1 ? s.variance.expectations : null)} / ${sd(s.runs > 1 ? s.variance.accuracy : null)}`,
    `$${s.costPerUnit.toFixed(3)}`,
    `${(s.latencyMs.mean / 1000).toFixed(1)}s / ${(s.latencyMs.p95 / 1000).toFixed(1)}s`,
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

/** Failure patterns for one run: what failed, so prompt changes can target it. */
function runSection(run: RunResult, numbered: boolean): string[] {
  const out = [`## ${run.config}${numbered ? ` #${run.repeat}` : ""}`, ""];
  const m = run.metrics;
  out.push(
    `${m.units} units: ${m.firstTry} valid on the first try, ${m.stale} stale, ${m.failed} failed. ` +
      `${m.expectations.passed}/${m.expectations.checked} expectation checks passed${m.expectations.unjudged > 0 ? ` (${m.expectations.unjudged} not judged)` : ""}. ` +
      `${m.warnings.total} warnings, ${m.warnings.standard} of them standard kinds.`,
  );
  if (m.accuracy) out.push(`Judge: ${m.accuracy.correct} correct, ${m.accuracy.minor} minor issues, ${m.accuracy.wrong} wrong.`);
  const usage = run.usage;
  out.push(`AI calls: ${usage.generate.calls} generate, ${usage.judge.calls} judge, ${usage.churn.calls} churn; $${(usage.generate.costUsd + usage.judge.costUsd + usage.churn.costUsd).toFixed(2)} at API prices.`, "");

  const failedChecks = run.units.flatMap((u) => u.checks.filter((c) => c.pass === false).map((c) => `- ${u.unit}: ${checkLabel(c.kind)} ${c.subject}`));
  if (failedChecks.length > 0) out.push("**Expectations not met**", "", ...failedChecks, "");
  const problems = run.units.flatMap((u) => [
    ...(u.failed ? [`- ${u.unit}: failed — ${u.failed}`] : []),
    ...(u.stale ? [`- ${u.unit}: stale (incomplete coverage)`] : []),
    ...u.missedEffects.map((e) => `- ${u.unit}: effect not covered at ${e}`),
    ...(u.judgeError ? [`- ${u.unit}: judge error — ${u.judgeError}`] : []),
  ]);
  if (problems.length > 0) out.push("**Validation**", "", ...problems, "");
  const judged = run.units.filter((u) => u.verdict && u.verdict.accuracy !== "correct");
  if (judged.length > 0) {
    out.push("**Judge findings**", "");
    for (const u of judged) {
      out.push(`- ${u.unit} — ${u.verdict!.accuracy}`);
      for (const i of u.verdict!.issues) out.push(`  - ${i.severity}: ${i.text}`);
    }
    out.push("");
  }
  if (run.churn) {
    const c = run.churn;
    out.push(`**Churn** (${c.edits.join("; ")}): ${c.steps.changed} of ${c.steps.unaffected} steps with unchanged code were reworded or dropped, in ${c.updated.length} updated units.`);
    for (const d of c.details) for (const s of d.changed) out.push(`- ${d.unit} ${s.id}: "${s.before}" → ${s.after === null ? "(dropped)" : `"${s.after}"`}`);
    if (c.rewordedUnrelated.length > 0) out.push(`- Reworded by context checks, code unchanged: ${c.rewordedUnrelated.join(", ")}`);
    if (c.failed.length > 0) out.push(`- Failed during sync: ${c.failed.join(", ")}`);
    out.push("");
  }
  return out;
}

function checkLabel(kind: string): string {
  return kind === "mention" ? "does not mention" : kind === "warn" ? "missing warning" : kind === "not-warn" ? "unwanted warning" : "lite should be";
}
