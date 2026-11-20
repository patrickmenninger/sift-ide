import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeSiftFile, type SiftUnit } from "@sift/core";
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
    const r = await sift("qualify", "x:y");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toContain('"sift qualify" is not available yet; it arrives with the bring-your-own-key providers.');
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

  describe("show (descriptions)", () => {
    const unit = (over: Partial<SiftUnit>): SiftUnit => ({
      id: "u_aaaaaaaa", symbol: "f", kind: "function", status: "generated", bodyHash: "0123456789abcdef",
      summary: "Does a thing.", inputs: [], effects: [], steps: [], warnings: [], tests: [], ...over,
    });

    async function project() {
      const root = await mkdtemp(join(tmpdir(), "sift-show-"));
      await writeFile(join(root, "sift.config.yaml"), "");
      await writeSiftFile(root, {
        sift: 0, source: "src/repo.ts", language: "typescript", fileHash: "1111111111111111",
        units: [unit({ id: "u_rrrrrrrr", symbol: "Repo.load", status: "verified" })],
      });
      await writeSiftFile(root, {
        sift: 0, source: "src/service.ts", language: "typescript", fileHash: "2222222222222222",
        units: [
          unit({
            id: "u_ssssssss",
            symbol: "Service.run",
            kind: "method",
            effects: ["db.read"],
            steps: [
              { id: "s_aaaa", text: "Load the record.", covers: ["0"], calls: ["u_rrrrrrrr", "ext:fs/promises#readFile"], effects: ["db.read"], steps: [] },
              {
                id: "s_bbbb", kind: "if", text: "If it is missing,", covers: ["1"], calls: [], effects: [],
                steps: [{ id: "s_cccc", text: "stop with an error.", covers: ["1.then.0"], calls: ["u_zzzzzzzz"], effects: ["throws"], steps: [] }],
              },
            ],
            warnings: [{ id: "w_aaaa", kind: "unhandled-error", text: "Errors from loading are not caught.", steps: ["s_aaaa"] }],
          }),
          unit({ id: "u_tttttttt", symbol: "helper", lite: true, summary: "Formats the result." }),
        ],
      });
      return root;
    }

    it("renders steps as a numbered outline with calls by name and warnings by step", async () => {
      const r = await sift("-C", await project(), "show", "src/service.ts");
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("Service.run  · method · generated, not verified");
      expect(r.out).toContain("    1. Load the record.\n       → src/repo.ts#Repo.load, fs/promises: readFile");
      expect(r.out).toContain("       2.1. stop with an error.\n            → u_zzzzzzzz (unknown unit)");
      expect(r.out).toContain("    ! unhandled-error (step 1): Errors from loading are not caught.");
      expect(r.out).toContain("helper  · function (lite) · generated, not verified");
    });

    it("narrows to one unit and prints JSON", async () => {
      const r = await sift("-C", await project(), "show", "--json", "src/service.ts#helper");
      expect(JSON.parse(r.out).units).toHaveLength(1);
    });

    it("explains when a file has no description yet", async () => {
      const r = await sift("-C", await project(), "show", "src/other.ts");
      expect(r.code).toBe(EXIT.error);
      expect(r.err).toContain("src/other.ts has no description yet (.sift/src/other.ts.sift does not exist)");
    });
  });

  it("fails with a usage error for unknown commands", async () => {
    const r = await sift("frobnicate");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/unknown command/);
  });
});
