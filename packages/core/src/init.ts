import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, SIFT_DIR } from "./config.js";
import { writeFileAtomic } from "./fs.js";

export const GITIGNORE_ENTRIES = [`${SIFT_DIR}/.cache/`, `${SIFT_DIR}/models.local.yaml`] as const;

export interface InitResult {
  /** Project-relative paths created. */
  created: string[];
  /** Project-relative paths changed. */
  updated: string[];
  /** Project-relative paths left alone because they already existed. */
  unchanged: string[];
}

/**
 * Set up Sift in a project. Safe to run again: existing files are never overwritten,
 * and .gitignore only gains the entries it is missing.
 */
export async function initProject(root: string): Promise<InitResult> {
  const result: InitResult = { created: [], updated: [], unchanged: [] };

  for (const dir of [SIFT_DIR, `${SIFT_DIR}/rules`]) {
    const abs = join(root, dir);
    if (existsSync(abs)) result.unchanged.push(`${dir}/`);
    else {
      await mkdir(abs, { recursive: true });
      result.created.push(`${dir}/`);
    }
  }

  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) result.unchanged.push(CONFIG_FILE);
  else {
    await writeFileAtomic(configPath, configTemplate(defaultInclude(root)));
    result.created.push(CONFIG_FILE);
  }

  const gitignorePath = join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : null;
  const present = new Set((existing ?? "").split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) result.unchanged.push(".gitignore");
  else {
    const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
    let text = existing ?? "";
    if (text !== "" && !text.endsWith("\n")) text += eol;
    if (text !== "") text += eol;
    text += ["# Sift (derived data and per-machine model settings)", ...missing].join(eol) + eol;
    await writeFileAtomic(gitignorePath, text);
    (existing === null ? result.created : result.updated).push(".gitignore");
  }

  return result;
}

function defaultInclude(root: string): string {
  const src = join(root, "src");
  return existsSync(src) && statSync(src).isDirectory() ? "src/**" : "**";
}

function configTemplate(include: string): string {
  return `# Sift project configuration. See docs/design.md §12.

# Source files to describe, relative to this file. node_modules and .sift are always skipped.
include:
  - "${include}"
exclude:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/dist/**"
  - "**/build/**"

# AI provider used to write descriptions.
provider: claude-code

# Maximum number of AI calls running at once.
concurrency: 4

# Functions with no control flow, no effects, and at most this many statements
# get a one-line summary instead of a step list.
lite:
  maxStatements: 3

# Units from the same file are described together, up to this many per AI call.
# Fewer calls means the instructions are sent fewer times. 1 describes each unit on its own.
batch:
  maxUnits: 8

# Optional model routing overrides, shared by everyone on the project.
# Personal overrides belong in .sift/models.local.yaml (not committed).
# models:
#   tasks:
#     describe: mid
#   tiers:
#     small: { model: claude-haiku-5-5, effort: low }
`;
}
