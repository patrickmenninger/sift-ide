// Integration tests, run inside VS Code by scripts/run-integration.mjs. Plain node:assert, no
// test framework: `run` resolves when every check passed and rejects with the first failure.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const SERVICE = "src/accounts/account-service.ts";

async function waitFor(what, check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tests = [
  [
    "activates on sift.config.yaml and starts one server for the folder",
    async (api) => {
      const projects = await waitFor("a project", () => api.projects().length === 1 && api.projects());
      const project = projects[0];
      await waitFor("the server", () => project.server.state.kind === "running");
      // Windows drive letters come in either case.
      const same = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
      assert.equal(same(project.root), same(process.env.SIFT_TEST_WORKSPACE));
      assert.deepEqual(project.server.info.provider, { id: "claude-code", local: false });
    },
  ],
  [
    "reports out-of-date logic: every unit of the fixture is new",
    async (api) => {
      const project = api.projects()[0];
      await waitFor("a status", () => project.status);
      assert.ok(project.outOfDate > 0);
      assert.equal(project.outOfDate, project.status.new.length);
      assert.ok(project.files.has(SERVICE));
    },
  ],
  [
    "a new source file shows up in the status without a request from the user",
    async (api) => {
      const project = api.projects()[0];
      const before = project.outOfDate;
      const uri = vscode.Uri.file(path.join(project.root, "src", "added.ts"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from("export function added(): number {\n  return 1;\n}\n"));
      await waitFor("the new file in the status", () => project.files.has("src/added.ts"));
      assert.equal(project.outOfDate, before + 1);
      await vscode.workspace.fs.delete(uri);
      await waitFor("the file gone from the status", () => !project.files.has("src/added.ts"));
    },
  ],
  [
    "Show Callers at the cursor fills the callers view",
    async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(process.env.SIFT_TEST_WORKSPACE, SERVICE)));
      const editor = await vscode.window.showTextDocument(doc);
      const line = doc.getText().split("\n").findIndex((l) => l.includes("async transferFunds("));
      assert.ok(line >= 0);
      editor.selection = new vscode.Selection(line + 1, 4, line + 1, 4);
      await vscode.commands.executeCommand("sift.showCallers");
      await vscode.commands.executeCommand("sift.showCallees");
    },
  ],
  [
    "commands are registered",
    async () => {
      const all = await vscode.commands.getCommands(true);
      for (const id of ["sift.describeFile", "sift.updateAll", "sift.showCallers", "sift.showCallees", "sift.restartServer", "sift.initialize"]) {
        assert.ok(all.includes(id), `${id} is registered`);
      }
    },
  ],
  [
    "Restart Server brings it back",
    async (api) => {
      await vscode.commands.executeCommand("sift.restartServer");
      const project = api.projects()[0];
      await waitFor("the server", () => project.server.state.kind === "running");
    },
  ],
];

async function run() {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === "sift-vscode");
  assert.ok(extension, "the extension is installed");
  const api = await waitFor("activation", async () => (extension.isActive ? extension.exports : (await extension.activate(), extension.exports)));
  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test(api);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err && err.stack ? err.stack : err}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${tests.length} integration tests failed`);
  console.log(`${tests.length} integration tests passed`);
}

module.exports = { run };
