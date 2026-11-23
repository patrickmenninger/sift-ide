/**
 * Entry point of the server bundled into the extension (`dist/server.mjs`): `sift serve` for one
 * project, without the rest of the CLI. The extension runs it with VS Code's own Node.
 *
 *   node server.mjs serve <project dir>
 *   node server.mjs init <dir>          (prints the result as JSON)
 *
 * Prompts and model maps are found next to the bundle (`../prompts`, `../models`, as in
 * @sift/core), the built-in rule packs in `../rules`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, SiftError, Workspace, type Provider } from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { claudeCodeProvider } from "@sift/provider-claude-code";
import { serve } from "@sift/server";

const VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));

function providerFor(name: string): Provider {
  if (name === "claude-code") return claudeCodeProvider;
  throw new SiftError("CONFIG_INVALID", `Unknown provider "${name}" in sift.config.yaml. Available: claude-code.`);
}

async function main(argv: string[]): Promise<number> {
  const [command, dir] = argv;
  if (!dir || (command !== "serve" && command !== "init")) {
    process.stderr.write("usage: server.mjs serve|init <dir>\n");
    return 2;
  }
  if (command === "init") {
    process.stdout.write(`${JSON.stringify(await initProject(dir))}\n`);
    return 0;
  }
  const workspace = await Workspace.open({
    cwd: dir,
    adapters: [typescriptAdapter],
    builtinRulesDir: join(HERE, "..", "rules"),
    provider: (config) => providerFor(config.provider),
  });
  // stdout carries the protocol from here on.
  const { closed } = serve({ workspace, input: process.stdin, output: process.stdout, serverVersion: VERSION });
  process.stderr.write(`sift serve ${VERSION}: ${workspace.root} (Node ${process.version})\n`);
  await closed;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Before the connection is up, the reason goes to stderr; the extension shows the tail.
    if (err instanceof SiftError) process.stderr.write(`${err.message}${err.details.map((d) => `\n  ${d}`).join("")}\n`);
    else process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
