import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { SiftError } from "./errors.js";
import type { Task } from "./provider.js";

/** Prompt files live in packages/core/prompts/<task>.md with a version in front matter (design §7.5). */
const PROMPTS_DIR = fileURLToPath(new URL("../prompts", import.meta.url));

export interface PromptTemplate {
  task: Task;
  version: number;
  /** "describe@1" — sent as `promptVersion` and stored in `generatedBy.prompt`. */
  id: string;
  /** The instructions and examples; sent as the system prompt. */
  text: string;
}

export function parsePromptFile(task: Task, source: string): PromptTemplate {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  const front = m ? (parseDocument(m[1]!).toJS() as { version?: unknown } | null) : null;
  if (!m || !Number.isInteger(front?.version)) {
    throw new SiftError("CONFIG_INVALID", `The ${task} prompt file must start with front matter containing "version: <number>".`);
  }
  const version = front!.version as number;
  return { task, version, id: `${task}@${version}`, text: m[2]!.trim() };
}

const loaded = new Map<Task, Promise<PromptTemplate>>();

export function loadPrompt(task: Task): Promise<PromptTemplate> {
  let p = loaded.get(task);
  if (!p) {
    p = readFile(join(PROMPTS_DIR, `${task}.md`), "utf8").then((text) => parsePromptFile(task, text));
    loaded.set(task, p);
  }
  return p;
}
