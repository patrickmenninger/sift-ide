import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AdapterProject } from "@sift/core";
import { typescriptAdapter } from "./index.js";

/** Overlays for edit validation (phase-2-design §8.10) and an open project that follows the disk (§4). */

const FIXTURE = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));
const SERVICE = "src/accounts/account-service.ts";

let project: AdapterProject;
let text: string;

beforeAll(async () => {
  project = await typescriptAdapter.openProject(FIXTURE, [], { liteMaxStatements: 3 });
  text = await readFile(join(FIXTURE, SERVICE), "utf8");
});

describe("extractText", () => {
  it("equals extractFile for the same text, and sees a changed text without touching disk", () => {
    expect(project.extractText!(SERVICE, text)).toEqual(project.extractFile(SERVICE));
    const changed = project.extractText!(SERVICE, text.replace("account.balanceCents -= amountCents;", "account.balanceCents -= amountCents + 1;"));
    const before = project.extractFile(SERVICE);
    const withdraw = (e: typeof before) => e.units.find((u) => u.symbol === "AccountService.withdraw")!;
    expect(withdraw(changed).bodyHash).not.toBe(withdraw(before).bodyHash);
    // Other units keep their hashes.
    expect(changed.units.find((u) => u.symbol === "AccountService.deposit")!.bodyHash).toBe(before.units.find((u) => u.symbol === "AccountService.deposit")!.bodyHash);
  });
});

describe("diagnostics", () => {
  it("reports only what the overlay adds, in the file and in files that import it", () => {
    expect(project.diagnostics!(new Map([[SERVICE, text]]), [SERVICE])).toEqual([]);

    const broken = text.replace("if (amountCents <= 0 || amountCents > 10_000_000) {", "if (amountCents <= minimum) {");
    const found = project.diagnostics!(new Map([[SERVICE, broken]]), [SERVICE]);
    expect(found).toEqual([
      { file: SERVICE, range: expect.objectContaining({ start: expect.objectContaining({ line: 30 }) }), message: "Cannot find name 'minimum'.", code: "TS2304", severity: "error" },
    ]);

    // A changed signature breaks a caller in another file, which imports this one.
    const signature = text.replace("async getBalance(accountId: string): Promise<number> {", "async getBalance(accountId: string, currency: string): Promise<number> {");
    const callers = project.diagnostics!(new Map([[SERVICE, signature]]), [SERVICE]);
    expect(callers.map((d) => [d.file, d.code])).toEqual([["src/http/routes.ts", "TS2554"]]);
  });

  it("reports syntax errors", () => {
    const found = project.diagnostics!(new Map([[SERVICE, text.replace("return account.balanceCents;", "return account.balanceCents +;")]]), []);
    expect(found.map((d) => d.code)).toEqual(["TS1109"]);
  });
});

describe("refresh", () => {
  it("follows edits on disk, and asks to be reopened when tsconfig changes", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "sift-overlay-")), "bank-app");
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(".cache") && !src.includes(".sift") });
    const open = await typescriptAdapter.openProject(dir, [], { liteMaxStatements: 3 });
    const before = open.extractFile(SERVICE).units.map((u) => u.symbol);
    await writeFile(join(dir, SERVICE), text.replace("  async getBalance(", "  async ping(): Promise<void> {}\n\n  async getBalance("));
    expect(open.refresh!([SERVICE])).toBe(true);
    expect(open.extractFile(SERVICE).units.map((u) => u.symbol)).toEqual([...before.slice(0, 4), "AccountService.ping", ...before.slice(4)]);

    const tsconfig = join(dir, "tsconfig.json");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(tsconfig, `${await readFile(tsconfig, "utf8")}\n`);
    expect(open.refresh!([SERVICE])).toBe(false);
  });
});
