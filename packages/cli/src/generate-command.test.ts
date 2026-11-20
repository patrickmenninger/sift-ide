import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

/**
 * A stand-in model that reads the prompt like a model would: it answers with the parameter names it
 * was given and one step per top-level structure key, so every response is valid.
 */
function answer(req: CompletionRequest, tweak: { dropKey?: string } = {}): Record<string, unknown> {
  const p = req.prompt;
  const unit = unitOf(req);
  const names = [...(/\nInputs[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]!);
  const returnsType = /\nReturns: (.+)/.exec(p)![1]!;
  const returns = /^(nothing|void|Promise<void>)/.test(returnsType) ? null : { meaning: `What ${unit} returns.` };
  const base = { summary: `Does what ${unit} does.`, inputs: names.map((n) => ({ name: n, meaning: `The ${n}.` })), returns };
  if (req.task === "describe-lite") return { ...base, warnings: [] };

  const keys = [...(/Structure keys[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- ([^:]+): (\w+)/gm)].map((m) => ({ key: m[1]!, kind: m[2]! }));
  const steps = keys
    .filter((k) => !k.key.includes(".") && k.key !== tweak.dropKey)
    .map((k) => ({ kind: ["if", "loop", "switch", "try"].includes(k.kind) ? k.kind : null, text: `Handle part ${k.key}.`, covers: [k.key], steps: [] }));
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
    expect(r.out).toContain("Describing 29 units in 12 files…");
    expect(r.out).toMatch(/✓ src\/accounts\/money\.ts#formatCents {2}describe-lite · claude-haiku-5-5 · \d/);
    expect(r.out).toContain("Described 29 of 29 units. Wrote 12 .sift files.");
    expect(r.out).toContain("1 warning raised");

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
      generatedBy: { provider: "claude-code", model: "claude-opus-5-5", prompt: "describe@1", belowTier: false },
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
    expect(again.out).toContain("Nothing to describe");
    expect(provider.requests.length).toBe(calls);
    expect(await readFile(join(dir, ".sift/src/accounts/account-service.ts.sift"), "utf8")).toBe(before);

    // A changed unit is kept and reported; --force describes it again with the same ID.
    const source = join(dir, "src/accounts/money.ts");
    await writeFile(source, (await readFile(source, "utf8")).replace("Math.floor", "Math.round"));
    const changed = await sift(provider, "-C", dir, "generate", "src/accounts/money.ts");
    expect(changed.out).toContain("changed: src/accounts/money.ts#applyMonthlyInterest");
    const oldId = idOf(money, "applyMonthlyInterest");
    const forced = await sift(provider, "-C", dir, "generate", "--force", "src/accounts/money.ts");
    expect(forced.out).toContain("Described 3 of 3 units.");
    expect(idOf((await readSiftFile(dir, "src/accounts/money.ts"))!.file, "applyMonthlyInterest")).toBe(oldId);
  }, 60_000);

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
    expect(unit.generatedBy).toEqual({ provider: "claude-code", model: "claude-sonnet-5-5", prompt: "describe@1", belowTier: true });
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
        "Would describe 3 units:",
        "  src/accounts/money.ts#formatCents  describe-lite · claude-haiku-5-5 (low)",
        "  src/accounts/money.ts#toCents  describe-lite · claude-haiku-5-5 (low)",
        "  src/accounts/money.ts#applyMonthlyInterest  describe · claude-opus-5-5 (medium)",
      ].join("\n"),
    );
    expect(provider.requests).toHaveLength(0);

    const missing = await sift(provider, "-C", dir, "generate", "src/nope");
    expect(missing.code).toBe(EXIT.error);
    expect(missing.err).toContain('No source files match "src/nope".');
  }, 60_000);
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
