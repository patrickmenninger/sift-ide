import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
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
  type CodeGraph,
  type LanguageAdapter,
} from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
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

export const VERSION = "0.0.0";

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
  { name: "generate", args: "[paths...]", summary: "Write or update .sift files for source files", availableIn: "milestone 6" },
  { name: "status", summary: "List stale, new, deleted, and unverified units", availableIn: "milestone 7" },
  { name: "check", summary: "Exit non-zero if any .sift file is stale or missing (for CI and hooks)", availableIn: "milestone 7" },
  { name: "eval", summary: "Run the evaluation harness", availableIn: "milestone 8" },
  { name: "models", summary: "Show task, tier, and model routing", availableIn: "milestone 6" },
  { name: "qualify", args: "<provider:model>", summary: "Test a model and assign it a tier", availableIn: "the bring-your-own-key providers" },
];

export function buildProgram(io: CliIO = processIO): Command {
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
            `${sourcePath} has no description yet (${siftPathFor(sourcePath)} does not exist). "sift generate" creates it (milestone 6); "sift show --structure" works now.`,
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
export async function run(argv: string[], io: CliIO = processIO): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
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
