import { extname } from "node:path";
import type { FileExtraction, LanguageAdapter } from "./adapter.js";
import { SiftCache } from "./cache.js";
import type { SiftConfig } from "./config.js";
import { listSourceFiles, refreshFingerprints } from "./freshness.js";
import { buildFileGraph, CodeGraph, fileOfId, GRAPH_VERSION, type GraphData } from "./graph.js";
import type { RuleSet } from "./rules.js";

export interface RefreshOptions {
  root: string;
  config: SiftConfig;
  adapters: LanguageAdapter[];
  rules: RuleSet;
  /** Hash every file instead of trusting size and mtime (design §5.1). */
  fullHash?: boolean;
}

export interface RefreshResult {
  graph: CodeGraph;
  /** Every source file in the project. */
  files: string[];
  /** Files whose graph entry was rebuilt this run. */
  rebuilt: string[];
  /** Files dropped from the graph because they no longer exist or are no longer included. */
  removed: string[];
  /** Files read and hashed by the freshness check. */
  hashed: string[];
}

/**
 * Bring the code graph up to date with the source (design §10.2), touching as little as possible:
 *
 * 1. The freshness fast path finds each file's current hash.
 * 2. Files whose hash differs from their graph entry are rebuilt, plus files with edges into a
 *    changed or removed file, because their call resolution may have changed with it.
 * 3. Extractions come from the cache when the hash matches; the adapter's project is opened only
 *    if something must actually be re-extracted.
 */
export async function refreshGraph(options: RefreshOptions): Promise<RefreshResult> {
  const { root, config, adapters, rules } = options;
  const cache = new SiftCache(root);
  const adapterFor = (path: string) => adapters.find((a) => a.extensions.includes(extname(path).toLowerCase()));

  const files = await listSourceFiles(root, config, adapters.flatMap((a) => a.extensions));
  const { hashes, hashed } = await refreshFingerprints(root, files, cache, (path, text) => adapterFor(path)!.hashFile(path, text), {
    ...(options.fullHash !== undefined ? { fullHash: options.fullHash } : {}),
  });

  const stored = await cache.getGraph();
  const data: GraphData = stored && stored.rules === rules.hash ? stored : { version: GRAPH_VERSION, rules: rules.hash, files: {} };

  const current = new Set(files);
  const removed = Object.keys(data.files).filter((f) => !current.has(f));
  const changed = files.filter((f) => {
    const entry = data.files[f];
    return !entry || entry.fileHash !== hashes.get(f) || entry.adapter !== adapterFor(f)!.id;
  });

  // Unchanged files that point into a changed or removed file are re-resolved against it.
  const touched = new Set([...changed, ...removed]);
  const dependents = touched.size === 0 ? [] : files.filter(
    (f) => !touched.has(f) && (data.files[f]?.edges ?? []).some((e) => {
      const file = fileOfId(e.to);
      return file !== null && file !== f && touched.has(file);
    }),
  );

  for (const f of removed) delete data.files[f];
  const rebuilt = [...changed, ...dependents].sort();

  if (rebuilt.length > 0) {
    const extractions = await extract(root, config, cache, adapters, files, hashes, changed, new Set(dependents));
    for (const extraction of extractions) {
      data.files[extraction.path] = buildFileGraph(extraction, rules, adapterFor(extraction.path)!.id);
    }
  }
  if (rebuilt.length > 0 || removed.length > 0 || !stored || stored.rules !== rules.hash) await cache.putGraph(data);

  return { graph: new CodeGraph(data), files, rebuilt, removed, hashed };
}

async function extract(
  root: string,
  config: SiftConfig,
  cache: SiftCache,
  adapters: LanguageAdapter[],
  files: string[],
  hashes: Map<string, string>,
  changed: string[],
  dependents: Set<string>,
): Promise<FileExtraction[]> {
  const results: FileExtraction[] = [];
  for (const adapter of adapters) {
    const mine = (f: string) => adapter.extensions.includes(extname(f).toLowerCase());
    const needed: string[] = [];
    for (const f of changed.filter(mine)) {
      const cached = await cache.getExtraction(f, hashes.get(f)!, adapter.id);
      if (cached) results.push(cached);
      else needed.push(f);
    }
    // Dependents are re-extracted even if cached: their own text is unchanged, but what they call is not.
    needed.push(...[...dependents].filter(mine));
    if (needed.length === 0) continue;

    const project = await adapter.openProject(root, files.filter(mine), { liteMaxStatements: config.lite.maxStatements });
    try {
      for (const f of needed) {
        const extraction = project.extractFile(f);
        // Keep the source of the version being replaced and of this one, for diffs and rename detection.
        const previous = await cache.getLastExtraction(f);
        if (previous && previous.fileHash !== extraction.fileHash) await cache.putUnitSources(previous.units);
        await cache.putUnitSources(extraction.units);
        await cache.putExtraction(extraction, adapter.id);
        results.push(extraction);
      }
    } finally {
      project.dispose();
    }
  }
  return results;
}

/**
 * Extractions for the given files at their current hashes (as recorded by `refreshGraph`): from the
 * cache when possible, otherwise extracted with one project per adapter.
 */
export async function loadExtractions(
  options: Pick<RefreshOptions, "root" | "config" | "adapters">,
  graph: CodeGraph,
  files: string[],
): Promise<Map<string, FileExtraction>> {
  const { root, config, adapters } = options;
  const cache = new SiftCache(root);
  const all = graph.files;
  const hashes = new Map(all.map((f) => [f, graph.data.files[f]!.fileHash]));
  const result = new Map<string, FileExtraction>();
  const missing: string[] = [];
  for (const f of files) {
    const adapter = adapters.find((a) => a.extensions.includes(extname(f).toLowerCase()));
    const cached = adapter && hashes.has(f) ? await cache.getExtraction(f, hashes.get(f)!, adapter.id) : null;
    if (cached) result.set(f, cached);
    else missing.push(f);
  }
  if (missing.length > 0) {
    for (const e of await extract(root, config, cache, adapters, all, hashes, missing, new Set())) result.set(e.path, e);
  }
  return result;
}
