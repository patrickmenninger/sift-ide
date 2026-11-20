import { describe, expect, it } from "vitest";
import { SiftError } from "./errors.js";
import { newId } from "./ids.js";
import type { SiftFile } from "./schema.js";
import { parseSiftText, serializeSiftFile, updateSiftText } from "./sift-yaml.js";
import { liteUnit, sampleSiftFile, transferUnit } from "./test-support.js";

describe("serializeSiftFile", () => {
  it("writes the layout from the design: fixed key order, folded prose, one-line lists", () => {
    const text = serializeSiftFile(sampleSiftFile());
    expect(text).toMatchSnapshot();
    expect(text.startsWith("sift: 0\nsource: src/accounts/account-service.ts\nlanguage: typescript\n")).toBe(true);
    expect(text).toContain("    summary: >-\n      Moves money");
    expect(text).toContain("    effects: [db.read, db.write]\n");
    expect(text).toContain(
      "    generatedBy:\n      provider: claude-code\n      model: claude-opus-5-5\n      prompt: describe@1\n      belowTier: false\n",
    );
    expect(text).toContain("calls: [u_z3c6m2kf, ext:@prisma/client#Prisma.AccountDelegate.update]");
    expect(text).not.toContain("tests:");
  });

  it("round-trips exactly", () => {
    const file = sampleSiftFile();
    expect(parseSiftText(serializeSiftFile(file), "x")).toEqual(file);
  });

  it("is deterministic and stable when re-serialized", () => {
    const once = serializeSiftFile(sampleSiftFile());
    expect(serializeSiftFile(parseSiftText(once, "x"))).toBe(once);
  });

  it("round-trips prose that needs care in YAML", () => {
    const tricky = [
      "Returns: the value # not a comment",
      "- starts like a list item",
      "  leading spaces and trailing spaces  ",
      'Quotes " and \' and a backslash \\ in text',
      "Line one\nLine two\n\nAfter a blank line",
      "x".repeat(150),
      "Words ".repeat(40).trim(),
      "yes",
      "123",
      "null",
    ];
    for (const text of tricky) {
      const file = sampleSiftFile();
      file.units[0]!.summary = text;
      file.units[0]!.steps[0]!.text = text;
      expect(parseSiftText(serializeSiftFile(file), "x")).toEqual(file);
    }
  });
});

describe("updateSiftText", () => {
  it("returns the existing text unchanged when nothing changed", () => {
    const text = serializeSiftFile(sampleSiftFile());
    expect(updateSiftText(text, sampleSiftFile())).toBe(text);
  });

  it("keeps an unchanged unit's exact text, including hand formatting and comments", () => {
    const original = serializeSiftFile(sampleSiftFile());
    const handEdited = original.replace(
      "  - id: u_m2c6d2aa\n",
      "  # Reviewed by Pat; keep this wording.\n  - id: u_m2c6d2aa\n",
    ).replace("    status: generated\n    bodyHash: 0e7d2c91aa4f3b60", "    status:   generated   # extra spaces\n    bodyHash: 0e7d2c91aa4f3b60");

    const next = sampleSiftFile();
    next.fileHash = "aaaaaaaaaaaaaaaa";
    next.units[0]!.summary = "A different summary.";

    const updated = updateSiftText(handEdited, next);
    const liteChunk = handEdited.slice(handEdited.indexOf("  # Reviewed by Pat"));
    expect(updated.endsWith(liteChunk)).toBe(true);
    expect(updated).toContain("fileHash: aaaaaaaaaaaaaaaa");
    expect(updated).toContain("summary: A different summary.");
    expect(parseSiftText(updated, "x")).toEqual(next);
  });

  it("only changes the lines of the unit that changed", () => {
    const before = serializeSiftFile(sampleSiftFile());
    const next = sampleSiftFile();
    next.units[1]!.summary = "Formats cents as dollars.";
    const after = updateSiftText(before, next);

    const changed = diffLines(before, after);
    // The old summary was folded (">-" on its own line, text on the next); only the text line is unique.
    expect(changed).toEqual({
      removed: ['      Formats a number of cents as a dollar string such as "$1,250.00".'],
      added: ["    summary: Formats cents as dollars."],
    });
  });

  it("handles added, removed, and reordered units", () => {
    const before = serializeSiftFile(sampleSiftFile());
    const added = { ...liteUnit(), id: newId("unit", new Set(["u_m2c6d2aa"])), symbol: "toCents" };
    const next: SiftFile = { ...sampleSiftFile(), units: [added, transferUnit()] };
    const after = updateSiftText(before, next);
    expect(parseSiftText(after, "x")).toEqual(next);
    expect(after).not.toContain("formatCents");
  });

  it("rewrites the whole file when the existing text is invalid", () => {
    expect(updateSiftText("units: [not: valid", sampleSiftFile())).toBe(serializeSiftFile(sampleSiftFile()));
    expect(updateSiftText(null, sampleSiftFile())).toBe(serializeSiftFile(sampleSiftFile()));
  });

  it("falls back to a full rewrite when reused text would not splice cleanly", () => {
    // Units written at a different indentation than Sift uses.
    const original = serializeSiftFile(sampleSiftFile());
    const dedented = original.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");
    expect(parseSiftText(dedented, "x")).toEqual(sampleSiftFile());
    const next = sampleSiftFile();
    next.units[0]!.summary = "Changed.";
    const updated = updateSiftText(dedented, next);
    expect(parseSiftText(updated, "x")).toEqual(next);
  });
});

describe("parseSiftText validation", () => {
  const problems = (text: string): string[] => {
    try {
      parseSiftText(text, "f.sift");
    } catch (err) {
      if (err instanceof SiftError) return err.details;
      throw err;
    }
    throw new Error("expected failure");
  };

  it("reports every problem with its location", () => {
    const text = serializeSiftFile(sampleSiftFile())
      .replace("kind: method", "kind: procedure")
      .replace("effects: [db.read, db.write]", "effects: [db.read, db.delete]")
      .replace("steps: [s_b2v7]", "steps: [s_zzzz]")
      .replace("id: s_m7p2", "id: s_q2w6")
      .replace("    status: generated\n    bodyHash: 0e7d2c91aa4f3b60", "    status: generated\n    colour: blue\n    bodyHash: 0e7d2c91aa4f3b60");
    expect(problems(text)).toEqual([
      "units[0].kind: must be one of function, method, constructor, component, module",
      'units[0].effects[1]: unknown effect "db.delete" (expected one of db.read, db.write, db.transaction, net.request, fs.read, fs.write, process.exec, event.emit, log, throws)',
      "units[0].steps[1].steps[0].id: duplicate step id s_q2w6",
      "units[0].warnings[0].steps: refers to unknown step s_zzzz",
      "units[1].colour: unknown field",
    ]);
  });

  it("refuses files from a newer schema with a clear message", () => {
    const text = serializeSiftFile(sampleSiftFile()).replace("sift: 0", "sift: 7");
    expect(() => parseSiftText(text, "f.sift")).toThrowError(/schema 7.*Update Sift/);
  });

  it("rejects steps on lite units and bad IDs", () => {
    const file = sampleSiftFile();
    file.units[1]!.steps = [{ id: "s_aaaa", text: "x", covers: ["0"], calls: [], effects: [], steps: [] }];
    file.units[0]!.id = "unit-1";
    expect(problems(serializeSiftFile(file))).toEqual([
      'units[0].id: has an invalid format: "unit-1"',
      "units[1].steps: lite units have no steps",
    ]);
  });
});

function diffLines(a: string, b: string): { removed: string[]; added: string[] } {
  const al = a.split("\n");
  const bl = b.split("\n");
  return { removed: al.filter((l) => !bl.includes(l)), added: bl.filter((l) => !al.includes(l)) };
}
