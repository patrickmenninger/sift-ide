import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeProvider, SiftError, type CompletionRequest, type WorkspaceChange } from "@sift/core";
import { CancellationTokenSource } from "vscode-jsonrpc/node";
import { serve, SiftClient, type Notifications } from "@sift/server";
import { openWorkspace } from "./program.js";
import { answer, fixtureCopy, sift } from "./test-helpers.js";

const SERVICE = "src/accounts/account-service.ts";

/** A server and a client joined by in-memory pipes. */
async function connected(dir: string, provider: FakeProvider) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = serve({ workspace: await openWorkspace(dir, { provider }), input: toServer, output: toClient, serverVersion: "test" });
  const client = new SiftClient(toClient, toServer);
  return { client, server };
}

describe("sift serve protocol", () => {
  it("answers workspace requests, streams generate progress, and reports changes", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => answer(req));
    const { client, server } = await connected(dir, provider);

    // Nothing works before initialize; a version mismatch is refused.
    await expect(client.request("sift/routes", {})).rejects.toThrow(/sift\/initialize/);
    await expect(client.request("sift/initialize", { protocolVersion: 999 })).rejects.toThrow(/protocol 1/);
    const init = await client.initialize();
    expect(init).toMatchObject({ protocolVersion: 1, serverVersion: "test" });

    const progress: Notifications["sift/generateProgress"][] = [];
    const changes: WorkspaceChange[] = [];
    client.on("sift/generateProgress", (p) => progress.push(p));
    client.on("sift/didChange", (c) => changes.push(c));

    const report = await client.request("sift/generate", { paths: [SERVICE], token: "t1" });
    expect(report.failed).toEqual([]);
    expect(progress.some((p) => p.token === "t1" && p.event.type === "described")).toBe(true);

    const logic = await client.request("sift/logicFile", { source: SERVICE });
    const transfer = logic.units.find((u) => u.unit.symbol === "AccountService.transferFunds")!;
    expect(transfer.freshness).toBe("fresh");
    const step = transfer.unit.steps[0]!;
    const ranges = await client.request("sift/sourceRanges", { unit: transfer.unit.id, step: step.id });
    expect(ranges.fresh).toBe(true);
    expect(await client.request("sift/stepAt", { source: SERVICE, position: ranges.ranges[0]!.start })).toMatchObject({ unitId: transfer.unit.id, stepId: step.id });
    expect(await client.request("sift/routes", {})).toEqual(["route:GET /accounts/:id/balance", "route:POST /transfers"]);

    // Errors arrive as SiftError with their code.
    const error = await client.request("sift/callers", { query: "noSuchThing" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiftError);
    expect((error as SiftError).code).toBe("SOURCE_NOT_FOUND");

    // A source edit shows up as a change once something refreshes.
    const path = join(dir, SERVICE);
    await writeFile(path, (await readFile(path, "utf8")).replace("amountCents <= 0", "amountCents < 1"));
    await client.request("sift/refresh", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(changes).toContainEqual({ type: "descriptions", files: expect.arrayContaining([`.sift/${SERVICE}.sift`]) });
    // Its dependants are rebuilt too: their calls may resolve differently now (design §10.2).
    expect(changes).toContainEqual({ type: "source", files: expect.arrayContaining([SERVICE, "src/http/routes.ts"]) });

    client.dispose();
    server.connection.dispose();
  }, 90_000);

  it("cancels a running generate: finished units are written, the report says cancelled", async () => {
    const dir = await fixtureCopy();
    // The first AI call answers; every later one waits until it is cancelled.
    const fake = new FakeProvider((req) => answer(req));
    let calls = 0;
    const provider = Object.assign(Object.create(fake) as FakeProvider, {
      complete: (req: CompletionRequest) =>
        ++calls === 1
          ? fake.complete(req)
          : new Promise<never>((_, reject) => req.signal?.addEventListener("abort", () => reject(new SiftError("PROVIDER_FAILED", "Cancelled.")))),
    });
    const { client, server } = await connected(dir, provider);
    await client.initialize();
    const source = new CancellationTokenSource();
    client.on("sift/generateProgress", (p) => {
      if (p.event.type === "described") source.cancel();
    });
    const report = await client.request("sift/generate", { token: "t" }, source.token);
    expect(report.cancelled).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.described.length).toBeGreaterThan(0);
    expect(report.described.length).toBeLessThan(report.planned.length);
    expect(report.written.length).toBeGreaterThan(0);
    // The workspace is free again afterwards.
    expect((await client.request("sift/status", {})).new.length).toBeGreaterThan(0);
    client.dispose();
    server.connection.dispose();
  }, 90_000);

  it("proposes, applies, and undoes an edit, with progress and edit notifications", async () => {
    const dir = await fixtureCopy();
    const withdraw = `${SERVICE}#AccountService.withdraw`;
    const provider = new FakeProvider((req) => {
      if (req.task === "edit-plan") return { kind: "behavior", interpretation: "Reject non-positive amounts.", questions: [], warnings: [], allowedUnits: [{ unit: withdraw, reason: "edited" }], helpers: [], examples: [], broader: null };
      if (req.task === "edit-code") {
        const code = `async withdraw(userId: string, accountId: string, amountCents: number): Promise<Account> {\n  if (amountCents <= 0) throw new ValidationError("Amount must be positive");\n  const account = await this.repo.getAccount(accountId);\n  if (account.ownerId !== userId) {\n    throw new ForbiddenError("You can only withdraw from your own accounts");\n  }\n  account.balanceCents -= amountCents;\n  await this.repo.save(account);\n  return account;\n}`;
        return { units: [{ unit: withdraw, text: code }], insertions: [], notes: "" };
      }
      if (req.task === "edit-verify") return { satisfied: true, gaps: [], unrequested: [] };
      return answer(req);
    });
    const { client, server } = await connected(dir, provider);
    await client.initialize();
    await client.request("sift/generate", { paths: [SERVICE] });
    const original = await readFile(join(dir, SERVICE), "utf8");

    const progress: Notifications["sift/editProgress"][] = [];
    const changes: WorkspaceChange[] = [];
    client.on("sift/editProgress", (p) => progress.push(p));
    client.on("sift/didChange", (c) => changes.push(c));

    const draft = await client.request("sift/edit/create", { unit: "AccountService.withdraw", request: "Reject amounts of zero or less" });
    expect(draft.state).toBe("draft");
    const ready = await client.request("sift/edit/propose", { id: draft.id, token: "e1" });
    expect(ready.state).toBe("ready");
    expect(progress.map((p) => (p.event.type === "stage" ? p.event.stage : p.event.state))).toEqual(["planning", "coding", "validating", "describing", "verifying", "ready"]);
    expect(changes).toContainEqual({ type: "edits", ids: [draft.id] });
    expect((await client.request("sift/edit/list", { states: ["ready"] })).map((r) => r.id)).toEqual([draft.id]);

    // The editor writes the source itself (its own undo stack); Sift checks it and writes the description.
    const proposed = ready.proposal!.files[0]!.text;
    await expect(client.request("sift/edit/apply", { id: draft.id, sourceWritten: true })).rejects.toThrow("does not hold the proposed change");
    await writeFile(join(dir, SERVICE), proposed);
    // What the editor replaced must be the text the change was proposed for.
    await expect(client.request("sift/edit/apply", { id: draft.id, sourceWritten: true, sourceBefore: { [SERVICE]: `${original}// edited
` } })).rejects.toThrow("is not the text the change was proposed for");
    const applied = await client.request("sift/edit/apply", { id: draft.id, sourceWritten: true, sourceBefore: { [SERVICE]: original } });
    expect(applied.written).toEqual([`.sift/${SERVICE}.sift`]);
    expect(changes).toContainEqual({ type: "descriptions", files: [`.sift/${SERVICE}.sift`] });
    const logic = await client.request("sift/logicFile", { source: SERVICE });
    expect(logic.units.find((u) => u.unit.symbol === "AccountService.withdraw")!.freshness).toBe("fresh");

    // Undo restores the description and, since the editor said what it replaced, the source.
    const undone = await client.request("sift/edit/undo", { id: draft.id });
    expect(undone.restored).toEqual([SERVICE, `.sift/${SERVICE}.sift`]);
    expect(await readFile(join(dir, SERVICE), "utf8")).toBe(original);

    // A check for pending edits that read a request before it was rejected must not write it back
    // as needs-review (the editor lists requests often, so the two overlap).
    const getBalance = await client.request("sift/edit/create", { unit: "AccountService.getBalance", request: "Return the balance in whole units" });
    await writeFile(join(dir, SERVICE), original.replace("return account.balanceCents;", "return account.balanceCents + 0;"));
    const [, rejected] = await Promise.all([client.request("sift/edit/list", {}), client.request("sift/edit/reject", { id: getBalance.id })]);
    expect(rejected.state).toBe("rejected");
    await client.request("sift/edit/list", {});
    expect((await client.request("sift/edit/get", { id: getBalance.id })).state).toBe("rejected");
    await writeFile(join(dir, SERVICE), original);
    expect((await client.request("sift/status", { paths: [SERVICE] })).inSync).toBe(true);
    client.dispose();
    server.connection.dispose();
  }, 90_000);

  it("runs as a process: sift serve on stdio", async () => {
    const dir = await fixtureCopy();
    expect((await sift(new FakeProvider((req) => answer(req)), "-C", dir, "status")).code).toBe(0);
    const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const child = spawn(process.execPath, [main, "-C", dir, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
    const client = new SiftClient(child.stdout, child.stdin);
    try {
      expect((await client.initialize()).root.replace(/\\/g, "/")).toBe(dir.replace(/\\/g, "/"));
      const status = await client.request("sift/status", {});
      expect(status.new.length).toBeGreaterThan(0);
    } finally {
      client.dispose();
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    }
  }, 90_000);
});
