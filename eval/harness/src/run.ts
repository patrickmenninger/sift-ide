import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  flatten,
  generate,
  loadModelMap,
  loadProject,
  loadPrompt,
  loadRulePacks,
  planSync,
  Router,
  RuleSet,
  SiftError,
  TASKS,
  unitId,
  type CodeGraph,
  type ExtractedUnit,
  type GenerateEvent,
  type GenerateReport,
  type LanguageAdapter,
  type Provider,
  type SiftUnit,
  type Task,
} from "@sift/core";
import { applyEdits, loadChurnEdits, loadExpectations, type MatrixConfig, type UnitExpectation } from "./files.js";
import { judgeUnit, renderJudgeInput, type JudgeCallee, type Verdict } from "./judge.js";
import { expectationChecks, mean, missedEffects, percentile, prose, STANDARD_WARNINGS, stddev, stepChurn, type Check, type UnitChurn } from "./metrics.js";

export interface EvalOptions {
  /** The repository's eval/ folder: fixtures/, expectations/, churn/, results/. */
  evalDir: string;
  fixture: string;
  adapters: LanguageAdapter[];
  builtinRulesDir: string;
  provider: Provider;
  configs: MatrixConfig[];
  repeat: number;
  judge: boolean;
  churn: boolean;
  /** Linked into each fixture copy as node_modules, for types such as @types/node. */
  nodeModules?: string;
  onProgress?: (line: string) => void;
}

export interface UnitResult {
  unit: string;
  task?: Task;
  model?: string;
  lite: boolean;
  attempts?: number;
  stale: boolean;
  failed?: string;
  warnings: string[];
  missedEffects: string[];
  durationMs?: number;
  checks: Check[];
  verdict?: Verdict;
  judgeError?: string;
}

export interface RunMetrics {
  units: number;
  failed: number;
  stale: number;
  firstTry: number;
  /** Units written complete, of all units (design §13.3). */
  coverage: number;
  /** Units that passed validation (possibly stale), of all units. */
  valid: number;
  missedEffects: number;
  expectations: { passed: number; checked: number; rate: number; unjudged: number };
  accuracy: { correct: number; minor: number; wrong: number; judged: number; rate: number; acceptable: number } | null;
  warnings: { total: number; standard: number };
  costPerUnit: number;
  latencyMs: { mean: number; p95: number };
}

export interface ChurnResult {
  edits: string[];
  /** Units whose code the edits changed. */
  updated: string[];
  steps: { unaffected: number; changed: number; rate: number };
  details: UnitChurn[];
  /** Units whose code did not change but whose wording did (context checks). */
  rewordedUnrelated: string[];
  failed: string[];
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunResult {
  config: string;
  repeat: number;
  models: Partial<Record<Task, string>>;
  metrics: RunMetrics;
  units: UnitResult[];
  churn?: ChurnResult;
  usage: { generate: Usage; judge: Usage; churn: Usage };
}

export interface ConfigSummary {
  config: string;
  models: Partial<Record<Task, string>>;
  runs: number;
  coverage: number;
  missedEffects: number;
  expectations: number;
  accuracy: number | null;
  acceptable: number | null;
  churn: number | null;
  variance: { expectations: number; accuracy: number | null };
  costPerUnit: number;
  latencyMs: { mean: number; p95: number };
}

export interface EvalResult {
  version: 1;
  fixture: string;
  startedAt: string;
  finishedAt: string;
  commit: { sha: string; dirty: boolean } | null;
  prompts: Partial<Record<Task, string>>;
  provider: string;
  judge: { model: string; selfGraded: boolean } | null;
  summary: ConfigSummary[];
  runs: RunResult[];
}

/** Run the evaluation (design §13): every configuration, `repeat` times, on a fresh copy of the fixture. */
export async function runEval(o: EvalOptions): Promise<EvalResult> {
  const startedAt = new Date().toISOString();
  const say = o.onProgress ?? (() => {});
  const fixtureDir = join(o.evalDir, "fixtures", o.fixture);
  if (!existsSync(fixtureDir)) throw new SiftError("SOURCE_NOT_FOUND", `No fixture "${o.fixture}" in ${join(o.evalDir, "fixtures")}.`);
  const expectations = await loadExpectations(o.evalDir, o.fixture);
  const edits = o.churn ? await loadChurnEdits(o.evalDir, o.fixture) : [];
  const modelMap = await loadModelMap(o.provider.id);
  const judgeRoute = new Router(modelMap, { models: { tasks: {}, tiers: {} } }).route("judge");

  const runs: RunResult[] = [];
  for (const config of o.configs) {
    for (let r = 1; r <= o.repeat; r++) {
      say(`[${config.name}${o.repeat > 1 ? ` #${r}` : ""}]`);
      runs.push(await runOnce(o, config, r, fixtureDir, expectations.units, edits, judgeRoute, say));
    }
  }

  const prompts: Partial<Record<Task, string>> = {};
  for (const task of TASKS) prompts[task] = (await loadPrompt(task)).id;
  return {
    version: 1,
    fixture: o.fixture,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: await gitInfo(o.evalDir),
    prompts,
    provider: o.provider.id,
    judge: o.judge ? { model: judgeRoute.choice.model, selfGraded: judgeRoute.choice.provider === o.provider.id } : null,
    summary: o.configs.map((c) => summarize(c.name, runs.filter((run) => run.config === c.name))),
    runs,
  };
}

async function runOnce(
  o: EvalOptions,
  config: MatrixConfig,
  repeat: number,
  fixtureDir: string,
  expectations: UnitExpectation[],
  edits: Awaited<ReturnType<typeof loadChurnEdits>>,
  judgeRoute: ReturnType<Router["route"]>,
  say: (line: string) => void,
): Promise<RunResult> {
  const dir = join(await mkdtemp(join(tmpdir(), "sift-eval-")), o.fixture);
  // Copy the fixture with its project rule packs (.sift/rules), but no descriptions, cache, or node_modules.
  const skip = (src: string) => /[\\/](node_modules|\.cache)$/.test(src) || (/\.sift$/.test(src) && !/[\\/]\.sift$/.test(src));
  await cp(fixtureDir, dir, { recursive: true, filter: (src) => !skip(src) });
  const link = join(dir, "node_modules");
  if (o.nodeModules) await symlink(o.nodeModules, link, "junction");
  try {
    const project = await loadProject(dir);
    const settings = { ...project.config, models: { tasks: { ...config.tasks }, tiers: {} } };
    const modelMap = await loadModelMap(o.provider.id);
    const router = new Router(modelMap, settings);
    const rules = new RuleSet((await loadRulePacks(dir, { builtinDir: o.builtinRulesDir })).packs);
    const base = { root: dir, config: settings, adapters: o.adapters, rules, provider: o.provider, router };
    const models: Partial<Record<Task, string>> = {};
    for (const task of ["describe", "describe-lite", "update", "context-check"] as Task[]) models[task] = router.route(task).choice.model;

    // 1. Describe everything.
    const durations = new Map<string, number>();
    const onEvent = (e: GenerateEvent) => {
      if (e.type === "described") durations.set(e.unit, e.durationMs);
      if (e.type === "failed") say(`  ✗ ${e.unit}: ${e.reason}`);
    };
    say("  generating…");
    const report = await generate({ ...base, onEvent });
    const snapshot = await describedState(base);

    // 2. Score: deterministic metrics, then the judge.
    const byUnit = new Map(expectations.map((e) => [e.unit, e]));
    const judgeUsage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const units: UnitResult[] = [];
    for (const [ref, { code }] of snapshot.code) {
      const described = snapshot.described.get(ref);
      const planned = report.planned.find((p) => p.unit === ref);
      const run = report.described.find((d) => d.unit === ref);
      const failed = report.failed.find((f) => f.unit === ref);
      const result: UnitResult = {
        unit: ref,
        lite: described?.lite ?? false,
        stale: described?.status === "stale",
        warnings: (described?.warnings ?? []).map((w) => w.kind),
        missedEffects: described ? missedEffects(described, code, rules) : [],
        checks: [],
      };
      if (planned) (result.task = planned.task), (result.model = described?.generatedBy?.model ?? planned.route.choice.model);
      if (run) result.attempts = run.attempts;
      if (failed) result.failed = `${failed.reason}${failed.problems.length > 0 ? `: ${failed.problems.join(" ")}` : ""}`;
      const ms = durations.get(ref);
      if (ms !== undefined) result.durationMs = ms;
      units.push(result);
    }
    if (o.judge) {
      say(`  judging ${snapshot.described.size} descriptions with ${judgeRoute.choice.model}…`);
      const limit = semaphore(settings.concurrency);
      await Promise.all(
        units.map((u) =>
          limit(async () => {
            const described = snapshot.described.get(u.unit);
            if (!described) return;
            const { code, file } = snapshot.code.get(u.unit)!;
            const ideas = byUnit.get(u.unit)?.mustMention ?? [];
            const prompt = renderJudgeInput(file, code, await readFile(join(dir, file), "utf8"), described, ideas, judgeCallees(code, u.unit, snapshot));
            const outcome = await judgeUnit(o.provider, judgeRoute, prompt, ideas, judgeUsage);
            if ("verdict" in outcome) u.verdict = outcome.verdict;
            else u.judgeError = outcome.error;
          }),
        ),
      );
    }
    for (const e of expectations) {
      const u = units.find((x) => x.unit === e.unit);
      const checks = expectationChecks(e, snapshot.described.get(e.unit), u?.verdict?.ideas ?? null);
      if (u) u.checks = checks;
      else units.push({ unit: e.unit, lite: false, stale: false, warnings: [], missedEffects: [], checks, failed: "not found in the fixture" });
    }

    // 3. Churn: small edits, then sync.
    let churn: ChurnResult | undefined;
    let churnUsage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    if (edits.length > 0) {
      say(`  churn: ${edits.map((e) => e.name).join(", ")}…`);
      await applyEdits(dir, edits);
      const sync = await generate(base);
      churnUsage = sync.usage;
      churn = measureChurn(snapshot, await describedState(base), edits.map((e) => e.name), sync);
    }

    const result: RunResult = {
      config: config.name,
      repeat,
      models,
      metrics: metricsOf(units, report),
      units,
      usage: { generate: report.usage, judge: judgeUsage, churn: churnUsage },
    };
    if (churn) result.churn = churn;
    const m = result.metrics;
    say(
      `  coverage ${pct(m.coverage)} · expectations ${pct(m.expectations.rate)}` +
        `${m.accuracy ? ` · accurate ${pct(m.accuracy.rate)}` : ""}${churn ? ` · churn ${pct(churn.steps.rate)}` : ""}`,
    );
    return result;
  } finally {
    if (o.nodeModules && existsSync(link)) await unlink(link); // remove the link itself, never what it points to
    await rm(join(dir, ".."), { recursive: true, force: true });
  }
}

interface DescribedState {
  graph: CodeGraph;
  /** "file#Symbol" → extracted code. */
  code: Map<string, { code: ExtractedUnit; file: string }>;
  /** "file#Symbol" → description. */
  described: Map<string, SiftUnit>;
}

/** The fixture's code and descriptions as they are now (no AI). */
async function describedState(base: Parameters<typeof planSync>[0]): Promise<DescribedState> {
  const plan = await planSync(base);
  const code = new Map<string, { code: ExtractedUnit; file: string }>();
  for (const file of plan.targets) for (const u of plan.extractions.get(file)!.units) code.set(unitId(file, u.symbol), { code: u, file });
  const described = new Map<string, SiftUnit>();
  for (const [file, sift] of plan.existing) for (const u of sift.units) described.set(unitId(file, u.symbol), u);
  return { graph: plan.graph, code, described };
}

/** The calls a unit makes, with the signatures and summaries the description writer saw. */
function judgeCallees(code: ExtractedUnit, ref: string, state: DescribedState): JudgeCallee[] {
  const out: JudgeCallee[] = [];
  const seen = new Set<string>();
  for (const node of flatten(code.body)) {
    for (const call of node.calls) {
      if (seen.has(call.expression)) continue;
      seen.add(call.expression);
      if (call.external) {
        out.push({ expression: call.expression, target: `library ${call.external.module}: ${call.external.name}` });
        continue;
      }
      if (!call.target) {
        out.push({ expression: call.expression, target: "not resolved (a dynamic call)" });
        continue;
      }
      const target = unitId(call.target.file, call.target.symbol);
      const entry: JudgeCallee = { expression: call.expression, target: call.target.symbol };
      const signature = state.code.get(target)?.code.signature;
      if (signature) entry.signature = signature;
      const summary = target === ref ? undefined : state.described.get(target)?.summary;
      const impls = state.graph.implementers(target).flatMap((i) => {
        const s = state.described.get(i)?.summary;
        return s ? [`${i.slice(i.indexOf("#") + 1)}: ${s}`] : [];
      });
      if (summary) entry.summary = summary;
      else if (impls.length > 0) entry.summary = `implemented by ${impls.join("; ")}`;
      out.push(entry);
    }
  }
  return out;
}

function measureChurn(before: DescribedState, after: DescribedState, edits: string[], sync: GenerateReport): ChurnResult {
  const result: ChurnResult = { edits, updated: [], steps: { unaffected: 0, changed: 0, rate: 0 }, details: [], rewordedUnrelated: [], failed: sync.failed.map((f) => f.unit) };
  for (const [ref, old] of before.described) {
    const now = after.described.get(ref);
    const oldCode = before.code.get(ref)?.code;
    const newCode = after.code.get(ref)?.code;
    if (!now || !oldCode || !newCode) continue;
    if (oldCode.bodyHash !== newCode.bodyHash) {
      result.updated.push(ref);
      const c = stepChurn(ref, old, oldCode, now, newCode);
      result.steps.unaffected += c.unaffected;
      result.steps.changed += c.changed.length;
      result.details.push(c);
    } else if (prose(old) !== prose(now)) result.rewordedUnrelated.push(ref);
  }
  result.steps.rate = result.steps.unaffected === 0 ? 0 : result.steps.changed / result.steps.unaffected;
  return result;
}

function metricsOf(units: UnitResult[], report: GenerateReport): RunMetrics {
  const planned = report.planned.filter((p) => p.action !== "context-check").length;
  const inFixture = units.filter((u) => u.task !== undefined);
  const checks = units.flatMap((u) => u.checks);
  const judged = checks.filter((c) => c.pass !== null);
  const verdicts = inFixture.flatMap((u) => (u.verdict ? [u.verdict] : []));
  const durations = inFixture.flatMap((u) => (u.durationMs !== undefined ? [u.durationMs] : []));
  const warnings = inFixture.flatMap((u) => u.warnings);
  const count = (a: Verdict["accuracy"]) => verdicts.filter((v) => v.accuracy === a).length;
  const stale = inFixture.filter((u) => u.stale && !u.failed).length;
  const failed = report.failed.length;
  return {
    units: planned,
    failed,
    stale,
    firstTry: inFixture.filter((u) => u.attempts === 1).length,
    coverage: planned === 0 ? 0 : (planned - failed - stale) / planned,
    valid: planned === 0 ? 0 : (planned - failed) / planned,
    missedEffects: inFixture.reduce((n, u) => n + u.missedEffects.length, 0),
    expectations: {
      passed: judged.filter((c) => c.pass).length,
      checked: judged.length,
      rate: judged.length === 0 ? 0 : judged.filter((c) => c.pass).length / judged.length,
      unjudged: checks.length - judged.length,
    },
    accuracy:
      verdicts.length === 0
        ? null
        : {
            correct: count("correct"),
            minor: count("minor-issues"),
            wrong: count("wrong"),
            judged: verdicts.length,
            rate: count("correct") / verdicts.length,
            acceptable: (count("correct") + count("minor-issues")) / verdicts.length,
          },
    warnings: { total: warnings.length, standard: warnings.filter((w) => STANDARD_WARNINGS.includes(w)).length },
    costPerUnit: planned === 0 ? 0 : report.usage.costUsd / planned,
    latencyMs: { mean: Math.round(mean(durations)), p95: Math.round(percentile(durations, 95)) },
  };
}

export function summarize(config: string, runs: RunResult[]): ConfigSummary {
  const metric = (f: (r: RunResult) => number | null | undefined) => runs.map(f).filter((v): v is number => typeof v === "number");
  const accuracy = metric((r) => r.metrics.accuracy?.rate);
  const acceptable = metric((r) => r.metrics.accuracy?.acceptable);
  const churn = metric((r) => r.churn?.steps.rate);
  const expectations = metric((r) => r.metrics.expectations.rate);
  return {
    config,
    models: runs[0]?.models ?? {},
    runs: runs.length,
    coverage: mean(metric((r) => r.metrics.coverage)),
    missedEffects: mean(metric((r) => r.metrics.missedEffects)),
    expectations: mean(expectations),
    accuracy: accuracy.length > 0 ? mean(accuracy) : null,
    acceptable: acceptable.length > 0 ? mean(acceptable) : null,
    churn: churn.length > 0 ? mean(churn) : null,
    variance: { expectations: stddev(expectations), accuracy: accuracy.length > 0 ? stddev(accuracy) : null },
    costPerUnit: mean(metric((r) => r.metrics.costPerUnit)),
    latencyMs: { mean: Math.round(mean(metric((r) => r.metrics.latencyMs.mean))), p95: Math.round(mean(metric((r) => r.metrics.latencyMs.p95))) },
  };
}

/** Write `results/<timestamp>.json` and `.md` (design §13.3); returns the two paths. */
export async function writeResults(dir: string, result: EvalResult, markdown: string): Promise<{ json: string; markdown: string }> {
  await mkdir(dir, { recursive: true });
  const stamp = result.startedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const json = join(dir, `${stamp}.json`);
  const md = join(dir, `${stamp}.md`);
  await writeFile(json, `${JSON.stringify(result, null, 1)}\n`);
  await writeFile(md, markdown);
  return { json, markdown: md };
}

async function gitInfo(cwd: string): Promise<{ sha: string; dirty: boolean } | null> {
  const run = promisify(execFile);
  try {
    const sha = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    const dirty = (await run("git", ["status", "--porcelain"], { cwd })).stdout.trim() !== "";
    return { sha, dirty };
  } catch {
    return null;
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function semaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
