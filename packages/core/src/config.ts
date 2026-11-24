import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { SiftError } from "./errors.js";
import { EFFORTS, TASKS, TIERS, type Effort, type Task, type Tier } from "./provider.js";

export const CONFIG_FILE = "sift.config.yaml";
export const SIFT_DIR = ".sift";

export interface TierModel {
  model: string;
  effort?: Effort;
}

export interface SiftConfig {
  /** Globs of source files to describe, relative to the project root. */
  include: string[];
  /** Globs to skip. node_modules and .sift are always skipped. */
  exclude: string[];
  provider: string;
  /** Maximum concurrent AI calls. */
  concurrency: number;
  lite: { maxStatements: number };
  /** Most units described together in one AI call (units of the same file and task). 1 means one call per unit. */
  batch: { maxUnits: number };
  /** Committed routing overrides (design §4.2). */
  models: {
    tasks: Partial<Record<Task, Tier>>;
    tiers: Partial<Record<Tier, TierModel>>;
  };
  /** Natural-language editing (phase-2-design §8.6). */
  edit: {
    /** Commands run against a copy of the project with a proposed change applied, only when the user asks. */
    checks: EditCheckCommand[];
    /** Each check is stopped after this long. */
    checkTimeoutSeconds: number;
  };
}

export interface EditCheckCommand {
  /** Shown in the review; the command itself when not given. */
  name: string;
  command: string;
}

export function defaultConfig(): SiftConfig {
  return {
    include: ["src/**"],
    exclude: [],
    provider: "claude-code",
    concurrency: 4,
    lite: { maxStatements: 3 },
    batch: { maxUnits: 8 },
    models: { tasks: {}, tiers: {} },
    edit: { checks: [], checkTimeoutSeconds: 300 },
  };
}

/** Parse and validate config text. Reports every problem at once rather than the first. */
export function parseConfig(text: string, sourceName = CONFIG_FILE): SiftConfig {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new SiftError(
      "CONFIG_INVALID",
      `${sourceName} is not valid YAML.`,
      doc.errors.map((e) => e.message),
    );
  }
  const raw: unknown = doc.toJS() ?? {};
  const problems: string[] = [];
  const config = defaultConfig();

  if (!isRecord(raw)) {
    throw new SiftError("CONFIG_INVALID", `${sourceName} must be a mapping of settings.`);
  }

  checkKeys(raw, ["include", "exclude", "provider", "concurrency", "lite", "batch", "models", "edit"], "", problems);

  if ("include" in raw) config.include = stringList(raw.include, "include", problems, { nonEmpty: true });
  if ("exclude" in raw) config.exclude = stringList(raw.exclude, "exclude", problems);
  if ("provider" in raw) {
    if (typeof raw.provider === "string" && raw.provider.trim() !== "") config.provider = raw.provider;
    else problems.push("provider: must be a non-empty string");
  }
  if ("concurrency" in raw) config.concurrency = positiveInt(raw.concurrency, "concurrency", problems);
  if ("lite" in raw) {
    if (isRecord(raw.lite)) {
      checkKeys(raw.lite, ["maxStatements"], "lite.", problems);
      if ("maxStatements" in raw.lite) {
        config.lite.maxStatements = positiveInt(raw.lite.maxStatements, "lite.maxStatements", problems);
      }
    } else problems.push("lite: must be a mapping");
  }
  if ("batch" in raw) {
    if (isRecord(raw.batch)) {
      checkKeys(raw.batch, ["maxUnits"], "batch.", problems);
      if ("maxUnits" in raw.batch) config.batch.maxUnits = positiveInt(raw.batch.maxUnits, "batch.maxUnits", problems);
    } else problems.push("batch: must be a mapping");
  }
  if ("models" in raw) parseModels(raw.models, config, problems);
  if ("edit" in raw) parseEdit(raw.edit, config, problems);

  if (problems.length > 0) {
    throw new SiftError("CONFIG_INVALID", `${sourceName} has ${problems.length} problem(s).`, problems);
  }
  return config;
}

function parseModels(value: unknown, config: SiftConfig, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("models: must be a mapping");
    return;
  }
  checkKeys(value, ["tasks", "tiers"], "models.", problems);

  if ("tasks" in value) {
    if (isRecord(value.tasks)) {
      for (const [task, tier] of Object.entries(value.tasks)) {
        if (!isOneOf(task, TASKS)) problems.push(`models.tasks.${task}: unknown task (expected one of ${TASKS.join(", ")})`);
        else if (!isOneOf(tier, TIERS)) problems.push(`models.tasks.${task}: must be one of ${TIERS.join(", ")}`);
        else config.models.tasks[task] = tier;
      }
    } else problems.push("models.tasks: must be a mapping of task to tier");
  }

  if ("tiers" in value) {
    if (isRecord(value.tiers)) {
      for (const [tier, spec] of Object.entries(value.tiers)) {
        const at = `models.tiers.${tier}`;
        if (!isOneOf(tier, TIERS)) {
          problems.push(`${at}: unknown tier (expected one of ${TIERS.join(", ")})`);
          continue;
        }
        if (!isRecord(spec)) {
          problems.push(`${at}: must be a mapping with "model" and optional "effort"`);
          continue;
        }
        checkKeys(spec, ["model", "effort"], `${at}.`, problems);
        if (typeof spec.model !== "string" || spec.model.trim() === "") {
          problems.push(`${at}.model: must be a non-empty string`);
          continue;
        }
        const entry: TierModel = { model: spec.model };
        if ("effort" in spec) {
          if (isOneOf(spec.effort, EFFORTS)) entry.effort = spec.effort;
          else problems.push(`${at}.effort: must be one of ${EFFORTS.join(", ")}`);
        }
        config.models.tiers[tier] = entry;
      }
    } else problems.push("models.tiers: must be a mapping of tier to model");
  }
}

function parseEdit(value: unknown, config: SiftConfig, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("edit: must be a mapping");
    return;
  }
  checkKeys(value, ["checks", "checkTimeoutSeconds"], "edit.", problems);
  if ("checks" in value) {
    if (!Array.isArray(value.checks)) problems.push("edit.checks: must be a list of commands");
    else {
      value.checks.forEach((c: unknown, i) => {
        const at = `edit.checks[${i}]`;
        if (typeof c === "string" && c.trim() !== "") config.edit.checks.push({ name: c, command: c });
        else if (isRecord(c) && typeof c.command === "string" && c.command.trim() !== "") {
          checkKeys(c, ["name", "command"], `${at}.`, problems);
          if (c.name !== undefined && (typeof c.name !== "string" || c.name.trim() === "")) problems.push(`${at}.name: must be a non-empty string`);
          config.edit.checks.push({ name: typeof c.name === "string" && c.name.trim() !== "" ? c.name : c.command, command: c.command });
        } else problems.push(`${at}: must be a command, or a mapping with "command" and optional "name"`);
      });
    }
  }
  if ("checkTimeoutSeconds" in value) config.edit.checkTimeoutSeconds = positiveInt(value.checkTimeoutSeconds, "edit.checkTimeoutSeconds", problems);
}

/** Walk up from `start` to the nearest directory containing sift.config.yaml. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadedProject {
  root: string;
  configPath: string;
  config: SiftConfig;
}

export async function loadProject(cwd: string): Promise<LoadedProject> {
  const root = findProjectRoot(cwd);
  if (root === null) {
    throw new SiftError(
      "CONFIG_NOT_FOUND",
      `No ${CONFIG_FILE} found in ${resolve(cwd)} or any parent directory. Run "sift init" in the project root.`,
    );
  }
  const configPath = join(root, CONFIG_FILE);
  const config = parseConfig(await readFile(configPath, "utf8"), configPath);
  return { root, configPath, config };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], prefix: string, problems: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.push(`${prefix}${key}: unknown setting (expected one of ${allowed.join(", ")})`);
  }
}

function stringList(value: unknown, at: string, problems: string[], opts: { nonEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    problems.push(`${at}: must be a list of non-empty strings`);
    return [];
  }
  if (opts.nonEmpty && value.length === 0) problems.push(`${at}: must contain at least one pattern`);
  return value as string[];
}

function positiveInt(value: unknown, at: string, problems: string[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  problems.push(`${at}: must be a positive whole number`);
  return 1;
}
