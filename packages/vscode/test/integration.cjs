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
const readText = (file) => require("node:fs").readFileSync(path.join(process.env.SIFT_TEST_WORKSPACE, file), "utf8");
const endsWith = (uri, file) => uri.fsPath.replace(/\\/g, "/").endsWith(file);

async function openSource(file) {
  const doc = await vscode.workspace.openTextDocument(inWorkspace(file));
  return vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
}

/** The logic document for a file, once it has loaded. */
function logicView(api, file) {
  return waitFor(`the logic of ${file}`, () => api.logicViews().find((v) => v.source === file && v.current.file));
}

/** A graph panel of a kind, once its model has loaded (and, given `match`, for that query). */
function graphView(api, kind, match = () => true) {
  return waitFor(`the ${kind} view`, () => api.graphViews().find((v) => v.query.view === kind && v.model && !v.current.loading && match(v)));
}

function unitOf(view, symbol) {
  return view.current.file.units.find((u) => u.unit.symbol === symbol);
}

async function waitFor(what, check, ms = 60_000, explain = () => "") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what} ${explain()}`.trim());
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
      // Only messages after the move (by identity: the list drops old entries). One for the cursor's
      // old place may still arrive after it, so wait for the newest to be the step at the cursor.
      const seen = new Set(view.sent);
      editor.selection = new vscode.Selection(line, 8, line, 8);
      const covers = (ranges) => ranges.ranges.some((r) => r.start.line - 1 <= line && r.end.line - 1 >= line);
      const current = await waitFor("the step at the cursor", async () => {
        const latest = view.sent.filter((m) => !seen.has(m) && m.type === "current" && m.at && m.at.unitId === transfer.unit.id && m.at.stepId).at(-1);
        return latest && covers(await view.ranges(latest.at)) ? latest : null;
      });
      const ranges = await view.ranges(current.at);
      assert.equal(ranges.fresh, true);
      assert.ok(covers(ranges), "the step's ranges include the cursor line");
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
      // As when the user Ctrl+clicks in it: the document has focus. Accepting the picker just as it
      // opens can find no item active (it then closes with no choice), so try again in that case.
      const repositoryLogic = () => api.logicViews().find((v) => REPOSITORIES.includes(v.source) && v.current.file);
      for (let attempt = 0; attempt < 3 && !repositoryLogic(); attempt++) {
        view.panel.reveal(undefined, false);
        await waitFor("the service's logic active", () => view.panel.active);
        let settled = false;
        const navigating = view.receive({ type: "navigate", at: { unitId: transfer.unit.id, stepId: step.id }, source: false }).finally(() => (settled = true));
        await waitFor("the picker accepted", async () => {
          await new Promise((r) => setTimeout(r, 400));
          await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
          return settled;
        });
        await navigating;
        await waitFor("the chosen logic", repositoryLogic, 5_000).catch(() => null);
      }
      const opened = await waitFor("the implementation's logic", repositoryLogic, 60_000, () =>
        JSON.stringify({ views: api.logicViews().map((v) => ({ source: v.source, file: !!v.current.file, error: v.current.error })), tab: String(vscode.window.tabGroups.activeTabGroup.activeTab && vscode.window.tabGroups.activeTabGroup.activeTab.label) }),
      );
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
    "Show Neighbourhood at the cursor draws transferFunds with both implementations; a node opens its logic",
    async (api) => {
      const editor = await openSource(SERVICE);
      const line = lineOf(editor.document, "async transferFunds(");
      editor.selection = new vscode.Selection(line + 1, 4, line + 1, 4);
      await vscode.commands.executeCommand("sift.showNeighbourhood");
      const view = await graphView(api, "neighbourhood");
      // The bundled script (with elkjs) loaded under the webview's policy and drew the diagram.
      const drawn = await waitFor("the diagram drawn", () => view.drawn);
      assert.equal(drawn.error, undefined);
      assert.equal(drawn.nodes, view.model.nodes.length);
      assert.match(view.panel.title, /Neighbourhood: AccountService\.transferFunds/);
      const ids = view.model.nodes.map((n) => n.id);
      for (const repo of REPOSITORIES) assert.ok(ids.some((id) => id.startsWith(`${repo}#`) && id.endsWith(".save")), `${repo} is in the neighbourhood`);
      assert.ok(view.model.edges.some((e) => e.kind === "implements"));
      await view.receive({ type: "open", nodeId: `${PRISMA}#PrismaAccountRepository.save`, source: false });
      const opened = await logicView(api, PRISMA);
      const reveal = await waitFor("the unit revealed", () => opened.sent.find((m) => m.type === "reveal"));
      assert.equal(opened.current.file.units.find((u) => u.unit.id === reveal.unitId).unit.symbol, "PrismaAccountRepository.save");
      // Shift+click: the neighbourhood moves to that unit, in the same panel.
      await view.receive({ type: "neighbourhood", nodeId: `${PRISMA}#PrismaAccountRepository.save` });
      await waitFor("the new subject", () => view.model && view.model.nodes.find((n) => n.role === "subject").id.endsWith("PrismaAccountRepository.save"));
      assert.equal(api.graphViews().filter((v) => v.query.view === "neighbourhood").length, 1);
    },
  ],
  [
    "the flow from each Express route reaches the Prisma calls with their effects",
    async (api) => {
      for (const route of ["route:POST /transfers", "route:GET /accounts/:id/balance"]) {
        await vscode.commands.executeCommand("sift.showFlow", route);
        const view = await graphView(api, "flow", (v) => v.query.route === route);
        const drawn = await waitFor(`the flow of ${route} drawn`, () => view.drawn);
        assert.equal(drawn.error, undefined);
        const prisma = view.model.nodes.filter((n) => n.kind === "external" && n.detail === "@prisma/client");
        assert.ok(prisma.length > 0, `${route} reaches Prisma`);
        assert.ok(prisma.every((n) => n.effects.some((e) => e.startsWith("db."))));
      }
    },
  ],
  [
    "Show Impact of Changing This lists POST /transfers; clicking the route shows its flow",
    async (api) => {
      const editor = await openSource(PRISMA);
      const line = lineOf(editor.document, "async save(");
      assert.ok(line >= 0);
      editor.selection = new vscode.Selection(line + 1, 4, line + 1, 4);
      await vscode.commands.executeCommand("sift.showImpact");
      const view = await graphView(api, "impact");
      assert.ok(view.model.nodes.some((n) => n.role === "changed" && n.id.endsWith("PrismaAccountRepository.save")));
      assert.ok(view.model.nodes.some((n) => n.id === "route:POST /transfers"));
      await view.receive({ type: "open", nodeId: "route:POST /transfers", source: false });
      await graphView(api, "flow", (v) => v.query.route === "route:POST /transfers");
    },
  ],
  [
    "a ready change opens for review with its diff, applies through the editor, and undoes exactly",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const withdraw = unitOf(view, "AccountService.withdraw");
      // run-integration.mjs proposed it before VS Code started.
      const edit = await waitFor("the proposed change on its unit", () => view.current.edits.find((e) => e.request.unitId === withdraw.unit.id && e.request.state === "ready"));
      const editor = await openSource(SERVICE);
      const original = editor.document.getText();
      const originalSift = readText(`.sift/${SERVICE}.sift`);

      await view.receive({ type: "review", id: edit.request.id });
      const review = await waitFor("the review panel", () => api.reviewViews().find((r) => r.id === edit.request.id && r.webviewReady && r.current.request));
      assert.equal(review.current.request.state, "ready");
      assert.match(review.panel.title, /Review: AccountService\.withdraw/);
      await review.receive({ type: "openDiff", path: SERVICE });
      await waitFor("the diff editor", () =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === "sift-proposal" && endsWith(t.input.original, SERVICE)),
      );

      await review.receive({ type: "approve" });
      await waitFor("applied", () => review.current.request && review.current.request.state === "applied");
      // The open editor has exactly the reviewed code, saved (it went through a WorkspaceEdit).
      assert.equal(editor.document.isDirty, false);
      assert.equal(editor.document.getText(), edit.request.proposal.files[0].text);
      assert.equal(readText(SERVICE), edit.request.proposal.files[0].text);
      assert.match(readText(SERVICE), /Withdrawal amount must be positive/);
      await waitFor("the new description, fresh", () => {
        const u = unitOf(view, "AccountService.withdraw");
        return u && u.freshness === "fresh" && u.unit.bodyHash !== withdraw.unit.bodyHash;
      });
      assert.ok(!view.current.edits.some((e) => e.request.id === edit.request.id), "an applied change is no longer shown on its unit");

      // Undo restores the code and the description byte for byte; the editor follows.
      await review.receive({ type: "undo" });
      await waitFor("undone", () => review.current.request.state === "undone");
      assert.equal(readText(SERVICE), original);
      assert.equal(readText(`.sift/${SERVICE}.sift`), originalSift);
      await waitFor("the editor back to the original", () => editor.document.getText() === original);
      await waitFor("the description current again", () => unitOf(view, "AccountService.withdraw").unit.bodyHash === withdraw.unit.bodyHash);
    },
  ],
  [
    "a draft is saved as a change request on its unit; when the code changes under it, it needs review",
    async (api) => {
      const view = await logicView(api, SERVICE);
      const balance = unitOf(view, "AccountService.getBalance");
      const edits = [{ op: "set", path: "summary", before: balance.unit.summary, after: "Reads an account's balance, in cents." }];
      await view.receive({ type: "draft", unitId: balance.unit.id, edits, request: "", seq: 7 });
      const draft = await waitFor("the draft", () => view.current.edits.find((e) => e.request.unitId === balance.unit.id));
      assert.equal(draft.request.state, "draft");
      assert.deepEqual(draft.request.edits, edits);
      assert.ok(view.sent.some((m) => m.type === "draftSaved" && m.unitId === balance.unit.id && m.seq === 7));

      const editor = await openSource(SERVICE);
      const original = editor.document.getText();
      try {
        const line = editor.document.lineAt(lineOf(editor.document, "return account.balanceCents;"));
        await editor.edit((b) => b.replace(line.range, line.text.replace("return account.balanceCents;", "return account.balanceCents + 0;")));
        await editor.document.save();
        const marked = await waitFor("the request marked for review", () => view.current.edits.find((e) => e.request.id === draft.request.id && e.request.state === "needs-review"));
        assert.match(marked.request.review, /code changed/);
        await view.receive({ type: "discard", id: draft.request.id });
        await waitFor("the request gone", () => !view.current.edits.some((e) => e.request.id === draft.request.id));
        // Later checks for pending edits leave it rejected.
        await api.projects()[0].refreshStatus();
        assert.equal((await api.projects()[0].server.request("sift/edit/get", { id: draft.request.id })).state, "rejected");
      } finally {
        const all = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
        await editor.edit((b) => b.replace(all, original));
        await editor.document.save();
        await waitFor("the unit current again", () => unitOf(view, "AccountService.getBalance").freshness === "fresh");
      }
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
      for (const id of [
        "sift.describeFile",
        "sift.updateAll",
        "sift.showCallers",
        "sift.showCallees",
        "sift.restartServer",
        "sift.initialize",
        "sift.openLogic",
        "sift.openSourceOfLogic",
        "sift.showNeighbourhood",
        "sift.showFlow",
        "sift.showImpact",
        "sift.showImpactOfChanges",
        "sift.editUnit",
        "sift.undoEdit",
      ]) {
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
  // SIFT_TEST_GREP: run only tests whose name matches (tests build on earlier ones, so include those too).
  const grep = process.env.SIFT_TEST_GREP ? new RegExp(process.env.SIFT_TEST_GREP) : null;
  const selected = tests.filter(([n]) => !grep || grep.test(n));
  for (const [name, test] of selected) {
    try {
      await test(api);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err && err.stack ? err.stack : err}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${selected.length} integration tests failed`);
  console.log(`${selected.length} integration tests passed`);
}

module.exports = { run };
