import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProvider, readSiftFile, SiftError, writeSiftFile, type Workspace, type WorkspaceChange } from "@sift/core";
import { openWorkspace } from "./program.js";
import { answer, fixtureCopy, sift } from "./test-helpers.js";

/** A described copy of bank-app and a workspace on it. */
async function described(): Promise<{ dir: string; workspace: Workspace; provider: FakeProvider }> {
  const dir = await fixtureCopy();
  const provider = new FakeProvider((req) => answer(req));
  expect((await sift(provider, "-C", dir, "generate")).code).toBe(0);
  return { dir, workspace: await openWorkspace(dir, { provider }), provider };
}

const SERVICE = "src/accounts/account-service.ts";

describe("Workspace", () => {
  it("reads a file's logic with status and freshness, and finds units by ID or symbol", async () => {
    const { dir, workspace } = await described();
    const logic = await workspace.logicFile(SERVICE);
    expect(logic.undescribed).toEqual([]);
    const transfer = logic.units.find((u) => u.unit.symbol === "AccountService.transferFunds")!;
    expect(transfer).toMatchObject({ ref: `${SERVICE}#AccountService.transferFunds`, status: "generated", freshness: "fresh" });
    expect((await workspace.unit(transfer.unit.id)).unit.symbol).toBe("AccountService.transferFunds");
    expect((await workspace.unit("transferFunds")).source).toBe(SERVICE);

    // After a code edit the description is no longer fresh, and the workspace says which files changed.
    const changes: WorkspaceChange[] = [];
    workspace.onDidChange((c) => changes.push(c));
    const path = join(dir, SERVICE);
    await writeFile(path, (await readFile(path, "utf8")).replace("amountCents <= 0", "amountCents < 1"));
    const after = await workspace.logicFile(SERVICE);
    expect(after.units.find((u) => u.unit.symbol === "AccountService.deposit")?.freshness).toBe("code-changed");
    expect(changes).toContainEqual({ type: "source", files: expect.arrayContaining([SERVICE]) });
  }, 90_000);

  it("maps steps to source ranges and source positions back to steps", async () => {
    const { dir, workspace } = await described();
    const { unit } = await workspace.unit("AccountService.transferFunds");
    const ifStep = unit.steps.find((s) => s.kind === "if")!;
    const ranges = await workspace.sourceRanges(unit.id, ifStep.id);
    expect(ranges.fresh).toBe(true);
    expect(ranges.ranges).toHaveLength(ifStep.covers.length);

    const text = (await readFile(join(dir, SERVICE), "utf8")).split(/\r?\n/);
    const start = ranges.ranges[0]!.start;
    expect(text[start.line - 1]!.slice(start.col - 1)).toMatch(/^if \(/);

    // A position inside the if's condition belongs to the if step; one inside its body to the nested step.
    expect(await workspace.stepAt(SERVICE, { line: start.line, col: start.col + 2 })).toEqual({ unitId: unit.id, ref: `${SERVICE}#AccountService.transferFunds`, stepId: ifStep.id, fresh: true });
    const signatureLine = text.findIndex((l) => l.includes("async transferFunds(")) + 1;
    expect(await workspace.stepAt(SERVICE, { line: signatureLine, col: 5 })).toMatchObject({ unitId: unit.id, fresh: true });
    expect((await workspace.stepAt(SERVICE, { line: signatureLine, col: 5 }))?.stepId).toBeUndefined();
    expect(await workspace.stepAt(SERVICE, { line: 1, col: 1 })).toBeNull();
  }, 90_000);

  it("resolves a step's calls to navigation targets: both implementations, and libraries with effects", async () => {
    const { workspace } = await described();
    const { unit } = await workspace.unit("AccountService.transferFunds");
    const save = unit.steps.find((s) => s.covers.includes("5"))!; // repo.save(from): an interface call
    const targets = await workspace.stepTargets(unit.id, save.id);
    expect(targets.map((t) => (t.kind === "unit" ? t.symbol : t.ref)).sort()).toEqual(["InMemoryAccountRepository.save", "PrismaAccountRepository.save"]);
    expect(targets[0]).toMatchObject({ kind: "unit", summary: expect.stringContaining("Does what") });

    const prisma = await workspace.unit("PrismaAccountRepository.save");
    const update = prisma.unit.steps.find((s) => s.calls.some((c) => c.startsWith("ext:")))!;
    const [library] = await workspace.stepTargets(prisma.unit.id, update.id);
    expect(library).toMatchObject({ kind: "external", module: "@prisma/client", effects: ["db.write"] });
  }, 90_000);

  it("follows a route's flow only through its own inline callback", async () => {
    const { workspace } = await described();
    const [transfers] = await workspace.flow("POST /transfers");
    expect(transfers!.handlers).toEqual([{ id: "src/http/routes.ts#createRouter", handlerKey: expect.stringMatching(/cb/) }]);
    const reached = transfers!.hits.map((h) => h.id);
    expect(reached).toContain("src/auth/auth-service.ts#AuthService.authenticate");
    expect(reached).toContain(`${SERVICE}#AccountService.transferFunds`);
    expect(reached).toContain("src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save");
    expect(reached).not.toContain("src/http/routes.ts#getBalanceHandler");
    expect(transfers!.effects["src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save"]).toEqual(["db.write"]);

    const [balance] = await workspace.flow("/accounts/:id/balance");
    expect(balance!.hits.map((h) => h.id)).toContain("src/http/routes.ts#getBalanceHandler");
    expect(balance!.hits.map((h) => h.id)).not.toContain(`${SERVICE}#AccountService.transferFunds`);

    await expect(workspace.flow("DELETE /nothing")).rejects.toThrow(/No route matches/);
  }, 90_000);

  it("verifies only descriptions that match the code", async () => {
    const { dir, workspace } = await described();
    const result = await workspace.verify(["AccountService.deposit"]);
    expect(result).toMatchObject({ verified: [`${SERVICE}#AccountService.deposit`], refused: [], written: [`.sift/${SERVICE}.sift`] });
    expect((await workspace.unit("AccountService.deposit")).unit.status).toBe("verified");

    const path = join(dir, SERVICE);
    await writeFile(path, (await readFile(path, "utf8")).replace("amountCents <= 0", "amountCents < 1"));
    const refused = await workspace.verify([SERVICE]);
    expect(refused.refused).toContainEqual({ unit: `${SERVICE}#AccountService.deposit`, reason: expect.stringContaining("code changed") });
    expect(refused.verified).toContain(`${SERVICE}#AccountService.transferFunds`);
  }, 90_000);

  it("migrates v0 files to the current schema without changing unit text", async () => {
    const { dir, workspace } = await described();
    const file = (await readSiftFile(dir, SERVICE))!.file;
    file.sift = 0;
    await writeSiftFile(dir, file);
    const before = await readFile(join(dir, ".sift", `${SERVICE}.sift`), "utf8");
    expect(before.startsWith("sift: 0\n")).toBe(true);

    const result = await workspace.migrate();
    expect(result.upgraded).toEqual([`.sift/${SERVICE}.sift`]);
    const after = await readFile(join(dir, ".sift", `${SERVICE}.sift`), "utf8");
    expect(after).toBe(before.replace("sift: 0\n", "sift: 1\n"));
    expect((await workspace.migrate()).upgraded).toEqual([]);
  }, 90_000);

  it("runs queries one at a time and reports a bad symbol clearly", async () => {
    const { workspace } = await described();
    const [a, b, c] = await Promise.all([workspace.callers("transferFunds"), workspace.callees("transferFunds"), workspace.status()]);
    expect(a.callers.map((h) => h.id)).toContain("src/http/routes.ts#createRouter");
    expect(b.effects).toContain("db.write");
    expect(c.inSync).toBe(true);
    await expect(workspace.callers("noSuchThing")).rejects.toBeInstanceOf(SiftError);
  }, 90_000);
});

describe("CLI on the workspace", () => {
  it("verify, flow, and migrate work from the command line", async () => {
    const { dir, provider } = await described();
    const verify = await sift(provider, "-C", dir, "verify", "AccountService.deposit");
    expect(verify.out).toContain(`✓ ${SERVICE}#AccountService.deposit`);
    expect((await sift(provider, "-C", dir, "show", `${SERVICE}#AccountService.deposit`)).out).toContain("· verified");

    const flow = await sift(provider, "-C", dir, "flow", "POST /transfers");
    expect(flow.code).toBe(0);
    expect(flow.out).toContain("Flow of POST /transfers");
    expect(flow.out).toMatch(/PrismaAccountRepository\.save .*\[db\.write\]/);

    const migrate = await sift(provider, "-C", dir, "migrate");
    expect(migrate.out).toContain("already at the current schema version");
  }, 90_000);
});
