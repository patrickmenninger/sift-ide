import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileExtraction } from "./adapter.js";
import { GRAPH_VERSION, type GraphData } from "./graph.js";
import { SIFT_DIR } from "./config.js";
import { writeFileAtomic } from "./fs.js";

/**
 * Bump when the shape of cached data changes; older caches are then ignored.
 * The cache is purely a speed-up (design §6.5): anything missing or unreadable is recomputed.
 */
export const CACHE_VERSION = 1;

export const CACHE_DIR = `${SIFT_DIR}/.cache`;

export interface Fingerprint {
  size: number;
  mtimeMs: number;
  fileHash: string;
}

interface CachedExtraction {
  version: number;
  adapter: string;
  extraction: FileExtraction;
}

interface FingerprintFile {
  version: number;
  files: Record<string, Fingerprint>;
}

export class SiftCache {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, CACHE_DIR);
  }

  /** The cached extraction for a source file, if it was made from the same content by the same adapter. */
  async getExtraction(sourcePath: string, fileHash: string, adapter: string): Promise<FileExtraction | null> {
    const cached = await this.readJson<CachedExtraction>(this.extractionPath(sourcePath));
    if (!cached || cached.version !== CACHE_VERSION || cached.adapter !== adapter) return null;
    return cached.extraction.fileHash === fileHash && cached.extraction.path === sourcePath ? cached.extraction : null;
  }

  async putExtraction(extraction: FileExtraction, adapter: string): Promise<void> {
    const entry: CachedExtraction = { version: CACHE_VERSION, adapter, extraction };
    await writeFileAtomic(this.extractionPath(extraction.path), JSON.stringify(entry));
  }

  async getFingerprints(): Promise<Map<string, Fingerprint>> {
    const data = await this.readJson<FingerprintFile>(join(this.dir, "fingerprints.json"));
    if (!data || data.version !== CACHE_VERSION || typeof data.files !== "object") return new Map();
    return new Map(Object.entries(data.files));
  }

  async putFingerprints(fingerprints: Map<string, Fingerprint>): Promise<void> {
    const files = Object.fromEntries([...fingerprints.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const data: FingerprintFile = { version: CACHE_VERSION, files };
    await writeFileAtomic(join(this.dir, "fingerprints.json"), `${JSON.stringify(data, null, 1)}\n`);
  }

  /** The stored code graph, or null if missing, unreadable, or from another version. */
  async getGraph(): Promise<GraphData | null> {
    const data = await this.readJson<GraphData & { cache?: number }>(join(this.dir, "graph.json"));
    if (!data || data.cache !== CACHE_VERSION || data.version !== GRAPH_VERSION || typeof data.files !== "object") return null;
    const { cache: _cache, ...graph } = data;
    return graph;
  }

  async putGraph(graph: GraphData): Promise<void> {
    const files = Object.fromEntries(Object.entries(graph.files).sort(([a], [b]) => a.localeCompare(b)));
    await writeFileAtomic(join(this.dir, "graph.json"), JSON.stringify({ cache: CACHE_VERSION, ...graph, files }));
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private extractionPath(sourcePath: string): string {
    return join(this.dir, "files", `${sourcePath}.json`);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return null;
    }
  }
}
