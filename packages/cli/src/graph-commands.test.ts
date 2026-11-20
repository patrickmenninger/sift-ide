import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadProject, loadRulePacks, refreshGraph, RuleSet, SiftCache } from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { EXIT, run } from "./program.js";

const FIXTURE = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));
const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const BUILTIN = join(dirname(createRequire(import.meta.url).resolve("@sift/rules/package.json")), "packs");

/** A private copy of the fixture, so tests can edit files and keep their own cache. */
async function fixtureCopy(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "sift-graph-")), "bank-app");
  await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(".cache") });
  // The fixture's tsconfig uses @types/node from the repository.
  await symlink(NODE_MODULES, join(dir, "node_modules"), "junction");
  return dir;
}

async function sift(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function refresh(root: string) {
  const project = await loadProject(root);
  const rules = new RuleSet((await loadRulePacks(root, { builtinDir: BUILTIN })).packs);
  return refreshGraph({ root, config: project.config, adapters: [typescriptAdapter], rules });
}

let root: string;
beforeAll(async () => {
  root = await fixtureCopy();
}, 30_000);

describe("graph over the bank-app fixture", () => {
  it("gives units their direct effects from the rule packs", async () => {
    const { graph } = await refresh(root);
    const effects = (id: string) => graph.unit(id)?.effects;
    expect(effects("src/accounts/prisma-account-repository.ts#PrismaAccountRepository.getAccount")).toEqual(["db.read", "throws"]);
    expect(effects("src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save")).toEqual(["db.write"]);
    expect(effects("src/auth/auth-service.ts#AuthService.authenticate")).toContain("net.request");
    expect(effects("src/notifications/notifier.ts#onTransferCompleted")).toEqual(["fs.write"]);
    expect(effects("src/accounts/account-service.ts#AccountService.transferFunds")).toEqual(["event.emit", "throws"]);
    expect(effects("src/app.ts#<module>")).toEqual(["log"]);
    expect(graph.effectsOf("src/accounts/account-service.ts#AccountService.transferFunds", { propagated: true })).toEqual([
      "db.read", "db.write", "event.emit", "throws",
    ]);
    expect(graph.unit("src/accounts/money.ts#formatCents")?.lite).toBe(true);
    expect(graph.unmatchedEvents()).toEqual({ emittedOnly: [], listenedOnly: [] });
  });

  it("sift callers shows dispatch, routes, and events", async () => {
    const r = await sift("-C", root, "callers", "PrismaAccountRepository.save", "-d", "3");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("  AccountService.transferFunds  src/accounts/account-service.ts:20,21 · calls via AccountRepository.save · resolved");
    expect(r.out).toContain("    createRouter  src/http/routes.ts:26 · calls · resolved");
    expect(r.out).toContain("      route POST /transfers  src/http/routes.ts:22 · handles-route · rule");
    expect(r.out).not.toContain("GET /accounts");

    const listener = await sift("-C", root, "callers", "onTransferCompleted");
    expect(listener.out).toContain("AccountService.transferFunds  src/accounts/account-service.ts:23 · emits via event transfer.completed · rule");
  });

  it("sift callees shows implementations, library calls, and effects", async () => {
    const r = await sift("-C", root, "callees", "src/accounts/account-service.ts#AccountService.transferFunds");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("  Effects: db.read, db.write, event.emit, throws");
    expect(r.out).toContain("PrismaAccountRepository.save  src/accounts/prisma-account-repository.ts · line 20,21 · calls via AccountRepository.save · resolved  [db.write]");
    expect(r.out).toContain("onTransferCompleted  src/notifications/notifier.ts · line 23 · emits via event transfer.completed · rule  [fs.write]");

    const bus = await sift("-C", root, "callees", "EventBus.emit");
    expect(bus.out).toContain("unresolved-call: handler(payload)  src/events/event-bus.ts:15");
  });

  it("sift impact lists routes and units upstream", async () => {
    const r = await sift("-C", root, "impact", "PrismaAccountRepository.save");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("    POST /transfers  · handled in createRouter · rule");
    expect(r.out).not.toContain("GET /accounts");
    for (const name of ["AccountService.deposit", "AccountService.transferFunds", "AccountService.withdraw", "createRouter", "<module>"]) {
      expect(r.out).toContain(`    ${name}  `);
    }
    const json = JSON.parse((await sift("-C", root, "impact", "--json", "getBalanceHandler")).out) as { routes: { id: string }[] };
    expect(json.routes.map((x) => x.id)).toEqual(["route:GET /accounts/:id/balance"]);
  });

  it("explains ambiguous and unknown symbols", async () => {
    const ambiguous = await sift("-C", root, "callers", "save");
    expect(ambiguous.code).toBe(EXIT.error);
    expect(ambiguous.err).toContain('"save" matches 3 symbols');
    expect(ambiguous.err).toContain("src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save");

    const unknown = await sift("-C", root, "callees", "transferFund");
    expect(unknown.err).toContain('No unit or symbol named "transferFund"');
  });
});

describe("incremental refresh", () => {
  it("does nothing when nothing changed, and matches a full rebuild after an edit", async () => {
    const dir = await fixtureCopy();
    await refresh(dir);
    const quiet = await refresh(dir);
    expect(quiet.rebuilt).toEqual([]);
    expect(quiet.hashed).toEqual([]);

    // Rename a method: routes.ts and app.ts are unchanged but call into the edited file, so they are rebuilt too.
    const service = join(dir, "src/accounts/account-service.ts");
    await writeFile(service, (await readFile(service, "utf8")).replace("async getBalance(", "async balanceOf("));
    const incremental = await refresh(dir);
    expect(incremental.rebuilt).toEqual(["src/accounts/account-service.ts", "src/app.ts", "src/http/routes.ts"]);
    expect(incremental.graph.callers("src/accounts/account-service.ts#AccountService.balanceOf")).toEqual([]);
    expect(incremental.graph.gapsIn("src/http/routes.ts#getBalanceHandler").map((g) => g.expression)).toEqual(['accounts.getBalance(req.params.id ?? "")']);

    await new SiftCache(dir).clear();
    const full = await refresh(dir);
    expect(incremental.graph.data).toEqual(full.graph.data);
  }, 30_000);
});

describe("sift impact --diff", () => {
  it("maps changed lines to units", async () => {
    const dir = await fixtureCopy();
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=sift", "-c", "user.email=sift@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    await writeFile(join(dir, ".gitignore"), "node_modules\n.sift/.cache/\n");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");

    const repo = join(dir, "src/accounts/prisma-account-repository.ts");
    await writeFile(repo, (await readFile(repo, "utf8")).replace("balanceCents: account.balanceCents", "balanceCents: Math.max(0, account.balanceCents)"));

    const r = await sift("-C", dir, "impact", "--diff", "HEAD");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Changed since HEAD: 1 unit\n  src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save");
    expect(r.out).toContain("POST /transfers");

    const none = await sift("-C", dir, "impact", "--diff", "HEAD~0", "--json");
    expect(JSON.parse(none.out).subjects).toHaveLength(1);

    const bad = await sift("-C", dir, "impact", "--diff", "no-such-ref");
    expect(bad.code).toBe(EXIT.error);
    expect(bad.err).toContain("git diff no-such-ref failed");
  }, 30_000);
});
