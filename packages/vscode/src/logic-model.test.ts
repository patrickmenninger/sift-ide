import { describe, expect, it } from "vitest";
import type { NavTarget, SiftStep } from "@sift/core";
import { logicOfSource, planNavigation, sourceOfLogic } from "./logic-model.js";
import { ServerProcess } from "./server-process.js";
import { fixtureCopy, inProcessServer } from "./test-support.js";

const SERVICE = "src/accounts/account-service.ts";
const PRISMA = "src/accounts/prisma-account-repository.ts";

const unit = (symbol: string, file = "src/a.ts"): NavTarget => ({ kind: "unit", unitId: `u_${symbol.padEnd(8, "a").slice(0, 8)}`, ref: `${file}#${symbol}`, file, symbol, summary: `${symbol}.` });
const external: NavTarget = { kind: "external", ref: "ext:@prisma/client#update", module: "@prisma/client", name: "update", effects: ["db.write"] };

const allSteps = (steps: SiftStep[]): SiftStep[] => steps.flatMap((s) => [s, ...allSteps(s.steps)]);

describe("planNavigation", () => {
  it("opens one unit, picks among several, shows library calls, and explains nothing to follow", () => {
    const a = unit("alpha");
    expect(planNavigation([a])).toEqual({ kind: "open", target: a });
    // A library call beside one project call still opens the project unit.
    expect(planNavigation([external, a])).toEqual({ kind: "open", target: a });
    // The same unit called twice is one target.
    expect(planNavigation([a, a])).toEqual({ kind: "open", target: a });
    const b = unit("bravo");
    expect(planNavigation([a, b])).toEqual({ kind: "pick", targets: [a, b] });
    expect(planNavigation([external])).toEqual({ kind: "card" });
    expect(planNavigation([{ kind: "missing", ref: "u_zzzzzzzz" }])).toMatchObject({ kind: "none", message: expect.stringContaining("no description") });
    expect(planNavigation([])).toMatchObject({ kind: "none", message: expect.stringContaining("nothing") });
  });

  it("maps .sift files to their sources and back", () => {
    expect(sourceOfLogic(".sift/src/a.ts.sift")).toBe("src/a.ts");
    expect(sourceOfLogic(".sift\\src\\a.ts.sift")).toBe("src/a.ts");
    expect(sourceOfLogic("src/a.ts")).toBeNull();
    expect(sourceOfLogic(".sift/.cache/x.sift")).toBeNull();
    expect(sourceOfLogic(".sift/rules/prisma.yaml")).toBeNull();
    expect(logicOfSource("src/a.ts")).toBe(".sift/src/a.ts.sift");
  });

  it("on the fixture: both AccountRepository implementations go to the picker, Prisma calls to the card", async () => {
    const dir = await fixtureCopy();
    const server = new ServerProcess({ root: dir, launch: inProcessServer(dir).launch, log: () => {} });
    try {
      await server.request("sift/generate", {});
      const service = await server.request("sift/logicFile", { source: SERVICE });
      const transfer = service.units.find((u) => u.unit.symbol === "AccountService.transferFunds")!;
      expect(transfer.freshness).toBe("fresh");

      // The step that saves an account calls the interface member; both implementations are offered.
      const plans = await Promise.all(
        allSteps(transfer.unit.steps)
          .filter((s) => s.calls.length > 0)
          .map(async (s) => planNavigation(await server.request("sift/stepTargets", { unit: transfer.unit.id, step: s.id }))),
      );
      const picks = plans.filter((p) => p.kind === "pick");
      expect(picks.length).toBeGreaterThan(0);
      for (const pick of picks) {
        expect(pick.targets.map((t) => t.symbol).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^InMemoryAccountRepository\./), expect.stringMatching(/^PrismaAccountRepository\./)]));
      }

      // The Prisma repository's steps call only the library: the card shows them with their effects.
      const prisma = await server.request("sift/logicFile", { source: PRISMA });
      const targets = (
        await Promise.all(
          prisma.units.flatMap((u) => allSteps(u.unit.steps).filter((s) => s.calls.length > 0).map((s) => server.request("sift/stepTargets", { unit: u.unit.id, step: s.id }))),
        )
      ).filter((t) => planNavigation(t).kind === "card");
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.flat().some((t) => t.kind === "external" && t.effects.includes("db.write"))).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
