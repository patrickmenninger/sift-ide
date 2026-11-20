import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AdapterProject, CallSite, ExtractedUnit, FileExtraction, StructureNode } from "@sift/core";
import { typescriptAdapter } from "./index.js";

const FIXTURE = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));

let project: AdapterProject;
const cache = new Map<string, FileExtraction>();

beforeAll(async () => {
  project = await typescriptAdapter.openProject(FIXTURE, [], { liteMaxStatements: 3 });
});

function file(path: string): FileExtraction {
  if (!cache.has(path)) cache.set(path, project.extractFile(path));
  return cache.get(path)!;
}

function unit(path: string, symbol: string): ExtractedUnit {
  const found = file(path).units.find((u) => u.symbol === symbol);
  if (!found) throw new Error(`${symbol} not found in ${path}: ${file(path).units.map((u) => u.symbol).join(", ")}`);
  return found;
}

function flat(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children)]);
}

function node(u: ExtractedUnit, key: string): StructureNode {
  const found = flat(u.body).find((n) => n.key === key);
  if (!found) throw new Error(`no node ${key} in ${u.symbol}`);
  return found;
}

function call(u: ExtractedUnit, key: string, expressionStart: string): CallSite {
  const found = node(u, key).calls.find((c) => c.expression.startsWith(expressionStart));
  if (!found) throw new Error(`no call ${expressionStart} at ${key} in ${u.symbol}`);
  return found;
}

describe("unit discovery", () => {
  it("finds methods, constructors, functions, arrow constants, components, and module code", () => {
    const kinds = (path: string) => file(path).units.map((u) => [u.symbol, u.kind]);
    expect(kinds("src/accounts/account-service.ts")).toEqual([
      ["AccountService.constructor", "constructor"],
      ["AccountService.transferFunds", "method"],
      ["AccountService.deposit", "method"],
      ["AccountService.withdraw", "method"],
      ["AccountService.getBalance", "method"],
      ["AccountService.totalBalance", "method"],
      ["AccountService.lowBalanceAccounts", "method"],
    ]);
    expect(kinds("src/accounts/money.ts")).toEqual([
      ["formatCents", "function"],
      ["toCents", "function"],
      ["applyMonthlyInterest", "function"],
    ]);
    expect(kinds("src/ui/balance-card.tsx")).toEqual([["BalanceCard", "component"]]);
    expect(kinds("src/app.ts")).toEqual([["<module>", "module"]]);
    expect(kinds("src/db.ts")).toEqual([["<module>", "module"]]);
  });

  it("ignores files with only types and classes without methods", () => {
    expect(file("src/accounts/account.ts").units).toEqual([]);
    expect(file("src/accounts/account-repository.ts").units).toEqual([]);
  });

  it("reports languages and keeps paths project-relative", () => {
    expect(file("src/legacy/report.js")).toMatchObject({ path: "src/legacy/report.js", language: "javascript" });
    expect(file("src/accounts/money.ts").language).toBe("typescript");
  });
});

describe("signatures and types", () => {
  it("uses written types and marks inferred ones", () => {
    const transfer = unit("src/accounts/account-service.ts", "AccountService.transferFunds");
    expect(transfer.signature).toBe(
      "async transferFunds(userId: string, fromId: string, toId: string, amountCents: number): Promise<TransferConfirmation>",
    );
    expect(transfer.inputs[3]).toEqual({ name: "amountCents", type: "number", typeInferred: false });
    expect(transfer.returns).toEqual({ type: "Promise<TransferConfirmation>", typeInferred: false });

    const summarize = unit("src/legacy/report.js", "summarize");
    expect(summarize.inputs).toEqual([{ name: "accounts", type: "any", typeInferred: true }]);
    expect(summarize.returns?.typeInferred).toBe(true);

    expect(unit("src/http/routes.ts", "getBalanceHandler").returns).toEqual({ type: "Promise<void>", typeInferred: true });
  });

  it("records project types used and the interface member a method implements", () => {
    const save = unit("src/accounts/prisma-account-repository.ts", "PrismaAccountRepository.save");
    expect(save.implementsMember).toEqual({ file: "src/accounts/account-repository.ts", symbol: "AccountRepository.save" });
    expect(save.typeRefs).toEqual([{ file: "src/accounts/account.ts", symbol: "Account" }]);
  });

  it("keeps only comments directly above a unit", () => {
    expect(unit("src/accounts/money.ts", "formatCents").docComment).toContain("dollar string");
    expect(unit("src/accounts/account-service.ts", "AccountService.deposit").docComment).toBe("// Deposits over $10,000 are rejected.");
    expect(unit("src/legacy/report.js", "summarize").docComment).toBeNull();
  });
});

describe("structure tree", () => {
  it("assigns structural keys for branches, loops, and callbacks", () => {
    const keys = (u: ExtractedUnit) => flat(u.body).map((n) => `${n.key}:${n.kind}`);
    expect(keys(unit("src/accounts/account-service.ts", "AccountService.transferFunds"))).toEqual([
      "0:statement", "1:if", "1.then.0:throw", "2:statement", "3:statement", "4:statement",
      "5:statement", "6:statement", "7:statement", "8:return",
    ]);
    expect(keys(unit("src/accounts/account-service.ts", "AccountService.lowBalanceAccounts"))).toEqual([
      "0:statement", "1:loop", "1.body.0:if", "1.body.0.then.0:statement", "2:return",
    ]);
    expect(keys(unit("src/accounts/account-service.ts", "AccountService.totalBalance"))).toEqual([
      "0:statement", "1:return", "1.cb0:callback", "1.cb0.0:return",
    ]);
  });

  it("represents try/catch inside a loop and switch cases", () => {
    const keys = (u: ExtractedUnit) => flat(u.body).map((n) => n.key);
    expect(keys(unit("src/notifications/notifier.ts", "onTransferCompleted"))).toEqual([
      "0", "1", "2", "2.body.0", "2.body.0.try.0", "2.body.0.try.1", "2.body.0.catch", "2.body.0.catch.0",
    ]);
    const statusFor = unit("src/http/routes.ts", "statusFor");
    expect(node(statusFor, "0").kind).toBe("switch");
    expect(node(statusFor, "0.case3").text).toBe("default:");
    expect(node(statusFor, "0.case1.0").text).toBe("return 403;");
  });

  it("attaches calls inside inline functions to the callback node, not the statement", () => {
    const router = unit("src/http/routes.ts", "createRouter");
    expect(node(router, "1").calls.map((c) => c.expression.slice(0, 11))).toEqual(["router.post"]);
    expect(call(router, "1.cb0.0.try.2", "accounts.transferFunds").target?.symbol).toBe("AccountService.transferFunds");
  });
});

describe("call resolution", () => {
  it("resolves interface calls and lists their implementations", () => {
    const site = call(unit("src/accounts/account-service.ts", "AccountService.transferFunds"), "0", "this.repo.getAccount");
    expect(site).toMatchObject({
      target: { file: "src/accounts/account-repository.ts", symbol: "AccountRepository.getAccount" },
      confidence: "resolved",
      awaited: true,
      external: null,
    });
    expect(site.implementations).toEqual([
      { file: "src/accounts/in-memory-account-repository.ts", symbol: "InMemoryAccountRepository.getAccount" },
      { file: "src/accounts/prisma-account-repository.ts", symbol: "PrismaAccountRepository.getAccount" },
    ]);
  });

  it("flags the un-awaited event emit", () => {
    const emit = call(unit("src/accounts/account-service.ts", "AccountService.transferFunds"), "7", "this.events.emit");
    expect(emit.awaited).toBe(false);
    expect(emit.target?.symbol).toBe("EventBus.emit");
  });

  it("names library calls by module and declaration", () => {
    const external = (path: string, symbol: string, key: string, start: string) => call(unit(path, symbol), key, start).external;
    expect(external("src/accounts/prisma-account-repository.ts", "PrismaAccountRepository.save", "0", "this.db.account.update")).toEqual({
      module: "@prisma/client",
      name: "Prisma.AccountDelegate.update",
    });
    expect(external("src/auth/auth-service.ts", "AuthService.authenticate", "1.try.0", "fetch")).toEqual({ module: "global", name: "fetch" });
    expect(external("src/notifications/notifier.ts", "onTransferCompleted", "2.body.0.try.0", "appendFile")).toEqual({
      module: "fs/promises",
      name: "appendFile",
    });
    expect(external("src/http/routes.ts", "createRouter", "1", "router.post")).toEqual({ module: "express", name: "Router.post" });
  });

  it("resolves constructors to the project class rather than an inherited base", () => {
    const site = call(unit("src/accounts/account-service.ts", "AccountService.transferFunds"), "1.then.0", "new ForbiddenError");
    expect(site.target).toEqual({ file: "src/accounts/account.ts", symbol: "ForbiddenError" });
    const ctor = call(unit("src/app.ts", "<module>"), "2", "new AccountService");
    expect(ctor.target?.symbol).toBe("AccountService.constructor");
  });

  it("describes arguments for edge rules: strings, function references, inline callbacks", () => {
    const on = call(unit("src/app.ts", "<module>"), "1", "bus.on");
    expect(on.args).toEqual([
      { kind: "string", value: "transfer.completed" },
      { kind: "unit", ref: { file: "src/notifications/notifier.ts", symbol: "onTransferCompleted" } },
    ]);
    const post = call(unit("src/http/routes.ts", "createRouter"), "1", "router.post");
    expect(post.args).toEqual([{ kind: "string", value: "/transfers" }, { kind: "callback", key: "1.cb0" }]);
    const push = call(unit("src/accounts/account-service.ts", "AccountService.lowBalanceAccounts"), "1.body.0.then.0", "result.push");
    expect(push.args).toEqual([{ kind: "unknown" }]);
  });

  it("leaves dynamic calls unresolved instead of guessing", () => {
    const site = call(unit("src/events/event-bus.ts", "EventBus.emit"), "0.body.0", "handler(payload)");
    expect(site).toMatchObject({ target: null, confidence: null, external: null, awaited: true });
  });

  it("resolves recursion to the unit itself", () => {
    const site = call(unit("src/accounts/money.ts", "applyMonthlyInterest"), "2", "applyMonthlyInterest");
    expect(site.target).toEqual({ file: "src/accounts/money.ts", symbol: "applyMonthlyInterest" });
  });
});

describe("lite heuristic", () => {
  it("marks short, branch-free functions without library effects as lite", () => {
    const lite = (path: string, symbol: string) => unit(path, symbol).isSmall;
    expect(lite("src/accounts/money.ts", "formatCents")).toBe(true);
    expect(lite("src/accounts/money.ts", "toCents")).toBe(true);
    expect(lite("src/accounts/money.ts", "applyMonthlyInterest")).toBe(false);
    expect(lite("src/accounts/account-service.ts", "AccountService.transferFunds")).toBe(false);
    expect(lite("src/accounts/prisma-account-repository.ts", "PrismaAccountRepository.listByOwner")).toBe(false);
  });
});

describe("findImplementations", () => {
  it("finds class methods implementing an interface member", () => {
    expect(project.findImplementations({ file: "src/accounts/account-repository.ts", symbol: "AccountRepository.save" })).toEqual([
      { file: "src/accounts/in-memory-account-repository.ts", symbol: "InMemoryAccountRepository.save" },
      { file: "src/accounts/prisma-account-repository.ts", symbol: "PrismaAccountRepository.save" },
    ]);
    expect(project.findImplementations({ file: "src/accounts/account-repository.ts", symbol: "AccountRepository.missing" })).toEqual([]);
  });
});

describe("hashFile", () => {
  it("matches the extraction's file hash without opening a project", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir(`${FIXTURE}/src`, { recursive: true })).map((f) => `src/${f.replaceAll("\\", "/")}`).filter((f) => /\.(ts|tsx|js)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      expect(typescriptAdapter.hashFile(path, await readFile(`${FIXTURE}/${path}`, "utf8")), path).toBe(file(path).fileHash);
    }
  });
});
