import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SIFT_DIR } from "./config.js";
import { SiftError } from "./errors.js";
import { writeFileAtomic } from "./fs.js";
import type { SiftFile } from "./schema.js";
import { parseSiftText, updateSiftText } from "./sift-yaml.js";

export const SIFT_EXTENSION = ".sift";

/** Directories and files inside .sift/ that are not logic files. */
const RESERVED = new Set([".cache", "edits", "rules", "models.local.yaml"]);

/**
 * Project-relative path of the `.sift` file for a source file. The whole source path is mirrored
 * under .sift/ and the full file name is kept, so `src/a.ts` and `src/a.js` never collide:
 * `src/accounts/transfer.ts` → `.sift/src/accounts/transfer.ts.sift`.
 */
export function siftPathFor(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("../") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new SiftError("SOURCE_NOT_FOUND", `${sourcePath} is outside the project.`);
  }
  return `${SIFT_DIR}/${normalized}${SIFT_EXTENSION}`;
}

/** Inverse of siftPathFor, or null if the path is not a logic file. */
export function sourcePathFor(siftPath: string): string | null {
  const normalized = siftPath.replace(/\\/g, "/");
  const prefix = `${SIFT_DIR}/`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(SIFT_EXTENSION)) return null;
  const source = normalized.slice(prefix.length, -SIFT_EXTENSION.length);
  return RESERVED.has(source.split("/")[0]!) || source === "" ? null : source;
}

export interface StoredSiftFile {
  file: SiftFile;
  /** Exact text on disk, used to keep unchanged units byte-identical on rewrite. */
  text: string;
}

/** Read the `.sift` file for a source path, or null if there is none. Invalid files throw. */
export async function readSiftFile(root: string, sourcePath: string): Promise<StoredSiftFile | null> {
  const rel = siftPathFor(sourcePath);
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const text = await readFile(abs, "utf8");
  return { file: parseSiftText(text, rel), text };
}

export interface WriteResult {
  /** Project-relative path of the `.sift` file. */
  path: string;
  /** False when the file already had exactly this content. */
  changed: boolean;
}

/**
 * Write a `.sift` file atomically. Unchanged units keep their existing text, and nothing is
 * written at all when the result is identical to what is on disk.
 * An existing file that can't be parsed is replaced rather than merged.
 */
export async function writeSiftFile(root: string, file: SiftFile): Promise<WriteResult> {
  const rel = siftPathFor(file.source);
  const abs = join(root, rel);
  const existing = existsSync(abs) ? await readFile(abs, "utf8") : null;
  const text = updateSiftText(existing, file);
  if (text === existing) return { path: rel, changed: false };
  await writeFileAtomic(abs, text);
  return { path: rel, changed: true };
}

export async function deleteSiftFile(root: string, sourcePath: string): Promise<boolean> {
  const abs = join(root, siftPathFor(sourcePath));
  if (!existsSync(abs)) return false;
  await rm(abs);
  // Remove folders the deletion left empty, up to (not including) .sift/.
  const base = join(root, SIFT_DIR);
  for (let dir = dirname(abs); dir.length > base.length && dir.startsWith(base); dir = dirname(dir)) {
    if ((await readdir(dir)).length > 0) break;
    await rmdir(dir);
  }
  return true;
}

/** Source paths of every `.sift` file in the project, sorted. */
export async function listSiftFiles(root: string): Promise<string[]> {
  const base = join(root, SIFT_DIR);
  if (!existsSync(base)) return [];
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = `${SIFT_DIR}/${abs.slice(base.length + 1).replace(/\\/g, "/")}`;
    const source = sourcePathFor(rel);
    if (source !== null) sources.push(source);
  }
  return sources.sort();
}
