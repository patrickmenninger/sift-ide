import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadModelMap,
  loadPrompt,
  renderRequest,
  Router,
  SiftError,
  unitText,
  Workspace,
  type ChangeRequest,
  type EditState,
  type LanguageAdapter,
  type Provider,
  type Task,
} from "@sift/core";
import { caseEdits, loadEditCases, type EditCase } from "./edit-cases.js";
import { judgeEdit, type EditVerdict } from "./edit-judge.js";
import type { MatrixConfig } from "./files.js";
import { renderDescription } from "./judge.js";
import { mean, percentile, stddev } from "./metrics.js";
import { copyFixture, gitInfo, pct, semaphore, type Usage } from "./run.js";

/**
 * The edit evaluation (phase-2-design §9): describe a copy of the fixture, run each scripted change
 * request through the edit pipeline up to review (nothing is applied), and score the proposals.
 */

export interface EditEvalOptions {
  evalDir: string;
  fixture: string;
  adapters: LanguageAdapter[];
  builtinRulesDir: string;
  provider: Provider;
  configs: MatrixConfig[];
  repeat: number;
  judge: boolean;
  /** Run only these case IDs. */
  only?: string[];
  /** The cases to run instead of eval/edits/<fixture>.yaml (tests). */
  cases?: EditCase[];
  nodeModules?: string;
  onProgress?: (line: string) => void;
}

/** The editing tasks, and `update` (the re-derivation). */
export const EDIT_TASKS = ["edit-plan", "edit-code", "update", "edit-verify"] as const satisfies readonly Task[];

/** §9 exit targets. */
export const EDIT_TARGETS = { typeChecks: 1, targeted: 0.9, acceptable: 0.85, wrong: 0, recall: 0.8, reword: 1 } as const;

export interface EditCheck {
  kind: "kind" | "reword" | "targeted" | "broader" | "type-checks" | "effect-added" | "effect-removed" | "asks" | "no-questions" | "mention";
  subject: string;
  /** null when it needs the judge and the judge did not run. */
  pass: boolean | null;
  detail?: string;
}

export interface EditCaseResult {
  id: string;
  unit: string;
  /** The request's final state, or "error" when the case could not be set up or run. */
  state: EditState | "error";
  kind: string | null;
  interpretation?: string;
  error?: string;
  /** Every question asked, by round, with the answer given. */
  questions: { round: number; text: string; answer?: string }[];
  changed: string[];
  broader: boolean;
  typeChecks: boolean | null;
  effects: { added: string[]; removed: string[] };
  verify: { satisfied: boolean; gaps: string[]; unrequested: string[] } | null;
  diff: string;
  checks: EditCheck[];
  verdict?: EditVerdict;
  judgeError?: string;
  usage: { costUsd: number; calls: number; inputTokens: number; outputTokens: number; durationMs: number; tasks: Partial<Record<Task, { calls: number; durationMs: number }>> };
}

export interface Rate {
  passed: number;
  of: number;
  rate: number | null;
}

export interface EditRunMetrics {
  cases: number;
  ready: number;
  failed: number;
  errors: number;
  typeChecks: Rate;
  targeted: Rate;
  intent: { correct: number; minor: number; wrong: number; judged: number; acceptable: number } | null;
  /** Expected questions asked (judged). */
  recall: Rate | null;
  /** Cases where no question was expected but one was asked: lower is better. */
  unneeded: Rate;
  reword: Rate;
  mentions: Rate & { unjudged: number };
  checks: Rate;
  costPerEdit: number;
  latencyMs: { mean: number; p95: number };
  tasks: Partial<Record<Task, { calls: number; meanMs: number }>>;
}

export interface EditRunResult {
  config: string;
  repeat: number;
  models: Partial<Record<Task, string>>;
  metrics: EditRunMetrics;
  cases: EditCaseResult[];
  usage: { generate: Usage; edits: Usage; judge: Usage };
}

export interface EditConfigSummary {
  config: string;
  models: Partial<Record<Task, string>>;
  runs: number;
  typeChecks: number | null;
  targeted: number | null;
  acceptable: number | null;
  wrong: number;
  recall: number | null;
  unneeded: number | null;
  reword: number | null;
  mentions: number | null;
  variance: { targeted: number; acceptable: number | null };
  costPerEdit: number;
  latencyMs: { mean: number; p95: number };
}

export interface EditEvalResult {
  version: 1;
  kind: "edits";
  fixture: string;
  startedAt: string;
  finishedAt: string;
  commit: { sha: string; dirty: boolean } | null;
  prompts: Partial<Record<Task, string>>;
  provider: string;
  judge: { model: string; selfGraded: boolean } | null;
  summary: EditConfigSummary[];
  runs: EditRunResult[];
}

export async function runEditEval(o: EditEvalOptions): Promise<EditEvalResult> {
  const startedAt = new Date().toISOString();
  const say = o.onProgress ?? (() => {});
  const fixtureDir = join(o.evalDir, "fixtures", o.fixture);
  if (!existsSync(fixtureDir)) throw new SiftError("SOURCE_NOT_FOUND", `No fixture "${o.fixture}" in ${join(o.evalDir, "fixtures")}.`);
  let cases = o.cases ?? (await loadEditCases(o.evalDir, o.fixture));
  if (o.only && o.only.length > 0) {
    const unknown = o.only.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) throw new SiftError("CONFIG_INVALID", `No edit case ${unknown.join(", ")}.`, cases.map((c) => c.id));
    cases = cases.filter((c) => o.only!.includes(c.id));
  }
  const judgeRoute = new Router(await loadModelMap(o.provider.id), { models: { tasks: {}, tiers: {} } }).route("edit-judge");

  const runs: EditRunResult[] = [];
  for (const config of o.configs) {
    for (let r = 1; r <= o.repeat; r++) {
      say(`[${config.name}${o.repeat > 1 ? ` #${r}` : ""}]`);
      runs.push(await runOnce(o, config, r, fixtureDir, cases, judgeRoute, say));
    }
  }
  const prompts: Partial<Record<Task, string>> = {};
  for (const task of [...EDIT_TASKS, "edit-judge"] as Task[]) prompts[task] = (await loadPrompt(task)).id;
  return {
    version: 1,
    kind: "edits",
    fixture: o.fixture,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: await gitInfo(o.evalDir),
    prompts,
    provider: o.provider.id,
    judge: o.judge ? { model: judgeRoute.choice.model, selfGraded: judgeRoute.choice.provider === o.provider.id } : null,
    summary: o.configs.map((c) => summarizeEdits(c.name, runs.filter((run) => run.config === c.name))),
    runs,
  };
}

async function runOnce(
  o: EditEvalOptions,
  config: MatrixConfig,
  repeat: number,
  fixtureDir: string,
  cases: EditCase[],
  judgeRoute: ReturnType<Router["route"]>,
  say: (line: string) => void,
): Promise<EditRunResult> {
  const { dir, cleanup } = await copyFixture(fixtureDir, o.fixture, o.nodeModules);
  try {
    const tiers = Object.entries(config.tasks);
    if (tiers.length > 0) await appendFile(join(dir, "sift.config.yaml"), `\nmodels:\n  tasks:\n${tiers.map(([t, tier]) => `    ${t}: ${tier}`).join("\n")}\n`);
    const ws = await Workspace.open({ cwd: dir, adapters: o.adapters, builtinRulesDir: o.builtinRulesDir, provider: o.provider });
    try {
      const { router } = await ws.router();
      const models: Partial<Record<Task, string>> = {};
      for (const task of EDIT_TASKS) models[task] = router.route(task).choice.model;

      say("  describing the fixture…");
      const generated = await ws.generate({ onEvent: (e) => e.type === "failed" && say(`  ✗ ${e.unit}: ${e.reason}`) });
      const limit = semaphore(ws.config.concurrency);
      const judgeUsage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const results = await Promise.all(
        cases.map((c) =>
          limit(async () => {
            const { result, req } = await runCase(ws, c);
            if (o.judge && req) await judgeCase(o.provider, judgeRoute, ws, c, req, result, judgeUsage);
            // Leave nothing open in the copy.
            if (req && ["draft", "needs-answers", "ready", "failed", "needs-review"].includes(req.state)) await ws.edits.reject(req.id).catch(() => {});
            result.checks = caseChecks(c, result);
            const failed = result.checks.filter((k) => k.pass === false).length;
            say(`  ${c.id}: ${result.state}${result.kind ? ` (${result.kind})` : ""}${result.verdict?.intent ? `, ${result.verdict.intent}` : ""}${failed > 0 ? `, ${failed} check${failed === 1 ? "" : "s"} failed` : ""}`);
            return result;
          }),
        ),
      );
      const editUsage = results.reduce<Usage>(
        (u, r) => ({ calls: u.calls + r.usage.calls, inputTokens: u.inputTokens + r.usage.inputTokens, outputTokens: u.outputTokens + r.usage.outputTokens, costUsd: u.costUsd + r.usage.costUsd }),
        { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      );
      const metrics = editMetrics(cases, results);
      say(
        `  type-checks ${rate(metrics.typeChecks)} · targeted ${rate(metrics.targeted)}` +
          `${metrics.intent ? ` · intent acceptable ${pct(metrics.intent.acceptable)} (${metrics.intent.wrong} wrong)` : ""}` +
          `${metrics.recall ? ` · question recall ${rate(metrics.recall)}` : ""} · reword ${rate(metrics.reword)}`,
      );
      return { config: config.name, repeat, models, metrics, cases: results, usage: { generate: generated.usage, edits: editUsage, judge: judgeUsage } };
    } finally {
      ws.dispose();
    }
  } finally {
    await cleanup();
  }
}

/** Run one case up to review: create, propose, answer questions (at most three rounds), and record the outcome. */
async function runCase(ws: Workspace, c: EditCase): Promise<{ result: EditCaseResult; req: ChangeRequest | undefined }> {
  const result: EditCaseResult = {
    id: c.id,
    unit: c.unit,
    state: "error",
    kind: null,
    questions: [],
    changed: [],
    broader: false,
    typeChecks: null,
    effects: { added: [], removed: [] },
    verify: null,
    diff: "",
    checks: [],
    usage: { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, tasks: {} },
  };
  let req: ChangeRequest | undefined;
  try {
    const file = c.unit.slice(0, c.unit.indexOf("#"));
    const symbol = c.unit.slice(file.length + 1);
    const { unit: description } = await ws.unit(c.unit);
    const code = (await ws.extraction(file)).units.find((u) => u.symbol === symbol);
    if (!code) throw new SiftError("SOURCE_NOT_FOUND", `${c.unit} is not in the code.`);
    const edits = caseEdits(c, description, code);
    req = await ws.edits.create({ unit: c.unit, edits, ...(c.request ? { request: c.request } : {}) });
    req = await ws.edits.propose(req.id);
    let round = 0;
    while (req.state === "needs-answers") {
      round++;
      const answer = c.answers.length > 0 ? c.answers.join(" ") : "Do what the project already does; keep the change as small as possible.";
      for (const q of req.questions ?? []) result.questions.push({ round, text: q.text, answer });
      req = await ws.edits.answer(req.id, (req.questions ?? []).map((q) => ({ questionId: q.id, answer })));
      req = await ws.edits.propose(req.id);
    }
  } catch (err) {
    if (err instanceof SiftError && err.code === "PROVIDER_AUTH") throw err;
    result.error = err instanceof Error ? err.message : String(err);
  }
  if (!req) return { result, req };
  result.state = req.state;
  result.kind = req.proposal?.kind ?? req.plan?.kind ?? null;
  if (req.plan) result.interpretation = req.plan.interpretation;
  if (req.error) result.error = [req.error.message, ...req.error.details].join(" ");
  result.usage = {
    costUsd: req.usage.costUsd,
    calls: req.usage.calls,
    inputTokens: req.usage.inputTokens,
    outputTokens: req.usage.outputTokens,
    durationMs: Object.values(req.usage.tasks).reduce((n, t) => n + (t?.durationMs ?? 0), 0),
    tasks: req.usage.tasks,
  };
  const p = req.proposal;
  if (p) {
    result.changed = p.scope.changed;
    result.broader = p.scope.broader !== null;
    const tc = p.checks.find((k) => k.kind === "type-check");
    if (p.kind === "behavior") result.typeChecks = tc ? tc.status === "passed" : null;
    result.effects = { added: [...p.effects.added], removed: [...p.effects.removed] };
    result.verify = p.verify;
    result.diff = p.files.map((f) => f.diff).join("\n");
  } else if (req.state === "failed" && /does not (parse|type-check)/.test(req.error?.message ?? "")) {
    result.typeChecks = false;
  }
  return { result, req };
}

async function judgeCase(provider: Provider, route: ReturnType<Router["route"]>, ws: Workspace, c: EditCase, req: ChangeRequest, r: EditCaseResult, usage: Usage): Promise<void> {
  const behavior = r.kind === "behavior" && r.diff !== "";
  if (!behavior && c.expect.asks.length === 0) return;
  const code = (await ws.extraction(req.file)).units.find((u) => u.symbol === req.symbol);
  if (!code) return;
  const fileText = await readFile(join(ws.root, req.file), "utf8");
  const after = req.proposal?.units.find((u) => u.ref === c.unit)?.after;
  const outcome = await judgeEdit(
    provider,
    route,
    {
      file: req.file,
      symbol: req.symbol,
      kind: code.kind,
      code: unitText(fileText, code),
      request: renderRequest(req.edits, req.request, req.answers, req.base.description),
      questions: r.questions.map((q) => ({ text: q.text, ...(q.answer ? { answer: q.answer } : {}) })),
      diffs: behavior ? [r.diff] : [],
      description: behavior && after ? renderDescription(after) : null,
      ideas: behavior ? c.expect.mustMention : [],
      asks: c.expect.asks,
    },
    usage,
  );
  if ("verdict" in outcome) r.verdict = outcome.verdict;
  else r.judgeError = outcome.error;
}

/** The checks of one case against its expectations. */
export function caseChecks(c: EditCase, r: EditCaseResult): EditCheck[] {
  const e = c.expect;
  const checks: EditCheck[] = [];
  const ready = r.state === "ready";
  const behavior = ready && r.kind === "behavior";
  const outcome = `${r.state}${r.kind ? ` (${r.kind})` : ""}${r.error ? `: ${r.error}` : ""}`;
  if (e.kind) checks.push({ kind: "kind", subject: e.kind, pass: r.kind === e.kind, detail: outcome });
  if (e.reword !== undefined) {
    const accepted = ready && r.kind === "reword";
    checks.push({ kind: "reword", subject: e.reword ? "accepted" : "not accepted", pass: accepted === e.reword, detail: outcome });
  }
  if (e.changedUnits) {
    const same = behavior && r.changed.length === e.changedUnits.length && e.changedUnits.every((u) => r.changed.includes(u));
    checks.push({ kind: "targeted", subject: e.changedUnits.join(", "), pass: same, detail: behavior ? `changed ${r.changed.join(", ") || "nothing"}` : outcome });
  }
  if (e.broader !== undefined) checks.push({ kind: "broader", subject: String(e.broader), pass: behavior && r.broader === e.broader, detail: behavior ? `broader: ${r.broader}` : outcome });
  if (r.typeChecks !== null) checks.push({ kind: "type-checks", subject: "no new diagnostics", pass: r.typeChecks, ...(r.typeChecks ? {} : { detail: r.error ?? "" }) });
  for (const fx of e.effectsAdded) checks.push({ kind: "effect-added", subject: fx, pass: behavior && r.effects.added.includes(fx) });
  for (const fx of e.effectsRemoved) checks.push({ kind: "effect-removed", subject: fx, pass: behavior && r.effects.removed.includes(fx) });
  const firstRound = r.questions.filter((q) => q.round === 1);
  e.asks.forEach((topic, i) => {
    const v = r.verdict?.asks[i];
    checks.push({ kind: "asks", subject: topic, pass: r.questions.length === 0 ? false : v ? v.asked : null, ...(v?.question ? { detail: v.question } : {}) });
  });
  if (e.asks.length === 0 && !e.questionsOk) checks.push({ kind: "no-questions", subject: "none needed", pass: firstRound.length === 0, ...(firstRound.length > 0 ? { detail: firstRound.map((q) => q.text).join(" | ") } : {}) });
  e.mustMention.forEach((idea, i) => {
    const v = r.verdict?.ideas[i];
    const judged = r.verdict !== undefined && r.verdict.intent !== null;
    checks.push({ kind: "mention", subject: idea, pass: !behavior || r.diff === "" ? false : judged && v ? v.present : null, ...(v?.where ? { detail: v.where } : {}) });
  });
  return checks;
}

function ratio(passed: number, of: number): Rate {
  return { passed, of, rate: of === 0 ? null : passed / of };
}

export function editMetrics(cases: EditCase[], results: EditCaseResult[]): EditRunMetrics {
  const all = results.flatMap((r) => r.checks);
  const of = (kind: EditCheck["kind"]) => all.filter((k) => k.kind === kind && k.pass !== null);
  const passed = (list: EditCheck[]) => list.filter((k) => k.pass).length;
  const verdicts = results.flatMap((r) => (r.verdict?.intent ? [r.verdict.intent] : []));
  const count = (v: EditVerdict["intent"]) => verdicts.filter((x) => x === v).length;
  const asks = all.filter((k) => k.kind === "asks");
  const mentions = all.filter((k) => k.kind === "mention");
  const durations = results.filter((r) => r.state !== "error").map((r) => r.usage.durationMs);
  const tasks: EditRunMetrics["tasks"] = {};
  for (const r of results) {
    for (const [task, t] of Object.entries(r.usage.tasks) as [Task, { calls: number; durationMs: number }][]) {
      const acc = (tasks[task] ??= { calls: 0, meanMs: 0 });
      acc.meanMs += t.durationMs; // summed here, divided below
      acc.calls += t.calls;
    }
  }
  for (const t of Object.values(tasks)) t!.meanMs = t!.calls === 0 ? 0 : Math.round(t!.meanMs / t!.calls);
  const noQuestions = of("no-questions");
  const judged = all.filter((k) => k.pass !== null);
  return {
    cases: cases.length,
    ready: results.filter((r) => r.state === "ready").length,
    failed: results.filter((r) => r.state === "failed").length,
    errors: results.filter((r) => r.state === "error").length,
    typeChecks: ratio(passed(of("type-checks")), of("type-checks").length),
    targeted: ratio(passed(of("targeted")), of("targeted").length),
    intent: verdicts.length === 0 ? null : { correct: count("correct"), minor: count("minor-issues"), wrong: count("wrong"), judged: verdicts.length, acceptable: (count("correct") + count("minor-issues")) / verdicts.length },
    recall: asks.length === 0 || asks.some((k) => k.pass === null) ? null : ratio(passed(asks), asks.length),
    unneeded: ratio(noQuestions.length - passed(noQuestions), noQuestions.length),
    reword: ratio(passed(of("reword")), of("reword").length),
    mentions: { ...ratio(passed(mentions.filter((k) => k.pass !== null)), mentions.filter((k) => k.pass !== null).length), unjudged: mentions.filter((k) => k.pass === null).length },
    checks: ratio(passed(judged), judged.length),
    costPerEdit: results.length === 0 ? 0 : results.reduce((n, r) => n + r.usage.costUsd, 0) / results.length,
    latencyMs: { mean: Math.round(mean(durations)), p95: Math.round(percentile(durations, 95)) },
    tasks,
  };
}

export function summarizeEdits(config: string, runs: EditRunResult[]): EditConfigSummary {
  const rates = (f: (m: EditRunMetrics) => number | null | undefined) => runs.map((r) => f(r.metrics)).filter((v): v is number => typeof v === "number");
  const avg = (values: number[]) => (values.length === 0 ? null : mean(values));
  const targeted = rates((m) => m.targeted.rate);
  const acceptable = rates((m) => m.intent?.acceptable);
  return {
    config,
    models: runs[0]?.models ?? {},
    runs: runs.length,
    typeChecks: avg(rates((m) => m.typeChecks.rate)),
    targeted: avg(targeted),
    acceptable: avg(acceptable),
    wrong: mean(rates((m) => m.intent?.wrong ?? 0)),
    recall: avg(rates((m) => m.recall?.rate)),
    unneeded: avg(rates((m) => m.unneeded.rate)),
    reword: avg(rates((m) => m.reword.rate)),
    mentions: avg(rates((m) => m.mentions.rate)),
    variance: { targeted: stddev(targeted), acceptable: acceptable.length > 0 ? stddev(acceptable) : null },
    costPerEdit: mean(rates((m) => m.costPerEdit)),
    latencyMs: { mean: Math.round(mean(rates((m) => m.latencyMs.mean))), p95: Math.round(mean(rates((m) => m.latencyMs.p95))) },
  };
}

function rate(r: Rate): string {
  return r.rate === null ? "–" : `${pct(r.rate)} (${r.passed}/${r.of})`;
}
