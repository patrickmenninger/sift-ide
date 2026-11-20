import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { CallSite } from "./adapter.js";
import { SIFT_DIR } from "./config.js";
import { SiftError } from "./errors.js";
import { globToRegExp } from "./glob.js";
import { EFFECTS, type Effect } from "./schema.js";

/**
 * Framework rule packs (design §9): YAML files that map call sites to effects and to graph edges.
 */

/** What a rule matches: a library call (`module` + `member`) or a call into the project (`symbol`). */
export interface RuleMatch {
  /** Glob over `CallSite.external.module`, e.g. "@prisma/client" or "{fs,fs/promises}". */
  module?: string;
  /** Glob over the declaration's qualified name, segments separated by "."; omitted = any. */
  member?: string;
  /** Glob over the qualified name of a project symbol (`CallSite.target.symbol`). */
  symbol?: string;
}

export interface EffectRule {
  match: RuleMatch;
  effect: Effect;
}

export const EDGE_RULE_KINDS = ["handles-route", "emits", "listens"] as const;
export type EdgeRuleKind = (typeof EDGE_RULE_KINDS)[number];

/** An argument position; -1 is the last argument. */
export interface ArgRef {
  arg: number;
}

export interface EdgeRule {
  match: RuleMatch;
  edge: EdgeRuleKind;
  /** The argument holding the handler (handles-route, listens). */
  from?: ArgRef;
  /** The argument holding the event name (emits, listens). */
  key?: ArgRef;
  /** handles-route: `method` is "member" (last segment of the matched name) or a fixed method such as "GET". */
  route?: { method: string; path: ArgRef };
}

export interface RulePack {
  pack: string;
  version: number;
  /** Where the pack was loaded from, for messages. */
  source: string;
  appliesWhen?: { dependency: string };
  rules: EffectRule[];
  edges: EdgeRule[];
}

/** Parse and validate one pack. Reports every problem at once. */
export function parseRulePack(text: string, source: string): RulePack {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new SiftError("RULES_INVALID", `${source} is not valid YAML.`, doc.errors.map((e) => e.message));
  }
  const raw: unknown = doc.toJS();
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SiftError("RULES_INVALID", `${source} must be a mapping with "pack" and "rules" or "edges".`);

  checkKeys(raw, ["pack", "version", "appliesWhen", "rules", "edges"], "", problems);
  const pack: RulePack = { pack: "", version: 1, source, rules: [], edges: [] };

  if (typeof raw.pack === "string" && /^[a-z0-9][a-z0-9-]*$/.test(raw.pack)) pack.pack = raw.pack;
  else problems.push('pack: must be a name made of lowercase letters, digits, and "-"');
  if ("version" in raw) {
    if (Number.isInteger(raw.version) && (raw.version as number) > 0) pack.version = raw.version as number;
    else problems.push("version: must be a positive whole number");
  }
  if ("appliesWhen" in raw) {
    const when = raw.appliesWhen;
    if (isRecord(when) && typeof when.dependency === "string" && when.dependency !== "") {
      checkKeys(when, ["dependency"], "appliesWhen.", problems);
      pack.appliesWhen = { dependency: when.dependency };
    } else problems.push("appliesWhen: must be a mapping with a non-empty \"dependency\"");
  }

  list(raw.rules, "rules", problems).forEach((entry, i) => {
    const at = `rules[${i}]`;
    if (!isRecord(entry)) return void problems.push(`${at}: must be a mapping with "match" and "effect"`);
    checkKeys(entry, ["match", "effect"], `${at}.`, problems);
    const match = parseMatch(entry.match, `${at}.match`, problems);
    if (!isOneOf(entry.effect, EFFECTS)) problems.push(`${at}.effect: must be one of ${EFFECTS.join(", ")}`);
    else if (entry.effect === "throws") problems.push(`${at}.effect: "throws" comes from throw statements, not rules`);
    else if (match) pack.rules.push({ match, effect: entry.effect });
  });

  list(raw.edges, "edges", problems).forEach((entry, i) => {
    const at = `edges[${i}]`;
    if (!isRecord(entry)) return void problems.push(`${at}: must be a mapping with "match" and "edge"`);
    checkKeys(entry, ["match", "edge", "from", "key", "route"], `${at}.`, problems);
    const match = parseMatch(entry.match, `${at}.match`, problems);
    if (!isOneOf(entry.edge, EDGE_RULE_KINDS)) {
      problems.push(`${at}.edge: must be one of ${EDGE_RULE_KINDS.join(", ")}`);
      return;
    }
    const rule: EdgeRule = { match: match ?? {}, edge: entry.edge };
    if ("from" in entry) rule.from = parseArgRef(entry.from, `${at}.from`, problems);
    if ("key" in entry) rule.key = parseArgRef(entry.key, `${at}.key`, problems);
    if ("route" in entry) {
      const route = entry.route;
      if (isRecord(route) && typeof route.method === "string" && route.method !== "") {
        checkKeys(route, ["method", "path"], `${at}.route.`, problems);
        const path = parseArgRef(route.path, `${at}.route.path`, problems);
        if (path) rule.route = { method: route.method, path };
      } else problems.push(`${at}.route: must be a mapping with "method" ("member" or e.g. "GET") and "path"`);
    }
    const needs: Record<EdgeRuleKind, (keyof EdgeRule)[]> = {
      "handles-route": ["from", "route"],
      emits: ["key"],
      listens: ["key", "from"],
    };
    for (const field of needs[rule.edge]) {
      if (!(field in entry)) problems.push(`${at}: a "${rule.edge}" edge needs "${field}"`);
    }
    if (match) pack.edges.push(rule);
  });

  if (problems.length > 0) throw new SiftError("RULES_INVALID", `${source} has ${problems.length} problem(s).`, problems);
  return pack;
}

function parseMatch(value: unknown, at: string, problems: string[]): RuleMatch | null {
  if (!isRecord(value)) {
    problems.push(`${at}: must be a mapping with "module" and "member", or "symbol"`);
    return null;
  }
  checkKeys(value, ["module", "member", "symbol"], `${at}.`, problems);
  const match: RuleMatch = {};
  for (const key of ["module", "member", "symbol"] as const) {
    if (!(key in value)) continue;
    const v = value[key];
    if (typeof v !== "string" || v === "") {
      problems.push(`${at}.${key}: must be a non-empty string`);
      continue;
    }
    try {
      globToRegExp(v);
    } catch (err) {
      problems.push(`${at}.${key}: ${(err as Error).message}`);
      continue;
    }
    match[key] = v;
  }
  const external = match.module !== undefined || match.member !== undefined;
  if (external && match.symbol !== undefined) problems.push(`${at}: use either "module"/"member" or "symbol", not both`);
  else if (match.member !== undefined && match.module === undefined) problems.push(`${at}: "member" needs "module"`);
  else if (!external && match.symbol === undefined) problems.push(`${at}: needs "module" or "symbol"`);
  else return match;
  return null;
}

function parseArgRef(value: unknown, at: string, problems: string[]): ArgRef | undefined {
  if (isRecord(value) && Number.isInteger(value.arg) && (value.arg as number) >= -1) {
    checkKeys(value, ["arg"], `${at}.`, problems);
    return { arg: value.arg as number };
  }
  problems.push(`${at}: must be { arg: n } with n ≥ 0, or -1 for the last argument`);
  return undefined;
}

export interface LoadedRules {
  packs: RulePack[];
  /** Packs not applied because the project doesn't use their dependency. */
  skipped: { pack: string; source: string; reason: string }[];
}

export const PROJECT_RULES_DIR = `${SIFT_DIR}/rules`;

/**
 * Load built-in packs (from `builtinDir`), then the project's own packs in `.sift/rules/`.
 * Packs with `appliesWhen.dependency` are applied only if package.json lists that dependency.
 */
export async function loadRulePacks(root: string, options: { builtinDir?: string } = {}): Promise<LoadedRules> {
  const sources: { path: string; label: string }[] = [];
  if (options.builtinDir) {
    for (const name of await yamlFiles(options.builtinDir)) sources.push({ path: join(options.builtinDir, name), label: `built-in pack ${name}` });
  }
  const projectDir = join(root, PROJECT_RULES_DIR);
  for (const name of await yamlFiles(projectDir)) sources.push({ path: join(projectDir, name), label: `${PROJECT_RULES_DIR}/${name}` });

  const deps = await projectDependencies(root);
  const result: LoadedRules = { packs: [], skipped: [] };
  const seen = new Map<string, string>();
  for (const { path, label } of sources) {
    const pack = parseRulePack(await readFile(path, "utf8"), label);
    const earlier = seen.get(pack.pack);
    if (earlier) throw new SiftError("RULES_INVALID", `Two rule packs are named "${pack.pack}": ${earlier} and ${label}.`);
    seen.set(pack.pack, label);
    if (pack.appliesWhen && !deps.has(pack.appliesWhen.dependency)) {
      result.skipped.push({ pack: pack.pack, source: label, reason: `package.json does not list "${pack.appliesWhen.dependency}"` });
    } else result.packs.push(pack);
  }
  return result;
}

async function yamlFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function projectDependencies(root: string): Promise<Set<string>> {
  const path = join(root, "package.json");
  if (!existsSync(path)) return new Set();
  try {
    const pkg = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
      isRecord(pkg[field]) ? Object.keys(pkg[field]) : [],
    );
    return new Set(names);
  } catch {
    return new Set();
  }
}

interface CompiledMatch {
  module?: RegExp;
  member?: RegExp;
  symbol?: RegExp;
}

/** Edge rule matched at a call site, with the name it matched (for `route.method: member`). */
export interface EdgeRuleHit {
  pack: string;
  rule: EdgeRule;
  matchedName: string;
}

/** Compiled rule packs, applied to call sites. */
export class RuleSet {
  /** Changes whenever any applied pack changes, so cached graph data built with other rules is discarded. */
  readonly hash: string;
  private readonly effectRules: { match: CompiledMatch; effect: Effect }[];
  private readonly edgeRules: { match: CompiledMatch; pack: string; rule: EdgeRule }[];

  constructor(readonly packs: RulePack[]) {
    const canonical = packs.map(({ source: _source, ...rest }) => rest);
    this.hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
    this.effectRules = packs.flatMap((p) => p.rules.map((r) => ({ match: compile(r.match), effect: r.effect })));
    this.edgeRules = packs.flatMap((p) => p.edges.map((rule) => ({ match: compile(rule.match), pack: p.pack, rule })));
  }

  static empty(): RuleSet {
    return new RuleSet([]);
  }

  /** Effects of one call site, in vocabulary order. */
  effectsFor(call: CallSite): Effect[] {
    const found = new Set<Effect>();
    for (const r of this.effectRules) if (matchName(r.match, call) !== null) found.add(r.effect);
    return EFFECTS.filter((e) => found.has(e));
  }

  edgesFor(call: CallSite): EdgeRuleHit[] {
    const hits: EdgeRuleHit[] = [];
    for (const r of this.edgeRules) {
      const matchedName = matchName(r.match, call);
      if (matchedName !== null) hits.push({ pack: r.pack, rule: r.rule, matchedName });
    }
    return hits;
  }
}

function compile(match: RuleMatch): CompiledMatch {
  const out: CompiledMatch = {};
  if (match.module !== undefined) out.module = globToRegExp(match.module, "/");
  if (match.member !== undefined) out.member = globToRegExp(match.member, ".");
  if (match.symbol !== undefined) out.symbol = globToRegExp(match.symbol, ".");
  return out;
}

/** The name a call matched by (external member or project symbol), or null. */
function matchName(match: CompiledMatch, call: CallSite): string | null {
  if (match.symbol) {
    return call.target && !call.external && match.symbol.test(call.target.symbol) ? call.target.symbol : null;
  }
  if (!call.external || !match.module?.test(call.external.module)) return null;
  return !match.member || match.member.test(call.external.name) ? call.external.name : null;
}

function list(value: unknown, at: string, problems: string[]): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  problems.push(`${at}: must be a list`);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], prefix: string, problems: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.push(`${prefix}${key}: unknown field (expected one of ${allowed.join(", ")})`);
  }
}
