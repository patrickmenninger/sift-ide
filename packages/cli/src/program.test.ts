import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, run, VERSION } from "./program.js";

async function sift(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(""), err: err.join("") };
}

describe("sift CLI", () => {
  it("prints the version", async () => {
    const r = await sift("--version");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trim()).toBe(VERSION);
  });

  it("lists commands in help", async () => {
    const r = await sift("--help");
    expect(r.code).toBe(EXIT.ok);
    for (const name of ["init", "generate", "status", "check", "callers", "impact", "eval"]) {
      expect(r.out).toContain(name);
    }
  });

  it("init sets up the target directory, then reports nothing to change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sift-cli-"));

    const first = await sift("--cwd", dir, "init");
    expect(first.code).toBe(EXIT.ok);
    expect(first.out).toContain("created  sift.config.yaml");
    expect(existsSync(join(dir, ".sift"))).toBe(true);

    const second = await sift("-C", dir, "init");
    expect(second.code).toBe(EXIT.ok);
    expect(second.out).toContain("Nothing to change");
  });

  it("explains when a command is not available yet", async () => {
    const r = await sift("status");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toContain('"sift status" is not available yet; it arrives with milestone 7.');
  });

  describe("show --structure", () => {
    const fixture = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));

    it("prints a file's units, statement tree, and resolved calls", async () => {
      const r = await sift("-C", fixture, "show", "--structure", "src/accounts/money.ts");
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("src/accounts/money.ts · typescript · 3 units");
      expect(r.out).toContain("formatCents  (function, lite)");
      expect(r.out).toContain("call Math.floor((balanceCents * annualRate) / 12) → external global: Math.floor (resolved)");
    });

    it("narrows to one unit with file#Symbol and can print JSON", async () => {
      const r = await sift("-C", fixture, "show", "--structure", "--json", "src/accounts/account-service.ts#AccountService.withdraw");
      expect(r.code).toBe(EXIT.ok);
      const parsed = JSON.parse(r.out) as { units: { symbol: string }[] };
      expect(parsed.units.map((u) => u.symbol)).toEqual(["AccountService.withdraw"]);
    });

    it("lists available units when the symbol is wrong", async () => {
      const r = await sift("-C", fixture, "show", "--structure", "src/accounts/money.ts#nope");
      expect(r.code).toBe(EXIT.error);
      expect(r.err).toContain('No unit named "nope"');
      expect(r.err).toContain("available: formatCents");
    });

    it("rejects unsupported file types", async () => {
      const r = await sift("-C", fixture, "show", "--structure", "README.md");
      expect(r.code).toBe(EXIT.error);
      expect(r.err).toContain('No language support for ".md" files yet');
    });
  });

  it("fails with a usage error for unknown commands", async () => {
    const r = await sift("frobnicate");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/unknown command/);
  });
});
