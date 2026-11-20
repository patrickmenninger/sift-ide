import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallSite, ExtractedUnit, FileExtraction, LanguageAdapter } from "./adapter.js";
import type { SiftConfig } from "./config.js";
import { flatten, renderDescribeInput, type CalleeInfo } from "./describe-input.js";
import { contextHashOf, deriveSiftUnit, DESCRIBE_LITE_SCHEMA, DESCRIBE_SCHEMA, validateDescribeResponse, type DescribeResponse } from "./describe-output.js";
import { effectsOfUnit } from "./effects.js";
import { SiftError } from "./errors.js";
import { externalId, unitId, type CodeGraph } from "./graph.js";
import { newId } from "./ids.js";
import { loadExtractions, refreshGraph } from "./project-index.js";
import { loadPrompt } from "./prompts.js";
import type { CompletionResult, Provider, Task, Tier } from "./provider.js";
import type { Route, Router } from "./routing.js";
import type { RuleSet } from "./rules.js";
import { SIFT_SCHEMA_VERSION, type Effect, type SiftFile, type SiftUnit } from "./schema.js";
import { listSiftFiles, readSiftFile, writeSiftFile } from "./store.js";
import { validateSiftFile } from "./validate.js";

/**
 * `sift generate` for units without a description (design §7.1). Units that already have one are
 * left alone here; updating changed units arrives with sync (milestone 7). `force` re-describes
 * them, keeping their IDs.
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
  force?: boolean;
  dryRun?: boolean;
  fullHash?: boolean;
  onEvent?: (event: GenerateEvent) => void;
}

export type GenerateEvent =
  | { type: "start"; units: number; files: number }
  | { type: "described"; unit: string; task: Task; model: string; attempts: number; stale: boolean; durationMs: number }
  | { type: "failed"; unit: string; reason: string }
  | { type: "substituted"; from: Tier; to: Tier; model: string; reason: string };

export interface PlannedUnit {
  /** "file#Symbol" */
  unit: string;
  task: Task;
  route: Route;
  reason: "new" | "forced";
}

export interface GenerateReport {
  planned: PlannedUnit[];
  described: { unit: string; stale: boolean; uncovered: string[]; warnings: number; attempts: number }[];
  failed: { unit: string; reason: string; problems: string[] }[];
  /** Units that already had a description and were not regenerated. */
  kept: { unit: string; changed: boolean }[];
  /** `.sift` units whose symbol no longer exists in the source (handled by sync, milestone 7). */
  orphaned: string[];
  written: string[];
  /** `.sift` files that could not be read and will be replaced. */
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
  reason: "new" | "forced";
}

export async function generate(options: GenerateOptions): Promise<GenerateReport> {
  const { root, config, adapters, rules, provider, router } = options;
  const emit = options.onEvent ?? (() => {});
  const report: GenerateReport = {
    planned: [], described: [], failed: [], kept: [], orphaned: [], written: [], replaced: [], redactions: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, substitutions: [], belowMinimum: [],
  };

  const { graph, files } = await refreshGraph({ root, config, adapters, rules, ...(options.fullHash ? { fullHash: true } : {}) });
  const targets = selectFiles(files, options.paths ?? []);

  // What is already described, project-wide: IDs and summaries for call references and callee context.
  const existing = new Map<string, SiftFile>();
  const known = new Map<string, { id: string; summary?: string }>();
  for (const source of await listSiftFiles(root)) {
    try {
      const stored = await readSiftFile(root, source);
      if (!stored) continue;
      existing.set(source, stored.file);
      for (const u of stored.file.units) known.set(unitId(source, u.symbol), { id: u.id, summary: u.summary });
    } catch (err) {
      if (!(err instanceof SiftError)) throw err;
      if (targets.includes(source)) report.replaced.push(source);
    }
  }
  const takenIds = new Set([...known.values()].map((k) => k.id));

  const extractions = await loadExtractions({ root, config, adapters }, graph, files);
  const work: WorkItem[] = [];
  for (const file of targets) {
    const extraction = extractions.get(file)!;
    const old = report.replaced.includes(file) ? undefined : existing.get(file);
    const oldBySymbol = new Map((old?.units ?? []).map((u) => [u.symbol, u]));
    for (const unit of extraction.units) {
      const ref = unitId(file, unit.symbol);
      const prior = oldBySymbol.get(unit.symbol);
      if (prior && !options.force) {
        report.kept.push({ unit: ref, changed: prior.bodyHash !== unit.bodyHash });
        continue;
      }
      const id = prior?.id ?? newId("unit", takenIds);
      takenIds.add(id);
      if (!prior) known.set(ref, { id }); // IDs are assigned up front so calls between new units can refer to each other
      work.push({ file, unit, ref, id, lite: graph.unit(ref)?.lite ?? unit.isSmall, reason: prior ? "forced" : "new" });
    }
    const current = new Set(extraction.units.map((u) => u.symbol));
    for (const u of old?.units ?? []) if (!current.has(u.symbol)) report.orphaned.push(unitId(file, u.symbol));
  }

  report.planned = work.map((w) => {
    const task: Task = w.lite ? "describe-lite" : "describe";
    return { unit: w.ref, task, route: router.route(task), reason: w.reason };
  });
  if (options.dryRun || work.length === 0) return report;
  emit({ type: "start", units: work.length, files: new Set(work.map((w) => w.file)).size });

  const fileTexts = new Map<string, Promise<string>>();
  const textOf = (file: string) => {
    let p = fileTexts.get(file);
    if (!p) fileTexts.set(file, (p = readFile(join(root, file), "utf8")));
    return p;
  };
  const results = new Map<string, SiftUnit>();
  const ctx: DescribeContext = { graph, rules, extractions, known, provider, router, report, emit, textOf, substitutions: new Map(), abort: null };

  // Callees before callers, so callers see their callees' summaries; recursion groups go together.
  const limit = semaphore(config.concurrency);
  const groups = stronglyConnected(work, graph);
  const done = new Map<number, Promise<void>>();
  const run = (index: number): Promise<void> => {
    let p = done.get(index);
    if (p) return p;
    const group = groups.components[index]!;
    p = (async () => {
      await Promise.all([...groups.dependsOn[index]!].map(run));
      await Promise.all(
        group.map((item) =>
          limit(async () => {
            if (ctx.abort) return;
            const unit = await describeOne(item, ctx);
            if (unit) {
              results.set(item.ref, unit);
              known.set(item.ref, { id: unit.id, summary: unit.summary });
            }
          }),
        ),
      );
    })();
    done.set(index, p);
    return p;
  };
  await Promise.all(groups.components.map((_, i) => run(i)));

  // Write each touched file: kept units unchanged, new ones in source order.
  for (const file of targets) {
    const mine = work.filter((w) => w.file === file && results.has(w.ref));
    if (mine.length === 0 && !report.replaced.includes(file)) continue;
    const extraction = extractions.get(file)!;
    const old = report.replaced.includes(file) ? undefined : existing.get(file);
    const oldBySymbol = new Map((old?.units ?? []).map((u) => [u.symbol, u]));
    const units: SiftUnit[] = [];
    let current = true;
    for (const u of extraction.units) {
      const fresh = results.get(unitId(file, u.symbol));
      const prior = oldBySymbol.get(u.symbol);
      if (fresh) units.push(fresh);
      else if (prior) {
        units.push(prior);
        if (prior.bodyHash !== u.bodyHash) current = false;
      } else current = false; // not described (failed)
    }
    const symbols = new Set(extraction.units.map((u) => u.symbol));
    for (const u of old?.units ?? []) {
      if (!symbols.has(u.symbol)) {
        units.push(u);
        current = false;
      }
    }
    if (units.length === 0) continue;
    // fileHash says "this .sift file matches the source"; it is only updated when every unit does.
    const fileHash = current || !old ? extraction.fileHash : old.fileHash;
    const next: SiftFile = { sift: SIFT_SCHEMA_VERSION, source: file, language: extraction.language, fileHash, units };
    validateSiftFile(JSON.parse(JSON.stringify(next)), file);
    const written = await writeSiftFile(root, next);
    if (written.changed) report.written.push(written.path);
  }

  if (ctx.abort) throw ctx.abort;
  return report;
}

function selectFiles(files: string[], paths: string[]): string[] {
  if (paths.length === 0) return files;
  const wanted = paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  const selected = files.filter((f) => wanted.some((p) => p === "" || p === "." || f === p || f.startsWith(`${p}/`)));
  const unmatched = wanted.filter((p) => p !== "" && p !== "." && !files.some((f) => f === p || f.startsWith(`${p}/`)));
  if (unmatched.length > 0) {
    throw new SiftError(
      "SOURCE_NOT_FOUND",
      `No source files match ${unmatched.map((p) => `"${p}"`).join(", ")}.`,
      ["Paths are relative to the project root and must be included by sift.config.yaml."],
    );
  }
  return selected;
}

interface DescribeContext {
  graph: CodeGraph;
  rules: RuleSet;
  extractions: Map<string, FileExtraction>;
  known: Map<string, { id: string; summary?: string }>;
  provider: Provider;
  router: Router;
  report: GenerateReport;
  emit: (event: GenerateEvent) => void;
  textOf: (file: string) => Promise<string>;
  /** Tier → tier used instead, once a model turned out to be unavailable in this run. */
  substitutions: Map<Tier, Tier>;
  /** Set when the run must stop (e.g. not logged in); remaining units are skipped. */
  abort: SiftError | null;
}

async function describeOne(item: WorkItem, ctx: DescribeContext): Promise<SiftUnit | null> {
  const started = Date.now();
  const task: Task = item.lite ? "describe-lite" : "describe";
  const template = await loadPrompt(task);
  const schema = item.lite ? DESCRIBE_LITE_SCHEMA : DESCRIBE_SCHEMA;
  const { nodes: nodeEffects } = effectsOfUnit(item.unit, ctx.rules);

  const input = renderDescribeInput({
    file: item.file,
    unit: item.unit,
    fileText: await ctx.textOf(item.file),
    lite: item.lite,
    nodeEffects,
    callees: calleesOf(item, ctx),
  });
  ctx.report.redactions += input.redactions;

  const schemaNote = ctx.provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
  const basePrompt = `${input.prompt}${schemaNote}`;

  let route = ctx.router.route(task);
  let prompt = basePrompt;
  let attempts = 0;
  let validation = { response: null as DescribeResponse | null, problems: [] as string[], uncovered: [] as string[] };
  try {
    while (attempts < 2) {
      attempts++;
      const budget = ctx.provider.capabilities.contextTokens(route.choice.model);
      if ((template.text.length + prompt.length) / 4 > budget) {
        fail(item, ctx, `the prompt is larger than ${route.choice.model}'s context budget`, []);
        return null;
      }
      const { result, route: used } = await completeWithFallback(ctx, task, route, {
        task, model: route.choice, promptVersion: template.id, system: template.text, prompt, jsonSchema: schema,
      });
      route = used;
      validation =
        result.json === undefined
          ? { response: null, problems: ["The response was not valid JSON. Respond with the JSON object only."], uncovered: [] }
          : validateDescribeResponse(result.json, item.unit, item.lite);
      const hard = validation.problems.length - (validation.uncovered.length > 0 ? 1 : 0);
      if (validation.problems.length === 0 || (attempts === 2 && hard === 0 && validation.response)) break;
      if (attempts === 2) {
        fail(item, ctx, "the response did not pass validation after one retry", validation.problems);
        return null;
      }
      prompt = `${basePrompt}\n\nYour previous response had these problems. Return a corrected JSON object.\n${validation.problems.map((p) => `- ${p}`).join("\n")}`;
    }
  } catch (err) {
    if (err instanceof SiftError && err.code === "PROVIDER_AUTH") {
      ctx.abort ??= err;
      return null;
    }
    fail(item, ctx, err instanceof Error ? err.message : String(err), []);
    return null;
  }

  if (route.belowMinimum) ctx.report.belowMinimum.push(item.ref);
  const calleeSummaries: { id: string; summary: string }[] = [];
  const addCallee = (ref: string) => {
    const k = ctx.known.get(ref);
    if (k?.summary && ref !== item.ref) calleeSummaries.push({ id: k.id, summary: k.summary });
  };
  for (const node of flatten(item.unit.body)) {
    for (const call of node.calls) {
      if (!call.target || call.external) continue;
      const ref = unitId(call.target.file, call.target.symbol);
      addCallee(ref);
      for (const impl of ctx.graph.implementers(ref)) addCallee(impl);
    }
  }

  const unit = deriveSiftUnit({
    unit: item.unit,
    response: validation.response!,
    id: item.id,
    lite: item.lite,
    uncovered: validation.uncovered,
    nodeEffects,
    callRefs: (call) => callRefs(call, ctx),
    calleeEffects: (call) => calleeEffects(call, ctx),
    generatedBy: { provider: route.choice.provider, model: route.choice.model, prompt: template.id, belowTier: route.belowTier },
    ...withContextHash(contextHashOf(calleeSummaries)),
  });
  ctx.report.described.push({ unit: item.ref, stale: unit.status === "stale", uncovered: validation.uncovered, warnings: unit.warnings.length, attempts });
  ctx.emit({ type: "described", unit: item.ref, task, model: route.choice.model, attempts, stale: unit.status === "stale", durationMs: Date.now() - started });
  return unit;
}

function withContextHash(hash: string | undefined): { contextHash?: string } {
  return hash ? { contextHash: hash } : {};
}

function fail(item: WorkItem, ctx: DescribeContext, reason: string, problems: string[]): void {
  ctx.report.failed.push({ unit: item.ref, reason, problems });
  ctx.emit({ type: "failed", unit: item.ref, reason });
}

/** Call the provider, walking the routing fallbacks (design §4.2) if the model is unavailable. */
async function completeWithFallback(
  ctx: DescribeContext,
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

function callRefs(call: CallSite, ctx: DescribeContext): string[] {
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

function calleeEffects(call: CallSite, ctx: DescribeContext): Effect[] {
  if (!call.target || call.external) return [];
  const ref = unitId(call.target.file, call.target.symbol);
  const out = new Set<Effect>();
  for (const target of [ref, ...ctx.graph.implementers(ref)]) {
    for (const e of ctx.graph.unit(target)?.effects ?? []) if (e !== "throws") out.add(e);
  }
  return [...out];
}

function calleesOf(item: WorkItem, ctx: DescribeContext): CalleeInfo[] {
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

/** Tarjan's algorithm over the call graph restricted to the units being described. */
function stronglyConnected(work: WorkItem[], graph: CodeGraph): { components: WorkItem[][]; dependsOn: Set<number>[] } {
  const byRef = new Map(work.map((w) => [w.ref, w]));
  const edges = new Map<string, string[]>();
  for (const w of work) {
    const targets = new Set<string>();
    for (const e of graph.edgesFrom(w.ref, "calls")) {
      for (const t of [e.to, ...graph.implementers(e.to)]) if (byRef.has(t) && t !== w.ref) targets.add(t);
    }
    edges.set(w.ref, [...targets]);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentOf = new Map<string, number>();
  const components: WorkItem[][] = [];

  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const component: WorkItem[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        componentOf.set(w, components.length);
        component.push(byRef.get(w)!);
      } while (w !== v);
      components.push(component);
    }
  };
  for (const w of work) if (!index.has(w.ref)) visit(w.ref);

  const dependsOn = components.map((component, i) => {
    const deps = new Set<number>();
    for (const item of component) for (const t of edges.get(item.ref) ?? []) if (componentOf.get(t) !== i) deps.add(componentOf.get(t)!);
    return deps;
  });
  return { components, dependsOn };
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
