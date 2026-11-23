import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedUnit, FileExtraction, LanguageAdapter, SourcePosition, SourceRange, StructureNode } from "./adapter.js";
import { loadProject, type SiftConfig } from "./config.js";
import { flatten } from "./describe-input.js";
import { stepOwners } from "./describe-output.js";
import { gitDiff } from "./diff.js";
import { SiftError } from "./errors.js";
import { generate, type GenerateEvent, type GenerateReport } from "./generate.js";
import { fileOfId, unitId, type CodeGraph, type FlowResult, type GapNote, type ImpactResult, type QueryHit } from "./graph.js";
import { loadExtractions, refreshGraph, type RefreshResult } from "./project-index.js";
import { displayStatus } from "./provenance.js";
import type { Provider } from "./provider.js";
import { loadLocalOverrides, loadModelMap, Router } from "./routing.js";
import { loadRulePacks, RuleSet, type LoadedRules } from "./rules.js";
import { SIFT_SCHEMA_VERSION, type Effect, type SiftFile, type SiftStep, type SiftUnit, type UnitStatus } from "./schema.js";
import { listSiftFiles, readSiftFile, siftPathFor, writeSiftFile } from "./store.js";
import { isInSync, syncStatus, type StatusReport } from "./sync.js";

/**
 * The long-lived engine behind the CLI, `sift serve`, and the MCP server (phase-2-design §4).
 *
 * Every read first brings the code graph up to date (freshness fast path, design §5.1), so results
 * never describe code that has since changed. Reads and writes are run one at a time: refreshing
 * the graph writes the cache, and two refreshes at once would race.
 */
export interface WorkspaceOptions {
  /** A directory inside the project; the root is found from it (sift.config.yaml). */
  cwd: string;
  adapters: LanguageAdapter[];
  /** The built-in rule packs (`@sift/rules` packs folder). */
  builtinRulesDir: string;
  /** Needed only for `generate`. A function receives the project's config, which names the provider. */
  provider?: Provider | ((config: SiftConfig) => Provider);
  /** Hash every file on every refresh instead of trusting size and mtime. */
  fullHash?: boolean;
}

export type WorkspaceChange =
  /** Source files whose graph entry was rebuilt or dropped by a refresh. */
  | { type: "source"; files: string[] }
  /** `.sift` files Sift wrote or removed (project-relative `.sift/...` paths). */
  | { type: "descriptions"; files: string[] };

export interface Disposable {
  dispose(): void;
}

/** A described unit as an editor shows it. */
export interface LogicUnit {
  /** `file#symbol`. */
  ref: string;
  unit: SiftUnit;
  /** What to show: `stale` first, and `user-edited` for a unit holding a person's wording. */
  status: UnitStatus;
  /** Whether the description was written for the code as it is now. */
  freshness: "fresh" | "code-changed" | "not-in-code";
}

export interface LogicFile {
  source: string;
  /** Null when the file has no `.sift` file yet. */
  sift: SiftFile | null;
  units: LogicUnit[];
  /** Symbols in the code that have no description yet. */
  undescribed: string[];
}

/** Where a step's call leads (phase-2-design §6.3). */
export type NavTarget =
  | { kind: "unit"; unitId: string; ref: string; file: string; symbol: string; summary: string }
  | { kind: "external"; ref: string; module: string; name: string; effects: Effect[] }
  /** A unit ID no `.sift` file has any more (the callee was deleted or not yet described again). */
  | { kind: "missing"; ref: string };

export interface SourceRanges {
  file: string;
  /** False when the code changed since the description was written; `ranges` is then the whole unit, if it still exists. */
  fresh: boolean;
  ranges: SourceRange[];
}

export interface StepLocation {
  unitId: string;
  ref: string;
  /** Absent when the position is in the unit but not in any statement (its signature), or the unit is not fresh. */
  stepId?: string;
  fresh: boolean;
}

export interface VerifyResult {
  verified: string[];
  /** Units not verified, with the reason. */
  refused: { unit: string; reason: string }[];
  written: string[];
}

export class Workspace {
  private graphValue: CodeGraph | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(e: WorkspaceChange) => void>();
  private readonly siftCache = new Map<string, { size: number; mtimeMs: number; file: SiftFile | null; error?: unknown }>();
  private disposed = false;

  private constructor(
    readonly root: string,
    readonly config: SiftConfig,
    readonly rules: RuleSet,
    readonly loadedRules: LoadedRules,
    private readonly options: WorkspaceOptions,
    readonly provider: Provider | undefined,
  ) {}

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const project = await loadProject(options.cwd);
    const loaded = await loadRulePacks(project.root, { builtinDir: options.builtinRulesDir });
    const provider = typeof options.provider === "function" ? options.provider(project.config) : options.provider;
    return new Workspace(project.root, project.config, new RuleSet(loaded.packs), loaded, options, provider);
  }

  get adapters(): LanguageAdapter[] {
    return this.options.adapters;
  }

  onDidChange(listener: (e: WorkspaceChange) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ freshness

  /** Bring the code graph up to date with the source (design §10.2). */
  refresh(options: { fullHash?: boolean } = {}): Promise<RefreshResult> {
    return this.serial(() => this.refreshNow(options));
  }

  /** The code graph, refreshed first. */
  graph(options: { fullHash?: boolean } = {}): Promise<CodeGraph> {
    return this.serial(async () => (await this.refreshNow(options)).graph);
  }

  private async refreshNow(options: { fullHash?: boolean }): Promise<RefreshResult> {
    this.assertOpen();
    const result = await refreshGraph({
      root: this.root,
      config: this.config,
      adapters: this.adapters,
      rules: this.rules,
      fullHash: options.fullHash ?? this.options.fullHash ?? process.env.SIFT_FULL_HASH === "1",
    });
    this.graphValue = result.graph;
    const files = [...result.rebuilt, ...result.removed];
    if (files.length > 0) this.emit({ type: "source", files });
    return result;
  }

  // ------------------------------------------------------------------ queries

  /** One symbol for a query (`file#Symbol`, `Class.method`, or a unique last part), or a helpful error. */
  resolveSymbol(graph: CodeGraph, query: string): string {
    const matches = graph.find(query);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new SiftError("SOURCE_NOT_FOUND", `"${query}" matches ${matches.length} symbols; use one of these names:`, matches);
    const lower = query.toLowerCase().split("#").pop()!;
    const similar = graph.units().map((u) => u.id).filter((id) => id.toLowerCase().includes(lower)).sort().slice(0, 10);
    throw new SiftError(
      "SOURCE_NOT_FOUND",
      `No unit or symbol named "${query}" in the files Sift reads (sift.config.yaml include/exclude).`,
      similar.map((id) => `similar: ${id}`),
    );
  }

  async callers(query: string, depth = 1): Promise<{ subject: string; callers: QueryHit[]; possibleCallers: GapNote[] }> {
    const graph = await this.graph();
    const subject = this.resolveSymbol(graph, query);
    return { subject, callers: graph.callers(subject, depth), possibleCallers: graph.possibleCallers(subject) };
  }

  async callees(query: string, depth = 1): Promise<{ subject: string; effects: Effect[]; callees: QueryHit[]; unresolved: GapNote[] }> {
    const graph = await this.graph();
    const subject = this.resolveSymbol(graph, query);
    return { subject, effects: graph.effectsOf(subject, { propagated: true }), callees: graph.callees(subject, depth), unresolved: graph.gapsIn(subject) };
  }

  /**
   * What changing some units may affect (design §10.4). With `diff`, the units changed since that
   * git ref are added to the subjects; `notes` says what in the diff was not a unit.
   */
  async impact(queries: string[], diff?: string): Promise<ImpactResult & { subjects: string[]; notes: string[] }> {
    if (queries.length === 0 && diff === undefined) throw new SiftError("SOURCE_NOT_FOUND", "Name at least one symbol, or a git ref to diff against.");
    const graph = await this.graph();
    const subjects = queries.map((q) => this.resolveSymbol(graph, q));
    const notes: string[] = [];
    if (diff !== undefined) {
      const changes = await gitDiff(this.root, diff);
      for (const [file, ranges] of [...changes.changed].sort(([a], [b]) => a.localeCompare(b))) {
        if (!graph.files.includes(file)) continue;
        const units = graph.unitsAt(file, ranges);
        if (units.length === 0) notes.push(`${file}: changes are outside any unit (imports, types, or comments)`);
        for (const u of units) if (!subjects.includes(u)) subjects.push(u);
      }
      for (const file of changes.deleted) if (this.supports(file)) notes.push(`${file}: deleted; its callers now show as unresolved calls`);
    }
    if (subjects.length === 0) return { subjects, notes, units: [], routes: [], tests: [], gaps: [] };
    return { subjects, notes, ...graph.impact(subjects) };
  }

  /** Routes matching a query (`POST /transfers`, `/transfers`), or an error listing the routes there are. */
  async findRoutes(query: string): Promise<string[]> {
    const graph = await this.graph();
    const found = graph.findRoutes(query);
    if (found.length === 0) throw new SiftError("SOURCE_NOT_FOUND", `No route matches "${query}".`, graph.routes().map((r) => `route: ${r.slice("route:".length)}`));
    return found;
  }

  async flow(query: string, depth = 10): Promise<FlowResult[]> {
    const routes = await this.findRoutes(query);
    const graph = this.graphValue!;
    return routes.map((r) => graph.flow(r, depth));
  }

  /** The `sift status` report (design §7.2.1). */
  status(options: { paths?: string[]; fullHash?: boolean } = {}): Promise<StatusReport & { inSync: boolean }> {
    return this.serial(async () => {
      const report = await syncStatus({
        root: this.root,
        config: this.config,
        adapters: this.adapters,
        rules: this.rules,
        ...(options.paths ? { paths: options.paths } : {}),
        fullHash: options.fullHash ?? this.options.fullHash ?? process.env.SIFT_FULL_HASH === "1",
      });
      return { inSync: isInSync(report), ...report };
    });
  }

  /** The adapter's extraction of a source file, as it is now. */
  extraction(source: string): Promise<FileExtraction> {
    return this.serial(async () => {
      const { graph } = await this.refreshNow({});
      if (!graph.files.includes(source)) throw this.notASourceFile(source);
      return (await loadExtractions({ root: this.root, config: this.config, adapters: this.adapters }, graph, [source])).get(source)!;
    });
  }

  // ------------------------------------------------------------------ descriptions

  /** A source file's logic: its `.sift` file with each unit's status and freshness. */
  async logicFile(source: string): Promise<LogicFile> {
    const extraction = await this.extraction(source);
    const sift = await this.readSift(source);
    const extracted = new Map(extraction.units.map((u) => [u.symbol, u]));
    const units: LogicUnit[] = (sift?.units ?? []).map((unit) => {
      const now = extracted.get(unit.symbol);
      return {
        ref: unitId(source, unit.symbol),
        unit,
        status: displayStatus(unit),
        freshness: !now ? "not-in-code" : now.bodyHash === unit.bodyHash ? "fresh" : "code-changed",
      };
    });
    const described = new Set(units.map((u) => u.unit.symbol));
    return { source, sift, units, undescribed: extraction.units.map((u) => u.symbol).filter((s) => !described.has(s)) };
  }

  /** A described unit by `.sift` ID (`u_…`) or by symbol query. */
  async unit(query: string): Promise<{ source: string; unit: SiftUnit }> {
    if (/^u_[a-z2-7]{8}$/.test(query)) {
      const found = (await this.unitIndex()).get(query);
      if (!found) throw new SiftError("SOURCE_NOT_FOUND", `No .sift file has a unit with ID ${query}.`);
      return found;
    }
    const graph = await this.graph();
    const ref = this.resolveSymbol(graph, query);
    const source = fileOfId(ref)!;
    const symbol = ref.slice(source.length + 1);
    const unit = (await this.readSift(source))?.units.find((u) => u.symbol === symbol);
    if (!unit) throw new SiftError("SOURCE_NOT_FOUND", `${ref} has no description yet. Run "sift generate ${source}" to create it.`);
    return { source, unit };
  }

  /** Unit ID → its source file and description, across every readable `.sift` file. */
  async unitIndex(): Promise<Map<string, { source: string; unit: SiftUnit }>> {
    const index = new Map<string, { source: string; unit: SiftUnit }>();
    for (const source of await listSiftFiles(this.root)) {
      let file: SiftFile | null = null;
      try {
        file = await this.readSift(source);
      } catch {
        continue; // an unreadable file elsewhere should not stop lookups; `status` reports it
      }
      for (const unit of file?.units ?? []) index.set(unit.id, { source, unit });
    }
    return index;
  }

  /** The code a step (or, without `stepId`, a whole unit) covers (phase-2-design §6.2). */
  async sourceRanges(unitIdOrQuery: string, stepId?: string): Promise<SourceRanges> {
    const { source, unit } = await this.unit(unitIdOrQuery);
    const extracted = (await this.extraction(source)).units.find((u) => u.symbol === unit.symbol);
    if (!extracted) return { file: source, fresh: false, ranges: [] };
    if (extracted.bodyHash !== unit.bodyHash) return { file: source, fresh: false, ranges: [extracted.range] };
    if (stepId === undefined) return { file: source, fresh: true, ranges: [extracted.range] };
    const step = findStep(unit.steps, stepId);
    if (!step) throw new SiftError("SOURCE_NOT_FOUND", `${unitId(source, unit.symbol)} has no step ${stepId}.`);
    const nodes = new Map(flatten(extracted.body).map((n) => [n.key, n]));
    const ranges = step.covers.flatMap((key) => (nodes.has(key) ? [nodes.get(key)!.range] : []));
    return { file: source, fresh: true, ranges };
  }

  /** The unit and step that own a position in a source file (phase-2-design §6.2), or null outside every unit. */
  async stepAt(source: string, position: SourcePosition): Promise<StepLocation | null> {
    const extraction = await this.extraction(source);
    const containing = extraction.units.filter((u) => contains(u.range, position)).sort((a, b) => span(a.range) - span(b.range));
    const sift = await this.readSift(source);
    for (const extracted of containing) {
      const unit = sift?.units.find((u) => u.symbol === extracted.symbol);
      if (!unit) continue;
      const location: StepLocation = { unitId: unit.id, ref: unitId(source, unit.symbol), fresh: unit.bodyHash === extracted.bodyHash };
      if (!location.fresh) return location;
      const node = deepestNode(extracted, position);
      const step = node ? stepOwners(unit.steps)(node.key) : undefined;
      if (step) location.stepId = step.id;
      return location;
    }
    return null;
  }

  /** Where Ctrl+click on a step goes: one target per call, in order (phase-2-design §6.3). */
  async stepTargets(unitIdOrQuery: string, stepId: string): Promise<NavTarget[]> {
    const { source, unit } = await this.unit(unitIdOrQuery);
    const step = findStep(unit.steps, stepId);
    if (!step) throw new SiftError("SOURCE_NOT_FOUND", `${unitId(source, unit.symbol)} has no step ${stepId}.`);
    const index = await this.unitIndex();
    return step.calls.map((ref): NavTarget => {
      if (ref.startsWith("ext:")) {
        const hash = ref.indexOf("#");
        const module = ref.slice("ext:".length, hash);
        const name = ref.slice(hash + 1);
        const range = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
        const effects = this.rules.effectsFor({ expression: name, target: null, confidence: "resolved", implementations: [], external: { module, name }, awaited: false, args: [], range });
        return { kind: "external", ref, module, name, effects };
      }
      const found = index.get(ref);
      if (!found) return { kind: "missing", ref };
      return { kind: "unit", unitId: ref, ref: unitId(found.source, found.unit.symbol), file: found.source, symbol: found.unit.symbol, summary: found.unit.summary };
    });
  }

  // ------------------------------------------------------------------ writing

  /** The routing for this project: shipped mapping, config, and personal overrides (design §4.2). */
  async router(providerId?: string): Promise<{ router: Router; localOverrides: boolean }> {
    const id = providerId ?? this.provider?.id ?? this.config.provider;
    const local = await loadLocalOverrides(this.root);
    return { router: new Router(await loadModelMap(id), this.config, local), localOverrides: local !== null };
  }

  /** Run the generation pipeline (design §7.1). */
  generate(options: { paths?: string[]; force?: boolean; dryRun?: boolean; fullHash?: boolean; onEvent?: (e: GenerateEvent) => void } = {}): Promise<GenerateReport> {
    return this.serial(async () => {
      const provider = this.provider;
      if (!provider) throw new SiftError("PROVIDER_FAILED", "This workspace was opened without an AI provider, so it cannot generate descriptions.");
      const { router } = await this.router(provider.id);
      const report = await generate({
        root: this.root,
        config: this.config,
        adapters: this.adapters,
        rules: this.rules,
        provider,
        router,
        ...(options.paths ? { paths: options.paths } : {}),
        force: options.force === true,
        dryRun: options.dryRun === true,
        fullHash: options.fullHash ?? this.options.fullHash ?? process.env.SIFT_FULL_HASH === "1",
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      this.graphValue = null;
      const files = [...report.written, ...report.removed.map(siftPathFor)];
      if (files.length > 0) this.emit({ type: "descriptions", files });
      return report;
    });
  }

  /**
   * Mark units as checked by a person (`status: verified`). Targets are symbol queries, unit IDs,
   * or source files (every unit in them). A unit whose description is not up to date with the
   * code, or that is marked stale, is refused: verifying it would vouch for text nobody checked
   * against the current code.
   */
  verify(targets: string[]): Promise<VerifyResult> {
    return this.serial(async () => {
      const graph = (await this.refreshNow({})).graph;
      const wanted = new Map<string, Set<string>>(); // source → symbols
      const add = (source: string, symbol: string) => (wanted.get(source) ?? wanted.set(source, new Set()).get(source)!).add(symbol);
      const index = targets.some((t) => /^u_[a-z2-7]{8}$/.test(t)) ? await this.unitIndex() : new Map<string, { source: string; unit: SiftUnit }>();
      for (const target of targets) {
        if (/^u_[a-z2-7]{8}$/.test(target)) {
          const found = index.get(target);
          if (!found) throw new SiftError("SOURCE_NOT_FOUND", `No .sift file has a unit with ID ${target}.`);
          add(found.source, found.unit.symbol);
        } else if (graph.files.includes(target)) {
          const file = await this.readSift(target);
          if (!file) throw new SiftError("SOURCE_NOT_FOUND", `${target} has no description yet. Run "sift generate ${target}" first.`);
          for (const u of file.units) add(target, u.symbol);
        } else {
          const ref = this.resolveSymbol(graph, target);
          add(fileOfId(ref)!, ref.slice(fileOfId(ref)!.length + 1));
        }
      }

      const report = await syncStatus({ root: this.root, config: this.config, adapters: this.adapters, rules: this.rules, paths: [...wanted.keys()] });
      const outOfDate = new Map<string, string>();
      for (const ref of report.changed) outOfDate.set(ref, "the code changed since it was described; run generate first");
      for (const ref of report.contextChanged) outOfDate.set(ref, "the descriptions of units it calls changed; run generate first");
      for (const r of report.renamed) outOfDate.set(r.to, "it was renamed or moved since it was described; run generate first");
      for (const ref of report.stale) outOfDate.set(ref, "it is marked stale; review it and run generate");

      const result: VerifyResult = { verified: [], refused: [], written: [] };
      for (const [source, symbols] of wanted) {
        const file = await this.readSift(source);
        if (!file) continue;
        let changed = false;
        for (const symbol of symbols) {
          const ref = unitId(source, symbol);
          const unit = file.units.find((u) => u.symbol === symbol);
          if (!unit) {
            result.refused.push({ unit: ref, reason: "it has no description yet; run generate first" });
            continue;
          }
          const why = outOfDate.get(ref);
          if (why) {
            result.refused.push({ unit: ref, reason: why });
            continue;
          }
          result.verified.push(ref);
          if (unit.status === "verified") continue;
          unit.status = "verified";
          clearStepStatus(unit.steps, "verified");
          changed = true;
        }
        if (changed) {
          const written = await writeSiftFile(this.root, file);
          if (written.changed) result.written.push(written.path);
        }
      }
      if (result.written.length > 0) this.emit({ type: "descriptions", files: result.written });
      return result;
    });
  }

  /** Rewrite every `.sift` file at the current schema version (phase-2-design §7). Unit text is kept as it is. */
  migrate(): Promise<{ upgraded: string[]; current: string[]; unreadable: { file: string; message: string }[] }> {
    return this.serial(async () => {
      const result = { upgraded: [] as string[], current: [] as string[], unreadable: [] as { file: string; message: string }[] };
      for (const source of await listSiftFiles(this.root)) {
        let file: SiftFile | null;
        try {
          file = (await readSiftFile(this.root, source))?.file ?? null;
        } catch (err) {
          result.unreadable.push({ file: siftPathFor(source), message: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (!file) continue;
        if (file.sift >= SIFT_SCHEMA_VERSION) {
          result.current.push(siftPathFor(source));
          continue;
        }
        file.sift = SIFT_SCHEMA_VERSION;
        const written = await writeSiftFile(this.root, file);
        if (written.changed) result.upgraded.push(written.path);
      }
      if (result.upgraded.length > 0) this.emit({ type: "descriptions", files: result.upgraded });
      return result;
    });
  }

  // ------------------------------------------------------------------ internals

  /** A source file's `.sift` file, or null. Read through a cache keyed by size and mtime, so a long-running server rereads only what changed. */
  async readSift(source: string): Promise<SiftFile | null> {
    const abs = join(this.root, siftPathFor(source));
    let info: { size: number; mtimeMs: number } | null = null;
    try {
      info = await stat(abs);
    } catch {
      this.siftCache.delete(source);
      return null;
    }
    const cached = this.siftCache.get(source);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      if (cached.error) throw cached.error;
      return structuredClone(cached.file);
    }
    try {
      const file = (await readSiftFile(this.root, source))?.file ?? null;
      this.siftCache.set(source, { size: info.size, mtimeMs: info.mtimeMs, file });
      return structuredClone(file);
    } catch (error) {
      this.siftCache.set(source, { size: info.size, mtimeMs: info.mtimeMs, file: null, error });
      throw error;
    }
  }

  private supports(file: string): boolean {
    const dot = file.lastIndexOf(".");
    return dot >= 0 && this.adapters.some((a) => a.extensions.includes(file.slice(dot).toLowerCase()));
  }

  private notASourceFile(source: string): SiftError {
    return this.supports(source)
      ? new SiftError("SOURCE_NOT_FOUND", `${source} is not one of the files Sift reads (it does not exist, or sift.config.yaml include/exclude leaves it out).`)
      : new SiftError("UNSUPPORTED_FILE", `No language support for ${source}. Supported: ${this.adapters.flatMap((a) => a.extensions).join(", ")}.`);
  }

  private emit(change: WorkspaceChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure must not break the operation that changed something.
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new SiftError("NOT_IMPLEMENTED", "This workspace has been closed.");
  }

  /** Run operations one at a time, in order; a failed one does not block the next. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function findStep(steps: SiftStep[], id: string): SiftStep | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = findStep(s.steps, id);
    if (inner) return inner;
  }
  return undefined;
}

function clearStepStatus(steps: SiftStep[], status: SiftStep["status"]): void {
  for (const s of steps) {
    if (s.status === status) delete s.status;
    clearStepStatus(s.steps, status);
  }
}

function before(a: SourcePosition, b: SourcePosition): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}

function contains(range: SourceRange, p: SourcePosition): boolean {
  return before(range.start, p) && before(p, range.end);
}

/** Relative size of a range, for picking the innermost one. */
function span(range: SourceRange): number {
  return (range.end.line - range.start.line) * 100_000 + (range.end.col - range.start.col);
}

function deepestNode(unit: ExtractedUnit, p: SourcePosition): StructureNode | undefined {
  let best: StructureNode | undefined;
  const walk = (nodes: StructureNode[]): void => {
    for (const n of nodes) {
      if (!contains(n.range, p)) continue;
      if (!best || span(n.range) <= span(best.range)) best = n;
      walk(n.children);
    }
  };
  walk(unit.body);
  return best;
}
