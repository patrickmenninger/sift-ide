import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SiftError } from "./errors.js";

export interface LineRange {
  start: number;
  end: number;
}

export interface DiffSummary {
  /** Changed line ranges on the new side, per project-relative path. */
  changed: Map<string, LineRange[]>;
  /** Files that no longer exist. */
  deleted: string[];
}

/**
 * Parse `git diff --unified=0` output. Added and changed lines give their new-side range; a pure
 * deletion gives the lines on both sides of where it was, so the enclosing unit is still found.
 */
export function parseUnifiedDiff(text: string): DiffSummary {
  const summary: DiffSummary = { changed: new Map(), deleted: [] };
  let oldPath: string | null = null;
  let current: LineRange[] | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
    } else if (line.startsWith("--- ")) {
      oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const newPath = stripPrefix(line.slice(4));
      if (newPath === null) {
        if (oldPath !== null) summary.deleted.push(oldPath);
        current = null;
      } else {
        current = summary.changed.get(newPath) ?? [];
        summary.changed.set(newPath, current);
      }
    } else if (line.startsWith("@@") && current) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      current.push(count === 0 ? { start: Math.max(start, 1), end: start + 1 } : { start, end: start + count - 1 });
    }
  }
  return summary;
}

/** "a/src/x.ts" → "src/x.ts"; "/dev/null" → null. Handles git's quoted paths. */
function stripPrefix(raw: string): string | null {
  let path = raw.trim();
  if (path === "/dev/null") return null;
  if (path.startsWith('"') && path.endsWith('"')) path = JSON.parse(path) as string;
  return path.replace(/^[ab]\//, "");
}

const run = promisify(execFile);

/** Changes in the working tree since `ref`, with paths relative to `root` (design §10.4 `impactOfDiff`). */
export async function gitDiff(root: string, ref: string): Promise<DiffSummary> {
  if (ref.startsWith("-")) throw new SiftError("GIT_FAILED", `"${ref}" is not a git revision.`);
  try {
    const { stdout } = await run("git", ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--relative", ref, "--"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseUnifiedDiff(stdout);
  } catch (err) {
    const message = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new SiftError("GIT_FAILED", `git diff ${ref} failed.`, [message]);
  }
}
