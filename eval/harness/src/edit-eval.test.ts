import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { typescriptAdapter } from "@sift/adapter-typescript";
import { FakeProvider, type CompletionRequest } from "@sift/core";
import { loadEditCases, parseEditCases, type EditCase } from "./edit-cases.js";
import { runEditEval } from "./edit-eval.js";
import { renderEditMarkdown, targetsMissed } from "./edit-report.js";
import { loadMatrix } from "./files.js";

const EVAL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const RULES = fileURLToPath(new URL("../../../packages/rules/packs", import.meta.url));

const SERVICE = "src/accounts/account-service.ts";
const WITHDRAW = `${SERVICE}#AccountService.withdraw`;
const DEPOSIT = `${SERVICE}#AccountService.deposit`;

/** A stand-in describer: one step per top-level structure key, IDs kept on update. */
function describeModel(req: CompletionRequest): unknown {
  const p = req.prompt;
  const unit = /^Unit: (.+) \(/m.exec(p)![1]!;
  if (req.task === "context-check") return { summary: null, steps: [] };
  const names = [...(/\nInputs[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]!);
  const returns = /^(nothing|void|Promise<void>)/.test(/\nReturns: (.+)/.exec(p)![1]!) ? null : { meaning: `What ${unit} returns.` };
  const base = { summary: `Does what ${unit} does.`, inputs: names.map((n) => ({ name: n, meaning: `The ${n}.` })), returns };
  if (req.task === "describe-lite") return { ...base, warnings: [] };
  const keys = [...(/Structure keys[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- ([^:]+): (\w+)/gm)].map((m) => ({ key: m[1]!, kind: m[2]! }));
  const previous = /Previous description[^\n]*\n```json\n([\s\S]*?)\n```/.exec(p);
  const old = previous ? ((JSON.parse(previous[1]!) as { steps?: { id: string; covers: string[] }[] }).steps ?? []) : [];
  const steps = keys
    .filter((k) => !k.key.includes("."))
    .map((k) => {
      const step: Record<string, unknown> = { kind: ["if", "loop", "switch", "try"].includes(k.kind) ? k.kind : null, text: `Handle part ${k.key}.`, covers: [k.key], steps: [] };
      if (req.task === "update") step.id = old.find((s) => s.covers[0] === k.key)?.id ?? null;
      return step;
    });
  return { ...base, steps, warnings: [] };
}

const plan = (unit: string, over: Record<string, unknown> = {}) => ({
  kind: "behavior",
  interpretation: "Do what was asked.",
  questions: [],
  warnings: [],
  allowedUnits: [{ unit, reason: "the edited unit" }],
  helpers: [],
  examples: [],
  broader: null,
  ...over,
});

function withdrawCode(check = "if (amountCents <= 0) {\n    throw new ValidationError(\"Withdrawal amount must be positive\");\n  }\n  "): string {
  return `async withdraw(userId: string, accountId: string, amountCents: number): Promise<Account> {
  ${check}const account = await this.repo.getAccount(accountId);
  if (account.ownerId !== userId) {
    throw new ForbiddenError("You can only withdraw from your own accounts");
  }
  account.balanceCents -= amountCents;
  await this.repo.save(account);
  return account;
}`;
}

const DEPOSIT_CHANGED = `async deposit(accountId: string, amountCents: number): Promise<Account> {
  if (amountCents <= 0 || amountCents > 500_000) {
    throw new ValidationError("Deposit amount is out of range");
  }
  const account = await this.repo.getAccount(accountId);
  account.balanceCents += amountCents;
  await this.repo.save(account);
  return account;
}`;

/** Scripted editing tasks, chosen by the request text in the prompt. */
function editModel(req: CompletionRequest): unknown {
  const p = req.prompt;
  const has = (s: string) => p.includes(s);
  if (req.task === "edit-plan") {
    if (has("Don't let people overdraw.")) {
      return has("Answers the person gave")
        ? plan(WITHDRAW)
        : plan(WITHDRAW, { kind: "unclear", questions: [{ id: "q1", text: "What should happen when the balance is too low?", options: ["Stop with an error", "Withdraw what is there"] }] });
    }
    if (has("Takes money out") || has("in dollars")) return plan(WITHDRAW, { kind: "reword" });
    if (has("Lower the deposit limit")) return plan(DEPOSIT);
    return plan(WITHDRAW);
  }
  if (req.task === "edit-code") {
    if (has("Reject withdrawals of zero")) return { units: [{ unit: WITHDRAW, text: withdrawCode() }], insertions: [], notes: "" };
    if (has("Don't let people overdraw.")) return { units: [{ unit: WITHDRAW, text: withdrawCode("") }, { unit: DEPOSIT, text: DEPOSIT_CHANGED }], insertions: [], notes: "" };
    if (has("Lower the deposit limit")) return { units: [{ unit: DEPOSIT, text: DEPOSIT_CHANGED.replace("500_000", '"500000"') }], insertions: [], notes: "" };
    return { units: [{ unit: WITHDRAW, text: withdrawCode() }], insertions: [], notes: "" };
  }
  if (req.task === "edit-verify") return has("in dollars") ? { satisfied: false, gaps: ["The code returns cents."], unrequested: [] } : { satisfied: true, gaps: [], unrequested: [] };
  if (req.task === "edit-judge") {
    const ideas = JSON.parse(/^Expected ideas: (.*)$/m.exec(p)![1]!) as string[];
    const asks = JSON.parse(/^Expected questions: (.*)$/m.exec(p)![1]!) as string[];
    const diff = has("```diff");
    return {
      ideas: ideas.map((idea) => ({ idea, present: true, where: "amountCents <= 0" })),
      asks: asks.map((topic) => ({ topic, asked: has("balance is too low?"), question: "What should happen when the balance is too low?" })),
      intent: diff ? "correct" : null,
      issues: [],
    };
  }
  return describeModel(req);
}

const yaml = `
fixture: bank-app
cases:
  - id: positive
    unit: ${WITHDRAW}
    request: "Reject withdrawals of zero or less."
    expect: { kind: behavior, changedUnits: [AccountService.withdraw], broader: false, mustMention: [rejects zero or less] }
  - id: overdraw
    unit: ${WITHDRAW}
    request: "Don't let people overdraw."
    answers: ["Stop with a validation error."]
    expect: { kind: behavior, asks: [what happens when the balance is too low], changedUnits: [AccountService.withdraw] }
  - id: type-error
    unit: ${DEPOSIT}
    request: "Lower the deposit limit to $5,000."
    expect: { kind: behavior, changedUnits: [AccountService.deposit] }
  - id: reword-ok
    unit: ${WITHDRAW}
    summary: "Takes money out of the user's own account."
    expect: { kind: reword, reword: true }
  - id: reword-false
    unit: ${SERVICE}#AccountService.getBalance
    returns: "The balance in dollars."
    expect: { reword: false }
`;

describe("edit evaluation", { timeout: 180_000 }, () => {
  it("runs change requests up to review and scores them", async () => {
    const provider = new FakeProvider(editModel);
    const lines: string[] = [];
    const cases = parseEditCases((await import("yaml")).parse(yaml), "test.yaml");
    const result = await runEditEval({
      evalDir: EVAL_DIR, fixture: "bank-app", adapters: [typescriptAdapter], builtinRulesDir: RULES, provider,
      configs: [{ name: "recommended", tasks: {} }], repeat: 1, judge: true, cases, nodeModules: NODE_MODULES, onProgress: (l) => lines.push(l),
    });
    const [run] = result.runs;
    const byId = (id: string) => run!.cases.find((c) => c.id === id)!;
    const failedChecks = (id: string) => byId(id).checks.filter((k) => k.pass === false).map((k) => k.kind);

    expect(byId("positive")).toMatchObject({ state: "ready", kind: "behavior", changed: [WITHDRAW], typeChecks: true, broader: false, verdict: { intent: "correct" } });
    expect(byId("positive").checks.map((k) => [k.kind, k.pass])).toEqual([["kind", true], ["targeted", true], ["broader", true], ["type-checks", true], ["no-questions", true], ["mention", true]]);
    expect(byId("positive").diff).toContain("+    if (amountCents <= 0) {");

    // Asked, answered, then the code changed deposit too: rejected, so not targeted.
    expect(byId("overdraw")).toMatchObject({ state: "failed", questions: [{ round: 1, text: "What should happen when the balance is too low?", answer: "Stop with a validation error." }] });
    expect(byId("overdraw").error).toContain("is not one of the units you may change");
    expect(failedChecks("overdraw")).toEqual(["targeted"]);
    expect(byId("overdraw").checks.find((k) => k.kind === "asks")).toMatchObject({ pass: true });

    // Type errors twice: failed, counted against type-checks.
    expect(byId("type-error")).toMatchObject({ state: "failed", typeChecks: false });
    expect(provider.requests.filter((q) => q.task === "edit-code" && q.prompt.includes("Lower the deposit limit"))).toHaveLength(2);

    expect(byId("reword-ok")).toMatchObject({ state: "ready", kind: "reword", diff: "" });
    expect(failedChecks("reword-ok")).toEqual([]);
    expect(byId("reword-false")).toMatchObject({ state: "failed", kind: "reword" });
    expect(failedChecks("reword-false")).toEqual([]);

    const m = run!.metrics;
    expect(m).toMatchObject({ cases: 5, ready: 2, failed: 3, errors: 0 });
    expect(m.typeChecks).toEqual({ passed: 1, of: 2, rate: 0.5 });
    expect(m.targeted).toEqual({ passed: 1, of: 3, rate: 1 / 3 });
    expect(m.reword).toEqual({ passed: 2, of: 2, rate: 1 });
    expect(m.recall).toEqual({ passed: 1, of: 1, rate: 1 });
    expect(m.unneeded).toEqual({ passed: 0, of: 4, rate: 0 });
    expect(m.intent).toEqual({ correct: 1, minor: 0, wrong: 0, judged: 1, acceptable: 1 });
    expect(m.tasks["edit-plan"]!.calls).toBe(6);
    expect(run!.models).toMatchObject({ "edit-plan": "claude-opus-5-5", "edit-code": "claude-opus-5-5", update: "claude-sonnet-5-5", "edit-verify": "claude-sonnet-5-5" });
    // Judged on frontier, and only where there is a change or an expected question.
    expect(provider.requests.filter((q) => q.task === "edit-judge").map((q) => q.model.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    expect(result.judge).toEqual({ model: "claude-opus-5-5", selfGraded: true });
    expect(result.prompts).toMatchObject({ "edit-plan": "edit-plan@2", "edit-judge": "edit-judge@1" });
    expect(lines).toContain("  positive: ready (behavior), correct");

    const summary = result.summary[0]!;
    expect(targetsMissed(summary)).toEqual(["type-checks 50% < 100%", "targeted 33% < 90%"]);
    const md = renderEditMarkdown(result);
    expect(md).toContain("| recommended | claude-opus-5-5 / claude-opus-5-5 / claude-sonnet-5-5 / claude-sonnet-5-5 | 50% | 33% | 100% | 0 | 100% | 0% | 100% | 100% |");
    expect(md).toContain("**recommended**: misses type-checks 50% < 100%; targeted 33% < 90%.");
    expect(md).toContain("- overdraw: should change exactly src/accounts/account-service.ts#AccountService.withdraw — failed (behavior)");
    expect(md).toContain("- overdraw (round 1): What should happen when the balance is too low?");
  });

  it("finds every step and input the bank-app edit set names, on a fresh description", async () => {
    // A plan that understands nothing fails each case right after setup: no case may fail before it.
    const provider = new FakeProvider((req) => (req.task === "edit-plan" ? plan(WITHDRAW, { kind: "unclear", interpretation: "?" }) : describeModel(req)));
    const result = await runEditEval({
      evalDir: EVAL_DIR, fixture: "bank-app", adapters: [typescriptAdapter], builtinRulesDir: RULES, provider,
      configs: [{ name: "recommended", tasks: { "edit-plan": "mid" } }], repeat: 1, judge: false, nodeModules: NODE_MODULES,
    });
    const cases = result.runs[0]!.cases;
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((c) => c.state !== "failed").map((c) => `${c.id}: ${c.error}`)).toEqual([]);
    expect(cases.every((c) => c.error?.startsWith("Sift could not tell what to change"))).toBe(true);
    // The matrix config moved edit-plan to mid.
    expect(provider.requests.find((q) => q.task === "edit-plan")!.model.model).toBe("claude-sonnet-5-5");
    expect(result.runs[0]!.models["edit-plan"]).toBe("claude-sonnet-5-5");
  });

  it("loads the edit set and the matrix, and rejects malformed cases", async () => {
    const cases = await loadEditCases(EVAL_DIR, "bank-app");
    const kinds = (f: (c: EditCase) => boolean) => cases.filter(f).length;
    expect(kinds((c) => c.set.length > 0)).toBeGreaterThanOrEqual(2);
    expect(kinds((c) => c.add.length > 0)).toBeGreaterThanOrEqual(1);
    expect(kinds((c) => c.delete.length > 0)).toBeGreaterThanOrEqual(1);
    expect(kinds((c) => c.expect.reword === true)).toBeGreaterThanOrEqual(1);
    expect(kinds((c) => c.expect.reword === false)).toBeGreaterThanOrEqual(1);
    expect(kinds((c) => c.expect.asks.length > 0)).toBeGreaterThanOrEqual(1);
    expect(kinds((c) => c.expect.broader === true)).toBeGreaterThanOrEqual(1);
    expect(cases.find((c) => c.id === "format-bigint")!.expect.changedUnits).toEqual(["src/accounts/money.ts#formatCents", "src/ui/balance-card.tsx#BalanceCard"]);
    expect((await loadMatrix(EVAL_DIR, "edits")).map((c) => c.name)).toEqual(["recommended", "edit-plan-on-mid"]);

    const dir = await mkdtemp(join(tmpdir(), "sift-editcases-"));
    await mkdir(join(dir, "edits"));
    await writeFile(
      join(dir, "edits/x.yaml"),
      "cases:\n  - id: a\n    unit: nohash\n  - id: b\n    unit: a.ts#f\n    expect: { kind: sideways }\n  - id: b\n    unit: a.ts#f\n    request: x\n    add: [{ text: t }]\n    expect: {}\n",
    );
    await expect(loadEditCases(dir, "x")).rejects.toMatchObject({
      details: [
        'cases[0] must have an "id" and a "unit" ("file#Symbol")',
        "cases[1] (b): asks for nothing (give a request or an edit)",
        "cases[1] (b).expect.kind must be behavior or reword",
        "cases[2] (b): duplicate id",
        'cases[2] (b).add[0] must have "text" and one of "after" (code), "inside" (code), or "first: true"',
      ],
    });
  });
});
