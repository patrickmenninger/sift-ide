import { SiftError } from "./errors.js";
import { ID_PATTERNS } from "./ids.js";
import {
  EFFECTS,
  SIFT_SCHEMA_VERSION,
  STEP_KINDS,
  STEP_STATUSES,
  UNIT_KINDS,
  UNIT_STATUSES,
  type Effect,
  type GeneratedBy,
  type SiftFile,
  type SiftInput,
  type SiftReturns,
  type SiftStep,
  type SiftUnit,
  type SiftWarning,
  requiredSchemaVersion,
} from "./schema.js";

const HASH = /^[0-9a-f]{16}$/;
const WARNING_KIND = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CALL_REF = /^(u_[a-z2-7]{8}|ext:[^#\s]+#\S+)$/;
const USER_EDITED_FIELD = /^(summary|returns|inputs\..+)$/;

type Obj = Record<string, unknown>;

/** Collects every problem with its path, so one run reports everything wrong with a file. */
class Checker {
  readonly problems: string[] = [];

  fail(at: string, message: string): void {
    this.problems.push(`${at}: ${message}`);
  }

  object(value: unknown, at: string, allowed: readonly string[]): Obj | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(at, "must be a mapping");
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.fail(`${at}.${key}`, "unknown field");
    }
    return value as Obj;
  }

  string(obj: Obj, key: string, at: string, opts: { optional?: boolean; pattern?: RegExp; nonEmpty?: boolean } = {}): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (!opts.optional) this.fail(`${at}.${key}`, "is required");
      return undefined;
    }
    if (typeof v !== "string") {
      this.fail(`${at}.${key}`, "must be a string");
      return undefined;
    }
    if (opts.nonEmpty && v.trim() === "") this.fail(`${at}.${key}`, "must not be empty");
    if (opts.pattern && !opts.pattern.test(v)) this.fail(`${at}.${key}`, `has an invalid format: ${JSON.stringify(v)}`);
    return v;
  }

  oneOf<T extends string>(obj: Obj, key: string, at: string, options: readonly T[], optional = false): T | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (!optional) this.fail(`${at}.${key}`, "is required");
      return undefined;
    }
    if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
      this.fail(`${at}.${key}`, `must be one of ${options.join(", ")}`);
      return undefined;
    }
    return v as T;
  }

  boolean(obj: Obj, key: string, at: string): boolean | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") {
      this.fail(`${at}.${key}`, "must be true or false");
      return undefined;
    }
    return v;
  }

  list(obj: Obj, key: string, at: string): unknown[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.fail(`${at}.${key}`, "must be a list");
      return [];
    }
    return v;
  }

  strings(obj: Obj, key: string, at: string, pattern?: RegExp): string[] {
    return this.list(obj, key, at).filter((v, i): v is string => {
      if (typeof v !== "string") {
        this.fail(`${at}.${key}[${i}]`, "must be a string");
        return false;
      }
      if (pattern && !pattern.test(v)) {
        this.fail(`${at}.${key}[${i}]`, `has an invalid format: ${JSON.stringify(v)}`);
        return false;
      }
      return true;
    });
  }

  effects(obj: Obj, key: string, at: string): Effect[] {
    return this.list(obj, key, at).filter((v, i): v is Effect => {
      if (typeof v !== "string" || !(EFFECTS as readonly string[]).includes(v)) {
        this.fail(`${at}.${key}[${i}]`, `unknown effect ${JSON.stringify(v)} (expected one of ${EFFECTS.join(", ")})`);
        return false;
      }
      return true;
    });
  }
}

/**
 * Validate parsed YAML as a `.sift` file. Throws SIFT_TOO_NEW for files from a newer Sift,
 * and SIFT_INVALID listing every problem otherwise.
 */
export function validateSiftFile(raw: unknown, name: string): SiftFile {
  const c = new Checker();
  const root = c.object(raw, "file", ["sift", "source", "language", "fileHash", "units"]);
  if (!root) throw new SiftError("SIFT_INVALID", `${name} is not a valid .sift file.`, c.problems);

  const version = root.sift;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    c.fail("sift", "must be the schema version number");
  } else if (version > SIFT_SCHEMA_VERSION) {
    throw new SiftError(
      "SIFT_TOO_NEW",
      `${name} uses .sift schema ${version}, but this version of Sift only understands up to ${SIFT_SCHEMA_VERSION}. Update Sift.`,
    );
  }

  const file: SiftFile = {
    sift: typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : SIFT_SCHEMA_VERSION,
    source: c.string(root, "source", "file", { nonEmpty: true }) ?? "",
    language: c.string(root, "language", "file", { nonEmpty: true }) ?? "",
    fileHash: c.string(root, "fileHash", "file", { pattern: HASH }) ?? "",
    units: [],
  };

  const unitIds = new Set<string>();
  const symbols = new Set<string>();
  c.list(root, "units", "file").forEach((u, i) => {
    const unit = validateUnit(c, u, `units[${i}]`);
    if (!unit) return;
    if (unitIds.has(unit.id)) c.fail(`units[${i}].id`, `duplicate unit id ${unit.id}`);
    if (symbols.has(unit.symbol)) c.fail(`units[${i}].symbol`, `duplicate symbol ${unit.symbol}`);
    unitIds.add(unit.id);
    symbols.add(unit.symbol);
    file.units.push(unit);
  });

  const needs = requiredSchemaVersion(file);
  if (needs > file.sift) c.fail("sift", `the file uses schema ${needs} fields (step status, userEdited, or resolved warnings) but declares schema ${file.sift}`);

  if (c.problems.length > 0) {
    throw new SiftError("SIFT_INVALID", `${name} has ${c.problems.length} problem(s).`, c.problems);
  }
  return file;
}

function validateUnit(c: Checker, raw: unknown, at: string): SiftUnit | null {
  const o = c.object(raw, at, [
    "id", "symbol", "kind", "lite", "status", "userEdited", "bodyHash", "contextHash", "generatedBy",
    "summary", "inputs", "returns", "effects", "steps", "warnings", "tests",
  ]);
  if (!o) return null;

  const unit: SiftUnit = {
    id: c.string(o, "id", at, { pattern: ID_PATTERNS.unit }) ?? "",
    symbol: c.string(o, "symbol", at, { nonEmpty: true }) ?? "",
    kind: c.oneOf(o, "kind", at, UNIT_KINDS) ?? "function",
    status: c.oneOf(o, "status", at, UNIT_STATUSES) ?? "stale",
    bodyHash: c.string(o, "bodyHash", at, { pattern: HASH }) ?? "",
    summary: c.string(o, "summary", at) ?? "",
    inputs: c.list(o, "inputs", at).map((v, i) => validateTyped(c, v, `${at}.inputs[${i}]`, true) as SiftInput),
    effects: c.effects(o, "effects", at),
    steps: [],
    warnings: [],
    tests: c.strings(o, "tests", at),
  };
  const lite = c.boolean(o, "lite", at);
  if (lite !== undefined) unit.lite = lite;
  const contextHash = c.string(o, "contextHash", at, { optional: true, pattern: HASH });
  if (contextHash !== undefined) unit.contextHash = contextHash;
  if (o.generatedBy !== undefined) {
    const g = c.object(o.generatedBy, `${at}.generatedBy`, ["provider", "model", "prompt", "belowTier"]);
    if (g) {
      const generatedBy: GeneratedBy = {
        provider: c.string(g, "provider", `${at}.generatedBy`, { nonEmpty: true }) ?? "",
        model: c.string(g, "model", `${at}.generatedBy`, { nonEmpty: true }) ?? "",
        prompt: c.string(g, "prompt", `${at}.generatedBy`, { nonEmpty: true }) ?? "",
        belowTier: c.boolean(g, "belowTier", `${at}.generatedBy`) ?? false,
      };
      unit.generatedBy = generatedBy;
    }
  }
  if (o.returns !== undefined) {
    const returns = validateTyped(c, o.returns, `${at}.returns`, false);
    if (returns) unit.returns = returns as SiftReturns;
  }
  if (o.userEdited !== undefined) {
    const fields = c.strings(o, "userEdited", at, USER_EDITED_FIELD);
    fields.forEach((f, i) => {
      if (f === "returns" && !unit.returns) c.fail(`${at}.userEdited[${i}]`, "names returns, but the unit has no returns");
      if (f.startsWith("inputs.") && !unit.inputs.some((input) => input.name === f.slice("inputs.".length))) {
        c.fail(`${at}.userEdited[${i}]`, `names an input the unit does not have: ${f.slice("inputs.".length)}`);
      }
    });
    if (new Set(fields).size !== fields.length) c.fail(`${at}.userEdited`, "lists a field more than once");
    if (fields.length > 0) unit.userEdited = fields;
  }

  const stepIds = new Set<string>();
  unit.steps = c.list(o, "steps", at).flatMap((s, i) => validateStep(c, s, `${at}.steps[${i}]`, stepIds) ?? []);
  if (unit.lite && unit.steps.length > 0) c.fail(`${at}.steps`, "lite units have no steps");

  const warningIds = new Set<string>();
  unit.warnings = c.list(o, "warnings", at).flatMap((w, i) => {
    const wat = `${at}.warnings[${i}]`;
    const wo = c.object(w, wat, ["id", "kind", "text", "steps", "resolved"]);
    if (!wo) return [];
    const warning: SiftWarning = {
      id: c.string(wo, "id", wat, { pattern: ID_PATTERNS.warning }) ?? "",
      kind: c.string(wo, "kind", wat, { pattern: WARNING_KIND }) ?? "",
      text: c.string(wo, "text", wat, { nonEmpty: true }) ?? "",
      steps: c.strings(wo, "steps", wat, ID_PATTERNS.step),
    };
    if (wo.resolved !== undefined) {
      const ro = c.object(wo.resolved, `${wat}.resolved`, ["by", "note"]);
      if (ro) {
        const by = c.oneOf(ro, "by", `${wat}.resolved`, ["edit"] as const);
        const note = c.string(ro, "note", `${wat}.resolved`, { nonEmpty: true });
        if (by && note !== undefined) warning.resolved = { by, note };
      }
    }
    if (warningIds.has(warning.id)) c.fail(`${wat}.id`, `duplicate warning id ${warning.id}`);
    warningIds.add(warning.id);
    for (const ref of warning.steps) {
      if (!stepIds.has(ref)) c.fail(`${wat}.steps`, `refers to unknown step ${ref}`);
    }
    return [warning];
  });
  return unit;
}

function validateTyped(c: Checker, raw: unknown, at: string, named: boolean): SiftInput | SiftReturns | null {
  const o = c.object(raw, at, named ? ["name", "type", "typeInferred", "meaning"] : ["type", "typeInferred", "meaning"]);
  if (!o) return null;
  const typed: SiftReturns = {
    type: c.string(o, "type", at, { nonEmpty: true }) ?? "",
    meaning: c.string(o, "meaning", at) ?? "",
  };
  const inferred = c.boolean(o, "typeInferred", at);
  if (inferred !== undefined) typed.typeInferred = inferred;
  return named ? { name: c.string(o, "name", at, { nonEmpty: true }) ?? "", ...typed } : typed;
}

function validateStep(c: Checker, raw: unknown, at: string, ids: Set<string>): SiftStep | null {
  const o = c.object(raw, at, ["id", "kind", "status", "text", "covers", "calls", "effects", "steps"]);
  if (!o) return null;
  const step: SiftStep = {
    id: c.string(o, "id", at, { pattern: ID_PATTERNS.step }) ?? "",
    text: c.string(o, "text", at, { nonEmpty: true }) ?? "",
    covers: c.strings(o, "covers", at),
    calls: c.strings(o, "calls", at, CALL_REF),
    effects: c.effects(o, "effects", at),
    steps: [],
  };
  const kind = c.oneOf(o, "kind", at, STEP_KINDS, true);
  if (kind !== undefined) step.kind = kind;
  const status = c.oneOf(o, "status", at, STEP_STATUSES, true);
  if (status !== undefined) step.status = status;
  if (ids.has(step.id)) c.fail(`${at}.id`, `duplicate step id ${step.id}`);
  ids.add(step.id);
  step.steps = c.list(o, "steps", at).flatMap((s, i) => validateStep(c, s, `${at}.steps[${i}]`, ids) ?? []);
  return step;
}
