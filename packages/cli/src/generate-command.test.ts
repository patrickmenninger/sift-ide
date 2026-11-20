import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeProvider, readSiftFile, SiftError, type CompletionRequest, type FakeResponder } from "@sift/core";
import { EXIT, run } from "./program.js";

const FIXTURE = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));
const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));

async function fixtureCopy(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "sift-gen-")), "bank-app");
  await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(".cache") });
  await symlink(NODE_MODULES, join(dir, "node_modules"), "junction");
  return dir;
}

async function sift(provider: FakeProvider, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, { provider });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const unitOf = (req: CompletionRequest) => /^Unit: (.+) \(/m.exec(req.prompt)![1]!;

/** The previous description shown in an update prompt, if any. */
function previousOf(req: CompletionRequest): { steps?: { id: string; covers: string[] }[] } | null {
  const m = /Previous description[^\n]*\n```json\n([\s\S]*?)\n```/.exec(req.prompt);
  return m ? (JSON.parse(m[1]!) as { steps?: { id: string; covers: string[] }[] }) : null;
}

/**
 * A stand-in model that reads the prompt like a model would: it answers with the parameter names it
 * was given and one step per top-level structure key, so every response is valid.
 */
function answer(req: CompletionRequest, tweak: { dropKey?: string; summary?: string } = {}): Record<string, unknown> {
  const p = req.prompt;
  const unit = unitOf(req);
  if (req.task === "context-check") return { summary: null, steps: [] };
  const names = [...(/\nInputs[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]!);
  const returnsType = /\nReturns: (.+)/.exec(p)![1]!;
  const returns = /^(nothing|void|Promise<void>)/.test(returnsType) ? null : { meaning: `What ${unit} returns.` };
  const base = { summary: tweak.summary ?? `Does what ${unit} does.`, inputs: names.map((n) => ({ name: n, meaning: `The ${n}.` })), returns };
  if (req.task === "describe-lite") return { ...base, warnings: [] };

  const keys = [...(/Structure keys[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- ([^:]+): (\w+)/gm)].map((m) => ({ key: m[1]!, kind: m[2]! }));
  const steps = keys
    .filter((k) => !k.key.includes(".") && k.key !== tweak.dropKey)
    .map((k) => ({ kind: ["if", "loop", "switch", "try"].includes(k.kind) ? k.kind : null, text: `Handle part ${k.key}.`, covers: [k.key], steps: [] as unknown[], id: null as string | null }));
  // An update keeps the ID of the previous step that covered the same key.
  const previous = previousOf(req);
  for (const s of steps) s.id = previous?.steps?.find((q) => q.covers[0] === s.covers[0])?.id ?? null;
  if (req.task !== "update") for (const s of steps) delete (s as { id?: unknown }).id;
  const warnings = unit === "AccountService.transferFunds" ? [{ kind: "missing-transaction", text: "The two saves are not in a transaction.", covers: ["5", "6"] }] : [];
  return { ...base, steps, warnings };
}

describe("sift generate", () => {
  it("describes every unit, callees first, and writes valid .sift files with derived calls and effects", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => answer(req));
    const r = await sift(provider, "-C", dir, "generate");
    expect(r.err).toBe("");
    expect(r.out).not.toContain("✗");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Using claude-code; code stays on this machine."); // the fake provider is local
    expect(r.out).toContain("Describing or updating 29 units in 12 files…");
    expect(r.out).toMatch(/✓ src\/accounts\/money\.ts#formatCents {2}describe-lite · claude-haiku-5-5 · \d/);
    expect(r.out).toContain("Described 29 new units.\nWrote 12 .sift files.");
    expect(r.out).toContain("1 warning in the new and updated descriptions");

    // Callees are described before their callers, and callers see the callees' summaries.
    const order = provider.requests.map(unitOf);
    expect(order.indexOf("PrismaAccountRepository.save")).toBeLessThan(order.indexOf("AccountService.transferFunds"));
    expect(order.indexOf("AccountService.transferFunds")).toBeLessThan(order.indexOf("createRouter"));
    const transferPrompt = provider.requests.find((q) => unitOf(q) === "AccountService.transferFunds")!.prompt;
    expect(transferPrompt).toContain("implemented by PrismaAccountRepository.save: Does what PrismaAccountRepository.save does.");

    const service = (await readSiftFile(dir, "src/accounts/account-service.ts"))!.file;
    const prisma = (await readSiftFile(dir, "src/accounts/prisma-account-repository.ts"))!.file;
    const memory = (await readSiftFile(dir, "src/accounts/in-memory-account-repository.ts"))!.file;
    const idOf = (file: typeof service, symbol: string) => file.units.find((u) => u.symbol === symbol)!.id;
    const transfer = service.units.find((u) => u.symbol === "AccountService.transferFunds")!;
    expect(transfer).toMatchObject({
      status: "generated",
      effects: ["db.read", "db.write", "event.emit", "throws"],
      generatedBy: { provider: "claude-code", model: "claude-opus-5-5", prompt: "describe@2", belowTier: false },
    });
    expect(transfer.contextHash).toMatch(/^[0-9a-f]{16}$/);
    const saveFrom = transfer.steps.find((s) => s.covers.includes("5"))!;
    expect(saveFrom).toMatchObject({ effects: ["db.write"], calls: [idOf(memory, "InMemoryAccountRepository.save"), idOf(prisma, "PrismaAccountRepository.save")] });
    expect(transfer.steps.find((s) => s.covers.includes("1"))).toMatchObject({ kind: "if", calls: [], effects: ["throws"] });
    expect(transfer.warnings).toEqual([{ id: expect.stringMatching(/^w_/), kind: "missing-transaction", text: "The two saves are not in a transaction.", steps: [saveFrom.id, transfer.steps.find((s) => s.covers.includes("6"))!.id] }]);

    const money = (await readSiftFile(dir, "src/accounts/money.ts"))!.file;
    expect(money.units.map((u) => [u.symbol, u.lite ?? false, u.steps.length > 0])).toEqual([
      ["formatCents", true, false],
      ["toCents", true, false],
      ["applyMonthlyInterest", false, true],
    ]);

    const show = await sift(provider, "-C", dir, "show", "src/accounts/account-service.ts#AccountService.transferFunds");
    expect(show.out).toContain("→ src/accounts/in-memory-account-repository.ts#InMemoryAccountRepository.save, src/accounts/prisma-account-repository.ts#PrismaAccountRepository.save");
    expect(show.out).toContain("! missing-transaction (step 6, 7): The two saves are not in a transaction.");

    // Nothing left to do: no AI calls, no file changes.
    const before = await readFile(join(dir, ".sift/src/accounts/account-service.ts.sift"), "utf8");
    const calls = provider.requests.length;
    const again = await sift(provider, "-C", dir, "generate");
    expect(again.out).toContain("Nothing to do: every description matches the code.");
    expect(provider.requests.length).toBe(calls);
    expect(await readFile(join(dir, ".sift/src/accounts/account-service.ts.sift"), "utf8")).toBe(before);

    // --force describes units again from scratch, keeping their IDs.
    const oldId = idOf(money, "applyMonthlyInterest");
    const forced = await sift(provider, "-C", dir, "generate", "--force", "src/accounts/money.ts");
    expect(forced.out).toContain("Described 3 new units.");
    expect(idOf((await readSiftFile(dir, "src/accounts/money.ts"))!.file, "applyMonthlyInterest")).toBe(oldId);
  }, 60_000);

  it("syncs after edits: updates changed units, follows renames and moves, removes deleted units, re-checks callers", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => {
      const unit = unitOf(req);
      if (req.task === "update" && unit === "PrismaAccountRepository.getAccount") return answer(req, { summary: "Reads an account, failing if it is missing." });
      if (req.task === "context-check" && unit === "AccountService.withdraw") return { summary: "Withdraws money from an account the user owns.", steps: [] };
      return answer(req);
    });
    expect((await sift(provider, "-C", dir, "generate")).code).toBe(EXIT.ok);
    const inSync = await sift(provider, "-C", dir, "check");
    expect(inSync.code).toBe(EXIT.ok);
    expect(inSync.out).toContain("In sync: 29 described units match the code.");

    const read = async (f: string) => (await readSiftFile(dir, f))!.file;
    type File = Awaited<ReturnType<typeof read>>;
    const unit = (file: File, symbol: string) => file.units.find((u) => u.symbol === symbol)!;
    const before = {
      money: await read("src/accounts/money.ts"),
      routes: await read("src/http/routes.ts"),
      report: await read("src/legacy/report.js"),
      service: await read("src/accounts/account-service.ts"),
    };

    // A person edited withdraw's description.
    const servicePath = join(dir, ".sift/src/accounts/account-service.ts.sift");
    const serviceText = await readFile(servicePath, "utf8");
    const edited = serviceText.replace(/(symbol: AccountService\.withdraw\n\s+kind: \w+\n\s+status: )generated/, "$1user-edited");
    expect(edited).not.toBe(serviceText);
    await writeFile(servicePath, edited);

    // Code edits: a change, a deletion, a rename (and its caller), a callee whose summary will change, a file move.
    const edit = async (file: string, from: string, to: string) => {
      const path = join(dir, file);
      const text = await readFile(path, "utf8");
      expect(text).toContain(from);
      await writeFile(path, text.replace(from, to));
    };
    await edit("src/accounts/money.ts", "Math.floor", "Math.round");
    await edit("src/accounts/money.ts", "export const toCents = (dollars: number): number => Math.round(dollars * 100);\n", "");
    await edit("src/http/routes.ts", "function statusFor(", "function httpStatusFor(");
    await edit("src/http/routes.ts", "res.status(statusFor(error))", "res.status(httpStatusFor(error))");
    await edit("src/accounts/prisma-account-repository.ts", "does not exist`", "was not found`");
    await mkdir(join(dir, "src/reports"));
    await rename(join(dir, "src/legacy/report.js"), join(dir, "src/reports/report.js"));

    const status = await sift(provider, "-C", dir, "check");
    expect(status.code).toBe(EXIT.problems);
    expect(status.out).toContain(
      [
        "Changed since described (3) — generate updates them:",
        "  src/accounts/money.ts#applyMonthlyInterest",
        "  src/accounts/prisma-account-repository.ts#PrismaAccountRepository.getAccount",
        "  src/http/routes.ts#createRouter",
        "Deleted from the source (1) — generate removes them:",
        "  src/accounts/money.ts#toCents",
      ].join("\n"),
    );
    expect(status.out).toMatch(/probably renamed \(\d+% similar\): src\/http\/routes\.ts#statusFor → src\/http\/routes\.ts#httpStatusFor/);
    expect(status.out).toContain("Files moved (1) — generate moves their .sift files:\n  src/legacy/report.js → src/reports/report.js");
    expect(status.out).toContain("Out of sync");
    const plan = await sift(provider, "-C", dir, "generate", "--dry-run");
    expect(plan.out).toContain("src/http/routes.ts#httpStatusFor  renamed and changed · update · claude-opus-5-5 (medium)");
    expect(plan.out).toContain("5 units may get a context check");

    const calls = provider.requests.length;
    const sync = await sift(provider, "-C", dir, "generate");
    expect(sync.err).toBe("");
    expect(sync.code).toBe(EXIT.ok);
    const asked = provider.requests.slice(calls);
    expect(asked.filter((q) => q.task === "update").map(unitOf).sort()).toEqual(["PrismaAccountRepository.getAccount", "applyMonthlyInterest", "createRouter", "httpStatusFor"]);
    expect(asked.filter((q) => q.task === "context-check").map(unitOf).sort()).toEqual([
      "AccountService.deposit", "AccountService.getBalance", "AccountService.transferFunds", "AccountService.withdraw",
    ]);
    expect(asked.length).toBe(8);

    // The update prompt shows the previous description and the code change.
    const update = asked.find((q) => unitOf(q) === "applyMonthlyInterest")!;
    expect(update.promptVersion).toBe("update@2");
    expect(update.prompt).toContain('"summary": "Does what applyMonthlyInterest does."');
    expect(update.prompt).toContain("-   const interest = Math.floor(");
    expect(update.prompt).toContain("+   const interest = Math.round(");
    // The context check shows the callee summary before and after.
    const check = asked.find((q) => unitOf(q) === "AccountService.transferFunds")!;
    expect(check.prompt).toContain("before: Does what PrismaAccountRepository.getAccount does.\n  now: Reads an account, failing if it is missing.");

    const after = {
      money: await read("src/accounts/money.ts"),
      routes: await read("src/http/routes.ts"),
      report: await read("src/reports/report.js"),
      service: await read("src/accounts/account-service.ts"),
    };
    // IDs survive updates, renames, and moves; kept steps keep theirs.
    const interest = unit(after.money, "applyMonthlyInterest");
    expect(interest.id).toBe(unit(before.money, "applyMonthlyInterest").id);
    expect(interest.steps.map((s) => s.id)).toEqual(unit(before.money, "applyMonthlyInterest").steps.map((s) => s.id));
    expect(interest.generatedBy?.prompt).toBe("update@2");
    expect(after.money.units.map((u) => u.symbol)).toEqual(["formatCents", "applyMonthlyInterest"]);
    expect(unit(after.routes, "httpStatusFor").id).toBe(unit(before.routes, "statusFor").id);
    const routerCalls = unit(after.routes, "createRouter").steps.flatMap(function all(s): string[] {
      return [...s.calls, ...s.steps.flatMap(all)];
    });
    expect(routerCalls).toContain(unit(before.routes, "statusFor").id);
    expect(after.report.units.map((u) => u.id)).toEqual(before.report.units.map((u) => u.id));
    expect(existsSync(join(dir, ".sift/src/legacy/report.js.sift"))).toBe(false);
    // Callers were re-checked: their contextHash follows the new summary; the person's wording went to review.
    const transfer = unit(after.service, "AccountService.transferFunds");
    expect(transfer.contextHash).not.toBe(unit(before.service, "AccountService.transferFunds").contextHash);
    expect(transfer.status).toBe("generated");
    expect(unit(after.service, "AccountService.withdraw")).toMatchObject({ status: "stale", summary: "Withdraws money from an account the user owns." });
    expect(sync.out).toContain("review: src/accounts/account-service.ts#AccountService.withdraw");
    expect(sync.out).toContain("file moved: src/legacy/report.js → src/reports/report.js");
    expect(sync.out).toContain("deleted: src/accounts/money.ts#toCents");

    // Only the unit waiting for review is left; nothing more to send to the AI.
    const final = await sift(provider, "-C", dir, "check");
    expect(final.code).toBe(EXIT.problems);
    expect(final.out).toContain("Marked stale (1)");
    expect(final.out).not.toContain("Changed since described");
    const count = provider.requests.length;
    await sift(provider, "-C", dir, "generate");
    expect(provider.requests.length).toBe(count);
  }, 90_000);

  it("retries once with the problems, writes incomplete units as stale, and keeps going after failures", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req, attempt) => {
      const unit = unitOf(req);
      if (unit === "toCents") return { summary: 42 };
      if (unit === "applyMonthlyInterest") return answer(req, { dropKey: "0" });
      if (unit === "onTransferCompleted" && attempt === 1) return answer(req, { dropKey: "1" });
      return answer(req);
    });
    const r = await sift(provider, "-C", dir, "generate", "src/accounts/money.ts", "src/notifications");
    expect(r.code).toBe(EXIT.problems);
    expect(r.out).toContain("✗ src/accounts/money.ts#toCents: the response did not pass validation after one retry");
    expect(r.out).toContain("summary must be a non-empty string.");
    expect(r.out).toMatch(/✓ src\/notifications\/notifier\.ts#onTransferCompleted .* · after a retry/);
    expect(r.out).toContain("stale: src/accounts/money.ts#applyMonthlyInterest (no step covers 0)");
    const retry = provider.requests.filter((q) => unitOf(q) === "onTransferCompleted")[1]!;
    expect(retry.prompt).toContain("Your previous response had these problems. Return a corrected JSON object.\n- These structure keys are not covered by any step: 1");

    const money = (await readSiftFile(dir, "src/accounts/money.ts"))!.file;
    expect(money.units.map((u) => [u.symbol, u.status])).toEqual([["formatCents", "generated"], ["applyMonthlyInterest", "stale"]]);
  }, 60_000);

  it("falls back to the next tier when a model is unavailable, and records it", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => {
      if (req.model.model === "claude-opus-5-5") throw new SiftError("MODEL_UNAVAILABLE", "no access to opus");
      return answer(req);
    });
    const r = await sift(provider, "-C", dir, "generate", "src/accounts/money.ts");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("! claude-sonnet-5-5 is used instead of the frontier tier: no access to opus");
    expect(provider.requests.filter((q) => q.model.model === "claude-opus-5-5")).toHaveLength(1);
    const unit = (await readSiftFile(dir, "src/accounts/money.ts"))!.file.units.find((u) => u.symbol === "applyMonthlyInterest")!;
    expect(unit.generatedBy).toEqual({ provider: "claude-code", model: "claude-sonnet-5-5", prompt: "describe@2", belowTier: true });
  }, 60_000);

  it("stops when Claude Code is not logged in, without writing anything", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider(() => {
      throw new SiftError("PROVIDER_AUTH", "Claude Code is not logged in. Run `claude` in a terminal, log in, then run this again.");
    });
    const r = await sift(provider, "-C", dir, "generate", "src/accounts/money.ts");
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toContain("Claude Code is not logged in");
    expect(existsSync(join(dir, ".sift/src/accounts/money.ts.sift"))).toBe(false);
  }, 60_000);

  it("plans without calling the AI, and rejects paths that match nothing", async () => {
    const dir = await fixtureCopy();
    const provider = new FakeProvider((req) => answer(req));
    const plan = await sift(provider, "-C", dir, "generate", "--dry-run", "src/accounts/money.ts");
    expect(plan.out).toBe(
      [
        "Would describe or update 3 units:",
        "  src/accounts/money.ts#formatCents  new · describe-lite · claude-haiku-5-5 (low)",
        "  src/accounts/money.ts#toCents  new · describe-lite · claude-haiku-5-5 (low)",
        "  src/accounts/money.ts#applyMonthlyInterest  new · describe · claude-opus-5-5 (medium)",
      ].join("\n"),
    );
    expect(provider.requests).toHaveLength(0);

    const missing = await sift(provider, "-C", dir, "generate", "src/nope");
    expect(missing.code).toBe(EXIT.error);
    expect(missing.err).toContain('No source files match "src/nope".');
  }, 60_000);
});

describe("sift eval", () => {
  it("runs the harness on the fixture and prints the summary table", async () => {
    const provider = new FakeProvider((req) => answer(req));
    const r = await sift(provider, "eval", "--no-judge", "--no-churn", "--no-save", "--tier", "describe=mid");
    expect(r.err).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Evaluating bank-app: describe=mid, 1 run each, no judge, no churn.");
    expect(r.out).toContain("| describe=mid | claude-sonnet-5-5 / claude-haiku-5-5 / claude-opus-5-5 / claude-haiku-5-5 | 100% | 0 |");
    expect(r.out).toContain("No judge: mentions and accuracy were not scored");
    expect(provider.requests.filter((q) => q.task === "describe").every((q) => q.model.model === "claude-sonnet-5-5")).toBe(true);

    const bad = await sift(provider, "eval", "--tier", "describe=huge");
    expect(bad.code).toBe(EXIT.error);
    expect(bad.err).toContain('--tier takes task=tier, such as describe=mid; got "describe=huge".');
  }, 90_000);
});

describe("sift models", () => {
  it("shows task → tier → model with the source of each override", async () => {
    const dir = await fixtureCopy();
    await writeFile(join(dir, "sift.config.yaml"), "models:\n  tasks:\n    describe: mid\n");
    const r = await sift(new FakeProvider(() => ({})), "-C", dir, "models");
    expect(r.out).toContain("describe       mid (config)  claude-sonnet-5-5  medium  frontier · below recommended");
    expect(r.out).toContain("describe-lite  small         claude-haiku-5-5   low     small");
  });
});
