import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryHit } from "@sift/core";
import { buildModel, describeNode, flowModel, impactModel, neighbourhoodModel } from "./graph-model.js";
import { ServerProcess } from "./server-process.js";
import { fixtureCopy, inProcessServer } from "./test-support.js";
import type { GraphModel } from "./webview/graph-protocol.js";

const SERVICE = "src/accounts/account-service.ts";
const TRANSFER = `${SERVICE}#AccountService.transferFunds`;
const SAVE_MEMBER = "src/accounts/account-repository.ts#AccountRepository.save";
const PRISMA_SAVE = "src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save";
const MEMORY_SAVE = "src/accounts/in-memory-account-repository.ts#InMemoryAccountRepository.save";

const node = (m: GraphModel, id: string) => m.nodes.find((n) => n.id === id);
const edge = (m: GraphModel, from: string, to: string) => m.edges.find((e) => e.from === from && e.to === to);
const site = { range: { start: { line: 3, col: 5 }, end: { line: 3, col: 20 } } };
const hit = (id: string, via: Partial<QueryHit["via"]> = {}, parent = "src/a.ts#a"): QueryHit => ({
  id,
  parent,
  depth: 1,
  via: { kind: "calls", confidence: "resolved", file: "src/a.ts", sites: [{ stepKey: "0", ...site }], ...via },
});

describe("graph models", () => {
  it("reads node IDs: units, library calls, routes, events, module scope", () => {
    expect(describeNode("src/a.ts#Foo.bar")).toEqual({ kind: "unit", label: "Foo.bar", detail: "src/a.ts" });
    expect(describeNode("ext:@prisma/client#Prisma.AccountDelegate.update")).toEqual({ kind: "external", label: "Prisma.AccountDelegate.update", detail: "@prisma/client" });
    expect(describeNode("route:POST /transfers")).toEqual({ kind: "route", label: "POST /transfers", detail: "route" });
    expect(describeNode("event:transfer.completed")).toEqual({ kind: "event", label: "transfer.completed", detail: "event" });
    expect(describeNode("src/a.ts#<module>").label).toBe("(module scope)");
  });

  it("neighbourhood: events in between, routes, weak edges dashed, gaps as nodes", () => {
    const subject = "src/a.ts#a";
    const m = neighbourhoodModel(
      {
        subject,
        callers: [
          hit("src/b.ts#emitter", { kind: "emits", confidence: "rule", event: "event:done" }, subject),
          hit("route:GET /a", { kind: "handles-route", confidence: "rule" }, subject),
          hit("src/c.ts#guess", { confidence: "name-match" }, subject),
        ],
        possibleCallers: [{ kind: "unresolved-call", unit: "src/d.ts#d", expression: "x.a()", file: "src/d.ts", site }],
      },
      { subject, effects: ["db.write"], callees: [hit("ext:fs#writeFile", { effects: ["fs.write"] }, subject)], unresolved: [] },
    );
    expect(node(m, subject)).toMatchObject({ role: "subject", effects: ["db.write"] });
    expect(edge(m, "src/b.ts#emitter", "event:done")).toMatchObject({ kind: "emits", weak: true });
    expect(edge(m, "event:done", subject)).toMatchObject({ kind: "listens" });
    expect(edge(m, "route:GET /a", subject)).toMatchObject({ kind: "handles-route", weak: true });
    expect(node(m, "route:GET /a")?.site).toEqual({ file: "src/a.ts", range: site.range });
    expect(edge(m, "src/c.ts#guess", subject)).toMatchObject({ weak: true, confidence: "name-match" });
    expect(node(m, "ext:fs#writeFile")).toMatchObject({ kind: "external", effects: ["fs.write"] });
    expect(edge(m, subject, "ext:fs#writeFile")?.weak).toBe(false);
    expect(node(m, "gaps:callers")).toMatchObject({ kind: "gaps", label: "1 possible caller", gaps: [{ label: "x.a()", file: "src/d.ts" }] });
    expect(edge(m, "gaps:callers", subject)?.weak).toBe(true);
    expect(m.subtitle).toContain("3 callers, 1 callee");
  });

  it("the same pair reached twice keeps the stronger edge", () => {
    const subject = "src/a.ts#a";
    const m = neighbourhoodModel(
      { subject, callers: [], possibleCallers: [] },
      { subject, effects: [], callees: [hit("src/b.ts#b", { confidence: "name-match" }, subject), hit("src/b.ts#b", {}, subject)], unresolved: [] },
    );
    expect(m.edges.filter((e) => e.to === "src/b.ts#b")).toHaveLength(1);
    expect(edge(m, subject, "src/b.ts#b")?.weak).toBe(false);
  });

  it("impact: changed at the bottom, members between, routes on top; dashed where the path weakens", () => {
    const changed = "src/a.ts#a";
    const m = impactModel(
      {
        subjects: [changed],
        notes: ["src/x.ts: changes are outside any unit (imports, types, or comments)"],
        units: [
          { id: "src/b.ts#b", depth: 1, confidence: "resolved", path: [changed, "src/b.ts#b"], via: { kind: "calls", dispatch: "src/i.ts#I.a" } },
          { id: "src/c.ts#c", depth: 2, confidence: "name-match", path: [changed, "src/b.ts#b", "src/c.ts#c"], via: { kind: "calls" } },
        ],
        routes: [{ id: "route:GET /c", handler: "src/c.ts#c", confidence: "name-match", path: [changed, "src/b.ts#b", "src/c.ts#c", "route:GET /c"] }],
        tests: [],
        gaps: [],
      },
      "changing a",
    );
    expect(node(m, changed)?.role).toBe("changed");
    expect(node(m, "src/i.ts#I.a")?.kind).toBe("declaration");
    expect(edge(m, "src/b.ts#b", "src/i.ts#I.a")?.weak).toBe(false);
    expect(edge(m, "src/i.ts#I.a", changed)?.kind).toBe("implements");
    expect(edge(m, "src/c.ts#c", "src/b.ts#b")?.weak).toBe(true);
    expect(node(m, "src/c.ts#c")).toMatchObject({ depth: 2, confidence: "name-match" });
    expect(node(m, "src/b.ts#b")?.note).toBe("through I.a");
    expect(edge(m, "route:GET /c", "src/c.ts#c")?.kind).toBe("handles-route");
    expect(m.notes).toHaveLength(1);
    expect(m.empty).toBeUndefined();

    const none = impactModel({ subjects: [], notes: [], units: [], routes: [], tests: [], gaps: [] }, "uncommitted changes");
    expect(none.empty).toContain("No changed units");
  });
});

describe("graph models on the fixture", () => {
  let dir: string;
  let server: ServerProcess;
  beforeAll(async () => {
    dir = await fixtureCopy();
    server = new ServerProcess({ root: dir, launch: inProcessServer(dir).launch, log: () => {} });
  });
  afterAll(() => server.stop());

  it("neighbourhood of transferFunds: the route handler above, both repository implementations below through the interface", async () => {
    const m = await buildModel(server, { view: "neighbourhood", ref: "AccountService.transferFunds" });
    expect(m.title).toBe("AccountService.transferFunds");
    expect(node(m, TRANSFER)?.role).toBe("subject");
    expect(edge(m, "src/http/routes.ts#createRouter", TRANSFER)?.kind).toBe("calls");
    expect(node(m, SAVE_MEMBER)?.kind).toBe("declaration");
    expect(edge(m, TRANSFER, SAVE_MEMBER)?.kind).toBe("calls");
    expect(edge(m, SAVE_MEMBER, PRISMA_SAVE)?.kind).toBe("implements");
    expect(edge(m, SAVE_MEMBER, MEMORY_SAVE)?.kind).toBe("implements");
    // The listener is reached through the event, by a rule: drawn dashed.
    expect(node(m, "event:transfer.completed")?.kind).toBe("event");
    expect(edge(m, "event:transfer.completed", "src/notifications/notifier.ts#onTransferCompleted")?.weak).toBe(true);
    // A class called as a constructor is not a unit: it opens code, not logic.
    for (const n of m.nodes.filter((n) => n.id.endsWith("#NotFoundError") || n.id.endsWith("Error"))) expect(n.kind).toBe("declaration");
  });

  it("flow from each Express route reaches the Prisma calls with their effects (phase-2-design §11)", async () => {
    const routes = await server.request("sift/routes", {});
    expect(routes).toEqual(["route:GET /accounts/:id/balance", "route:POST /transfers"]);
    for (const route of routes) {
      const m = await buildModel(server, { view: "flow", route });
      expect(node(m, route)?.role).toBe("subject");
      const handler = m.nodes.find((n) => n.role === "handler")!;
      expect(handler).toMatchObject({ id: "src/http/routes.ts#createRouter", note: "inline callback" });
      expect(edge(m, route, handler.id)).toMatchObject({ kind: "handles-route", weak: true });
      const prisma = m.nodes.filter((n) => n.kind === "external" && n.detail === "@prisma/client");
      expect(prisma.length).toBeGreaterThan(0);
      expect(prisma.every((n) => n.effects.some((e) => e.startsWith("db.")))).toBe(true);
      // Every node is connected, and the Prisma calls hang off the Prisma repository.
      for (const n of m.nodes) if (n.id !== route) expect(m.edges.some((e) => e.to === n.id)).toBe(true);
      expect(prisma.every((p) => m.edges.some((e) => e.to === p.id && e.from.startsWith("src/accounts/prisma-account-repository.ts#")))).toBe(true);
    }
    const transfer = await buildModel(server, { view: "flow", route: "route:POST /transfers" });
    expect(node(transfer, PRISMA_SAVE)?.effects).toContain("db.write");
    expect(node(transfer, "ext:fs/promises#appendFile")?.effects).toContain("fs.write");
  });

  it("impact of the uncommitted changes: the changed unit, its callers through the interface, and POST /transfers", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=sift", "-c", "user.email=sift@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    await writeFile(join(dir, ".gitignore"), "node_modules\n.sift/.cache/\n");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    const clean = await buildModel(server, { view: "impact", refs: [], diff: "HEAD", what: "uncommitted changes" });
    expect(clean.empty).toBeDefined();

    const repo = join(dir, "src/accounts/prisma-account-repository.ts");
    await writeFile(repo, (await readFile(repo, "utf8")).replace("balanceCents: account.balanceCents", "balanceCents: Math.max(0, account.balanceCents)"));
    const m = await buildModel(server, { view: "impact", refs: [], diff: "HEAD", what: "uncommitted changes" });
    expect(m.nodes.filter((n) => n.role === "changed").map((n) => n.id)).toEqual([PRISMA_SAVE]);
    expect(node(m, TRANSFER)).toMatchObject({ depth: 1, note: "through AccountRepository.save" });
    expect(edge(m, SAVE_MEMBER, PRISMA_SAVE)?.kind).toBe("implements");
    expect(node(m, "route:POST /transfers")).toBeDefined();
    // The route is reached by a rule-pack edge: dashed.
    expect(edge(m, "route:POST /transfers", "src/http/routes.ts#createRouter")?.weak).toBe(true);
  });
});
