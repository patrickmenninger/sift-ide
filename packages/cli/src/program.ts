import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { initProject, SiftError } from "@sift/core";

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
  { name: "show", args: "<target>", summary: "Print a readable rendering of a unit or file", availableIn: "milestone 2" },
  { name: "callers", args: "<symbol>", summary: "List units that call a symbol", availableIn: "milestone 4" },
  { name: "callees", args: "<symbol>", summary: "List units and external calls a symbol makes", availableIn: "milestone 4" },
  { name: "impact", args: "[symbols...]", summary: "List units, routes, and tests a change may affect", availableIn: "milestone 4" },
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

  for (const planned of PLANNED) {
    const cmd = program.command(planned.args ? `${planned.name} ${planned.args}` : planned.name);
    cmd.description(`${planned.summary} (not available yet)`).allowUnknownOption();
    cmd.action(() => {
      throw new SiftError("NOT_IMPLEMENTED", `"sift ${planned.name}" is not available yet; it arrives with ${planned.availableIn}.`);
    });
  }

  return program;
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
