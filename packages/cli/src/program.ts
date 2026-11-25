import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { initProject, SiftError, siftPathFor, TASKS, TIERS, Workspace, type Provider, type LanguageAdapter } from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { claudeCodeProvider } from "@sift/provider-claude-code";
import { serve } from "@sift/server";
import { serveMcp } from "@sift/mcp";
import { DEFAULT_CONFIG, loadMatrix, renderEditMarkdown, renderMarkdown, runEditEval, runEval, targetsMissed, writeResults, type MatrixConfig } from "@sift/eval";
import { registerEdit } from "./edit-command.js";
import { renderGenerateReport, renderModels, renderPlan, renderStatus } from "./generate-render.js";
import { renderCallees, renderCallers, renderFlow, renderImpact } from "./graph-render.js";
import { renderSift, renderStructure } from "./render.js";

function toProjectPath(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/");
}

export const ADAPTERS: LanguageAdapter[] = [typescriptAdapter];

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
  /** Asks a question on the terminal (sift edit); by default stdin when it is a terminal. */
  ask?: (question: string) => Promise<string>;
}

export function providerFor(name: string, deps: Pick<CliDeps, "provider">): Provider {
  if (deps.provider) return deps.provider;
  if (name === "claude-code") return claudeCodeProvider;
  throw new SiftError("CONFIG_INVALID", `Unknown provider "${name}" in sift.config.yaml. Available: claude-code.`);
}

/** Open the project containing `cwd` as a workspace, with the built-in adapters and rule packs. */
export function openWorkspace(cwd: string, deps: Pick<CliDeps, "provider"> = {}, options: { fullHash?: boolean; withProvider?: boolean } = {}): Promise<Workspace> {
  return Workspace.open({
    cwd,
    adapters: ADAPTERS,
    builtinRulesDir: builtinRulesDir(),
    // The project's config names the provider.
    ...(options.withProvider === false ? {} : { provider: (config) => providerFor(config.provider, deps) }),
    ...(options.fullHash ? { fullHash: true } : {}),
  });
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

  /** A workspace for read-only commands: no AI provider needed. */
  const reader = (cmd: Command, opts: { fullHash?: boolean } = {}) =>
    openWorkspace(cwdOf(cmd), deps, { withProvider: false, fullHash: opts.fullHash === true || process.env.SIFT_FULL_HASH === "1" });

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
      const workspace = await reader(cmd);
      const hash = target.indexOf("#");
      const filePart = hash >= 0 ? target.slice(0, hash) : target;
      const symbol = hash >= 0 ? target.slice(hash + 1) : undefined;
      const sourcePath = toProjectPath(workspace.root, resolve(cwd, filePart));
      adapterFor(sourcePath);

      if (!opts.structure) {
        // Shown from the .sift file alone: it reads the same with or without the source.
        const file = await workspace.readSift(sourcePath);
        if (!file) {
          throw new SiftError(
            "SOURCE_NOT_FOUND",
            `${sourcePath} has no description yet (${siftPathFor(sourcePath)} does not exist). Run "sift generate ${sourcePath}" to create it.`,
          );
        }
        const units = symbol === undefined ? file.units : file.units.filter((u) => u.symbol === symbol);
        if (symbol !== undefined && units.length === 0) {
          throw new SiftError("SOURCE_NOT_FOUND", `No unit named "${symbol}" in ${siftPathFor(sourcePath)}.`, file.units.map((u) => `available: ${u.symbol}`));
        }
        if (opts.json) {
          io.out(JSON.stringify(symbol === undefined ? file : { ...file, units }, null, 2));
          return;
        }
        const names = new Map([...(await workspace.unitIndex())].map(([id, { source, unit }]) => [id, `${source}#${unit.symbol}`]));
        io.out(renderSift(file, units, names));
        return;
      }

      const extraction = await workspace.extraction(sourcePath);
      const units = symbol === undefined ? extraction.units : extraction.units.filter((u) => u.symbol === symbol);
      if (symbol !== undefined && units.length === 0) {
        throw new SiftError("SOURCE_NOT_FOUND", `No unit named "${symbol}" in ${extraction.path}.`, extraction.units.map((u) => `available: ${u.symbol}`));
      }
      io.out(opts.json ? JSON.stringify(symbol === undefined ? extraction : { ...extraction, units }, null, 2) : renderStructure(extraction, units));
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
    const workspace = await reader(cmd, opts);
    const result = await workspace.callers(query, depthOf(opts.depth));
    const graph = await workspace.graph();
    io.out(opts.json ? JSON.stringify(result, null, 2) : renderCallers(graph, result.subject, result.callers, result.possibleCallers));
  });

  graphOptions(
    program
      .command("callees <symbol>")
      .description("List the units and library calls a symbol makes, with their effects")
      .option("-d, --depth <n>", "follow calls this many levels down", "1"),
  ).action(async (query: string, opts: GraphOpts & { depth: string }, cmd: Command) => {
    const workspace = await reader(cmd, opts);
    const result = await workspace.callees(query, depthOf(opts.depth));
    const graph = await workspace.graph();
    io.out(opts.json ? JSON.stringify(result, null, 2) : renderCallees(graph, result.subject, result.callees, result.unresolved));
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
    const workspace = await reader(cmd, opts);
    const { subjects, notes, ...result } = await workspace.impact(queries, opts.diff);
    if (subjects.length === 0) {
      io.out(opts.json ? JSON.stringify({ subjects, notes }, null, 2) : [`No units changed since ${opts.diff}.`, ...notes.map((n) => `  ${n}`)].join("\n"));
      return;
    }
    if (opts.json) {
      io.out(JSON.stringify({ subjects, ...result, notes }, null, 2));
      return;
    }
    const graph = await workspace.graph();
    const lines = [renderImpact(graph, subjects, result)];
    if (opts.diff !== undefined) lines.unshift(`Changed since ${opts.diff}: ${subjects.length} unit${subjects.length === 1 ? "" : "s"}`, ...subjects.map((s) => `  ${s}`), ...notes.map((n) => `  ${n}`), "");
    io.out(lines.join("\n"));
  });

  graphOptions(
    program
      .command("flow <route>")
      .description('Show what a route does: its handler and every unit and library call it reaches, with effects (e.g. "POST /transfers" or "/transfers")')
      .option("-d, --depth <n>", "follow calls this many levels down", "10"),
  ).action(async (query: string, opts: GraphOpts & { depth: string }, cmd: Command) => {
    const workspace = await reader(cmd, opts);
    const flows = await workspace.flow(query, depthOf(opts.depth));
    if (opts.json) {
      io.out(JSON.stringify(flows, null, 2));
      return;
    }
    const graph = await workspace.graph();
    io.out(flows.map((f) => renderFlow(graph, f)).join("\n\n"));
  });

  program
    .command("generate [paths...]")
    .description("Bring the .sift files in line with the code: describe new units, update changed ones, follow renames and moves")
    .option("--dry-run", "list what would be described or updated, and the models, without calling the AI")
    .option("--force", "describe every unit again from scratch (IDs are kept)")
    .option("--full-hash", "hash every file instead of trusting size and modification time")
    .option("--json", "print the run report as JSON")
    .action(async (paths: string[], opts: { dryRun?: boolean; force?: boolean; fullHash?: boolean; json?: boolean }, cmd: Command) => {
      const workspace = await openWorkspace(cwdOf(cmd), deps);
      const provider = workspace.provider!;
      const cwd = resolve(cwdOf(cmd));
      const projectPaths = paths.map((p) => toProjectPath(workspace.root, resolve(cwd, p)));

      if (!opts.dryRun && !opts.json) {
        io.out(
          provider.capabilities.local
            ? `Using ${provider.id}; code stays on this machine.`
            : `Using ${provider.id}: the code of each unit is sent to Anthropic through Claude Code, on your own login.`,
        );
        if ((await workspace.router()).localOverrides) io.out("Personal model overrides from .sift/models.local.yaml are in use.");
      }
      const report = await workspace.generate({
        paths: projectPaths,
        force: opts.force === true,
        dryRun: opts.dryRun === true,
        fullHash: opts.fullHash === true || process.env.SIFT_FULL_HASH === "1",
        ...(opts.json
          ? {}
          : {
              onEvent: (e) => {
                if (e.type === "start") io.out(`Describing or updating ${e.units} unit${e.units === 1 ? "" : "s"} in ${e.files} file${e.files === 1 ? "" : "s"}…`);
                else if (e.type === "described") {
                  const outcome = e.action === "context-check" ? (e.changed ? "reworded" : "no change needed") : e.action === "update" && !e.changed ? "no change needed" : "";
                  const notes = [outcome, e.attempts > 1 ? "after a retry" : "", e.stale ? "marked stale" : ""].filter(Boolean).join(", ");
                  io.out(`  ✓ ${e.unit}  ${e.task} · ${e.model} · ${(e.durationMs / 1000).toFixed(1)}s${notes ? ` · ${notes}` : ""}`);
                } else if (e.type === "failed") io.out(`  ✗ ${e.unit}: ${e.reason}`);
                else io.out(`  ! ${e.model} is used instead of the ${e.from} tier: ${e.reason}`);
              },
            }),
      });
      if (opts.json) io.out(JSON.stringify(report, null, 2));
      else io.out(opts.dryRun ? renderPlan(report) : renderGenerateReport(report));
      if (report.failed.length > 0 && deps.state) deps.state.exitCode = EXIT.problems;
    });

  const statusAction = (check: boolean) => async (opts: { json?: boolean; fullHash?: boolean }, cmd: Command) => {
    const workspace = await reader(cmd);
    // In CI a fresh checkout's modification times say nothing, so check hashes every file there (design §5.1).
    const fullHash = opts.fullHash === true || process.env.SIFT_FULL_HASH === "1" || (check && Boolean(process.env.CI));
    const { inSync, ...report } = await workspace.status({ fullHash });
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
    .command("verify <targets...>")
    .description("Mark descriptions as checked by a person: units (file#Symbol, Class.method) or whole files. Only descriptions that match the current code can be verified.")
    .option("--json", "print raw JSON")
    .action(async (targets: string[], opts: { json?: boolean }, cmd: Command) => {
      const workspace = await reader(cmd);
      const cwd = resolve(cwdOf(cmd));
      // A target that is a path on disk is a source file; anything else is a symbol.
      const resolved = targets.map((t) => (!t.includes("#") && existsSync(resolve(cwd, t)) ? toProjectPath(workspace.root, resolve(cwd, t)) : t));
      const result = await workspace.verify(resolved);
      if (opts.json) io.out(JSON.stringify(result, null, 2));
      else {
        const out: string[] = [];
        if (result.verified.length > 0) out.push(`Verified (${result.verified.length}):`, ...result.verified.map((u) => `  ✓ ${u}`));
        if (result.refused.length > 0) out.push(`Not verified (${result.refused.length}):`, ...result.refused.map((r) => `  ✗ ${r.unit}: ${r.reason}`));
        if (result.written.length > 0) out.push("", `Wrote ${result.written.length} .sift file${result.written.length === 1 ? "" : "s"}.`);
        io.out(out.join("\n"));
      }
      if (result.refused.length > 0 && deps.state) deps.state.exitCode = EXIT.problems;
    });

  registerEdit(program, io, deps, (cmd, withProvider) => openWorkspace(cwdOf(cmd), deps, { withProvider }));

  program
    .command("migrate")
    .description("Rewrite every .sift file at the current schema version, keeping its text (files are otherwise upgraded only when they need it)")
    .option("--json", "print raw JSON")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const workspace = await reader(cmd);
      const result = await workspace.migrate();
      if (opts.json) io.out(JSON.stringify(result, null, 2));
      else {
        const out = result.upgraded.length > 0 ? [`Upgraded ${result.upgraded.length} .sift file${result.upgraded.length === 1 ? "" : "s"}:`, ...result.upgraded.map((f) => `  ${f}`)] : ["Every .sift file is already at the current schema version."];
        for (const u of result.unreadable) out.push(`  ✗ ${u.file}: ${u.message}`);
        io.out(out.join("\n"));
      }
      if (result.unreadable.length > 0 && deps.state) deps.state.exitCode = EXIT.problems;
    });

  program
    .command("serve")
    .description("Serve this project's descriptions and code graph over JSON-RPC on stdin and stdout, for editor extensions")
    .action(async (_opts: unknown, cmd: Command) => {
      // stdout carries the protocol from here on; anything else the server says goes to stderr.
      const workspace = await openWorkspace(cwdOf(cmd), deps);
      const { closed } = serve({ workspace, input: process.stdin, output: process.stdout, serverVersion: VERSION });
      io.err(`sift serve: ${workspace.root}`);
      await closed;
    });

  program
    .command("mcp")
    .description("Serve this project's descriptions, code graph, and impact analysis to AI coding agents as an MCP server on stdin and stdout")
    .option("--root <dir>", "the project to serve (default: the current directory)")
    .option("--allow-generate", "add the sift_generate tool, which spends your AI quota")
    .action(async (opts: { root?: string; allowGenerate?: boolean }, cmd: Command) => {
      // stdout carries the protocol from here on; anything else goes to stderr.
      const allowGenerate = opts.allowGenerate === true;
      const workspace = await openWorkspace(opts.root ? resolve(cwdOf(cmd), opts.root) : cwdOf(cmd), deps, { withProvider: allowGenerate });
      const { closed } = await serveMcp({ workspace, allowGenerate, version: VERSION, input: process.stdin, output: process.stdout });
      io.err(`sift mcp: ${workspace.root}${allowGenerate ? " (sift_generate allowed)" : ""}`);
      await closed;
    });

  program
    .command("models")
    .description("Show which model each task uses: task → tier → model, with overrides")
    .option("--json", "print raw JSON")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const workspace = await reader(cmd);
      const providerId = deps.provider?.id ?? workspace.config.provider;
      const { router, localOverrides } = await workspace.router(providerId);
      const routes = TASKS.map((t) => router.route(t));
      io.out(opts.json ? JSON.stringify({ provider: providerId, localOverrides, routes }, null, 2) : renderModels(providerId, routes, localOverrides));
    });

  program
    .command("eval")
    .description("Run the evaluation harness on a fixture: generate, score against expectations, judge, and measure churn; or, with --edits, evaluate natural-language editing (from a Sift source checkout)")
    .option("--fixture <name>", "fixture under eval/fixtures", "bank-app")
    .option("--edits", "evaluate editing: run the change requests in eval/edits/<fixture>.yaml up to review")
    .option("--case <id...>", "with --edits: run only these cases")
    .option("--matrix", "run every configuration in eval/matrix.yaml (its edits list with --edits)")
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
      let configs: MatrixConfig[] = opts.matrix ? await loadMatrix(evalDir, opts.edits ? "edits" : "configs") : [DEFAULT_CONFIG];
      if (opts.tier) configs = [{ name: opts.tier.join(","), tasks: parseTiers(opts.tier) }];
      const repeat = opts.repeat === undefined ? (opts.matrix ? 3 : 1) : depthOf(opts.repeat);
      const provider = providerFor("claude-code", deps);
      const log = opts.json ? () => {} : (line: string) => io.out(line);
      const nodeModules = existsSync(join(SOURCE_ROOT, "node_modules")) ? { nodeModules: join(SOURCE_ROOT, "node_modules") } : {};
      if (opts.edits) {
        log(`Evaluating edits on ${opts.fixture}: ${configs.map((c) => c.name).join(", ")}, ${repeat} run${repeat === 1 ? "" : "s"} each${opts.judge ? "" : ", no judge"}.`);
        const result = await runEditEval({
          evalDir, fixture: opts.fixture, adapters: ADAPTERS, builtinRulesDir: builtinRulesDir(), provider, configs, repeat, judge: opts.judge,
          ...(opts.case ? { only: opts.case } : {}), ...nodeModules, onProgress: log,
        });
        const markdown = renderEditMarkdown(result);
        const saved = opts.save ? await writeResults(join(evalDir, "results"), result, markdown, "-edits") : null;
        if (opts.json) {
          io.out(JSON.stringify(result, null, 2));
          return;
        }
        io.out(["", ...markdown.split("\n## ")[0]!.trimEnd().split("\n").slice(2)].join("\n"));
        if (saved) io.out(`\nResults: ${relative(process.cwd(), saved.markdown)} (details per case) and ${relative(process.cwd(), saved.json)}`);
        if (result.summary.some((s) => targetsMissed(s).length > 0) && deps.state) deps.state.exitCode = EXIT.problems;
        return;
      }
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
        ...nodeModules,
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
  edits?: boolean;
  case?: string[];
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
export function builtinRulesDir(): string {
  return join(dirname(createRequire(import.meta.url).resolve("@sift/rules/package.json")), "packs");
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
