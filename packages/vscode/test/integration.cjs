// Integration tests, run inside VS Code by scripts/run-integration.mjs. Plain node:assert, no
// test framework: `run` resolves when every check passed and rejects with the first failure.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

// run-integration.mjs describes src/accounts before VS Code starts; the rest is undescribed.
const SERVICE = "src/accounts/account-service.ts";
const PRISMA = "src/accounts/prisma-account-repository.ts";
const REPOSITORIES = ["src/accounts/in-memory-account-repository.ts", PRISMA];
const ROUTES = "src/http/routes.ts";

const allSteps = (steps) => steps.flatMap((s) => [s, ...allSteps(s.steps)]);
const lineOf = (doc, text) => doc.getText().split("\n").findIndex((l) => l.includes(text));
const inWorkspace = (file) => vscode.Uri.file(path.join(process.env.SIFT_TEST_WORKSPACE, file));
const endsWith = (uri, file) => uri.fsPath.replace(/\\/g, "/").endsWith(file);

async function openSource(file) {
  const doc = await vscode.workspace.openTextDocument(inWorkspace(file));
  return vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
}

/** The logic document for a file, once it has loaded. */
function logicView(api, file) {
  return waitFor(`the logic of ${file}`, () => api.logicViews().find((v) => v.source === file && v.current.file));
}

function unitOf(view, symbol) {
  return view.current.file.units.find((u) => u.unit.symbol === symbol);
}

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
    "reports out-of-date logic: units outside src/accounts are new",
    async (api) => {
      const project = api.projects()[0];
      await waitFor("a status", () => project.status);
      assert.ok(project.outOfDate > 0);
      assert.equal(project.outOfDate, project.status.new.length);
      assert.ok(project.files.has(ROUTES));
      assert.ok(!project.files.has(SERVICE));
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
    "Open Logic shows the file's logic document beside the source",
    async (api) => {
      await openSource(SERVICE);
      await vscode.commands.executeCommand("sift.openLogic");
      const view = await logicView(api, SERVICE);
      // The bundled document loaded under the webview's content security policy.
      await waitFor("the webview script", () => view.webviewReady);
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "sift.logic");
      assert.ok(tab, "a logic editor tab is open");
      assert.ok(endsWith(tab.input.uri, `.sift/${SERVICE}.sift`));
      assert.notEqual(tab.group.viewColumn, vscode.ViewColumn.One);
      const transfer = unitOf(view, "AccountService.transferFunds");
      assert.equal(transfer.freshness, "fresh");
      assert.equal(transfer.status, "generated");
      // Opening it again reuses the document.
      await vscode.commands.executeCommand("sift.openLogic", inWorkspace(SERVICE));
      assert.equal(api.logicViews().filter((v) => v.source === SERVICE).length, 1);
    },
  ],
  [
    "the cursor in the source marks the step that owns it; the step's ranges cover that code",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const editor = await openSource(SERVICE);
      const line = lineOf(editor.document, "await this.repo.save(from);");
      assert.ok(line >= 0);
      const transfer = unitOf(view, "AccountService.transferFunds");
      // Only messages after the move: the document already got one for the cursor's old place.
      const before = view.sent.length;
      editor.selection = new vscode.Selection(line, 8, line, 8);
      const current = await waitFor("the current step", () => view.sent.slice(before).find((m) => m.type === "current" && m.at && m.at.unitId === transfer.unit.id && m.at.stepId));
      const ranges = await view.ranges(current.at);
      assert.equal(ranges.fresh, true);
      assert.ok(ranges.ranges.some((r) => r.start.line - 1 <= line && r.end.line - 1 >= line), "the step's ranges include the cursor line");
      // Hovering highlights (decorations are not readable through the API; this checks it runs).
      await view.receive({ type: "hover", at: current.at });
      await view.receive({ type: "hover", at: null });
    },
  ],
  [
    "Ctrl+click on an interface call offers both implementations and opens the chosen one's logic",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const transfer = unitOf(view, "AccountService.transferFunds");
      const step = allSteps(transfer.unit.steps).find((s) => s.calls.length === 2);
      assert.ok(step, "a step calling both repository implementations");
      // As when the user Ctrl+clicks in it: the document has focus.
      view.panel.reveal(undefined, false);
      await waitFor("the service's logic active", () => view.panel.active);
      const navigating = view.receive({ type: "navigate", at: { unitId: transfer.unit.id, stepId: step.id }, source: false });
      await new Promise((r) => setTimeout(r, 1000)); // the picker opens
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      await navigating;
      const opened = await waitFor("the implementation's logic", () => api.logicViews().find((v) => REPOSITORIES.includes(v.source) && v.current.file));
      const reveal = await waitFor("the unit revealed", () => opened.sent.find((m) => m.type === "reveal"));
      const target = opened.current.file.units.find((u) => u.unit.id === reveal.unitId);
      assert.ok(step.calls.includes(target.unit.id));
      assert.match(target.unit.symbol, /Repository\.(save|getAccount)$/);
      // Go Back returns to the logic the navigation started from.
      const activeLogic = () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return tab && tab.input instanceof vscode.TabInputCustom ? tab.input.uri : null;
      };
      await waitFor("the implementation's logic active", () => activeLogic() && endsWith(activeLogic(), `${opened.source}.sift`));
      await vscode.commands.executeCommand("workbench.action.navigateBack");
      await waitFor("the service's logic active again", () => activeLogic() && endsWith(activeLogic(), `${SERVICE}.sift`));
    },
  ],
  [
    "Ctrl+click on a step with only library calls pins the calls card",
    async (api) => {
      await vscode.commands.executeCommand("sift.openLogic", inWorkspace(PRISMA));
      const view = await logicView(api, PRISMA);
      const candidates = view.current.file.units.flatMap((u) =>
        allSteps(u.unit.steps)
          .filter((s) => s.calls.length > 0 && s.calls.every((c) => c.startsWith("ext:")))
          .map((s) => ({ unitId: u.unit.id, stepId: s.id })),
      );
      assert.ok(candidates.length > 0);
      await view.receive({ type: "navigate", at: candidates[0], source: false });
      const card = view.sent.find((m) => m.type === "targets" && m.pinned);
      assert.ok(card, "a pinned card");
      assert.ok(card.targets.every((t) => t.kind === "external"));
    },
  ],
  [
    "Alt+click on a target opens its code",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const deposit = unitOf(view, "AccountService.deposit");
      const target = { kind: "unit", unitId: deposit.unit.id, ref: deposit.ref, file: SERVICE, symbol: deposit.unit.symbol, summary: deposit.unit.summary };
      await view.receive({ type: "openTarget", target, source: true });
      const editor = vscode.window.activeTextEditor;
      assert.ok(endsWith(editor.document.uri, SERVICE));
      assert.ok(editor.document.lineAt(editor.selection.active.line).text.includes("deposit("));
    },
  ],
  [
    "Verify marks a unit verified in its .sift file",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const deposit = unitOf(view, "AccountService.deposit");
      await view.receive({ type: "verify", unitId: deposit.unit.id });
      await waitFor("the unit verified", () => unitOf(view, "AccountService.deposit").status === "verified");
      const text = Buffer.from(await vscode.workspace.fs.readFile(inWorkspace(`.sift/${SERVICE}.sift`))).toString("utf8");
      assert.match(text, /status: verified/);
    },
  ],
  [
    "an unsaved source edit is flagged in the logic document; once saved, the unit is stale",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const editor = await openSource(SERVICE);
      const line = lineOf(editor.document, "amountCents <= 0");
      assert.ok(line >= 0);
      const text = editor.document.lineAt(line);
      await editor.edit((b) => b.replace(text.range, text.text.replace("amountCents <= 0", "amountCents < 1")));
      await waitFor("the dirty flag", () => view.current.dirty);
      await editor.document.save();
      await waitFor("the saved flag", () => !view.current.dirty);
      const changed = await waitFor("a stale unit", () => view.current.file.units.find((u) => u.freshness === "code-changed"));
      // A stale unit's ranges are the whole unit, not step ranges.
      const ranges = await view.ranges({ unitId: changed.unit.id, stepId: changed.unit.steps[0].id });
      assert.equal(ranges.fresh, false);
    },
  ],
  [
    "a file with no description yet opens as a logic panel",
    async (api) => {
      await vscode.commands.executeCommand("sift.openLogic", inWorkspace(ROUTES));
      const view = await logicView(api, ROUTES);
      assert.equal(view.current.file.sift, null);
      assert.ok(view.current.file.undescribed.length > 0);
    },
  ],
  [
    "commands are registered",
    async () => {
      const all = await vscode.commands.getCommands(true);
      for (const id of ["sift.describeFile", "sift.updateAll", "sift.showCallers", "sift.showCallees", "sift.restartServer", "sift.initialize", "sift.openLogic", "sift.openSourceOfLogic"]) {
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
