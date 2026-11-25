import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { SIFT_DIR, type SiftConfig, type TierModel } from "./config.js";
import { SiftError } from "./errors.js";
import { EFFORTS, TASKS, TIERS, type Effort, type ModelChoice, type Task, type Tier } from "./provider.js";

/**
 * Model routing (design §4.2): task → tier (fixed in core, overridable), then tier → model for the
 * active provider (shipped mapping file, overridable in sift.config.yaml and .sift/models.local.yaml).
 */

export const TASK_TIERS: Record<Task, { recommended: Tier; minimum: Tier }> = {
  describe: { recommended: "mid", minimum: "mid" },
  "describe-lite": { recommended: "small", minimum: "small" },
  update: { recommended: "mid", minimum: "mid" },
  "context-check": { recommended: "small", minimum: "small" },
  judge: { recommended: "frontier", minimum: "frontier" },
  // Editing (phase-2-design §8.11): code generation never runs below frontier.
  "edit-plan": { recommended: "frontier", minimum: "mid" },
  "edit-code": { recommended: "frontier", minimum: "frontier" },
  "edit-verify": { recommended: "mid", minimum: "mid" },
  // The edit evaluation's judge (phase-2-design §9), like `judge`.
  "edit-judge": { recommended: "frontier", minimum: "frontier" },
};

/** Higher is stronger. */
export function tierRank(tier: Tier): number {
  return TIERS.length - TIERS.indexOf(tier);
}

export interface ModelMapTier {
  model: string;
  effort?: Effort;
  effortByTask?: Partial<Record<Task, Effort>>;
}

export interface ModelMap {
  provider: string;
  tiers: Partial<Record<Tier, ModelMapTier>>;
  fallback: Partial<Record<Tier, Tier[]>>;
}

export const MODELS_LOCAL_FILE = `${SIFT_DIR}/models.local.yaml`;

const MODELS_DIR = fileURLToPath(new URL("../models", import.meta.url));

/** The shipped tier → model mapping for a provider. */
export async function loadModelMap(provider: string): Promise<ModelMap> {
  const path = join(MODELS_DIR, `${provider}.yaml`);
  if (!existsSync(path)) {
    throw new SiftError("CONFIG_INVALID", `There is no model mapping for provider "${provider}". Known providers: claude-code.`);
  }
  const raw = parseDocument(await readFile(path, "utf8")).toJS() as Partial<ModelMap>;
  return { provider, tiers: raw.tiers ?? {}, fallback: raw.fallback ?? {} };
}

/** Routing overrides: committed ones from sift.config.yaml, personal ones from .sift/models.local.yaml. */
export interface RoutingOverrides {
  tasks: Partial<Record<Task, Tier>>;
  tiers: Partial<Record<Tier, TierModel>>;
}

/** Read `.sift/models.local.yaml` (same shape as `models:` in sift.config.yaml). Missing file → no overrides. */
export async function loadLocalOverrides(root: string): Promise<RoutingOverrides | null> {
  const path = join(root, MODELS_LOCAL_FILE);
  if (!existsSync(path)) return null;
  const doc = parseDocument(await readFile(path, "utf8"));
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const result: RoutingOverrides = { tasks: {}, tiers: {} };
  for (const key of Object.keys(raw)) if (key !== "tasks" && key !== "tiers") problems.push(`${key}: unknown setting (expected tasks, tiers)`);
  for (const [task, tier] of Object.entries((raw.tasks ?? {}) as Record<string, unknown>)) {
    if (!(TASKS as readonly string[]).includes(task) || !(TIERS as readonly string[]).includes(tier as string)) problems.push(`tasks.${task}: must map a task to one of ${TIERS.join(", ")}`);
    else result.tasks[task as Task] = tier as Tier;
  }
  for (const [tier, spec] of Object.entries((raw.tiers ?? {}) as Record<string, unknown>)) {
    const s = spec as { model?: unknown; effort?: unknown } | null;
    if (!(TIERS as readonly string[]).includes(tier) || typeof s?.model !== "string") problems.push(`tiers.${tier}: must be a tier with a "model"`);
    else if (s.effort !== undefined && !(EFFORTS as readonly string[]).includes(s.effort as string)) problems.push(`tiers.${tier}.effort: must be one of ${EFFORTS.join(", ")}`);
    else result.tiers[tier as Tier] = { model: s.model, ...(s.effort ? { effort: s.effort as Effort } : {}) };
  }
  if (problems.length > 0) throw new SiftError("CONFIG_INVALID", `${MODELS_LOCAL_FILE} has ${problems.length} problem(s).`, problems);
  return result;
}

export interface Route {
  task: Task;
  choice: ModelChoice;
  /** The tier the task ran on; below `TASK_TIERS[task].recommended` is recorded in provenance. */
  tier: Tier;
  belowTier: boolean;
  belowMinimum: boolean;
  /** Where each decision came from, for `sift models`. */
  source: { tier: "default" | "config" | "local"; model: "default" | "config" | "local" };
}

export class Router {
  constructor(
    readonly map: ModelMap,
    private readonly config: Pick<SiftConfig, "models">,
    private readonly local: RoutingOverrides | null = null,
  ) {}

  /** The route for a task, optionally forced onto another tier (fallback). */
  route(task: Task, forcedTier?: Tier): Route {
    const localTier = this.local?.tasks[task];
    const configTier = this.config.models.tasks[task];
    const tier = forcedTier ?? localTier ?? configTier ?? TASK_TIERS[task].recommended;
    const tierSource = forcedTier || !(localTier ?? configTier) ? "default" : localTier ? "local" : "config";

    const localModel = this.local?.tiers[tier];
    const configModel = this.config.models.tiers[tier];
    const shipped = this.map.tiers[tier];
    const override = localModel ?? configModel;
    const model = override?.model ?? shipped?.model;
    if (!model) throw new SiftError("CONFIG_INVALID", `No model is configured for the "${tier}" tier of provider "${this.map.provider}".`);
    const effort = override ? override.effort : (shipped?.effortByTask?.[task] ?? shipped?.effort);

    const { recommended, minimum } = TASK_TIERS[task];
    return {
      task,
      tier,
      choice: { provider: this.map.provider, model, tier, ...(effort ? { effort } : {}) },
      belowTier: tierRank(tier) < tierRank(recommended),
      belowMinimum: tierRank(tier) < tierRank(minimum),
      source: { tier: tierSource, model: localModel ? "local" : configModel ? "config" : "default" },
    };
  }

  /** Tiers to try, in order, when the routed model is unavailable. */
  fallbacks(tier: Tier): Tier[] {
    return this.map.fallback[tier] ?? [];
  }
}
