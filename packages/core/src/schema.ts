import type { UnitKind } from "./adapter.js";

/** Current `.sift` schema version (design §6). */
export const SIFT_SCHEMA_VERSION = 0;

export const UNIT_KINDS = ["function", "method", "constructor", "component", "module"] as const satisfies readonly UnitKind[];
export const UNIT_STATUSES = ["generated", "user-edited", "verified", "stale"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

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
}
