import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import {
  gitDiff,
  initProject,
  listSiftFiles,
  loadProject,
  loadRulePacks,
  readSiftFile,
  refreshGraph,
  RuleSet,
  SiftError,
  siftPathFor,
  generate,
  isInSync,
  syncStatus,
  loadLocalOverrides,
  loadModelMap,
  Router,
  TASKS,
  TIERS,
  type CodeGraph,
  type Provider,
  type LanguageAdapter,
} from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { claudeCodeProvider } from "@sift/provider-claude-code";
import { DEFAULT_CONFIG, loadMatrix, renderMarkdown, runEval, writeResults, type MatrixConfig } from "@sift/eval";
import { renderGenerateReport, renderModels, renderPlan, renderStatus } from "./generate-render.js";
import { renderCallees, renderCallers, renderImpact } from "./graph-render.js";
import { renderSift, renderStructure } from "./render.js";

function toProjectPath(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/");
}

/** Unit ID → "file#symbol" across every .sift file, so calls render as names. Unreadable files are skipped. */
async function unitNameIndex(root: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const source of await listSiftFiles(root)) {
    try {
      const stored = await readSiftFile(root, source);
      for (const u of stored?.file.units ?? []) names.set(u.id, `${source}#${u.symbol}`);
    } catch {
      // An invalid file elsewhere shouldn't stop showing this one; its calls render as unknown.
    }
  }
  return names;
}

const ADAPTERS: LanguageAdapter[] = [typescriptAdapter];

function adapterFor(path: string): LanguageAdapter {
  const ext = extname(path).toLowerCase();
  const adapter = ADAPTERS.find((a) => a.extensions.includes(ext));
  if (!adapter) {
    const supported = ADAPTERS.flatMap((a) => a.extensions).join(", ");
    throw new SiftError("UNSUPPORTED_FILE", `No language support for "${ext || path}" files yet. Supported: ${supported}.`);
  }
  return adapter;
}

export const VERSION = "0.1.0";

/** Exit codes shared by every command. `check` uses 1 for "found problems". */
export const EXIT = { ok: 0, problems: 1, error: 2 } as const;

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

const processIO: CliIO = {
  out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
};

/** Commands that exist in the design but arrive in later milestones. */
const PLANNED: { name: string; args?: string; summary: string; availableIn: string }[] = [
  { name: "qualify", args: "<provider:model>", summary: "Test a model and assign it a tier", availableIn: "the bring-your-own-key providers" },
];

/** Things tests replace: the AI provider, and where the exit code for "finished with problems" goes. */
export interface CliDeps {
  provider?: Provider;
  state?: { exitCode: number };
}

function providerFor(name: string, deps: CliDeps): Provider {
  if (deps.provider) return deps.provider;
  if (name === "claude-code") return claudeCodeProvider;
  throw new SiftError("CONFIG_INVALID", `Unknown provider "${name}" in sift.config.yaml. Available: claude-code.`);
}

async function routerFor(root: string, provider: string, config: Parameters<typeof generate>[0]["config"]): Promise<{ router: Router; local: boolean }> {
  const local = await loadLocalOverrides(root);
  return { router: new Router(await loadModelMap(provider), config, local), local: local !== null };
}

export function buildProgram(io: CliIO = processIO, deps: CliDeps = {}): Command {
  const program = new Command();
  program
    .name("sift")
    .description("Readable, verified descriptions of what your code does.")
    .version(VERSION)
    .option("-C, --cwd <dir>", "run as if started in <dir>")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride()
    .showHelpAfterError();

  program
    .command("init")
    .description("Set up Sift in the current directory")
    .action(async (_opts: unknown, cmd: Command) => {
      const root = resolve(cwdOf(cmd));
      const result = await initProject(root);
      if (result.created.length === 0 && result.updated.length === 0) {
        io.out(`Sift is already set up in ${root}. Nothing to change.`);
        return;
      }
      io.out(`Set up Sift in ${root}`);
      for (const path of result.created) io.out(`  created  ${path}`);
      for (const path of result.updated) io.out(`  updated  ${path}`);
      io.out("\nNext: review sift.config.yaml and commit it.");
    });

  program
    .command("show <target>")
    .description("Print the description of a file or unit (file#Symbol). --structure shows what the language adapter extracted instead.")
    .option("--structure", "show the adapter's extraction: units, statement tree, calls, types")
    .option("--json", "print raw JSON instead of the readable outline")
    .action(async (target: string, opts: { structure?: boolean; json?: boolean }, cmd: Command) => {
      const cwd = cwdOf(cmd);
      const project = await loadProject(cwd);
      const hash = target.indexOf("#");
      const filePart = hash >= 0 ? target.slice(0, hash) : target;
      const symbol = hash >= 0 ? target.slice(hash + 1) : undefined;
      const abs = resolve(cwd, filePart);

      if (!opts.structure) {
        const sourcePath = toProjectPath(project.root, abs);
        const stored = await readSiftFile(project.root, sourcePath);
        if (!stored) {
          throw new SiftError(
            "SOURCE_NOT_FOUND",
            `${sourcePath} has no description yet (${siftPathFor(sourcePath)} does not exist). Run "sift generate ${sourcePath}" to create it.`,
          );
        }
        const units = symbol === undefined ? stored.file.units : stored.file.units.filter((u) => u.symbol === symbol);
        if (symbol !== undefined && units.length === 0) {
          throw new SiftError(
            "SOURCE_NOT_FOUND",
            `No unit named "${symbol}" in ${siftPathFor(sourcePath)}.`,
            stored.file.units.map((u) => `available: ${u.symbol}`),
          );
        }
        if (opts.json) {
          io.out(JSON.stringify(symbol === undefined ? stored.file : { ...stored.file, units }, null, 2));
          return;
        }
        io.out(renderSift(stored.file, units, await unitNameIndex(project.root)));
        return;
      }

      const adapterProject = await adapterFor(abs).openProject(project.root, [abs], {
        liteMaxStatements: project.config.lite.maxStatements,
      });
      try {
        const extraction = adapterProject.extractFile(abs);
        const units = symbol === undefined ? extraction.units : extraction.units.filter((u) => u.symbol === symbol);
        if (symbol !== undefined && units.length === 0) {
          throw new SiftError(
            "SOURCE_NOT_FOUND",
            `No unit named "${symbol}" in ${extraction.path}.`,
            extraction.units.map((u) => `available: ${u.symbol}`),
          );
        }
        io.out(opts.json ? JSON.stringify(symbol === undefined ? extraction : { ...extraction, units }, null, 2) : renderStructure(extraction, units));
      } finally {
        adapterProject.dispose();
      }
    });

  const graphOptions = (cmd: Command) =>
    cmd
      .option("--json", "print raw JSON")
      .option("--full-hash", "hash every file instead of trusting size and modification time (also SIFT_FULL_HASH=1)");

  graphOptions(
    program
      .command("callers <symbol>")
      .description("List units that call a symbol (file#Symbol, Class.method, or method), with edge confidence")
      .option("-d, --depth <n>", "follow callers this many levels up", "1"),
  ).action(async (query: string, opts: GraphOpts & { depth: string }, cmd: Command) => {
    const graph = await openGraph(cmd, opts);
    const id = resolveSymbol(graph, query);
    const hits = graph.callers(id, depthOf(opts.depth));
    const gaps = graph.possibleCallers(id);
    io.out(opts.json ? JSON.stringify({ subject: id, callers: hits, possibleCallers: gaps }, null, 2) : renderCallers(graph, id, hits, gaps));
  });

  graphOptions(
    program
      .command("callees <symbol>")
      .description("List the units and library calls a symbol makes, with their effects")
      .option("-d, --depth <n>", "follow calls this many levels down", "1"),
  ).action(async (query: string, opts: GraphOpts & { depth: string }, cmd: Command) => {
    const graph = await openGraph(cmd, opts);
    const id = resolveSymbol(graph, query);
    const hits = graph.callees(id, depthOf(opts.depth));
    const gaps = graph.gapsIn(id);
    io.out(opts.json ? JSON.stringify({ subject: id, effects: graph.effectsOf(id, { propagated: true }), callees: hits, unresolved: gaps }, null, 2) : renderCallees(graph, id, hits, gaps));
  });

  graphOptions(
    program
      .command("impact [symbols...]")
      .description("List the units, routes, and tests that may be affected by changing symbols, or by the changes since a git ref")
      .option("--diff <ref>", "use the units changed since <ref> (git diff), e.g. HEAD or main"),
  ).action(async (queries: string[], opts: GraphOpts & { diff?: string }, cmd: Command) => {
    if (queries.length === 0 && opts.diff === undefined) {
      throw new SiftError("SOURCE_NOT_FOUND", "Name at least one symbol, or use --diff <ref>.");
    }
    const graph = await openGraph(cmd, opts);
    const subjects = queries.map((q) => resolveSymbol(graph, q));
    const notes: string[] = [];
    if (opts.diff !== undefined) {
      const diff = await gitDiff(graph.root, opts.diff);
      for (const [file, ranges] of [...diff.changed].sort(([a], [b]) => a.localeCompare(b))) {
        if (!graph.files.includes(file)) continue;
        const units = graph.unitsAt(file, ranges);
        if (units.length === 0) notes.push(`${file}: changes are outside any unit (imports, types, or comments)`);
        for (const u of units) if (!subjects.includes(u)) subjects.push(u);
      }
      for (const file of diff.deleted) if (ADAPTERS.some((a) => a.extensions.includes(extname(file).toLowerCase()))) notes.push(`${file}: deleted; its callers now show as unresolved calls`);
      if (subjects.length === 0) {
        io.out(opts.json ? JSON.stringify({ subjects, notes }, null, 2) : [`No units changed since ${opts.diff}.`, ...notes.map((n) => `  ${n}`)].join("\n"));
        return;
      }
    }
    const result = graph.impact(subjects);
    if (opts.json) {
      io.out(JSON.stringify({ subjects, ...result, notes }, null, 2));
      return;
    }
    const lines = [renderImpact(graph, subjects, result)];
    if (opts.diff !== undefined) lines.unshift(`Changed since ${opts.diff}: ${subjects.length} unit${subjects.length === 1 ? "" : "s"}`, ...subjects.map((s) => `  ${s}`), ...notes.map((n) => `  ${n}`), "");
    io.out(lines.join("\n"));
  });

  program
    .command("generate [paths...]")
    .description("Bring the .sift files in line with the code: describe new units, update changed ones, follow renames and moves")
    .option("--dry-run", "list what would be described or updated, and the models, without calling the AI")
    .option("--force", "describe every unit again from scratch (IDs are kept)")
    .option("--full-hash", "hash every file instead of trusting size and modification time")
    .option("--json", "print the run report as JSON")
    .action(async (paths: string[], opts: { dryRun?: boolean; force?: boolean; fullHash?: boolean; json?: boolean }, cmd: Command) => {
      const project = await loadProject(cwdOf(cmd));
      const loaded = await loadRulePacks(project.root, { builtinDir: builtinRulesDir() });
      const provider = providerFor(project.config.provider, deps);
      const { router, local } = await routerFor(project.root, provider.id, project.config);
      const cwd = resolve(cwdOf(cmd));
      const projectPaths = paths.map((p) => toProjectPath(project.root, resolve(cwd, p)));

      if (!opts.dryRun && !opts.json) {
        io.out(
          provider.capabilities.local
            ? `Using ${provider.id}; code stays on this machine.`
            : `Using ${provider.id}: the code of each unit is sent to Anthropic through Claude Code, on your own login.`,
        );
        if (local) io.out("Personal model overrides from .sift/models.local.yaml are in use.");
      }
      const report = await generate({
        root: project.root,
        config: project.config,
        adapters: ADAPTERS,
        rules: new RuleSet(loaded.packs),
        provider,
        router,
        paths: projectPaths,
        force: opts.force === true,
        dryRun: opts.dryRun === true,
        fullHash: opts.fullHash === true || process.env.SIFT_FULL_HASH === "1",
        onEvent: opts.json
          ? undefined
          : (e) => {
              if (e.type === "start") io.out(`Describing or updating ${e.units} unit${e.units === 1 ? "" : "s"} in ${e.files} file${e.files === 1 ? "" : "s"}…`);
              else if (e.type === "described") {
                const outcome = e.action === "context-check" ? (e.changed ? "reworded" : "no change needed") : e.action === "update" && !e.changed ? "no change needed" : "";
                const notes = [outcome, e.attempts > 1 ? "after a retry" : "", e.stale ? "marked stale" : ""].filter(Boolean).join(", ");
                io.out(`  ✓ ${e.unit}  ${e.task} · ${e.model} · ${(e.durationMs / 1000).toFixed(1)}s${notes ? ` · ${notes}` : ""}`);
              } else if (e.type === "failed") io.out(`  ✗ ${e.unit}: ${e.reason}`);
              else io.out(`  ! ${e.model} is used instead of the ${e.from} tier: ${e.reason}`);
            },
      });
      if (opts.json) io.out(JSON.stringify(report, null, 2));
      else io.out(opts.dryRun ? renderPlan(report) : renderGenerateReport(report));
      if (report.failed.length > 0 && deps.state) deps.state.exitCode = EXIT.problems;
    });

  const statusAction = (check: boolean) => async (opts: { json?: boolean; fullHash?: boolean }, cmd: Command) => {
    const project = await loadProject(cwdOf(cmd));
    const loaded = await loadRulePacks(project.root, { builtinDir: builtinRulesDir() });
    // In CI a fresh checkout's modification times say nothing, so check hashes every file there (design §5.1).
    const fullHash = opts.fullHash === true || process.env.SIFT_FULL_HASH === "1" || (check && Boolean(process.env.CI));
    const report = await syncStatus({ root: project.root, config: project.config, adapters: ADAPTERS, rules: new RuleSet(loaded.packs), fullHash });
    const inSync = isInSync(report);
    io.out(opts.json ? JSON.stringify({ inSync, ...report }, null, 2) : renderStatus(report, inSync));
    if (check && !inSync && deps.state) deps.state.exitCode = EXIT.problems;
  };

  program
    .command("status")
    .description("List units whose description is out of date: changed, new, deleted, renamed, stale, or with changed callees")
    .option("--full-hash", "hash every file instead of trusting size and modification time")
    .option("--json", "print raw JSON")
    .action(statusAction(false));

  program
    .command("check")
    .description("Like status, but exit with code 1 if any description is out of date (for CI and hooks)")
    .option("--full-hash", "hash every file (the default when the CI environment variable is set)")
    .option("--json", "print raw JSON")
    .action(statusAction(true));

  program
    .command("models")
    .description("Show which model each task uses: task → tier → model, with overrides")
    .option("--json", "print raw JSON")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const project = await loadProject(cwdOf(cmd));
      const providerId = deps.provider?.id ?? project.config.provider;
      const { router, local } = await routerFor(project.root, providerId, project.config);
      const routes = TASKS.map((t) => router.route(t));
      io.out(opts.json ? JSON.stringify({ provider: providerId, localOverrides: local, routes }, null, 2) : renderModels(providerId, routes, local));
    });

  program
    .command("eval")
    .description("Run the evaluation harness on a fixture: generate, score against expectations, judge, and measure churn (from a Sift source checkout)")
    .option("--fixture <name>", "fixture under eval/fixtures", "bank-app")
    .option("--matrix", "run every configuration in eval/matrix.yaml")
    .option("--repeat <n>", "runs per configuration (default 1, or 3 with --matrix)")
    .option("--tier <task=tier...>", "run tasks on other tiers, e.g. --tier describe=mid")
    .option("--no-judge", "skip the AI judge (no mention or accuracy scores)")
    .option("--no-churn", "skip the churn edits")
    .option("--eval-dir <dir>", "the eval folder (default: the one in this Sift checkout)")
    .option("--no-save", "do not write eval/results/<timestamp>.json and .md")
    .option("--json", "print the full results as JSON")
    .action(async (opts: EvalOpts) => {
      const evalDir = resolve(opts.evalDir ?? join(SOURCE_ROOT, "eval"));
      if (!existsSync(join(evalDir, "fixtures"))) {
        throw new SiftError("SOURCE_NOT_FOUND", `No evaluation fixtures in ${evalDir}. "sift eval" runs from a Sift source checkout, or with --eval-dir.`);
      }
      let configs: MatrixConfig[] = opts.matrix ? await loadMatrix(evalDir) : [DEFAULT_CONFIG];
      if (opts.tier) configs = [{ name: opts.tier.join(","), tasks: parseTiers(opts.tier) }];
      const repeat = opts.repeat === undefined ? (opts.matrix ? 3 : 1) : depthOf(opts.repeat);
      const provider = providerFor("claude-code", deps);
      const log = opts.json ? () => {} : (line: string) => io.out(line);
      log(`Evaluating ${opts.fixture}: ${configs.map((c) => c.name).join(", ")}, ${repeat} run${repeat === 1 ? "" : "s"} each${opts.judge ? "" : ", no judge"}${opts.churn ? "" : ", no churn"}.`);
      const result = await runEval({
        evalDir,
        fixture: opts.fixture,
        adapters: ADAPTERS,
        builtinRulesDir: builtinRulesDir(),
        provider,
        configs,
        repeat,
        judge: opts.judge,
        churn: opts.churn,
        ...(existsSync(join(SOURCE_ROOT, "node_modules")) ? { nodeModules: join(SOURCE_ROOT, "node_modules") } : {}),
        onProgress: log,
      });
      const markdown = renderMarkdown(result);
      const saved = opts.save ? await writeResults(join(evalDir, "results"), result, markdown) : null;
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
        return;
      }
      io.out(["", ...markdown.split("\n## ")[0]!.trimEnd().split("\n").slice(2)].join("\n"));
      if (saved) io.out(`\nResults: ${relative(process.cwd(), saved.markdown)} (details per run) and ${relative(process.cwd(), saved.json)}`);
    });

  for (const planned of PLANNED) {
    const cmd = program.command(planned.args ? `${planned.name} ${planned.args}` : planned.name);
    cmd.description(`${planned.summary} (not available yet)`).allowUnknownOption();
    cmd.action(() => {
      throw new SiftError("NOT_IMPLEMENTED", `"sift ${planned.name}" is not available yet; it arrives with ${planned.availableIn}.`);
    });
  }

  return program;
}

interface GraphOpts {
  json?: boolean;
  fullHash?: boolean;
}

interface EvalOpts {
  fixture: string;
  matrix?: boolean;
  repeat?: string;
  tier?: string[];
  judge: boolean;
  churn: boolean;
  evalDir?: string;
  save: boolean;
  json?: boolean;
}

/** The Sift checkout this CLI runs from (packages/cli/dist → the repository root). */
const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function parseTiers(values: string[]): MatrixConfig["tasks"] {
  const tasks: MatrixConfig["tasks"] = {};
  for (const value of values) {
    const [task, tier] = value.split("=");
    if (!(TASKS as readonly string[]).includes(task ?? "") || !(TIERS as readonly string[]).includes(tier ?? "")) {
      throw new SiftError("CONFIG_INVALID", `--tier takes task=tier, such as describe=mid; got "${value}".`, [`tasks: ${TASKS.join(", ")}`, `tiers: ${TIERS.join(", ")}`]);
    }
    tasks[task as (typeof TASKS)[number]] = tier as (typeof TIERS)[number];
  }
  return tasks;
}

/** The built-in rule packs shipped in @sift/rules. */
function builtinRulesDir(): string {
  return join(dirname(createRequire(import.meta.url).resolve("@sift/rules/package.json")), "packs");
}

/** Load the project and its rule packs, and bring the code graph up to date (design §12: queries never see stale data). */
async function openGraph(cmd: Command, opts: GraphOpts): Promise<CodeGraph & { root: string }> {
  const project = await loadProject(cwdOf(cmd));
  const loaded = await loadRulePacks(project.root, { builtinDir: builtinRulesDir() });
  const { graph } = await refreshGraph({
    root: project.root,
    config: project.config,
    adapters: ADAPTERS,
    rules: new RuleSet(loaded.packs),
    fullHash: opts.fullHash === true || process.env.SIFT_FULL_HASH === "1",
  });
  return Object.assign(graph, { root: project.root });
}

function resolveSymbol(graph: CodeGraph, query: string): string {
  const matches = graph.find(query);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new SiftError("SOURCE_NOT_FOUND", `"${query}" matches ${matches.length} symbols; use one of these names:`, matches);
  }
  const lower = query.toLowerCase().split("#").pop()!;
  const similar = graph.units().map((u) => u.id).filter((id) => id.toLowerCase().includes(lower)).sort().slice(0, 10);
  throw new SiftError(
    "SOURCE_NOT_FOUND",
    `No unit or symbol named "${query}" in the files Sift reads (sift.config.yaml include/exclude).`,
    similar.map((id) => `similar: ${id}`),
  );
}

function depthOf(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SiftError("SOURCE_NOT_FOUND", `--depth must be a whole number of at least 1, not "${value}".`);
  return n;
}

function cwdOf(cmd: Command): string {
  const opts = cmd.optsWithGlobals<{ cwd?: string }>();
  return opts.cwd ?? process.cwd();
}

/** Run the CLI and return the exit code. Never throws. */
export async function run(argv: string[], io: CliIO = processIO, deps: Omit<CliDeps, "state"> = {}): Promise<number> {
  const state = { exitCode: EXIT.ok as number };
  const program = buildProgram(io, { ...deps, state });
  try {
    await program.parseAsync(argv, { from: "user" });
    return state.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and --version end with exitCode 0; usage errors were already printed by commander.
      return err.exitCode === 0 ? EXIT.ok : EXIT.error;
    }
    if (err instanceof SiftError) {
      io.err(`sift: ${err.message}`);
      for (const detail of err.details) io.err(`  - ${detail}`);
      return EXIT.error;
    }
    io.err(`sift: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return EXIT.error;
  }
}
