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

// A change ready for review (phase-2-design §8, M15), proposed with a stand-in model, so the tests
// can review, apply, and undo it without an AI.
const WITHDRAW = "src/accounts/account-service.ts#AccountService.withdraw";
const withdraw = `async withdraw(userId: string, accountId: string, amountCents: number): Promise<Account> {
  if (amountCents <= 0) {
    throw new ValidationError("Withdrawal amount must be positive");
  }
  const account = await this.repo.getAccount(accountId);
  if (account.ownerId !== userId) {
    throw new ForbiddenError("You can only withdraw from your own accounts");
  }
  account.balanceCents -= amountCents;
  await this.repo.save(account);
  return account;
}`;
const editor = new FakeProvider((req) => {
  if (req.task === "edit-plan") {
    return {
      kind: "behavior",
      interpretation: "Reject a withdrawal of zero or less with a validation error before reading the account.",
      questions: [],
      warnings: [],
      allowedUnits: [{ unit: WITHDRAW, reason: "the edited unit" }],
      helpers: [],
      examples: [],
      broader: null,
    };
  }
  if (req.task === "edit-code") return { units: [{ unit: WITHDRAW, text: withdraw }], insertions: [], notes: "" };
  if (req.task === "edit-verify") return { satisfied: true, gaps: [], unrequested: [] };
  return answer(req);
});
const proposed = await sift(editor, "-C", workspace, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less");
if (proposed.code !== 0) {
  console.error(`Proposing the fixture's change failed:\n${proposed.out}\n${proposed.err}`);
  process.exit(1);
}

try {
  await runTests({
    version: process.env.SIFT_VSCODE_VERSION ?? "stable",
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(pkg, "test", "integration.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
    extensionTestsEnv: { SIFT_TEST_WORKSPACE: workspace, ...(process.env.SIFT_TEST_GREP ? { SIFT_TEST_GREP: process.env.SIFT_TEST_GREP } : {}) },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
