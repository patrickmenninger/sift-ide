import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, findProjectRoot, loadProject, parseConfig } from "./config.js";
import { SiftError } from "./errors.js";

function problemsOf(text: string): string[] {
  try {
    parseConfig(text);
  } catch (err) {
    if (err instanceof SiftError) return err.details;
    throw err;
  }
  throw new Error("expected parseConfig to fail");
}

describe("parseConfig", () => {
  it("returns defaults for an empty file", () => {
    expect(parseConfig("")).toEqual(defaultConfig());
  });

  it("reads every setting", () => {
    const config = parseConfig(`
include: ["lib/**"]
exclude: ["**/*.gen.ts"]
provider: claude-code
concurrency: 2
lite: { maxStatements: 5 }
models:
  tasks: { describe: mid }
  tiers:
    small: { model: claude-haiku-5-5, effort: low }
`);
    expect(config).toEqual({
      include: ["lib/**"],
      exclude: ["**/*.gen.ts"],
      provider: "claude-code",
      concurrency: 2,
      lite: { maxStatements: 5 },
      models: {
        tasks: { describe: "mid" },
        tiers: { small: { model: "claude-haiku-5-5", effort: "low" } },
      },
    });
  });

  it("reports every problem at once", () => {
    const problems = problemsOf(`
include: []
concurency: 4
concurrency: 0
models:
  tasks: { describe: huge, summarize: small }
  tiers:
    small: { model: "", effort: low }
    mid: { model: x, effort: turbo }
`);
    expect(problems).toEqual([
      "concurency: unknown setting (expected one of include, exclude, provider, concurrency, lite, models)",
      "include: must contain at least one pattern",
      "concurrency: must be a positive whole number",
      "models.tasks.describe: must be one of frontier, mid, small",
      "models.tasks.summarize: unknown task (expected one of describe, describe-lite, update, context-check, judge)",
      "models.tiers.small.model: must be a non-empty string",
      "models.tiers.mid.effort: must be one of low, medium, high, xhigh, max",
    ]);
  });

  it("rejects invalid YAML with the parser's message", () => {
    expect(() => parseConfig("include: [unclosed")).toThrowError(/not valid YAML/);
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parseConfig("- a\n- b\n")).toThrowError(/must be a mapping/);
  });
});

describe("findProjectRoot / loadProject", () => {
  it("finds the config in a parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sift-config-"));
    await writeFile(join(root, "sift.config.yaml"), "concurrency: 7\n");
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(root);
    const project = await loadProject(nested);
    expect(project.root).toBe(root);
    expect(project.config.concurrency).toBe(7);
  });

  it("explains how to fix a missing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sift-noconfig-"));
    await expect(loadProject(dir)).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });
});
