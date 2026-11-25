import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeProvider } from "@sift/core";
import { cap, createMcpServer, type UnitView } from "@sift/mcp";
import { openWorkspace } from "./program.js";
import { answer, fixtureCopy, sift } from "./test-helpers.js";

const SERVICE = "src/accounts/account-service.ts";
const TRANSFER = `${SERVICE}#AccountService.transferFunds`;

async function connect(dir: string, options: { allowGenerate?: boolean; provider?: FakeProvider } = {}) {
  const workspace = await openWorkspace(dir, options.provider ? { provider: options.provider } : {}, { withProvider: options.provider !== undefined });
  const server = createMcpServer({ workspace, version: "test", ...(options.allowGenerate ? { allowGenerate: true } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { error: r.isError === true, text, data: r.structuredContent as Record<string, unknown> };
  };
  return { client, call, close: () => client.close() };
}

describe("sift mcp", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fixtureCopy();
    expect((await sift(new FakeProvider((req) => answer(req)), "-C", dir, "generate")).code).toBe(0);
  }, 120_000);

  it("offers the read-only tools, and sift_generate only when allowed", async () => {
    const plain = await connect(dir);
    const names = (await plain.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["sift_callees", "sift_callers", "sift_describe", "sift_find", "sift_flow", "sift_impact", "sift_status"]);
    for (const t of (await plain.client.listTools()).tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(plain.client.getInstructions()).toMatch(/Stale:/);
    await plain.close();

    const provider = new FakeProvider((req) => answer(req));
    const generating = await connect(dir, { allowGenerate: true, provider });
    expect((await generating.client.listTools()).tools.map((t) => t.name)).toContain("sift_generate");
    const dry = await generating.call("sift_generate", { paths: [SERVICE], dryRun: true, force: true });
    expect(dry.error).toBe(false);
    expect(dry.text).toMatch(/^Would run \d+ AI task/);
    expect(provider.requests).toHaveLength(0);
    await generating.close();
  }, 90_000);

  it("describes units and files, finds them, and reports errors as tool errors", async () => {
    const { call, close } = await connect(dir);

    const unit = await call("sift_describe", { target: "AccountService.transferFunds" });
    expect(unit.error).toBe(false);
    const view = (unit.data.units as UnitView[])[0]!;
    expect(view).toMatchObject({ ref: TRANSFER, status: "generated", freshness: "fresh" });
    expect(view.stale).toBeUndefined();
    expect(view.warnings.map((w) => w.kind)).toEqual(["missing-transaction"]);
    expect(view.steps.flatMap((s) => s.calls).some((c) => c.includes("#") && !c.startsWith("u_"))).toBe(true);
    expect(unit.text).toMatch(/^src\/accounts\/account-service\.ts#AccountService\.transferFunds · method · generated, not verified/);
    expect(unit.text).toMatch(/Warnings\n {4}! missing-transaction \(step 6, 7\): The two saves/);

    // The same unit by file#Symbol and by ID; a whole file by path.
    expect((await call("sift_describe", { target: TRANSFER })).data.units).toEqual([view]);
    expect((await call("sift_describe", { target: view.id })).data.units).toEqual([view]);
    const file = await call("sift_describe", { target: SERVICE });
    expect((file.data.units as UnitView[]).map((u) => u.ref)).toContain(TRANSFER);

    const found = await call("sift_find", { query: "transfer" });
    expect(found.data.matches).toContainEqual(expect.objectContaining({ ref: TRANSFER, kind: "method", status: "generated", summary: view.summary }));

    const missing = await call("sift_describe", { target: "noSuchThing" });
    expect(missing.error).toBe(true);
    expect(missing.text).toMatch(/No unit or symbol named "noSuchThing"/);
    expect((await call("sift_callers", { symbol: "noSuchThing" })).error).toBe(true);
    await close();
  }, 90_000);

  it("answers graph questions: callers, callees, impact, flow", async () => {
    const { call, close } = await connect(dir);

    const callers = await call("sift_callers", { symbol: "transferFunds" });
    expect(callers.data.subject).toBe(TRANSFER);
    expect(callers.text).toMatch(/^Callers of /);
    expect((callers.data.callers as { ref: string }[]).length).toBeGreaterThan(0);

    const callees = await call("sift_callees", { symbol: "transferFunds" });
    expect(callees.data.effects).toEqual(expect.arrayContaining(["db.write"]));

    const impact = await call("sift_impact", { symbols: ["transferFunds"] });
    expect(impact.data.routes).toContainEqual(expect.objectContaining({ route: "POST /transfers" }));
    expect(impact.text).toMatch(/Routes\n {2}POST \/transfers/);
    expect((await call("sift_impact", {})).error).toBe(true);

    const routes = await call("sift_flow");
    expect(routes.data.routes).toEqual(["GET /accounts/:id/balance", "POST /transfers"]);
    for (const route of routes.data.routes as string[]) {
      const flow = await call("sift_flow", { route });
      const reaches = (flow.data.flows as { reaches: { kind: string; effects: string[] }[] }[])[0]!.reaches;
      // Every route reaches the database through Prisma, with the effects at that step.
      expect(reaches.some((h) => h.kind === "external" && h.effects.some((e) => e.startsWith("db.")))).toBe(true);
    }
    await close();
  }, 90_000);

  it("never returns a stale description unmarked", async () => {
    const { call, close } = await connect(dir);
    const path = join(dir, SERVICE);
    const before = await readFile(path, "utf8");
    await writeFile(path, before.replace("to.balanceCents += amountCents;", "to.balanceCents = to.balanceCents + amountCents;"));
    try {
      const unit = await call("sift_describe", { target: TRANSFER });
      const view = (unit.data.units as UnitView[])[0]!;
      expect(view.freshness).toBe("code-changed");
      expect(view.stale).toBe("Stale: the code changed after this was written.");
      expect(view.summary.startsWith("Stale: ")).toBe(true);
      expect(unit.text).toMatch(/\n {2}Stale: the code changed after this was written\. /);

      const found = await call("sift_find", { query: "AccountService.transferFunds" });
      expect(found.data.matches).toEqual([expect.objectContaining({ ref: TRANSFER, stale: view.stale, summary: view.summary })]);

      const resource = await (async () => {
        const c = await connect(dir);
        const r = await c.client.readResource({ uri: `sift://file/${SERVICE}` });
        await c.close();
        return r.contents[0] as { text: string };
      })();
      expect(resource.text).toContain("Stale: the code changed after this was written.");

      const status = await call("sift_status");
      expect(status.data.inSync).toBe(false);
      expect(status.data.changed).toContain(TRANSFER);
    } finally {
      await writeFile(path, before);
    }
    await close();
  }, 90_000);

  it("lists described files as resources", async () => {
    const { client, close } = await connect(dir);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(`sift://file/${SERVICE}`);
    const read = await client.readResource({ uri: `sift://file/${SERVICE}` });
    expect((read.contents[0] as { text: string }).text).toMatch(/^src\/accounts\/account-service\.ts · \d+ described units/);
    await close();
  }, 90_000);

  it("bounds lists and says what it left out", () => {
    const truncated: Record<string, number> = {};
    expect(cap([...Array(60).keys()], "units", truncated)).toHaveLength(50);
    expect(truncated).toEqual({ units: 10 });
  });

  it("runs as a process: sift mcp on stdio", async () => {
    const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const transport = new StdioClientTransport({ command: process.execPath, args: [main, "mcp", "--root", dir], stderr: "pipe" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "sift" });
      const r = (await client.callTool({ name: "sift_status", arguments: {} })) as CallToolResult;
      expect(r.isError).not.toBe(true);
      expect((r.structuredContent as { counts: { units: number } }).counts.units).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 90_000);
});
