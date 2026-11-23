import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallSite, ExtractedUnit, FileExtraction, LanguageAdapter } from "./adapter.js";
import { SiftCache } from "./cache.js";
import type { SiftConfig } from "./config.js";
import { renderContextCheckInput, renderDescribeInput, type CalleeInfo, flatten } from "./describe-input.js";
import {
  CONTEXT_CHECK_SCHEMA,
  deriveSiftUnit,
  DESCRIBE_LITE_SCHEMA,
  DESCRIBE_SCHEMA,
  rederiveFacts,
  UPDATE_SCHEMA,
  validateContextCheckResponse,
  validateDescribeResponse,
  type ContextCheckResponse,
  type DescribeResponse,
} from "./describe-output.js";
import { effectsOfUnit } from "./effects.js";
import { SiftError } from "./errors.js";
import { externalId, unitId, type CodeGraph } from "./graph.js";
import { newId } from "./ids.js";
import { loadPrompt, type PromptTemplate } from "./prompts.js";
import type { CompletionResult, Provider, Task, Tier } from "./provider.js";
import type { Route, Router } from "./routing.js";
import type { RuleSet } from "./rules.js";
import { SIFT_SCHEMA_VERSION, type Effect, type SiftFile, type SiftStep, type SiftUnit } from "./schema.js";
import { deleteSiftFile, writeSiftFile } from "./store.js";
import { calleeRefsOf, CycleIndex, describedUnits, expectedContextHash, planSync, stronglyConnected, type Ambiguity, type UnitChange } from "./sync.js";
import { lineDiff } from "./text-diff.js";
import { validateSiftFile } from "./validate.js";

/**
 * `sift generate` (design §7.1): brings the `.sift` files in line with the source. New units are
 * described, changed units updated (§7.4), renamed and moved units keep their IDs (§7.2), deleted
 * units are removed, and units whose callees' summaries changed get a context check (§7.3).
 * Everything else is kept, with its calls and effects recomputed from the code.
 */

export interface GenerateOptions {
  root: string;
  config: SiftConfig;
  adapters: LanguageAdapter[];
  rules: RuleSet;
  provider: Provider;
  router: Router;
  /** Project-relative files or folders to limit the run to. */
  paths?: string[];
  /** Describe every unit again from scratch, keeping IDs. */
  force?: boolean;
  dryRun?: boolean;
  fullHash?: boolean;
  onEvent?: (event: GenerateEvent) => void;
}

export type GenerateAction = "describe" | "update" | "context-check";

export type GenerateEvent =
  | { type: "start"; units: number; files: number }
  | { type: "described"; unit: string; action: GenerateAction; task: Task; model: string; attempts: number; stale: boolean; changed: boolean; durationMs: number }
  | { type: "failed"; unit: string; reason: string }
  | { type: "substituted"; from: Tier; to: Tier; model: string; reason: string };

export interface PlannedUnit {
  /** "file#Symbol" */
  unit: string;
  action: GenerateAction;
  task: Task;
  route: Route;
  /** Why: "new", "changed", "probable-rename", "forced", or (for context checks) "callees-changed". */
  reason: UnitChange | "forced" | "callees-changed";
}

export interface GenerateReport {
  /** AI work known before the run. Context checks can cascade, so more may run. */
  planned: PlannedUnit[];
  described: { unit: string; action: GenerateAction; stale: boolean; uncovered: string[]; warnings: number; attempts: number; changed: boolean }[];
  failed: { unit: string; reason: string; problems: string[] }[];
  /** Units whose description was kept as it is (facts recomputed). */
  unchanged: string[];
  /** Units that kept their ID under a new name or in a new file. */
  renamed: { from: string; to: string; change: "renamed" | "probable-rename" | "moved"; similarity?: number }[];
  /** Units removed because their code no longer exists. */
  deleted: string[];
  movedFiles: { from: string; to: string }[];
  ambiguous: Ambiguity[];
  /** Units a person edited whose wording the AI changed: written with status stale for review. */
  needsReview: string[];
  /** `.sift` files written. */
  written: string[];
  /** `.sift` files removed (moved or deleted sources, or no units left). */
  removed: string[];
  /** `.sift` files that could not be read and were replaced. */
  replaced: string[];
  redactions: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
  substitutions: { from: Tier; to: Tier; model: string }[];
  belowMinimum: string[];
}

interface WorkItem {
  file: string;
  unit: ExtractedUnit;
  ref: string;
  id: string;
  lite: boolean;
  /** describe: no usable description; update: the code changed; keep: only facts and context. */
  mode: "describe" | "update" | "keep";
  reason: PlannedUnit["reason"];
  previous?: SiftUnit;
}

export async function generate(options: GenerateOptions): Promise<GenerateReport> {
  const { root, config, rules, provider, router } = options;
  const emit = options.onEvent ?? (() => {});
  const report: GenerateReport = {
    planned: [], described: [], failed: [], unchanged: [], renamed: [], deleted: [], movedFiles: [], ambiguous: [], needsReview: [],
    written: [], removed: [], replaced: [], redactions: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, substitutions: [], belowMinimum: [],
  };

  const plan = await planSync(options);
  const { graph, extractions, existing, targets } = plan;
  report.replaced = plan.unreadable;
  report.movedFiles = plan.movedFiles;
  report.ambiguous = plan.ambiguous;
  const cycles = new CycleIndex(graph);

  const known = describedUnits(plan);
  const targetSet = new Set(targets);
  /** Summaries as they were before this run: what the existing descriptions were written against. */
  const before = new Map(known);
  const takenIds = new Set<string>();
  for (const file of existing.values()) for (const u of file.units) takenIds.add(u.id);

  const work: WorkItem[] = [];
  for (const m of plan.units) {
    if (m.change === "deleted") {
      report.deleted.push(unitId(m.file, m.previous!.symbol));
      continue;
    }
    const unit = m.current!;
    const ref = unitId(m.file, unit.symbol);
    const prior = m.previous;
    if (prior && m.change !== "unchanged" && m.change !== "changed") {
      report.renamed.push({ from: unitId(m.previousFile ?? m.file, prior.symbol), to: ref, change: m.change as "renamed" | "probable-rename" | "moved", ...(m.similarity !== undefined ? { similarity: m.similarity } : {}) });
    }
    const id = prior?.id ?? newId("unit", takenIds);
    takenIds.add(id);
    if (!prior) known.set(ref, { id }); // IDs are assigned up front so calls between new units can refer to each other
    const lite = graph.unit(ref)?.lite ?? unit.isSmall;
    const sameCode = prior !== undefined && prior.bodyHash === unit.bodyHash;
    let mode: WorkItem["mode"];
    if (!prior || options.force) mode = "describe";
    else if (!sameCode || prior.lite !== (lite || undefined)) mode = "update";
    else mode = "keep";
    const reason: PlannedUnit["reason"] = options.force && prior ? "forced" : m.change;
    work.push({ file: m.file, unit, ref, id, lite, mode, reason, ...(prior ? { previous: prior } : {}) });
  }

  const taskOf = (item: WorkItem): Task => (item.lite ? "describe-lite" : item.mode === "update" ? "update" : "describe");
  for (const w of work) {
    if (w.mode !== "keep") report.planned.push({ unit: w.ref, action: w.mode, task: taskOf(w), route: router.route(taskOf(w)), reason: w.reason });
  }
  // Possible context checks: kept units whose callees are being described again, or whose
  // contextHash already disagrees with their callees' summaries. They run only if a summary changes.
  const redescribed = new Set(work.filter((w) => w.mode !== "keep").map((w) => w.ref));
  for (const w of work) {
    if (w.mode !== "keep") continue;
    const refs = calleeRefsOf(w.unit, w.ref, graph, cycles);
    if (refs.some((r) => redescribed.has(r)) || expectedContextHash(refs, known) !== w.previous!.contextHash) {
      report.planned.push({ unit: w.ref, action: "context-check", task: "context-check", route: router.route("context-check"), reason: "callees-changed" });
    }
  }
  if (options.dryRun) {
    return report;
  }

  const ai = work.filter((w) => w.mode !== "keep").length;
  if (ai > 0) emit({ type: "start", units: ai, files: new Set(work.filter((w) => w.mode !== "keep").map((w) => w.file)).size });

  const cache = new SiftCache(root);
  const fileTexts = new Map<string, Promise<string>>();
  const textOf = (file: string) => {
    let p = fileTexts.get(file);
    if (!p) fileTexts.set(file, (p = readFile(join(root, file), "utf8")));
    return p;
  };
  const results = new Map<string, SiftUnit>();
  const ctx: Context = {
    graph, rules, extractions, known, before, cycles, provider, router, report, emit, textOf, cache, substitutions: new Map(), abort: null,
  };

  // Units to describe or update are batched per file and task (one AI call each, up to
  // batch.maxUnits units); kept units are handled one by one. Batches run callees before callers,
  // so callers see their callees' new summaries; batches that depend on each other go together.
  const limit = semaphore(config.concurrency);
  const byRef = new Map(work.map((w) => [w.ref, w]));
  const batches: WorkItem[][] = [];
  const open = new Map<string, WorkItem[]>();
  for (const w of work) {
    if (w.mode === "keep") {
      batches.push([w]);
      continue;
    }
    const key = `${w.file}\n${describeTaskOf(w)}`;
    let batch = open.get(key);
    if (!batch || batch.length >= config.batch.maxUnits) {
      batch = [];
      open.set(key, batch);
      batches.push(batch);
    }
    batch.push(w);
  }
  const batchOf = new Map<string, number>();
  batches.forEach((b, i) => b.forEach((w) => batchOf.set(w.ref, i)));
  const unitEdges = (ref: string) => graph.edgesFrom(ref, "calls").flatMap((e) => [e.to, ...graph.implementers(e.to)]).filter((t) => t !== ref && byRef.has(t));
  const batchEdges = (key: string) => [...new Set(batches[Number(key)]!.flatMap((w) => unitEdges(w.ref).map((t) => String(batchOf.get(t)!))))].filter((k) => k !== key);
  const components = stronglyConnected(batches.map((_, i) => String(i)), batchEdges);
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => c.forEach((key) => componentOf.set(key, i)));
  const record = (unit: SiftUnit | null | undefined, item: WorkItem) => {
    if (!unit) return;
    results.set(item.ref, unit);
    known.set(item.ref, { id: unit.id, summary: unit.summary });
  };
  const done = new Map<number, Promise<void>>();
  const run = (index: number): Promise<void> => {
    let p = done.get(index);
    if (p) return p;
    p = (async () => {
      const deps = new Set(components[index]!.flatMap((key) => batchEdges(key).map((k) => componentOf.get(k)!)).filter((c) => c !== index));
      await Promise.all([...deps].map(run));
      await Promise.all(
        components[index]!.map((key) =>
          limit(async () => {
            if (ctx.abort) return;
            const batch = batches[Number(key)]!;
            if (batch.length === 1) {
              record(await processItem(batch[0]!, ctx), batch[0]!);
              return;
            }
            const units = await describeBatch(batch, ctx);
            for (const item of batch) record(units.get(item.ref), item);
            // Units in a batch may call each other: their context hashes can only include each
            // other's summaries once the whole batch is recorded.
            for (const item of batch) {
              const unit = units.get(item.ref);
              if (unit) setContextHash(unit, expectedContextHash(calleeRefsOf(item.unit, item.ref, graph, cycles), known));
            }
          }),
        ),
      );
    })();
    done.set(index, p);
    return p;
  };
  await Promise.all(components.map((_, i) => run(i)));

  // Write: each target file in source order; failed units keep their previous description.
  const finalUnits = new Map<string, SiftUnit[]>();
  for (const file of targets) {
    const extraction = extractions.get(file)!;
    const old = existing.get(file);
    const units: SiftUnit[] = [];
    let current = true;
    for (const u of extraction.units) {
      const ref = unitId(file, u.symbol);
      const fresh = results.get(ref);
      const prior = byRef.get(ref)?.previous;
      if (fresh) units.push(fresh);
      else if (prior) {
        units.push(prior);
        current = false;
      } else current = false; // not described (failed)
    }
    finalUnits.set(file, units);
    const moved = plan.movedFiles.find((m) => m.to === file);
    if (units.length === 0) {
      if (old && (await deleteSiftFile(root, file))) report.removed.push(file);
      if (moved && (await deleteSiftFile(root, moved.from))) report.removed.push(moved.from);
      continue;
    }
    // fileHash says "this .sift file matches the source"; it is only updated when every unit does.
    const fileHash = current || !old ? extraction.fileHash : old.fileHash;
    const next: SiftFile = { sift: SIFT_SCHEMA_VERSION, source: file, language: extraction.language, fileHash, units };
    validateSiftFile(JSON.parse(JSON.stringify(next)), file);
    const written = await writeSiftFile(root, next);
    if (written.changed) report.written.push(written.path);
    if (moved && (await deleteSiftFile(root, moved.from))) report.removed.push(moved.from);
  }
  for (const file of plan.deletedFiles) if (await deleteSiftFile(root, file)) report.removed.push(file);

  if (ctx.abort) throw ctx.abort;
  // Old unit sources are kept only while a description still refers to them.
  if (!options.paths?.length) {
    const keep = new Set<string>();
    for (const [source, file] of existing) if (!targetSet.has(source)) for (const u of file.units) keep.add(u.bodyHash);
    for (const units of finalUnits.values()) for (const u of units) keep.add(u.bodyHash);
    await cache.pruneUnitSources(keep);
  }
  return report;
}

interface Context {
  graph: CodeGraph;
  rules: RuleSet;
  extractions: Map<string, FileExtraction>;
  known: Map<string, { id: string; summary?: string }>;
  before: Map<string, { id: string; summary?: string }>;
  cycles: CycleIndex;
  provider: Provider;
  router: Router;
  report: GenerateReport;
  emit: (event: GenerateEvent) => void;
  textOf: (file: string) => Promise<string>;
  cache: SiftCache;
  /** Tier → tier used instead, once a model turned out to be unavailable in this run. */
  substitutions: Map<Tier, Tier>;
  /** Set when the run must stop (e.g. not logged in); remaining units are skipped. */
  abort: SiftError | null;
}

async function processItem(item: WorkItem, ctx: Context): Promise<SiftUnit | null> {
  if (item.mode !== "keep") return describeOne(item, ctx);
  const { nodes: nodeEffects } = effectsOfUnit(item.unit, ctx.rules);
  const facts = { nodeEffects, callRefs: (c: CallSite) => callRefs(c, ctx), calleeEffects: (c: CallSite) => calleeEffects(c, ctx) };
  const kept = rederiveFacts(item.previous!, item.unit, facts);
  const expected = expectedContextHash(calleeRefsOf(item.unit, item.ref, ctx.graph, ctx.cycles), ctx.known);
  if (expected === item.previous!.contextHash) {
    ctx.report.unchanged.push(item.ref);
    return kept;
  }
  setContextHash(kept, expected);
  let changes = contextChanges(item, ctx.graph, ctx.cycles, ctx.before, ctx.known);
  if (changes.length === 0) {
    // The summaries changed before this run (e.g. edited by hand): which ones is unknown, so show them all.
    changes = calleeRefsOf(item.unit, item.ref, ctx.graph, ctx.cycles).flatMap((ref) => {
      const after = ctx.known.get(ref)?.summary;
      return after ? [{ name: ref.slice(ref.indexOf("#") + 1), after }] : [];
    });
  }
  if (changes.length === 0) {
    ctx.report.unchanged.push(item.ref);
    return kept;
  }
  return contextCheck(item, kept, changes, ctx);
}

/** Callees whose summary differs from the one the description was written against. */
function contextChanges(
  item: WorkItem,
  graph: CodeGraph,
  cycles: CycleIndex,
  before: Map<string, { summary?: string }>,
  now: Map<string, { summary?: string }>,
): { name: string; before?: string; after: string }[] {
  return calleeRefsOf(item.unit, item.ref, graph, cycles).flatMap((ref) => {
    const after = now.get(ref)?.summary;
    const was = before.get(ref)?.summary;
    if (!after || after === was) return [];
    return [{ name: ref.slice(ref.indexOf("#") + 1), ...(was ? { before: was } : {}), after }];
  });
}

function setContextHash(unit: SiftUnit, hash: string | undefined): void {
  if (hash) unit.contextHash = hash;
  else delete unit.contextHash;
}

async function contextCheck(item: WorkItem, kept: SiftUnit, changes: { name: string; before?: string; after: string }[], ctx: Context): Promise<SiftUnit | null> {
  const started = Date.now();
  const task: Task = "context-check";
  const template = await loadPrompt(task);
  const prompt = renderContextCheckInput({ file: item.file, unit: kept, changes });
  const stepIds = new Set<string>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => (stepIds.add(s.id), index(s.steps)));
  index(kept.steps);
  const outcome = await askWithRetry(ctx, item, task, template, prompt, CONTEXT_CHECK_SCHEMA, (json) => {
    const v = validateContextCheckResponse(json, stepIds);
    return { value: v.response, problems: v.problems, soft: false };
  });
  if (!outcome) return null;
  const response: ContextCheckResponse = outcome.value;
  const updated = structuredClone(kept);
  let changed = false;
  if (response.summary !== null && response.summary !== updated.summary) {
    updated.summary = response.summary;
    changed = true;
  }
  const texts = new Map(response.steps.map((s) => [s.id, s.text]));
  const apply = (steps: SiftStep[]): void =>
    steps.forEach((s) => {
      const t = texts.get(s.id);
      if (t !== undefined && t !== s.text) (s.text = t), (changed = true);
      apply(s.steps);
    });
  apply(updated.steps);
  if (changed) markEdited(updated, item, ctx);
  ctx.report.described.push({ unit: item.ref, action: "context-check", stale: updated.status === "stale", uncovered: [], warnings: updated.warnings.length, attempts: outcome.attempts, changed });
  ctx.emit({ type: "described", unit: item.ref, action: "context-check", task, model: outcome.route.choice.model, attempts: outcome.attempts, stale: updated.status === "stale", changed, durationMs: Date.now() - started });
  return updated;
}

/** After the AI changed a kept description's wording: a person's wording goes to review; verified no longer holds. */
function markEdited(unit: SiftUnit, item: WorkItem, ctx: Context): void {
  if (item.previous?.status === "user-edited") {
    unit.status = "stale";
    ctx.report.needsReview.push(item.ref);
  } else if (unit.status === "verified" || unit.status === "user-edited") unit.status = "generated";
}

/** Everything needed to ask for, check, and turn into a unit one describe or update response. */
interface PreparedDescribe {
  task: Task;
  template: PromptTemplate;
  schema: object;
  nodeEffects: Map<string, Effect[]>;
  prompt: string;
  updating: boolean;
  previousStepIds: Set<string> | undefined;
}

type DescribeValue = { response: DescribeResponse; uncovered: string[] };

/** The task a describe or update work item runs as. */
function describeTaskOf(item: WorkItem): Task {
  return item.lite ? "describe-lite" : item.mode === "update" ? "update" : "describe";
}

async function prepareDescribe(item: WorkItem, ctx: Context): Promise<PreparedDescribe> {
  const updating = item.mode === "update";
  const task = describeTaskOf(item);
  const template = await loadPrompt(task);
  const schema = item.lite ? DESCRIBE_LITE_SCHEMA : updating ? UPDATE_SCHEMA : DESCRIBE_SCHEMA;
  const { nodes: nodeEffects } = effectsOfUnit(item.unit, ctx.rules);

  let previous: { unit: SiftUnit; diff: string | null } | undefined;
  if (updating) {
    const old = await ctx.cache.getUnitSource(item.previous!.bodyHash);
    previous = { unit: item.previous!, diff: old ? lineDiff(dedentText(old.sourceText), dedentText(item.unit.sourceText)) : null };
  }
  const input = renderDescribeInput({
    file: item.file,
    unit: item.unit,
    fileText: await ctx.textOf(item.file),
    lite: item.lite,
    nodeEffects,
    callees: calleesOf(item, ctx),
    ...(previous ? { previous } : {}),
  });
  ctx.report.redactions += input.redactions;

  let previousStepIds: Set<string> | undefined;
  if (updating && !item.lite) {
    previousStepIds = new Set<string>();
    const ids = previousStepIds;
    const index = (steps: SiftStep[]): void => steps.forEach((s) => (ids.add(s.id), index(s.steps)));
    index(item.previous!.steps);
  }
  return { task, template, schema, nodeEffects, prompt: input.prompt, updating, previousStepIds };
}

function checkDescribe(item: WorkItem, prep: PreparedDescribe, json: unknown): { value: DescribeValue | null; problems: string[]; soft: boolean } {
  const v = validateDescribeResponse(json, item.unit, item.lite, prep.previousStepIds);
  // Coverage is the one problem a unit may still be written with, as stale.
  const hard = v.problems.length - (v.uncovered.length > 0 ? 1 : 0);
  return { value: v.response ? { response: v.response, uncovered: v.uncovered } : null, problems: v.problems, soft: hard === 0 && v.response !== null };
}

/**
 * Describe one unit on its own. `hint` lists problems an earlier (batched) response for this unit
 * had, so the model can avoid them.
 */
async function describeOne(item: WorkItem, ctx: Context, hint: string[] = []): Promise<SiftUnit | null> {
  const started = Date.now();
  const prep = await prepareDescribe(item, ctx);
  const prompt = hint.length === 0 ? prep.prompt : `${prep.prompt}\n\nAn earlier response for this unit had these problems; avoid them:\n${hint.map((p) => `- ${p}`).join("\n")}`;
  const outcome = await askWithRetry(ctx, item, prep.task, prep.template, prompt, prep.schema, (json) => checkDescribe(item, prep, json));
  if (!outcome) return null;
  return finishDescribe(item, prep, outcome.value, outcome.attempts, outcome.route, prep.template.id, started, ctx);
}

/** The system-prompt addition for a batch request (several units of one file in one call). */
const BATCH_PROMPT_ID = "batch@2";
const BATCH_NOTE = `## Several units in one request

This request contains several units from the same file. Each one starts with a "# Unit" heading and has its own inputs, doc comment, code, structure keys, and calls. Describe each unit on its own, following everything above, as carefully as if it were the only unit in the request. Structure keys belong to the unit they are listed under. Units in this request may call each other: their code is all here, so use it to say what such a call does.

Review each unit for warnings separately:
- A unit's warnings are about that unit's own code. If two units share a problem (for example, a route handler and the router that registers it both serve data without checking the caller is allowed to see it), raise the warning on each of them. Never leave a warning off one unit because another unit in this request already has it.
- If a unit has a doc comment, compare it with that unit's code, and raise \`comment-contradicts-code\` when they disagree, even when your description already states what the code really does.

Respond with one JSON object of the form {"units": [{"symbol": "<the unit's symbol>", ...that unit's description...}]}: one entry per unit, in the order given, each with exactly the fields a single description has plus "symbol".`;

/** The response schema of a batch: the single-unit schema, once per unit, with the unit's symbol. */
function batchSchema(schema: object): object {
  const s = schema as { $defs?: object; properties: object; required: string[] };
  return {
    type: "object",
    ...(s.$defs ? { $defs: s.$defs } : {}),
    properties: {
      units: {
        type: "array",
        items: { type: "object", properties: { symbol: { type: "string" }, ...s.properties }, required: ["symbol", ...s.required], additionalProperties: false },
      },
    },
    required: ["units"],
    additionalProperties: false,
  };
}

/**
 * Describe several units of one file, all with the same task, in one AI call. The instructions,
 * examples, and schema are sent once instead of once per unit. Units whose part of the response
 * is missing or does not validate are described again on their own, told what was wrong.
 */
async function describeBatch(items: WorkItem[], ctx: Context): Promise<Map<string, SiftUnit>> {
  const started = Date.now();
  const out = new Map<string, SiftUnit>();
  const preps = await Promise.all(items.map((item) => prepareDescribe(item, ctx)));
  const { task, template, schema } = preps[0]!;
  const fullSchema = batchSchema(schema);
  const sections = items.map((item, i) => `# Unit ${i + 1} of ${items.length}: ${item.unit.symbol}\n\n${preps[i]!.prompt}`);
  const schemaNote = ctx.provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(fullSchema)}`;
  const prompt = `This request has ${items.length} units from ${items[0]!.file}.\n\n${sections.join("\n\n")}${schemaNote}`;
  const system = `${template.text}\n\n${BATCH_NOTE}`;

  const hints = new Map<string, string[]>();
  let route = ctx.router.route(task);
  if ((system.length + prompt.length) / 4 > ctx.provider.capabilities.contextTokens(route.choice.model)) {
    for (const item of items) hints.set(item.ref, []);
  } else {
    try {
      const { result, route: used } = await completeWithFallback(ctx, task, route, {
        task, model: route.choice, promptVersion: `${template.id}+${BATCH_PROMPT_ID}`, system, prompt, jsonSchema: fullSchema,
        parts: items.map((item, i) => ({ symbol: item.unit.symbol, prompt: preps[i]!.prompt, jsonSchema: schema })),
      });
      route = used;
      const entries = isRecordValue(result.json) && Array.isArray(result.json.units) ? (result.json.units as unknown[]) : [];
      items.forEach((item, i) => {
        const bySymbol = entries.find((e) => isRecordValue(e) && e.symbol === item.unit.symbol);
        const entry = bySymbol ?? (entries.length === items.length ? entries[i] : undefined);
        if (!isRecordValue(entry)) {
          hints.set(item.ref, []);
          return;
        }
        const { symbol: _symbol, ...json } = entry;
        const checked = checkDescribe(item, preps[i]!, json);
        if (checked.value === null || checked.problems.length > 0) {
          hints.set(item.ref, checked.problems);
          return;
        }
        const unit = finishDescribe(item, preps[i]!, checked.value, 1, route, `${template.id}+${BATCH_PROMPT_ID}`, started, ctx);
        if (route.belowMinimum && !ctx.report.belowMinimum.includes(item.ref)) ctx.report.belowMinimum.push(item.ref);
        out.set(item.ref, unit);
      });
    } catch (err) {
      if (err instanceof SiftError && err.code === "PROVIDER_AUTH") {
        ctx.abort ??= err;
        return out;
      }
      for (const item of items) hints.set(item.ref, []);
    }
  }
  // Whatever the batch did not settle is described unit by unit (one at a time: this holds one
  // concurrency slot).
  for (const item of items) {
    if (ctx.abort || !hints.has(item.ref)) continue;
    const unit = await describeOne(item, ctx, hints.get(item.ref));
    if (unit) out.set(item.ref, unit);
  }
  return out;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finishDescribe(
  item: WorkItem,
  prep: PreparedDescribe,
  value: DescribeValue,
  attempts: number,
  route: Route,
  promptId: string,
  started: number,
  ctx: Context,
): SiftUnit {
  const { response, uncovered } = value;
  const { task, nodeEffects, updating } = prep;
  const outcome = { attempts, route };
  const template = { id: promptId };

  const unit = deriveSiftUnit({
    unit: item.unit,
    response,
    id: item.id,
    lite: item.lite,
    uncovered,
    nodeEffects,
    callRefs: (call) => callRefs(call, ctx),
    calleeEffects: (call) => calleeEffects(call, ctx),
    generatedBy: { provider: outcome.route.choice.provider, model: outcome.route.choice.model, prompt: template.id, belowTier: outcome.route.belowTier },
    ...(item.previous ? { previousWarnings: item.previous.warnings } : {}),
  });
  setContextHash(unit, expectedContextHash(calleeRefsOf(item.unit, item.ref, ctx.graph, ctx.cycles), ctx.known));
  let changed = true;
  if (updating && item.previous!.status === "user-edited") {
    if (unit.status !== "stale" && keepsWording(item.previous!, unit)) unit.status = "user-edited";
    else markEdited(unit, item, ctx);
  }
  if (updating) changed = JSON.stringify(proseOf(item.previous!)) !== JSON.stringify(proseOf(unit));
  ctx.report.described.push({ unit: item.ref, action: item.mode as GenerateAction, stale: unit.status === "stale", uncovered, warnings: unit.warnings.length, attempts: outcome.attempts, changed });
  ctx.emit({ type: "described", unit: item.ref, action: item.mode as GenerateAction, task, model: outcome.route.choice.model, attempts: outcome.attempts, stale: unit.status === "stale", changed, durationMs: Date.now() - started });
  return unit;
}

/** True when every piece of a person's wording that the update kept is unchanged. */
function keepsWording(previous: SiftUnit, next: SiftUnit): boolean {
  if (previous.summary !== next.summary) return false;
  if (previous.returns && next.returns && previous.returns.meaning !== next.returns.meaning) return false;
  for (const i of previous.inputs) {
    const now = next.inputs.find((n) => n.name === i.name);
    if (now && now.meaning !== i.meaning) return false;
  }
  const old = new Map<string, string>();
  const index = (steps: SiftStep[]): void => steps.forEach((s) => (old.set(s.id, s.text), index(s.steps)));
  index(previous.steps);
  const check = (steps: SiftStep[]): boolean => steps.every((s) => (!old.has(s.id) || old.get(s.id) === s.text) && check(s.steps));
  return check(next.steps);
}

/** The AI-written parts of a unit, to tell whether an update changed any wording. */
function proseOf(u: SiftUnit): unknown {
  const step = (s: SiftStep): unknown => [s.id, s.kind, s.text, s.covers, s.steps.map(step)];
  return [u.summary, u.inputs.map((i) => i.meaning), u.returns?.meaning, u.steps.map(step), u.warnings.map((w) => [w.kind, w.text])];
}

/**
 * Send a prompt, validate the reply, and retry once with the problems (design §8). `check` says
 * whether the reply is usable; `soft` replies are accepted after the retry despite problems.
 */
async function askWithRetry<T>(
  ctx: Context,
  item: WorkItem,
  task: Task,
  template: PromptTemplate,
  basePrompt: string,
  schema: object,
  check: (json: unknown) => { value: T | null; problems: string[]; soft: boolean },
): Promise<{ value: T; attempts: number; route: Route } | null> {
  const schemaNote = ctx.provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
  const first = `${basePrompt}${schemaNote}`;
  let route = ctx.router.route(task);
  let prompt = first;
  try {
    for (let attempts = 1; attempts <= 2; attempts++) {
      const budget = ctx.provider.capabilities.contextTokens(route.choice.model);
      if ((template.text.length + prompt.length) / 4 > budget) {
        fail(item, ctx, `the prompt is larger than ${route.choice.model}'s context budget`, []);
        return null;
      }
      const { result, route: used } = await completeWithFallback(ctx, task, route, {
        task, model: route.choice, promptVersion: template.id, system: template.text, prompt, jsonSchema: schema,
      });
      route = used;
      const checked =
        result.json === undefined
          ? { value: null, problems: ["The response was not valid JSON. Respond with the JSON object only."], soft: false }
          : check(result.json);
      if (checked.value !== null && (checked.problems.length === 0 || (attempts === 2 && checked.soft))) {
        if (route.belowMinimum && !ctx.report.belowMinimum.includes(item.ref)) ctx.report.belowMinimum.push(item.ref);
        return { value: checked.value, attempts, route };
      }
      if (attempts === 2) {
        fail(item, ctx, "the response did not pass validation after one retry", checked.problems);
        return null;
      }
      prompt = `${first}\n\nYour previous response had these problems. Return a corrected JSON object.\n${checked.problems.map((p) => `- ${p}`).join("\n")}`;
    }
  } catch (err) {
    if (err instanceof SiftError && err.code === "PROVIDER_AUTH") {
      ctx.abort ??= err;
      return null;
    }
    fail(item, ctx, err instanceof Error ? err.message : String(err), []);
  }
  return null;
}

function fail(item: WorkItem, ctx: Context, reason: string, problems: string[]): void {
  ctx.report.failed.push({ unit: item.ref, reason, problems });
  ctx.emit({ type: "failed", unit: item.ref, reason });
}

/** Call the provider, walking the routing fallbacks (design §4.2) if the model is unavailable. */
async function completeWithFallback(
  ctx: Context,
  task: Task,
  route: Route,
  request: Parameters<Provider["complete"]>[0],
): Promise<{ result: CompletionResult; route: Route }> {
  let current = route;
  const substituted = ctx.substitutions.get(route.tier);
  if (substituted) current = ctx.router.route(task, substituted);
  const tried = new Set<Tier>();
  for (;;) {
    tried.add(current.tier);
    try {
      const result = await ctx.provider.complete({ ...request, model: current.choice });
      ctx.report.usage.calls++;
      ctx.report.usage.inputTokens += result.usage.inputTokens ?? 0;
      ctx.report.usage.outputTokens += result.usage.outputTokens ?? 0;
      ctx.report.usage.costUsd += result.usage.costUsd ?? 0;
      return { result, route: current };
    } catch (err) {
      if (!(err instanceof SiftError) || err.code !== "MODEL_UNAVAILABLE") throw err;
      const next = ctx.router.fallbacks(current.tier).find((t) => !tried.has(t));
      if (!next) throw err;
      const nextRoute = ctx.router.route(task, next);
      if (!ctx.substitutions.has(route.tier)) {
        ctx.substitutions.set(route.tier, next);
        ctx.report.substitutions.push({ from: route.tier, to: next, model: nextRoute.choice.model });
        ctx.emit({ type: "substituted", from: route.tier, to: next, model: nextRoute.choice.model, reason: err.message });
      }
      current = nextRoute;
    }
  }
}

function callRefs(call: CallSite, ctx: Context): string[] {
  if (call.external) return [externalId(call.external.module, call.external.name)];
  if (!call.target) return [];
  const ref = unitId(call.target.file, call.target.symbol);
  const direct = ctx.known.get(ref);
  if (direct) return [direct.id];
  // An interface member or abstract method: point at the implementations that have descriptions.
  return ctx.graph.implementers(ref).flatMap((impl) => {
    const k = ctx.known.get(impl);
    return k ? [k.id] : [];
  });
}

function calleeEffects(call: CallSite, ctx: Context): Effect[] {
  if (!call.target || call.external) return [];
  const ref = unitId(call.target.file, call.target.symbol);
  const out = new Set<Effect>();
  for (const target of [ref, ...ctx.graph.implementers(ref)]) {
    for (const e of ctx.graph.unit(target)?.effects ?? []) if (e !== "throws") out.add(e);
  }
  return [...out];
}

function calleesOf(item: WorkItem, ctx: Context): CalleeInfo[] {
  const out: CalleeInfo[] = [];
  const seen = new Set<string>();
  for (const node of flatten(item.unit.body)) {
    for (const call of node.calls) {
      const target = call.external ? externalId(call.external.module, call.external.name) : call.target ? unitId(call.target.file, call.target.symbol) : null;
      const dedupe = `${node.key}|${target ?? call.expression}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const effects = new Set<Effect>([...ctx.rules.effectsFor(call), ...calleeEffects(call, ctx)]);
      if (!target) {
        out.push({ expression: call.expression, key: node.key, target: null, kind: "unresolved", effects: [] });
        continue;
      }
      if (call.external) {
        out.push({ expression: call.expression, key: node.key, target, kind: "external", effects: [...effects] });
        continue;
      }
      const isUnit = ctx.graph.unit(target) !== undefined;
      const info: CalleeInfo = { expression: call.expression, key: node.key, target, kind: isUnit ? "unit" : "declaration", effects: [...effects] };
      const signature = ctx.extractions.get(call.target!.file)?.units.find((u) => u.symbol === call.target!.symbol)?.signature;
      if (signature) info.signature = signature;
      const summary = target === item.ref ? undefined : ctx.known.get(target)?.summary;
      if (summary) info.summary = summary;
      const impls = ctx.graph.implementers(target);
      if (impls.length > 0) {
        info.implementations = impls.map((i) => {
          const s = ctx.known.get(i)?.summary;
          return s ? { target: i, summary: s } : { target: i };
        });
      }
      out.push(info);
    }
  }
  return out;
}

/** Remove the indentation all non-blank lines share. */
function dedentText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  // The first line of a unit's source starts at the declaration, without its indentation.
  const rest = indents.slice(1);
  const cut = rest.length > 0 ? Math.min(...rest) : 0;
  return lines.map((l, i) => (i === 0 ? l : l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length)))).join("\n");
}

function semaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    // A finishing task hands its slot straight to the next waiter, so the limit is never exceeded.
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
