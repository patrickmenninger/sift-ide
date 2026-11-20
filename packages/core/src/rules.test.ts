import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SiftError } from "./errors.js";
import { loadRulePacks, parseRulePack, RuleSet } from "./rules.js";
import { ext, internal } from "./test-support.js";

const BUILTIN = fileURLToPath(new URL("../../rules/packs", import.meta.url));

function problems(text: string): string[] {
  try {
    parseRulePack(text, "test.yaml");
  } catch (err) {
    if (err instanceof SiftError) return err.details;
    throw err;
  }
  return [];
}

describe("parseRulePack", () => {
  it("reads effect and edge rules", () => {
    const pack = parseRulePack(
      [
        "pack: demo",
        "rules:",
        "  - match: { module: lib, member: \"Client.{get,list}\" }",
        "    effect: net.request",
        "  - match: { symbol: AuditLog.record }",
        "    effect: db.write",
        "edges:",
        "  - match: { symbol: Bus.on }",
        "    edge: listens",
        "    key: { arg: 0 }",
        "    from: { arg: -1 }",
      ].join("\n"),
      "demo.yaml",
    );
    expect(pack.version).toBe(1);
    expect(pack.rules).toHaveLength(2);
    expect(pack.edges[0]).toEqual({ match: { symbol: "Bus.on" }, edge: "listens", key: { arg: 0 }, from: { arg: -1 } });
  });

  it("reports every problem at once", () => {
    const found = problems(
      [
        "pack: Bad Name",
        "extra: 1",
        "rules:",
        "  - match: { member: x }",
        "    effect: db.delete",
        "  - match: { module: m, symbol: s }",
        "    effect: throws",
        "edges:",
        "  - match: { symbol: Bus.emit }",
        "    edge: emits",
        "  - match: { module: express }",
        "    edge: handles-route",
        "    from: { arg: 1.5 }",
      ].join("\n"),
    );
    expect(found).toEqual([
      "extra: unknown field (expected one of pack, version, appliesWhen, rules, edges)",
      'pack: must be a name made of lowercase letters, digits, and "-"',
      'rules[0].match: "member" needs "module"',
      "rules[0].effect: must be one of db.read, db.write, db.transaction, net.request, fs.read, fs.write, process.exec, event.emit, log, throws",
      'rules[1].match: use either "module"/"member" or "symbol", not both',
      'rules[1].effect: "throws" comes from throw statements, not rules',
      'edges[0]: a "emits" edge needs "key"',
      "edges[1].from: must be { arg: n } with n ≥ 0, or -1 for the last argument",
      'edges[1]: a "handles-route" edge needs "route"',
    ]);
  });
});

describe("built-in packs", () => {
  it("all parse, and dependency-gated packs apply only when package.json lists the dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "sift-rules-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { express: "^5" } }));
    const loaded = await loadRulePacks(root, { builtinDir: BUILTIN });
    expect(loaded.packs.map((p) => p.pack).sort()).toEqual(["console", "express", "fetch", "node-child-process", "node-fs"]);
    expect(loaded.skipped).toEqual([{ pack: "prisma", source: "built-in pack prisma.yaml", reason: 'package.json does not list "@prisma/client"' }]);
  });

  it("loads project packs after built-in ones and rejects duplicate names", async () => {
    const root = await mkdtemp(join(tmpdir(), "sift-rules-"));
    await mkdir(join(root, ".sift", "rules"), { recursive: true });
    await writeFile(join(root, ".sift", "rules", "mine.yaml"), "pack: mine\nrules:\n  - match: { symbol: Audit.record }\n    effect: db.write\n");
    const loaded = await loadRulePacks(root, { builtinDir: BUILTIN });
    expect(loaded.packs.at(-1)?.pack).toBe("mine");

    await writeFile(join(root, ".sift", "rules", "dup.yaml"), "pack: fetch\n");
    await expect(loadRulePacks(root, { builtinDir: BUILTIN })).rejects.toThrow('Two rule packs are named "fetch"');
  });

  it("maps library calls to effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "sift-rules-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@prisma/client": "6", express: "5" } }));
    const rules = new RuleSet((await loadRulePacks(root, { builtinDir: BUILTIN })).packs);

    expect(rules.effectsFor(ext("@prisma/client", "Prisma.AccountDelegate.findUnique"))).toEqual(["db.read"]);
    expect(rules.effectsFor(ext("@prisma/client", "Prisma.AccountDelegate.update"))).toEqual(["db.write"]);
    expect(rules.effectsFor(ext(".prisma", "Prisma.UserDelegate.deleteMany"))).toEqual(["db.write"]);
    expect(rules.effectsFor(ext("@prisma/client", "PrismaClient.$transaction"))).toEqual(["db.transaction"]);
    expect(rules.effectsFor(ext("fs/promises", "appendFile"))).toEqual(["fs.write"]);
    expect(rules.effectsFor(ext("fs", "readFileSync"))).toEqual(["fs.read"]);
    expect(rules.effectsFor(ext("fs/promises", "FileHandle.writeFile"))).toEqual(["fs.write"]);
    expect(rules.effectsFor(ext("child_process", "execFile"))).toEqual(["process.exec"]);
    expect(rules.effectsFor(ext("global", "fetch"))).toEqual(["net.request"]);
    expect(rules.effectsFor(ext("global", "Console.log"))).toEqual(["log"]);
    expect(rules.effectsFor(ext("global", "Math.floor"))).toEqual([]);
    expect(rules.effectsFor(ext("express", "Router.post"))).toEqual([]);

    const route = rules.edgesFor(ext("express", "Router.post"));
    expect(route.map((h) => [h.pack, h.rule.edge, h.matchedName])).toEqual([["express", "handles-route", "Router.post"]]);
    expect(rules.edgesFor(ext("express", "Application.use"))).toEqual([]);
  });

  it("changes its hash when a pack changes", () => {
    const a = new RuleSet([parseRulePack("pack: a\nrules:\n  - match: { module: m }\n    effect: log\n", "a.yaml")]);
    const b = new RuleSet([parseRulePack("pack: a\nrules:\n  - match: { module: m }\n    effect: fs.read\n", "a.yaml")]);
    const a2 = new RuleSet([parseRulePack("pack: a\nrules:\n  - match: { module: m }\n    effect: log\n", "elsewhere.yaml")]);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe(a2.hash);
  });

  it("matches project symbols, not library calls, with symbol rules", () => {
    const rules = new RuleSet([parseRulePack("pack: mine\nrules:\n  - match: { symbol: \"AuditLog.*\" }\n    effect: db.write\n", "mine.yaml")]);
    expect(rules.effectsFor(internal("src/audit.ts", "AuditLog.record"))).toEqual(["db.write"]);
    expect(rules.effectsFor(ext("lib", "AuditLog.record"))).toEqual([]);
  });
});
