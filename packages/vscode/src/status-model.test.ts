import { describe, expect, it } from "vitest";
import type { StatusReport } from "@sift/core";
import { describeCounts, filesWithProblems, statusBarContent, statusEntries } from "./status-model.js";

const empty: StatusReport = {
  changed: [], new: [], deleted: [], renamed: [], movedFiles: [], ambiguous: [], contextChanged: [], stale: [], belowTier: [], unreadable: [],
  counts: { units: 0, generated: 0, userEdited: 0, verified: 0 },
};

describe("status model", () => {
  it("lists out-of-date units by kind, and files to decorate", () => {
    const entries = statusEntries({
      ...empty,
      new: ["src/a.ts#added"],
      changed: ["src/a.ts#Foo.bar"],
      stale: ["src/b.ts#baz"],
      deleted: ["src/gone.ts#old"],
      renamed: [{ from: "src/b.ts#before", to: "src/c.ts#after", change: "moved" }],
      ambiguous: [{ previous: "src/b.ts#twin", candidates: ["src/b.ts#twinA", "src/b.ts#twinB"] }],
      contextChanged: ["src/c.ts#caller"],
      belowTier: ["src/a.ts#Foo.bar"],
    });
    expect(entries.map((e) => `${e.kind} ${e.unit}`)).toEqual([
      "stale src/b.ts#baz",
      "changed src/a.ts#Foo.bar",
      "new src/a.ts#added",
      "renamed src/c.ts#after",
      "ambiguous src/b.ts#twin",
      "contextChanged src/c.ts#caller",
      "deleted src/gone.ts#old",
    ]);
    expect(entries.find((e) => e.kind === "renamed")?.detail).toBe("from src/b.ts#before");

    const files = filesWithProblems(entries);
    // A deleted unit's file may not exist any more: no decoration for it.
    expect([...files.keys()].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(describeCounts(files.get("src/a.ts")!.counts)).toBe("1 changed, 1 new");
    expect(describeCounts(files.get("src/b.ts")!.counts)).toBe("1 stale, 1 ambiguous");
  });

  it("puts the count of out-of-date descriptions in the status bar", () => {
    expect(statusBarContent({ kind: "ready", outOfDate: 0, units: 29, verified: 3 })).toMatchObject({ text: "$(check) Sift", warning: false });
    expect(statusBarContent({ kind: "ready", outOfDate: 4, units: 29, verified: 3 })).toMatchObject({ text: "$(warning) Sift: 4", warning: true });
    expect(statusBarContent({ kind: "failed", message: "no config" }).tooltip).toContain("no config");
  });
});
