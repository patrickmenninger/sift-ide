import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SiftError, TASKS, TIERS, type Task, type Tier } from "@sift/core";

/** What a correct description of a unit must contain (design §13.2). */
export interface UnitExpectation {
  /** "file#Symbol" */
  unit: string;
  lite?: boolean;
  mustMention: string[];
  mustWarn: string[];
  mustNotWarn: string[];
}

export interface Expectations {
  fixture: string;
  units: UnitExpectation[];
}

/** A scripted edit for the churn metric (design §13.3). */
export interface ChurnEdit {
  name: string;
  file: string;
  replace: { from: string; to: string; all?: boolean }[];
}

/** One configuration of the model matrix (design §13.4): tasks moved to other tiers. */
export interface MatrixConfig {
  name: string;
  tasks: Partial<Record<Task, Tier>>;
}

export const DEFAULT_CONFIG: MatrixConfig = { name: "recommended", tasks: {} };

export async function loadExpectations(evalDir: string, fixture: string): Promise<Expectations> {
  const path = join(evalDir, "expectations", `${fixture}.yaml`);
  const raw = await readYaml(path);
  const problems: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.units)) throw invalid(path, ['expected "fixture" and a "units" list']);
  const units = raw.units.map((u: unknown, i: number): UnitExpectation => {
    const at = `units[${i}]`;
    if (!isRecord(u) || typeof u.unit !== "string" || !u.unit.includes("#")) {
      problems.push(`${at}.unit must be "file#Symbol"`);
      return { unit: "", mustMention: [], mustWarn: [], mustNotWarn: [] };
    }
    const strings = (key: string) => {
      const v = u[key];
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
      problems.push(`${at}.${key} must be a list of strings`);
      return [];
    };
    for (const key of Object.keys(u)) if (!["unit", "lite", "mustMention", "mustWarn", "mustNotWarn"].includes(key)) problems.push(`${at}: unknown field "${key}"`);
    const e: UnitExpectation = { unit: u.unit, mustMention: strings("mustMention"), mustWarn: strings("mustWarn"), mustNotWarn: strings("mustNotWarn") };
    if (u.lite !== undefined) {
      if (typeof u.lite === "boolean") e.lite = u.lite;
      else problems.push(`${at}.lite must be true or false`);
    }
    return e;
  });
  if (problems.length > 0) throw invalid(path, problems);
  return { fixture: typeof raw.fixture === "string" ? raw.fixture : fixture, units };
}

export async function loadChurnEdits(evalDir: string, fixture: string): Promise<ChurnEdit[]> {
  const path = join(evalDir, "churn", `${fixture}.yaml`);
  if (!existsSync(path)) return [];
  const raw = await readYaml(path);
  if (!isRecord(raw) || !Array.isArray(raw.edits)) throw invalid(path, ['expected an "edits" list']);
  const problems: string[] = [];
  const edits = raw.edits.map((e: unknown, i: number): ChurnEdit => {
    const ok =
      isRecord(e) && typeof e.name === "string" && typeof e.file === "string" && Array.isArray(e.replace) &&
      e.replace.every((r: unknown) => isRecord(r) && typeof r.from === "string" && r.from !== "" && typeof r.to === "string" && (r.all === undefined || typeof r.all === "boolean"));
    if (!ok) problems.push(`edits[${i}] must have "name", "file", and "replace" (a list of { from, to, all? })`);
    return e as ChurnEdit;
  });
  if (problems.length > 0) throw invalid(path, problems);
  return edits;
}

/** The configurations in eval/matrix.yaml: `configs` for descriptions, `edits` for the edit evaluation. */
export async function loadMatrix(evalDir: string, section: "configs" | "edits" = "configs"): Promise<MatrixConfig[]> {
  const path = join(evalDir, "matrix.yaml");
  const raw = await readYaml(path);
  const list = isRecord(raw) ? raw[section] : undefined;
  if (!Array.isArray(list) || list.length === 0) throw invalid(path, [`expected a non-empty "${section}" list`]);
  const problems: string[] = [];
  const configs = list.map((c: unknown, i: number): MatrixConfig => {
    if (!isRecord(c) || typeof c.name !== "string") {
      problems.push(`${section}[${i}].name must be a string`);
      return DEFAULT_CONFIG;
    }
    const tasks: Partial<Record<Task, Tier>> = {};
    for (const [task, tier] of Object.entries(isRecord(c.tasks) ? c.tasks : {})) {
      if (!(TASKS as readonly string[]).includes(task)) problems.push(`${section}[${i}].tasks: unknown task "${task}"`);
      else if (!(TIERS as readonly unknown[]).includes(tier)) problems.push(`${section}[${i}].tasks.${task}: unknown tier "${String(tier)}"`);
      else tasks[task as Task] = tier as Tier;
    }
    return { name: c.name, tasks };
  });
  if (problems.length > 0) throw invalid(path, problems);
  return configs;
}

/** Apply the edits to a project copy; every `from` must be found. */
export async function applyEdits(root: string, edits: ChurnEdit[]): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  for (const edit of edits) {
    const path = join(root, edit.file);
    let text = await readFile(path, "utf8");
    for (const r of edit.replace) {
      if (!text.includes(r.from)) throw new SiftError("CONFIG_INVALID", `Churn edit "${edit.name}": "${r.from.trim()}" was not found in ${edit.file}.`);
      text = r.all ? text.split(r.from).join(r.to) : text.replace(r.from, () => r.to);
    }
    await writeFile(path, text);
  }
}

async function readYaml(path: string): Promise<unknown> {
  if (!existsSync(path)) throw new SiftError("SOURCE_NOT_FOUND", `${path} does not exist.`);
  return parse(await readFile(path, "utf8")) as unknown;
}

function invalid(path: string, problems: string[]): SiftError {
  return new SiftError("CONFIG_INVALID", `${path} is not valid:`, problems);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
