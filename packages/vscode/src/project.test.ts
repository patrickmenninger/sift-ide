import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeLabel } from "./graph-labels.js";
import { Project } from "./project.js";
import { fixtureCopy, inProcessServer } from "./test-support.js";

const SERVICE = "src/accounts/account-service.ts";

const waitFor = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Project", () => {
  it("keeps the status current, coalescing refreshes, and finds the unit at a position", async () => {
    const dir = await fixtureCopy();
    const server = inProcessServer(dir);
    const project = new Project(dir, { launch: server.launch, log: () => {}, debounceMs: 20 });
    let updates = 0;
    project.onDidChangeStatus(() => updates++);

    // Overlapping refreshes run once more, not once each.
    await Promise.all([project.refreshStatus(), project.refreshStatus(), project.refreshStatus()]);
    expect(updates).toBe(2);
    expect(project.outOfDate).toBe(project.status!.new.length);
    expect(project.files.has(SERVICE)).toBe(true);

    // Descriptions written through the server update the status (sift/didChange).
    updates = 0;
    await project.server.request("sift/generate", { paths: [SERVICE] });
    await waitFor(() => !project.files.has(SERVICE));
    expect(updates).toBeGreaterThan(0);

    // A source edit is picked up by a scheduled refresh; bursts make one request.
    const path = join(dir, SERVICE);
    await writeFile(path, (await readFile(path, "utf8")).replace("amountCents <= 0", "amountCents < 1"));
    updates = 0;
    project.scheduleRefresh();
    project.scheduleRefresh();
    await waitFor(() => updates > 0);
    // Let a second (unwanted) refresh show up if the burst was not coalesced.
    await new Promise((r) => setTimeout(r, 200));
    expect(updates).toBe(1);
    expect(project.entries.filter((e) => e.kind === "changed").map((e) => e.unit)).toEqual([`${SERVICE}#AccountService.deposit`]);

    expect(project.relative(join(dir, "src", "a.ts"))).toBe("src/a.ts");
    expect(project.relative(join(dir, "..", "elsewhere.ts"))).toBeNull();

    const extraction = await project.server.request("sift/extraction", { source: SERVICE });
    const transfer = extraction.units.find((u) => u.symbol === "AccountService.transferFunds")!;
    const inside = { line: transfer.range.start.line + 2, col: 5 };
    expect((await project.unitAt(SERVICE, inside))?.ref).toBe(`${SERVICE}#AccountService.transferFunds`);
    // Outside any function, in a file with no top-level code: nothing.
    expect(await project.unitAt(SERVICE, { line: 1, col: 1 })).toBeNull();
    expect(nodeLabel(`${SERVICE}#AccountService.deposit`)).toEqual({ label: "AccountService.deposit", description: SERVICE, kind: "unit" });
    expect(nodeLabel("route:POST /transfers")).toEqual({ label: "POST /transfers", description: "route", kind: "route" });
    project.dispose();
  }, 90_000);
});
