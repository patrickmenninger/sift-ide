import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("fails with a usage error for unknown commands", async () => {
    const r = await sift("frobnicate");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/unknown command/);
  });
});
