import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SiftCache, Fingerprint } from "./cache.js";
import type { SiftConfig } from "./config.js";
import { globToRegExp, matchesAny } from "./glob.js";

/** Directories never searched for source files. */
const ALWAYS_SKIPPED = new Set(["node_modules", ".git", ".sift"]);

/** Project-relative paths (forward slashes, sorted) of source files matched by `include`/`exclude` with one of the extensions. */
export async function listSourceFiles(root: string, config: Pick<SiftConfig, "include" | "exclude">, extensions: string[]): Promise<string[]> {
  const include = config.include.map((p) => globToRegExp(p));
  const exclude = config.exclude.map((p) => globToRegExp(p));
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const found: string[] = [];

  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ALWAYS_SKIPPED.has(entry.name) && !matchesAny(path, exclude)) await walk(join(dir, entry.name), path);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot < 0 || !exts.has(entry.name.slice(dot).toLowerCase())) continue;
        if (matchesAny(path, include) && !matchesAny(path, exclude)) found.push(path);
      }
    }
  };
  await walk(root, "");
  return found.sort();
}

export interface FreshnessResult {
  /** Current normalized hash of every file. */
  hashes: Map<string, string>;
  /** Files that had to be read and hashed (new, or size/mtime changed, or `fullHash`). */
  hashed: string[];
}

/**
 * The freshness fast path (design §5.1): compare each file's size and mtime with its cached
 * fingerprint and hash only the files that differ. With `fullHash`, every file is hashed.
 */
export async function refreshFingerprints(
  root: string,
  files: string[],
  cache: SiftCache,
  hashFile: (path: string, text: string) => string,
  options: { fullHash?: boolean } = {},
): Promise<FreshnessResult> {
  const previous = await cache.getFingerprints();
  const next = new Map<string, Fingerprint>();
  const hashes = new Map<string, string>();
  const hashed: string[] = [];

  for (const path of files) {
    const abs = join(root, path);
    const info = await stat(abs);
    const old = previous.get(path);
    if (!options.fullHash && old && old.size === info.size && old.mtimeMs === info.mtimeMs) {
      next.set(path, old);
      hashes.set(path, old.fileHash);
      continue;
    }
    const fileHash = hashFile(path, await readFile(abs, "utf8"));
    hashed.push(path);
    next.set(path, { size: info.size, mtimeMs: info.mtimeMs, fileHash });
    hashes.set(path, fileHash);
  }

  const changed = next.size !== previous.size || [...next].some(([path, fp]) => {
    const old = previous.get(path);
    return !old || old.size !== fp.size || old.mtimeMs !== fp.mtimeMs || old.fileHash !== fp.fileHash;
  });
  if (changed) await cache.putFingerprints(next);
  return { hashes, hashed };
}
