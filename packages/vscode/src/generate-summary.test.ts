import { describe, expect, it } from "vitest";
import { FakeProvider, Workspace } from "@sift/core";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { builtinRulesDir } from "../../cli/src/program.js";
import { planSummary, resultSummary } from "./generate-summary.js";
import { answer, fixtureCopy } from "./test-support.js";

describe("generate summaries", () => {
  it("estimates from a dry run, then summarises the run", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => answer(req));
    const workspace = await Workspace.open({ cwd: dir, adapters: [typescriptAdapter], builtinRulesDir: builtinRulesDir(), provider });
    const SERVICE = "src/accounts/account-service.ts";

    const plan = await workspace.generate({ paths: [SERVICE], dryRun: true });
    expect(provider.requests).toHaveLength(0);
    const summary = planSummary(plan, { local: false, providerId: "claude-code" });
    expect(summary.nothing).toBe(false);
    expect(summary.message).toMatch(/^Describe \d+ units in 1 file\?$/);
    expect(summary.detail).toMatch(/describe on claude-sonnet-5-5 \(medium effort\): \d+ units/);
    expect(summary.detail).toMatch(/describe-lite on claude-haiku-5-5 \(low effort\): \d+ unit/);
    expect(summary.detail).toContain("sent to Anthropic through Claude Code");
    expect(planSummary(plan, { local: true, providerId: "fake" }).detail).toContain("code stays on this machine");

    const report = await workspace.generate({ paths: [SERVICE] });
    expect(resultSummary(report)).toEqual({ message: `Sift described ${report.described.length} units.`, problem: false });
    const again = await workspace.generate({ paths: [SERVICE], dryRun: true });
    expect(planSummary(again, { local: false, providerId: "claude-code" })).toMatchObject({ nothing: true, message: "Nothing to do: every description matches the code." });

    expect(resultSummary({ ...report, cancelled: true, failed: [{ unit: `${SERVICE}#x`, reason: "timeout", problems: [] }] })).toEqual({
      message: `Cancelled. Sift described ${report.described.length} units. Units not reached keep their previous description. 1 unit failed: ${SERVICE}#x (timeout).`,
      problem: true,
    });
    workspace.dispose();
  }, 90_000);
});
