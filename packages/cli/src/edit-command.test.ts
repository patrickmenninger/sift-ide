import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProvider, readSiftFile, type ChangeRequest, type CompletionRequest } from "@sift/core";
import { EXIT } from "./program.js";
import { answer, fixtureCopy, sift } from "./test-helpers.js";

const SERVICE = "src/accounts/account-service.ts";
const WITHDRAW = `${SERVICE}#AccountService.withdraw`;

/** The new withdraw: a check before anything else. `extra` replaces the check's condition for broken variants. */
function withdrawCode(condition = "amountCents <= 0", name = "withdraw"): string {
  return `async ${name}(userId: string, accountId: string, amountCents: number): Promise<Account> {
  if (${condition}) {
    throw new ValidationError("Withdrawal amount must be positive");
  }
  const account = await this.repo.getAccount(accountId);
  if (account.ownerId !== userId) {
    throw new ForbiddenError("You can only withdraw from your own accounts");
  }
  account.balanceCents -= amountCents;
  await this.repo.save(account);
  return account;
}`;
}

interface Script {
  plan?: (req: CompletionRequest) => unknown;
  code?: (req: CompletionRequest) => unknown;
  verify?: (req: CompletionRequest) => unknown;
}

const behaviorPlan = (over: Record<string, unknown> = {}) => ({
  kind: "behavior",
  interpretation: "Reject a withdrawal of zero or less with a validation error before reading the account.",
  questions: [],
  warnings: [],
  allowedUnits: [{ unit: WITHDRAW, reason: "the edited unit" }],
  helpers: [],
  examples: [],
  broader: null,
  ...over,
});

/** A stand-in model: describes like `answer`, and plays the editing tasks from a script. */
function model(script: Script = {}): FakeProvider {
  return new FakeProvider((req) => {
    if (req.task === "edit-plan") return (script.plan ?? (() => behaviorPlan()))(req);
    if (req.task === "edit-code") return (script.code ?? (() => ({ units: [{ unit: WITHDRAW, text: withdrawCode() }], insertions: [], notes: "" })))(req);
    if (req.task === "edit-verify") return (script.verify ?? (() => ({ satisfied: true, gaps: [], unrequested: [] })))(req);
    return answer(req);
  });
}

async function described(provider: FakeProvider): Promise<string> {
  const dir = await fixtureCopy();
  const r = await sift(provider, "-C", dir, "generate", "src/accounts");
  expect(r.code).toBe(EXIT.ok);
  return dir;
}

const json = (out: string) => JSON.parse(out) as ChangeRequest;

describe("sift edit", { timeout: 90_000 }, () => {
  it("plans, writes, checks, and re-describes a change, applies it, and undoes it exactly", async () => {
    const provider = model();
    const dir = await described(provider);
    const original = await readFile(join(dir, SERVICE), "utf8");
    const originalSift = await readFile(join(dir, `.sift/${SERVICE}.sift`), "utf8");

    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less");
    expect(r.err).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toMatch(/^Change request e_[a-z2-7]{8} for src\/accounts\/account-service\.ts#AccountService\.withdraw/);
    expect(r.out).toContain("Plan (behavior): Reject a withdrawal of zero or less");
    expect(r.out).toContain('+    if (amountCents <= 0) {\n+      throw new ValidationError("Withdrawal amount must be positive");\n+    }');
    expect(r.out).toContain("✓ parses: passed");
    expect(r.out).toContain("✓ type-checks: passed");
    expect(r.out).toContain("✓ scope: passed");
    expect(r.out).toContain(`changes: ${WITHDRAW}`);
    expect(r.out).toContain("Matches the request.");
    // Nothing is written before approval.
    expect(await readFile(join(dir, SERVICE), "utf8")).toBe(original);

    // Routing: frontier for plan and code, mid for the re-derivation and the intent check.
    const byTask = (t: string) => provider.requests.filter((q) => q.task === t);
    expect(byTask("edit-plan")[0]!.model).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(byTask("edit-code")[0]!.model).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(byTask("edit-verify")[0]!.model.model).toBe("claude-sonnet-5-5");
    expect(byTask("edit-plan")[0]!.prompt).toContain("Request:\nReject amounts of zero or less");
    expect(byTask("edit-plan")[0]!.prompt).toContain("/*[0]*/ const account = await this.repo.getAccount(accountId);");
    expect(byTask("edit-code")[0]!.prompt).toContain(`## ${WITHDRAW} (method) — the edited unit`);
    expect(byTask("edit-code")[0]!.prompt).toContain("export interface Account {");
    const update = provider.requests.filter((q) => q.task === "update").at(-1)!;
    expect(update.prompt).toContain("What was asked: Reject a withdrawal of zero or less");
    expect(update.prompt).toContain('+   if (amountCents <= 0) {');

    const id = /e_[a-z2-7]{8}/.exec(r.out)![0];
    const req = json((await sift(provider, "-C", dir, "edit", "show", id, "--json")).out);
    expect(req.state).toBe("ready");
    expect(req.proposal!.units[0]!.logic.some((c) => c.field === "step" && c.change === "added")).toBe(true);

    const applied = await sift(provider, "-C", dir, "edit", "apply", id);
    expect(applied.err).toBe("");
    expect(applied.out).toContain(`Applied ${id}. Wrote:\n  ${SERVICE}\n  .sift/${SERVICE}.sift`);
    const now = await readFile(join(dir, SERVICE), "utf8");
    expect(now).toBe(req.proposal!.files[0]!.text);
    expect(now).toContain('  async withdraw(userId: string, accountId: string, amountCents: number): Promise<Account> {\n    if (amountCents <= 0) {');
    // The diff adds the check and changes nothing else.
    const diff = req.proposal!.files[0]!.diff.split("\n");
    expect(diff.filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toEqual(["+    if (amountCents <= 0) {", '+      throw new ValidationError("Withdrawal amount must be positive");', "+    }"]);
    expect(diff.filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);

    // The description matches the new code, so nothing in src/accounts is out of date (the rest was never described).
    const status = JSON.parse((await sift(provider, "-C", dir, "status", "--json")).out) as Record<string, string[]>;
    for (const list of ["changed", "contextChanged", "stale", "renamed", "deleted"]) expect(status[list]).toEqual([]);
    expect(status.new!.filter((u) => u.startsWith("src/accounts/"))).toEqual([]);

    const undo = await sift(provider, "-C", dir, "edit", "undo", id);
    expect(undo.err).toBe("");
    expect(await readFile(join(dir, SERVICE), "utf8")).toBe(original);
    expect(await readFile(join(dir, `.sift/${SERVICE}.sift`), "utf8")).toBe(originalSift);
    expect(json((await sift(provider, "-C", dir, "edit", "show", id, "--json")).out).state).toBe("undone");
  });

  it("asks the plan's questions, takes answers ahead of time, and folds them into the request", async () => {
    const provider = model({
      plan: (req) =>
        req.prompt.includes("Answers the person gave")
          ? behaviorPlan({ interpretation: "Stop with an error when the balance is lower than the amount." })
          : behaviorPlan({ kind: "unclear", questions: [{ id: "q1", text: "What happens when the balance is too low?", options: ["Stop with an error", "Withdraw what is there"] }] }),
      code: () => ({ units: [{ unit: WITHDRAW, text: withdrawCode() }], insertions: [], notes: "" }),
    });
    const dir = await described(provider);

    // Without an answer, it stops and says how to answer.
    const first = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Don't let people overdraw.");
    expect(first.code).toBe(EXIT.problems);
    expect(first.out).toContain("q1: What happens when the balance is too low?  [Stop with an error / Withdraw what is there]");
    const id = /e_[a-z2-7]{8}/.exec(first.out)![0];
    expect(first.out).toContain(`Answer with: sift edit answer ${id} q1="…"`);

    const answered = await sift(provider, "-C", dir, "edit", "answer", id, "q1=Stop with an error");
    expect(answered.err).toBe("");
    expect(answered.code).toBe(EXIT.ok);
    expect(answered.out).toContain("Q: What happens when the balance is too low?\n  A: Stop with an error");
    const replan = provider.requests.filter((q) => q.task === "edit-plan").at(-1)!;
    expect(replan.prompt).toContain("- Q: What happens when the balance is too low?\n  A: Stop with an error");
    expect(provider.requests.filter((q) => q.task === "update").at(-1)!.prompt).toContain('answered "Stop with an error"');

    // Ahead of time with --answer: one call, no stop.
    const ahead = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Don't let people overdraw.", "--answer", "q1=Stop with an error", "--json");
    expect(json(ahead.out).state).toBe("ready");
  });

  it("retries the code once with the type errors, then accepts code that type-checks", async () => {
    const provider = model({
      code: (req) => ({ units: [{ unit: WITHDRAW, text: req.prompt.includes("It had these problems") ? withdrawCode() : withdrawCode("amountCents <= minimumAmount") }], insertions: [], notes: "" }),
    });
    const dir = await described(provider);
    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less", "--json");
    const req = json(r.out);
    expect(req.state).toBe("ready");
    const code = provider.requests.filter((q) => q.task === "edit-code");
    expect(code).toHaveLength(2);
    expect(code[1]!.prompt).toMatch(/src\/accounts\/account-service\.ts:\d+:\d+ TS2304: Cannot find name 'minimumAmount'\./);
    expect(req.proposal!.checks.find((c) => c.kind === "type-check")!.status).toBe("passed");
    expect(req.usage.tasks["edit-code"]!.calls).toBe(2);
  });

  it("fails without retry when the code changes more than the request allows", async () => {
    const provider = model({ code: () => ({ units: [{ unit: WITHDRAW, text: withdrawCode("amountCents <= 0", "withdrawMoney") }], insertions: [], notes: "" }) });
    const dir = await described(provider);
    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less");
    expect(r.code).toBe(EXIT.problems);
    expect(r.out).toContain("Failed: The proposed code changed code outside the request, so it was rejected.");
    expect(r.out).toContain(`- ${WITHDRAW} was renamed or removed; keep its name.`);
    expect(r.out).toContain(`- ${SERVICE}#AccountService.withdrawMoney is new, but the plan did not name it as a helper.`);
    expect(provider.requests.filter((q) => q.task === "edit-code")).toHaveLength(1);
  });

  it("accepts an accurate rewording without touching code, and rejects a false one", async () => {
    const verify = (req: CompletionRequest) =>
      req.prompt.includes("checks the balance")
        ? { satisfied: false, gaps: ["The code does not check the balance."], unrequested: [] }
        : { satisfied: true, gaps: [], unrequested: [] };
    const provider = model({ plan: () => behaviorPlan({ kind: "reword", interpretation: "Only the wording changes.", allowedUnits: [] }), verify });
    const dir = await described(provider);
    const unit = (await readSiftFile(dir, SERVICE))!.file.units.find((u) => u.symbol === "AccountService.withdraw")!;
    const step = unit.steps[0]!;
    const code = await readFile(join(dir, SERVICE), "utf8");

    const ok = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--step", step.id, "--text", "Load the account to withdraw from.", "--apply");
    expect(ok.err).toBe("");
    expect(ok.out).toContain("Code: unchanged (only the wording changes).");
    expect(ok.out).toContain(`~ step ${step.id}: "${step.text}" → "Load the account to withdraw from."`);
    expect(ok.out).toContain("Wrote:\n  .sift/src/accounts/account-service.ts.sift");
    expect(await readFile(join(dir, SERVICE), "utf8")).toBe(code);
    const after = (await readSiftFile(dir, SERVICE))!.file;
    expect(after.sift).toBe(1);
    expect(after.units.find((u) => u.symbol === "AccountService.withdraw")!.steps[0]).toMatchObject({ id: step.id, status: "user-edited", text: "Load the account to withdraw from." });
    expect(provider.requests.some((q) => q.task === "edit-code")).toBe(false);

    const bad = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--step", step.id, "--text", "Load the account and checks the balance.");
    expect(bad.code).toBe(EXIT.problems);
    expect(bad.out).toContain("Failed: The new wording does not match what the code does, so it was not accepted.");
    expect(bad.out).toContain("  - The code does not check the balance.");
  });

  it("marks a pending edit for review when its code changes, and refuses to undo over later changes", async () => {
    const provider = model();
    const dir = await described(provider);
    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less", "--json");
    const id = json(r.out).id;
    const original = await readFile(join(dir, SERVICE), "utf8");

    await writeFile(join(dir, SERVICE), original.replace("account.balanceCents -= amountCents;", "account.balanceCents -= amountCents * 1;"));
    const list = await sift(provider, "-C", dir, "edit", "list");
    expect(list.out).toContain(`${id}  needs-review`);
    const refused = await sift(provider, "-C", dir, "edit", "apply", id);
    expect(refused.code).toBe(EXIT.error);
    expect(refused.err).toContain("is needs-review and cannot be applied. The code changed since this edit was written.");

    // Undo refuses once a file it wrote has changed since.
    await writeFile(join(dir, SERVICE), original);
    const out = (await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less", "--apply")).out;
    const again = { id: /Applied (e_[a-z2-7]{8})/.exec(out)![1]! };
    const applied = await readFile(join(dir, SERVICE), "utf8");
    await writeFile(join(dir, SERVICE), `${applied}\n// later change\n`);
    const undo = await sift(provider, "-C", dir, "edit", "undo", again.id);
    expect(undo.code).toBe(EXIT.error);
    expect(undo.err).toContain(`Cannot undo ${again.id}: these files changed after it was applied.`);
    expect(undo.err).toContain(`  - ${SERVICE}`);
    expect(await readFile(join(dir, SERVICE), "utf8")).toBe(`${applied}\n// later change\n`);
    expect(existsSync(join(dir, ".sift/edits/applied", `${again.id}.json`))).toBe(true);
  });

  it("runs configured checks only when asked, against a copy of the project with the change", async () => {
    const provider = model();
    const dir = await described(provider);
    await writeFile(join(dir, "check.cjs"), 'const t = require("fs").readFileSync("src/accounts/account-service.ts", "utf8");\nprocess.exit(t.includes("amountCents <= 0) {") ? 0 : 3);\n');
    const config = join(dir, "sift.config.yaml");
    await writeFile(config, `${await readFile(config, "utf8")}edit:\n  checks:\n    - { name: has-check, command: node check.cjs }\n    - name: fails\n      command: 'node -e "process.exit(3)"'\n    - sift-no-such-command-xyz\n`);

    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less");
    expect(r.out).toContain("– has-check: skipped");
    const id = /e_[a-z2-7]{8}/.exec(r.out)![0];

    const checked = await sift(provider, "-C", dir, "edit", "checks", id, "--json");
    const checks = json(checked.out).proposal!.checks.filter((c) => c.kind === "command");
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["has-check", "passed"],
      ["fails", "failed"],
      ["sift-no-such-command-xyz", "unavailable"],
    ]);
    // The project itself is untouched.
    expect(await readFile(join(dir, SERVICE), "utf8")).not.toContain("amountCents <= 0) {");
  });

  it("requires a second confirmation for a change that reaches beyond the edited unit", async () => {
    const deposit = `${SERVICE}#AccountService.deposit`;
    const provider = model({
      plan: () => behaviorPlan({ allowedUnits: [{ unit: WITHDRAW, reason: "the edited unit" }, { unit: deposit, reason: "same check" }], broader: { reason: "Deposits need the same check.", units: [deposit] } }),
    });
    const dir = await described(provider);
    const r = await sift(provider, "-C", dir, "edit", "AccountService.withdraw", "--request", "Reject amounts of zero or less");
    expect(r.out).toContain("BROADER CHANGE: Deposits need the same check.");
    const id = /e_[a-z2-7]{8}/.exec(r.out)![0];
    const refused = await sift(provider, "-C", dir, "edit", "apply", id);
    expect(refused.code).toBe(EXIT.error);
    expect(refused.err).toContain("Confirm the broader change to apply it.");
    const ok = await sift(provider, "-C", dir, "edit", "apply", id, "--confirm-broader");
    expect(ok.err).toBe("");
    expect(ok.code).toBe(EXIT.ok);
  });
});
