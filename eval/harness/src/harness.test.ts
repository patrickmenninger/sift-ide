import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { FakeProvider, type CompletionRequest, type SiftUnit } from "@sift/core";
import { loadExpectations, loadMatrix } from "./files.js";
import { expectationChecks, shapeOf } from "./metrics.js";
import { renderMarkdown } from "./report.js";
import { runEval, writeResults } from "./run.js";

const EVAL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const RULES = fileURLToPath(new URL("../../../packages/rules/packs", import.meta.url));

const unitOf = (req: CompletionRequest) => /^Unit: (.+) \(/m.exec(req.prompt)![1]!;

/** A stand-in for every task: valid descriptions, updates that keep step IDs, and judge verdicts. */
function fakeModel(req: CompletionRequest): unknown {
  const p = req.prompt;
  const unit = unitOf(req);
  if (req.task === "context-check") return { summary: null, steps: [] };
  if (req.task === "judge") {
    const ideas = JSON.parse(/^Expected ideas: (.*)$/m.exec(p)![1]!) as string[];
    return {
      ideas: ideas.map((idea, i) => ({ idea, present: !(unit === "statusFor" && i === 0), where: "" })),
      accuracy: unit === "createRouter" ? "wrong" : "correct",
      issues: unit === "createRouter" ? [{ severity: "major", text: "Leaves out the balance route." }] : [],
    };
  }
  const names = [...(/\nInputs[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]!);
  const returns = /^(nothing|void|Promise<void>)/.test(/\nReturns: (.+)/.exec(p)![1]!) ? null : { meaning: "The result." };
  const base = { summary: `Does what ${unit} does.`, inputs: names.map((n) => ({ name: n, meaning: `The ${n}.` })), returns };
  if (req.task === "describe-lite") return { ...base, warnings: [] };
  const keys = [...(/Structure keys[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- ([^:]+): (\w+)/gm)].map((m) => ({ key: m[1]!, kind: m[2]! }));
  const previous = /Previous description[^\n]*\n```json\n([\s\S]*?)\n```/.exec(p);
  const old = previous ? (JSON.parse(previous[1]!) as { steps: { id: string; covers: string[] }[] }).steps : [];
  const steps = keys
    .filter((k) => !k.key.includes("."))
    .map((k) => {
      const reworded = req.task === "update" && unit === "AccountService.transferFunds" && k.key === "0";
      const step: Record<string, unknown> = { kind: ["if", "loop", "switch", "try"].includes(k.kind) ? k.kind : null, text: reworded ? "Look up the source account." : `Handle part ${k.key}.`, covers: [k.key], steps: [] };
      if (req.task === "update") step.id = old.find((s) => s.covers[0] === k.key)?.id ?? null;
      return step;
    });
  const warnings = unit === "AccountService.transferFunds" ? [{ kind: "missing-transaction", text: "Not in a transaction.", covers: ["5", "6"] }] : [];
  return { ...base, steps, warnings };
}

describe("runEval", () => {
  it("generates, scores, judges, and measures churn on a copy of the fixture", async () => {
    const provider = new FakeProvider((req) => fakeModel(req));
    const lines: string[] = [];
    const result = await runEval({
      evalDir: EVAL_DIR, fixture: "bank-app", adapters: [typescriptAdapter], builtinRulesDir: RULES, provider,
      configs: [{ name: "recommended", tasks: {} }], repeat: 1, judge: true, churn: true, nodeModules: NODE_MODULES, onProgress: (l) => lines.push(l),
    });
    expect(existsSync(join(EVAL_DIR, "fixtures/bank-app/.sift/src"))).toBe(false); // the fixture itself is never touched

    const [run] = result.runs;
    expect(run!.metrics).toMatchObject({ units: 29, failed: 0, stale: 0, coverage: 1, valid: 1, missedEffects: 0, firstTry: 29 });
    expect(run!.metrics.accuracy).toMatchObject({ correct: 28, wrong: 1, judged: 29 });
    expect(run!.models).toMatchObject({ describe: "claude-sonnet-5-5", "describe-lite": "claude-haiku-5-5", update: "claude-sonnet-5-5", "context-check": "claude-haiku-5-5" });
    const transfer = run!.units.find((u) => u.unit === "src/accounts/account-service.ts#AccountService.transferFunds")!;
    expect(transfer.checks.filter((c) => !c.pass).map((c) => `${c.kind} ${c.subject}`)).toEqual(["warn missing-check", "warn unawaited-promise"]);
    expect(run!.units.find((u) => u.unit === "src/http/routes.ts#statusFor")!.checks[0]).toMatchObject({ kind: "mention", pass: false });
    expect(run!.metrics.expectations.unjudged).toBe(0);

    // Churn: the three edits update three units; one step whose code did not change was reworded.
    expect(run!.churn!.updated.sort()).toEqual([
      "src/accounts/account-service.ts#AccountService.transferFunds",
      "src/accounts/account-service.ts#AccountService.withdraw",
      "src/accounts/money.ts#applyMonthlyInterest",
    ]);
    expect(run!.churn!.steps.changed).toBe(1);
    expect(run!.churn!.steps.unaffected).toBeGreaterThan(10);
    expect(run!.churn!.details.flatMap((d) => d.changed)).toEqual([{ id: expect.stringMatching(/^s_/), before: "Handle part 0.", after: "Look up the source account." }]);
    expect(run!.churn!.rewordedUnrelated).toEqual([]);

    expect(result.judge).toEqual({ model: "claude-opus-5-5", selfGraded: true });
    expect(result.prompts).toMatchObject({ describe: "describe@2", update: "update@2", judge: "judge@2" });
    expect(result.summary).toEqual([expect.objectContaining({ config: "recommended", runs: 1, coverage: 1, accuracy: 28 / 29, churn: run!.churn!.steps.rate })]);
    expect(lines.join("\n")).toContain("judging 29 descriptions with claude-opus-5-5…");

    const md = renderMarkdown(result);
    expect(md).toContain("| recommended | claude-sonnet-5-5 / claude-haiku-5-5 / claude-sonnet-5-5 / claude-haiku-5-5 | 100% | 0 |");
    expect(md).toContain("**self-graded**");
    expect(md).toContain("- src/accounts/account-service.ts#AccountService.transferFunds: missing warning unawaited-promise");
    expect(md).toContain("- src/http/routes.ts#createRouter — wrong\n  - major: Leaves out the balance route.");
    expect(md).toContain('"Handle part 0." → "Look up the source account."');

    const out = await mkdtemp(join(tmpdir(), "sift-results-"));
    const saved = await writeResults(out, result, md);
    expect(saved.json).toMatch(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.json$/);
    expect(JSON.parse(await readFile(saved.json, "utf8")).summary[0].config).toBe("recommended");
  }, 120_000);
});

describe("eval files and metrics", () => {
  it("loads the bank-app expectations and the matrix, and rejects malformed files", async () => {
    const e = await loadExpectations(EVAL_DIR, "bank-app");
    expect(e.units.find((u) => u.unit === "src/accounts/money.ts#formatCents")).toEqual({ unit: "src/accounts/money.ts#formatCents", lite: true, mustMention: ["formats cents as a dollar string"], mustWarn: [], mustNotWarn: [] });
    expect((await loadMatrix(EVAL_DIR)).map((c) => c.name)).toEqual(["recommended", "describe-on-frontier"]);

    const dir = await mkdtemp(join(tmpdir(), "sift-evalfiles-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "expectations"));
    await writeFile(join(dir, "expectations/x.yaml"), "units:\n  - unit: nohash\n  - unit: a.ts#f\n    mustWarn: missing-check\n    extra: 1\n");
    await expect(loadExpectations(dir, "x")).rejects.toMatchObject({ details: ['units[0].unit must be "file#Symbol"', 'units[1]: unknown field "extra"', "units[1].mustWarn must be a list of strings"] });
    await writeFile(join(dir, "matrix.yaml"), "configs:\n  - name: a\n    tasks: { describe: huge, nope: mid }\n");
    await expect(loadMatrix(dir)).rejects.toMatchObject({ details: ['configs[0].tasks.describe: unknown tier "huge"', 'configs[0].tasks: unknown task "nope"'] });
  });

  it("checks warnings and lite deterministically, and leaves mentions to the judge", () => {
    const unit = { lite: true, warnings: [{ id: "w_a", kind: "missing-check", text: "", steps: [] }] } as unknown as SiftUnit;
    const e = { unit: "a#b", lite: true, mustMention: ["x"], mustWarn: ["missing-check", "missing-auth"], mustNotWarn: ["missing-check"] };
    expect(expectationChecks(e, unit, null).map((c) => [c.kind, c.subject, c.pass])).toEqual([
      ["mention", "x", null], ["warn", "missing-check", true], ["warn", "missing-auth", false], ["not-warn", "missing-check", false], ["lite", "true", true],
    ]);
    expect(expectationChecks(e, undefined, null).every((c) => c.pass === false)).toBe(true);
  });

  it("compares code shapes without identifier names", () => {
    expect(shapeOf("const to = await repo.get(toId);")).toBe(shapeOf("const destination = await repo.get(toId);"));
    expect(shapeOf("if (months <= 0) {}")).not.toBe(shapeOf("if (months < 1) {}"));
  });
});
