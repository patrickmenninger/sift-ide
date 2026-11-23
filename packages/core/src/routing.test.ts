import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { loadLocalOverrides, loadModelMap, Router } from "./routing.js";

describe("Router", () => {
  it("routes tasks to the shipped claude-code models by default", async () => {
    const router = new Router(await loadModelMap("claude-code"), defaultConfig());
    expect(router.route("describe")).toMatchObject({
      tier: "mid", belowTier: false, choice: { provider: "claude-code", model: "claude-sonnet-5-5", effort: "medium", tier: "mid" },
    });
    expect(router.route("describe-lite").choice).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(router.route("judge").choice.effort).toBe("high");
    expect(router.fallbacks("frontier")).toEqual(["mid"]);
  });

  it("applies config overrides, then personal overrides, and flags tiers below the recommendation", async () => {
    const config = defaultConfig();
    config.models.tasks.describe = "frontier";
    config.models.tiers.small = { model: "claude-sonnet-5-5", effort: "low" };
    const router = new Router(await loadModelMap("claude-code"), config, { tasks: { update: "small" }, tiers: {} });

    expect(router.route("describe")).toMatchObject({ tier: "frontier", belowTier: false, belowMinimum: false, choice: { model: "claude-opus-5-5" }, source: { tier: "config", model: "default" } });
    expect(router.route("describe", "small")).toMatchObject({ tier: "small", belowTier: true });
    expect(router.route("describe-lite")).toMatchObject({ choice: { model: "claude-sonnet-5-5" }, source: { model: "config" } });
    expect(router.route("update")).toMatchObject({ tier: "small", belowMinimum: true, source: { tier: "local" } });
    expect(router.route("describe", "small")).toMatchObject({ tier: "small", belowMinimum: true, source: { tier: "default" } });
  });

  it("reads .sift/models.local.yaml and reports its problems", async () => {
    const root = await mkdtemp(join(tmpdir(), "sift-models-"));
    expect(await loadLocalOverrides(root)).toBeNull();
    await mkdir(join(root, ".sift"));
    await writeFile(join(root, ".sift/models.local.yaml"), "tiers:\n  mid: { model: my-model, effort: low }\ntasks:\n  describe: mid\n");
    expect(await loadLocalOverrides(root)).toEqual({ tasks: { describe: "mid" }, tiers: { mid: { model: "my-model", effort: "low" } } });

    await writeFile(join(root, ".sift/models.local.yaml"), "tiers:\n  huge: { model: x }\nother: 1\n");
    await expect(loadLocalOverrides(root)).rejects.toMatchObject({ details: ["other: unknown setting (expected tasks, tiers)", 'tiers.huge: must be a tier with a "model"'] });
  });

  it("refuses providers without a mapping", async () => {
    await expect(loadModelMap("nobody")).rejects.toThrow('no model mapping for provider "nobody"');
  });
});
