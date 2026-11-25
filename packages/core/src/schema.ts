import type { UnitKind } from "./adapter.js";

/**
 * Newest `.sift` schema version this build reads and writes (design §6; v1: phase-2-design §7).
 * A file keeps its version until something writes a field only a newer schema has (`requiredSchemaVersion`).
 */
export const SIFT_SCHEMA_VERSION = 1;

export const UNIT_KINDS = ["function", "method", "constructor", "component", "module"] as const satisfies readonly UnitKind[];
export const UNIT_STATUSES = ["generated", "user-edited", "verified", "stale"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/** Step-level status (schema v1). Omitted means the step is as its unit. */
export const STEP_STATUSES = ["user-edited", "verified"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Step kinds for control flow; plain steps have no kind. */
export const STEP_KINDS = ["if", "else", "switch", "case", "loop", "try", "catch", "finally"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Effect vocabulary v0 (design §9). */
export const EFFECTS = [
  "db.read",
  "db.write",
  "db.transaction",
  "net.request",
  "fs.read",
  "fs.write",
  "process.exec",
  "event.emit",
  "log",
  "throws",
] as const;
export type Effect = (typeof EFFECTS)[number];

export interface SiftFile {
  /** Schema version. */
  sift: number;
  /** Source path relative to the project root, forward slashes. */
  source: string;
  language: string;
  fileHash: string;
  /** Ordered by source position. */
  units: SiftUnit[];
}

export interface GeneratedBy {
  provider: string;
  model: string;
  /** Prompt name and version, e.g. "describe@3". */
  prompt: string;
  /** True when the model was below the task's recommended tier. */
  belowTier: boolean;
}

export interface SiftUnit {
  /** "u_" + 8 base32 characters; never reused. */
  id: string;
  symbol: string;
  kind: UnitKind;
  /** Lite units have a summary but no steps. */
  lite?: boolean;
  status: UnitStatus;
  /**
   * Schema v1: the non-step fields a person wrote: "summary", "returns", or "inputs.<name>".
   * Steps a person wrote carry their own `status: user-edited`.
   */
  userEdited?: string[];
  bodyHash: string;
  contextHash?: string;
  generatedBy?: GeneratedBy;
  summary: string;
  inputs: SiftInput[];
  returns?: SiftReturns;
  effects: Effect[];
  steps: SiftStep[];
  warnings: SiftWarning[];
  /** Reserved for Phase 3. */
  tests: string[];
}

export interface SiftInput {
  name: string;
  type: string;
  typeInferred?: boolean;
  meaning: string;
}

export interface SiftReturns {
  type: string;
  typeInferred?: boolean;
  meaning: string;
}

export interface SiftStep {
  /** "s_" + 4 base32 characters, unique within the unit. */
  id: string;
  kind?: StepKind;
  /** Schema v1: "user-edited" when a person wrote this step's text; "verified" when a person confirmed it. */
  status?: StepStatus;
  text: string;
  /** Structural keys of the code this step describes (design §3.1). */
  covers: string[];
  /** Unit IDs, or "ext:<module>#<name>" for library calls. Derived by core, never by AI. */
  calls: string[];
  /** Derived from the covered code by rule packs. */
  effects: Effect[];
  steps: SiftStep[];
}

export interface SiftWarning {
  /** "w_" + 4 base32 characters, unique within the unit. */
  id: string;
  /** kebab-case, e.g. "missing-transaction". */
  kind: string;
  text: string;
  /** Step IDs the warning is about. */
  steps: string[];
  /** Schema v1: the warning was answered by an edit (phase-2-design §7). */
  resolved?: { by: "edit"; note: string };
}

/** The lowest schema version that can hold this file's content. */
export function requiredSchemaVersion(file: SiftFile): number {
  const stepNeeds = (steps: SiftStep[]): boolean => steps.some((s) => s.status !== undefined || stepNeeds(s.steps));
  const v1 = file.units.some((u) => (u.userEdited?.length ?? 0) > 0 || stepNeeds(u.steps) || u.warnings.some((w) => w.resolved !== undefined));
  return v1 ? 1 : 0;
}
