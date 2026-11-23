// Runs the extension's integration tests (test/integration.cjs) in a real VS Code with
// @vscode/test-electron (phase-2-design §10): a copy of the bank-app fixture as the workspace,
// the built extension (dist/) under development. Build first: `npm run test:integration`.
//
// src/accounts is described beforehand with the CLI's stand-in model, so the logic documents
// have content; this needs the packages built (`npm run build` at the repository root).
//
// VS Code is downloaded once into .vscode-test/. Set SIFT_VSCODE_VERSION to pin another version.
import { cp, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { FakeProvider } from "../../core/dist/index.js";
import { answer, sift } from "../../cli/dist/test-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..");

const workspace = join(await mkdtemp(join(tmpdir(), "sift-vscode-")), "bank-app");
await cp(join(repo, "eval", "fixtures", "bank-app"), workspace, { recursive: true, filter: (src) => !src.includes(".cache") });
await symlink(join(repo, "node_modules"), join(workspace, "node_modules"), "junction");
const described = await sift(new FakeProvider((req) => answer(req)), "-C", workspace, "generate", "src/accounts");
if (described.code !== 0) {
  console.error(`Describing the fixture failed:\n${described.err}`);
  process.exit(1);
}

try {
  await runTests({
    version: process.env.SIFT_VSCODE_VERSION ?? "stable",
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(pkg, "test", "integration.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
    extensionTestsEnv: { SIFT_TEST_WORKSPACE: workspace },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
