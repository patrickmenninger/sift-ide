import type { ExtractedUnit, FileExtraction, LanguageAdapter } from "./adapter.js";
import { SiftCache } from "./cache.js";
import type { SiftConfig } from "./config.js";
import { contextHashOf } from "./describe-output.js";
import { SiftError } from "./errors.js";
import { unitId, type CodeGraph } from "./graph.js";
import { loadExtractions, refreshGraph } from "./project-index.js";
import type { RuleSet } from "./rules.js";
import type { SiftFile, SiftUnit } from "./schema.js";
import { listSiftFiles, readSiftFile } from "./store.js";
import { similarity, tokenize } from "./text-diff.js";

/**
 * Sync planning (design §7.2, §7.3): pair the units in the source with the units in the `.sift`
 * files, find moved files, and work out what each unit needs. `generate` carries the plan out;
 * `status` and `check` only report it.
 */

/** Token similarity at or above which an unmatched pair is a probable rename (design §16: tune on the fixture). */
export const RENAME_THRESHOLD = 0.8;

export type UnitChange =
  /** Same symbol, same code. */
  | "unchanged"
  /** Same symbol, different code. */
  | "changed"
  /** Different symbol, same code. */
  | "renamed"
  /** Different symbol, similar code (rename plus edits). */
  | "probable-rename"
  /** Same code, now in another file. */
  | "moved"
  /** No description yet. */
  | "new"
  /** Described, but no longer in the source. */
  | "deleted";

export interface UnitMatch {
  change: UnitChange;
  /** The file the unit is in now (for deleted units: the file it was in). */
  file: string;
  /** The unit in the source; absent for deleted units. */
  current?: ExtractedUnit;
  /** The described unit; absent for new units. */
  previous?: SiftUnit;
  /** For moved units: the file the description was in. */
  previousFile?: string;
  /** For probable renames: how similar the old and new code are. */
  similarity?: number;
}

export interface Ambiguity {
  /** "file#Symbol" of the described unit. */
  previous: string;
  /** "file#Symbol" of each unit it could have become. */
  candidates: string[];
}

export interface SyncPlan {
  graph: CodeGraph;
  /** Source files the run covers. */
  targets: string[];
  /** Extractions of the target files. */
  extractions: Map<string, FileExtraction>;
  /** Every readable `.sift` file in the project, keyed by its source path after moves. */
  existing: Map<string, SiftFile>;
  /** Units of the target files, plus described units that no longer exist. */
  units: UnitMatch[];
  /** `.sift` files whose source moved: the description follows it. */
  movedFiles: { from: string; to: string }[];
  /** `.sift` files whose source no longer exists and did not move. */
  deletedFiles: string[];
  /** Target `.sift` files that could not be read; they are replaced on the next write. */
  unreadable: string[];
  /** Renames that were not guessed because several units were similar enough. */
  ambiguous: Ambiguity[];
}

export interface PlanOptions {
  root: string;
  config: SiftConfig;
  adapters: LanguageAdapter[];
  rules: RuleSet;
  /** Project-relative files or folders to limit the run to. */
  paths?: string[];
  fullHash?: boolean;
}

export async function planSync(options: PlanOptions): Promise<SyncPlan> {
  const { root } = options;
  const cache = new SiftCache(root);
  const { graph, files } = await refreshGraph({ ...options, ...(options.fullHash ? { fullHash: true } : {}) });
  const targets = selectFiles(files, options.paths ?? []);
  const inScope = (path: string) => matchesPaths(path, options.paths ?? []);

  const existing = new Map<string, SiftFile>();
  const unreadable: string[] = [];
  for (const source of await listSiftFiles(root)) {
    try {
      const stored = await readSiftFile(root, source);
      if (stored) existing.set(source, stored.file);
    } catch (err) {
      if (!(err instanceof SiftError)) throw err;
      if (targets.includes(source)) unreadable.push(source);
    }
  }
  const extractions = await loadExtractions(options, graph, targets);

  // File moves: a .sift file whose source is gone follows a new source file with the same content.
  const sourceSet = new Set(files);
  const orphans = [...existing.keys()].filter((s) => !sourceSet.has(s));
  const undescribed = targets.filter((f) => !existing.has(f) && !unreadable.includes(f));
  const movedFiles = matchMovedFiles(
    orphans.map((s) => ({ path: s, file: existing.get(s)! })),
    undescribed.map((f) => extractions.get(f)!),
  );
  for (const { from, to } of movedFiles) {
    existing.set(to, { ...existing.get(from)!, source: to });
    existing.delete(from);
  }
  const deletedFiles = orphans.filter((s) => !movedFiles.some((m) => m.from === s) && inScope(s));

  // Units, file by file (§7.2 rules 1–5).
  const units: UnitMatch[] = [];
  const ambiguous: Ambiguity[] = [];
  const sourceOf = async (bodyHash: string) => (await cache.getUnitSource(bodyHash))?.sourceText ?? null;
  for (const file of targets) {
    const previous = unreadable.includes(file) ? [] : existing.get(file)?.units ?? [];
    const result = await matchUnits(previous, extractions.get(file)!.units, sourceOf);
    for (const m of result.matches) units.push({ ...m, file });
    for (const a of result.ambiguous) {
      ambiguous.push({ previous: unitId(file, a.previous), candidates: a.candidates.map((c) => unitId(file, c)) });
    }
  }
  for (const file of deletedFiles) for (const u of existing.get(file)!.units) units.push({ change: "deleted", file, previous: u });

  // A unit moved to another file keeps its ID when exactly one deleted and one new unit share its code.
  const deletedByHash = groupBy(units.filter((m) => m.change === "deleted"), (m) => m.previous!.bodyHash);
  const newByHash = groupBy(units.filter((m) => m.change === "new"), (m) => m.current!.bodyHash);
  for (const [hash, gone] of deletedByHash) {
    const added = newByHash.get(hash);
    if (gone.length !== 1 || added?.length !== 1 || gone[0]!.file === added[0]!.file) continue;
    const [from, to] = [gone[0]!, added[0]!];
    units.splice(units.indexOf(from), 1);
    to.change = "moved";
    to.previous = from.previous!;
    to.previousFile = from.file;
  }

  return { graph, targets, extractions, existing, units, movedFiles, deletedFiles, unreadable, ambiguous };
}

/**
 * What is described, keyed by where each unit is now ("file#Symbol"): IDs for call references and
 * summaries for context. Renamed and moved units appear under their new name.
 */
export function describedUnits(plan: SyncPlan): Map<string, { id: string; summary?: string }> {
  const known = new Map<string, { id: string; summary?: string }>();
  const targets = new Set(plan.targets);
  for (const [source, file] of plan.existing) {
    if (!targets.has(source)) for (const u of file.units) known.set(unitId(source, u.symbol), { id: u.id, summary: u.summary });
  }
  for (const m of plan.units) if (m.current && m.previous) known.set(unitId(m.file, m.current.symbol), { id: m.previous.id, summary: m.previous.summary });
  return known;
}

export interface StatusReport {
  /** Described units whose code changed. */
  changed: string[];
  /** Units without a description. */
  new: string[];
  /** Described units whose code is gone. */
  deleted: string[];
  renamed: { from: string; to: string; change: "renamed" | "probable-rename" | "moved"; similarity?: number }[];
  movedFiles: { from: string; to: string }[];
  ambiguous: Ambiguity[];
  /** Unchanged units whose callees' summaries changed since they were described (design §7.3). */
  contextChanged: string[];
  /** Units marked stale: incomplete coverage, or a person's wording the AI changed (review them). */
  stale: string[];
  /** Units described below their task's recommended tier (design §4.5). */
  belowTier: string[];
  unreadable: string[];
  counts: { units: number; generated: number; userEdited: number; verified: number };
}

/** `sift status` / `sift check`: what `generate` would have to do, without calling the AI. */
export async function syncStatus(options: PlanOptions): Promise<StatusReport> {
  const plan = await planSync(options);
  const known = describedUnits(plan);
  const cycles = new CycleIndex(plan.graph);
  const report: StatusReport = {
    changed: [], new: [], deleted: [], renamed: [], movedFiles: plan.movedFiles, ambiguous: plan.ambiguous,
    contextChanged: [], stale: [], belowTier: [], unreadable: plan.unreadable, counts: { units: 0, generated: 0, userEdited: 0, verified: 0 },
  };
  for (const m of plan.units) {
    const ref = unitId(m.file, (m.current ?? m.previous!).symbol);
    if (m.change === "new") report.new.push(ref);
    else if (m.change === "deleted") report.deleted.push(ref);
    else if (m.change === "changed") report.changed.push(ref);
    else if (m.change !== "unchanged") {
      report.renamed.push({ from: unitId(m.previousFile ?? m.file, m.previous!.symbol), to: ref, change: m.change, ...(m.similarity !== undefined ? { similarity: m.similarity } : {}) });
      if (m.change === "probable-rename") report.changed.push(ref);
    }
    const prior = m.previous;
    if (!prior || m.change === "deleted") continue;
    report.counts.units++;
    if (prior.status === "verified") report.counts.verified++;
    else if (prior.status === "user-edited") report.counts.userEdited++;
    else report.counts.generated++;
    if (prior.status === "stale") report.stale.push(ref);
    if (prior.generatedBy?.belowTier) report.belowTier.push(ref);
    if (m.current && prior.bodyHash === m.current.bodyHash) {
      if (expectedContextHash(calleeRefsOf(m.current, ref, plan.graph, cycles), known) !== prior.contextHash) report.contextChanged.push(ref);
    }
  }
  return report;
}

/** True when the `.sift` files match the source: nothing for `generate` to do (design §12, `sift check`). */
export function isInSync(r: StatusReport): boolean {
  return [r.changed, r.new, r.deleted, r.renamed, r.movedFiles, r.contextChanged, r.stale, r.unreadable].every((l) => l.length === 0);
}

/**
 * Pair described units with extracted ones, in the order of design §7.2. `sourceOf` returns the
 * code a description was made from (by bodyHash), when it is still known; without it, rule 4
 * (similar code) cannot apply.
 */
export async function matchUnits(
  previous: SiftUnit[],
  current: ExtractedUnit[],
  sourceOf: (bodyHash: string) => Promise<string | null>,
  threshold = RENAME_THRESHOLD,
): Promise<{ matches: Omit<UnitMatch, "file">[]; ambiguous: { previous: string; candidates: string[] }[] }> {
  const matches: Omit<UnitMatch, "file">[] = [];
  const oldLeft = new Set(previous);
  const newLeft = new Set(current);
  const pair = (p: SiftUnit, c: ExtractedUnit, change: UnitChange, extra: { similarity?: number } = {}) => {
    matches.push({ change, current: c, previous: p, ...extra });
    oldLeft.delete(p);
    newLeft.delete(c);
  };

  // 1–2. Same symbol.
  const bySymbol = new Map(previous.map((p) => [p.symbol, p]));
  for (const c of current) {
    const p = bySymbol.get(c.symbol);
    if (p && oldLeft.has(p)) pair(p, c, p.bodyHash === c.bodyHash ? "unchanged" : "changed");
  }
  // 3. Same code under another name (only when the code identifies one unit on each side).
  const oldByHash = groupBy([...oldLeft], (p) => p.bodyHash);
  const newByHash = groupBy([...newLeft], (c) => c.bodyHash);
  for (const [hash, olds] of oldByHash) {
    const news = newByHash.get(hash);
    if (olds.length === 1 && news?.length === 1) pair(olds[0]!, news[0]!, "renamed");
  }
  // 4. Similar code and the same kind: a probable rename, if neither side has another candidate.
  const ambiguous: { previous: string; candidates: string[] }[] = [];
  const candidates = new Map<SiftUnit, { unit: ExtractedUnit; score: number }[]>();
  for (const p of oldLeft) {
    const source = await sourceOf(p.bodyHash);
    if (source === null) continue;
    const tokens = tokenize(source);
    const found = [...newLeft]
      .filter((c) => c.kind === p.kind)
      .map((c) => ({ unit: c, score: similarity(tokens, tokenize(c.sourceText)) }))
      .filter((x) => x.score >= threshold);
    if (found.length > 0) candidates.set(p, found);
  }
  for (const [p, found] of candidates) {
    const rivals = [...candidates.entries()].filter(([q, f]) => q !== p && f.some((x) => found.some((y) => y.unit === x.unit)));
    if (found.length === 1 && rivals.length === 0) pair(p, found[0]!.unit, "probable-rename", { similarity: round(found[0]!.score) });
    else ambiguous.push({ previous: p.symbol, candidates: found.map((x) => x.unit.symbol) });
  }
  // 5. Everything else.
  for (const p of oldLeft) matches.push({ change: "deleted", previous: p });
  for (const c of newLeft) matches.push({ change: "new", current: c });

  const order = new Map(current.map((c, i) => [c, i]));
  matches.sort((a, b) => (a.current ? order.get(a.current)! : Infinity) - (b.current ? order.get(b.current)! : Infinity));
  return { matches, ambiguous };
}

/**
 * Match `.sift` files whose source no longer exists to new source files (design §7.2): the same
 * fileHash, or at least 80% of units shared by code. Only one-to-one matches count.
 */
export function matchMovedFiles(orphans: { path: string; file: SiftFile }[], candidates: FileExtraction[]): { from: string; to: string }[] {
  const pairs: { from: string; to: string }[] = [];
  const score = (o: SiftFile, e: FileExtraction) => {
    if (o.fileHash === e.fileHash) return 1;
    const before = new Set(o.units.map((u) => u.bodyHash));
    const shared = e.units.filter((u) => before.has(u.bodyHash)).length;
    const total = Math.max(before.size, e.units.length);
    return total === 0 ? 0 : shared / total;
  };
  const options = orphans.map((o) => ({ o, hits: candidates.filter((e) => score(o.file, e) >= RENAME_THRESHOLD) }));
  for (const { o, hits } of options) {
    if (hits.length !== 1) continue;
    const target = hits[0]!;
    if (options.filter((x) => x.hits.includes(target)).length !== 1) continue;
    pairs.push({ from: o.path, to: target.path });
  }
  return pairs;
}

/**
 * The project units whose summaries a unit's description depends on: what it calls, and for calls
 * to an interface member, the implementations. Units in the same recursion cycle are left out, so
 * describing a cycle in parallel always gives the same contextHash.
 */
export function calleeRefsOf(unit: ExtractedUnit, ref: string, graph: CodeGraph, cycles: CycleIndex): string[] {
  const out = new Set<string>();
  for (const node of flattenNodes(unit.body)) {
    for (const call of node.calls) {
      if (!call.target || call.external) continue;
      const target = unitId(call.target.file, call.target.symbol);
      for (const t of [target, ...graph.implementers(target)]) if (t !== ref && !cycles.same(t, ref)) out.add(t);
    }
  }
  return [...out].sort();
}

/** contextHash from the callees' current summaries (`summaries` maps "file#Symbol" to summary). */
export function expectedContextHash(refs: string[], known: Map<string, { id: string; summary?: string }>): string | undefined {
  return contextHashOf(refs.flatMap((r) => {
    const k = known.get(r);
    return k?.summary ? [{ id: k.id, summary: k.summary }] : [];
  }));
}

/** Which units are in the same call cycle, over the whole graph (calls plus interface dispatch). */
export class CycleIndex {
  private readonly componentOf = new Map<string, number>();

  constructor(graph: CodeGraph) {
    const ids = graph.units().map((u) => u.id);
    const edges = (id: string) => graph.edgesFrom(id, "calls").flatMap((e) => [e.to, ...graph.implementers(e.to)]).filter((t) => graph.unit(t));
    stronglyConnected(ids, edges).forEach((component, i) => {
      if (component.length > 1) for (const id of component) this.componentOf.set(id, i);
    });
  }

  same(a: string, b: string): boolean {
    const c = this.componentOf.get(a);
    return c !== undefined && c === this.componentOf.get(b);
  }
}

/** Tarjan's algorithm; components come out callees first (reverse topological order). */
export function stronglyConnected(ids: string[], edgesOf: (id: string) => string[]): string[][] {
  const known = new Set(ids);
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  // Iterative, so deep call chains cannot overflow the stack.
  for (const start of ids) {
    if (index.has(start)) continue;
    const work: { v: string; next: string[]; i: number }[] = [];
    const open = (v: string) => {
      index.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      work.push({ v, next: [...new Set(edgesOf(v))].filter((w) => known.has(w)), i: 0 });
    };
    open(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      if (top.i < top.next.length) {
        const w = top.next[top.i++]!;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
      if (low.get(top.v) === index.get(top.v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== top.v);
        components.push(component);
      }
    }
  }
  return components;
}

export function selectFiles(files: string[], paths: string[]): string[] {
  if (paths.length === 0) return files;
  const wanted = normalizePaths(paths);
  const unmatched = wanted.filter((p) => p !== "" && p !== "." && !files.some((f) => f === p || f.startsWith(`${p}/`)));
  if (unmatched.length > 0) {
    throw new SiftError(
      "SOURCE_NOT_FOUND",
      `No source files match ${unmatched.map((p) => `"${p}"`).join(", ")}.`,
      ["Paths are relative to the project root and must be included by sift.config.yaml."],
    );
  }
  return files.filter((f) => matchesPaths(f, paths));
}

function matchesPaths(file: string, paths: string[]): boolean {
  if (paths.length === 0) return true;
  return normalizePaths(paths).some((p) => p === "" || p === "." || file === p || file.startsWith(`${p}/`));
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
}

function flattenNodes<T extends { children: T[] }>(nodes: T[]): T[] {
  return nodes.flatMap((n) => [n, ...flattenNodes(n.children)]);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
