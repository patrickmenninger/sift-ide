import { EDIT_TARGETS, type EditCheck, type EditConfigSummary, type EditEvalResult, type EditRunResult, type Rate } from "./edit-eval.js";

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const sd = (n: number | null) => (n === null ? "–" : `±${Math.round(n * 100)}`);
const rate = (r: Rate | null) => (r === null || r.rate === null ? "–" : `${pct(r.rate)} (${r.passed}/${r.of})`);

/** The Markdown summary of an edit evaluation (phase-2-design §9). */
export function renderEditMarkdown(r: EditEvalResult): string {
  const out: string[] = [];
  out.push(`# Edit evaluation: ${r.fixture}`, "");
  out.push(`- Started ${r.startedAt}; commit ${r.commit ? `${r.commit.sha}${r.commit.dirty ? " (with uncommitted changes)" : ""}` : "unknown"}`);
  out.push(`- Provider ${r.provider}; prompts ${Object.values(r.prompts).join(", ")}`);
  out.push(r.judge ? `- Judge ${r.judge.model}${r.judge.selfGraded ? " — **self-graded**: same vendor as the models tested; weigh type-checks, targeting, and rewording (deterministic) more" : ""}` : "- No judge: intent, mentions, and question recall were not scored");
  out.push("", "| Config | Models (plan / code / update / verify) | Type-checks | Targeted | Intent acceptable | Wrong | Question recall | Unneeded questions | Reword | Mentions | Variance (targeted / acc.) | Cost / edit | Latency (mean / p95) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.summary) out.push(row(s));
  out.push(
    "",
    `Targets (§9): type-checks ${pct(EDIT_TARGETS.typeChecks)}, targeted ≥ ${pct(EDIT_TARGETS.targeted)}, intent acceptable ≥ ${pct(EDIT_TARGETS.acceptable)} with none wrong, question recall ≥ ${pct(EDIT_TARGETS.recall)}, reword ${pct(EDIT_TARGETS.reword)}.`,
    "Targeted: the units whose code changed are exactly the expected ones. Unneeded questions: cases that needed none but asked (lower is better). Cost is at API prices; latency is the AI time per edit, judge excluded.",
    "",
  );
  for (const s of r.summary) {
    const missed = targetsMissed(s);
    out.push(`**${s.config}**: ${missed.length === 0 ? "meets every target." : `misses ${missed.join("; ")}.`}`);
  }
  out.push("");
  for (const run of r.runs) out.push(...runSection(run, r.runs.length > 1));
  return `${out.join("\n")}\n`;
}

/** The §9 targets a configuration misses (metrics that were not measured are not counted). */
export function targetsMissed(s: EditConfigSummary): string[] {
  const missed: string[] = [];
  const below = (name: string, value: number | null, target: number) => {
    if (value !== null && value < target - 1e-9) missed.push(`${name} ${pct(value)} < ${pct(target)}`);
  };
  below("type-checks", s.typeChecks, EDIT_TARGETS.typeChecks);
  below("targeted", s.targeted, EDIT_TARGETS.targeted);
  below("intent acceptable", s.acceptable, EDIT_TARGETS.acceptable);
  if (s.acceptable !== null && s.wrong > EDIT_TARGETS.wrong) missed.push(`${s.wrong} judged wrong`);
  below("question recall", s.recall, EDIT_TARGETS.recall);
  below("reword", s.reword, EDIT_TARGETS.reword);
  return missed;
}

function row(s: EditConfigSummary): string {
  const m = s.models;
  return [
    `${s.config}${s.runs > 1 ? ` (×${s.runs})` : ""}`,
    [m["edit-plan"], m["edit-code"], m.update, m["edit-verify"]].join(" / "),
    pct(s.typeChecks),
    pct(s.targeted),
    pct(s.acceptable),
    s.acceptable === null ? "–" : s.wrong.toFixed(s.runs > 1 ? 1 : 0),
    pct(s.recall),
    pct(s.unneeded),
    pct(s.reword),
    pct(s.mentions),
    `${sd(s.runs > 1 ? s.variance.targeted : null)} / ${sd(s.runs > 1 ? s.variance.acceptable : null)}`,
    `$${s.costPerEdit.toFixed(3)}`,
    `${(s.latencyMs.mean / 1000).toFixed(0)}s / ${(s.latencyMs.p95 / 1000).toFixed(0)}s`,
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function runSection(run: EditRunResult, numbered: boolean): string[] {
  const m = run.metrics;
  const out = [`## ${run.config}${numbered ? ` #${run.repeat}` : ""}`, ""];
  out.push(
    `${m.cases} cases: ${m.ready} ready for review, ${m.failed} failed, ${m.errors} not run. ` +
      `Type-checks ${rate(m.typeChecks)}, targeted ${rate(m.targeted)}, reword ${rate(m.reword)}, question recall ${rate(m.recall)}, unneeded questions ${rate(m.unneeded)}, mentions ${rate(m.mentions)}${m.mentions.unjudged > 0 ? ` (${m.mentions.unjudged} not judged)` : ""}.`,
  );
  if (m.intent) out.push(`Judge: ${m.intent.correct} correct, ${m.intent.minor} minor issues, ${m.intent.wrong} wrong.`);
  const tasks = Object.entries(m.tasks).map(([t, v]) => `${t} ${v!.calls} × ${(v!.meanMs / 1000).toFixed(0)}s`);
  out.push(`AI calls: ${run.usage.generate.calls} describe, ${run.usage.edits.calls} editing (${tasks.join(", ")}), ${run.usage.judge.calls} judge; $${(run.usage.generate.costUsd + run.usage.edits.costUsd + run.usage.judge.costUsd).toFixed(2)} at API prices.`, "");

  out.push("| Case | Outcome | Checks | Intent | Cost | Time |", "|---|---|---|---|---|---|");
  for (const c of run.cases) {
    const judged = c.checks.filter((k) => k.pass !== null);
    out.push(
      `| ${c.id} | ${c.state}${c.kind ? ` (${c.kind})` : ""} | ${judged.filter((k) => k.pass).length}/${judged.length} | ${c.verdict?.intent ?? "–"} | $${c.usage.costUsd.toFixed(2)} | ${(c.usage.durationMs / 1000).toFixed(0)}s |`,
    );
  }
  out.push("");

  const failed = run.cases.flatMap((c) => c.checks.filter((k) => k.pass === false).map((k) => `- ${c.id}: ${checkLabel(k)}${k.detail ? ` — ${k.detail}` : ""}`));
  if (failed.length > 0) out.push("**Checks not met**", "", ...failed, "");
  const findings = run.cases.filter((c) => (c.verdict && c.verdict.issues.length > 0) || c.judgeError || (c.verify && (!c.verify.satisfied || c.verify.unrequested.length > 0)));
  if (findings.length > 0) {
    out.push("**Findings**", "");
    for (const c of findings) {
      out.push(`- ${c.id}${c.verdict?.intent ? ` — ${c.verdict.intent}` : ""}`);
      for (const i of c.verdict?.issues ?? []) out.push(`  - judge, ${i.severity}: ${i.text}`);
      if (c.judgeError) out.push(`  - judge error: ${c.judgeError}`);
      for (const g of c.verify?.gaps ?? []) out.push(`  - edit-verify gap: ${g}`);
      for (const u of c.verify?.unrequested ?? []) out.push(`  - edit-verify, not asked for: ${u}`);
    }
    out.push("");
  }
  const asked = run.cases.filter((c) => c.questions.length > 0);
  if (asked.length > 0) {
    out.push("**Questions asked**", "");
    for (const c of asked) for (const q of c.questions) out.push(`- ${c.id} (round ${q.round}): ${q.text}`);
    out.push("");
  }
  return out;
}

function checkLabel(k: EditCheck): string {
  switch (k.kind) {
    case "kind":
      return `plan should be ${k.subject}`;
    case "reword":
      return `rewording should be ${k.subject}`;
    case "targeted":
      return `should change exactly ${k.subject}`;
    case "broader":
      return k.subject === "true" ? "should be flagged as reaching beyond the unit" : "should not reach beyond the unit";
    case "type-checks":
      return "does not type-check";
    case "effect-added":
      return `should add effect ${k.subject}`;
    case "effect-removed":
      return `should remove effect ${k.subject}`;
    case "asks":
      return `should ask ${k.subject}`;
    case "no-questions":
      return "asked questions that were not needed";
    case "mention":
      return `does not ${k.subject}`;
  }
}
