import { describe, expect, it } from "vitest";
import type { ExtractedUnit, FileExtraction } from "./adapter.js";
import { validateCode, validatePlan, type EditPlan } from "./edit-prompts.js";
import { applyDescriptionEdits, applySourceChanges, endOfImports, logicDiff, unifiedDiff } from "./edit-text.js";
import { transferUnit } from "./test-support.js";

const FILE = `import { a } from "./a.js";
import {
  b,
  c,
} from "./b.js";

// Adds.
export function add(x: number, y: number): number {
  return x + y;
}

export class Calc {
  /** Twice. */
  double(x: number): number {
    return x * 2;
  }
}
`;

function unit(symbol: string, start: [number, number], end: [number, number], docComment: string | null = null): ExtractedUnit {
  return {
    symbol, kind: "function", isSmall: true, signature: symbol, inputs: [], returns: null, bodyHash: symbol, body: [], docComment, sourceText: "", typeRefs: [], implementsMember: null,
    range: { start: { line: start[0], col: start[1] }, end: { line: end[0], col: end[1] } },
  };
}

const extraction: FileExtraction = {
  path: "src/calc.ts",
  language: "typescript",
  fileHash: "x",
  units: [unit("add", [8, 1], [10, 2], "// Adds."), unit("Calc.double", [14, 3], [16, 4], "/** Twice. */")],
};

describe("applySourceChanges", () => {
  it("replaces a unit in place, re-indented to where it sits, and keeps everything else byte for byte", () => {
    const text = applySourceChanges(FILE, extraction, [{ symbol: "Calc.double", text: "double(x: number): number {\n  if (x < 0) throw new Error(\"negative\");\n  return x * 2;\n}" }], []);
    expect(text).toBe(FILE.replace("    return x * 2;\n  }", '    if (x < 0) throw new Error("negative");\n    return x * 2;\n  }'));
    // The model may also send the text indented as it was in the class.
    const indented = applySourceChanges(FILE, extraction, [{ symbol: "Calc.double", text: "  double(x: number): number {\n    return x * 3;\n  }\n" }], []);
    expect(indented).toBe(FILE.replace("x * 2", "x * 3"));
  });

  it("inserts imports after the import block, and helpers before (above the doc comment) or after a unit, or at the end", () => {
    const text = applySourceChanges(
      FILE,
      extraction,
      [],
      [
        { at: "imports", text: 'import { d } from "./d.js";' },
        { at: { before: "src/calc.ts#add" }, text: "function helper(): void {}" },
        { at: { after: "src/calc.ts#Calc.double" }, text: "triple(x: number): number {\n  return x * 3;\n}" },
        { at: "end", text: "export const ZERO = 0;" },
      ],
    );
    expect(text).toBe(`import { a } from "./a.js";
import {
  b,
  c,
} from "./b.js";
import { d } from "./d.js";

function helper(): void {}

// Adds.
export function add(x: number, y: number): number {
  return x + y;
}

export class Calc {
  /** Twice. */
  double(x: number): number {
    return x * 2;
  }

  triple(x: number): number {
    return x * 3;
  }
}

export const ZERO = 0;
`);
  });

  it("keeps CRLF line endings", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const text = applySourceChanges(crlf, extraction, [{ symbol: "add", text: "export function add(x: number, y: number): number {\n  return y + x;\n}" }], [{ at: "imports", text: 'import { d } from "./d.js";' }]);
    expect(text).toBe(crlf.replace("x + y", "y + x").replace('} from "./b.js";\r\n', '} from "./b.js";\r\nimport { d } from "./d.js";\r\n'));
  });

  it("refuses a unit that is not in the file", () => {
    expect(() => applySourceChanges(FILE, extraction, [{ symbol: "nope", text: "x" }], [])).toThrow("src/calc.ts has no unit nope.");
  });
});

describe("endOfImports", () => {
  it("finds the end of the leading imports, with comments and multi-line imports", () => {
    expect(FILE.slice(0, endOfImports(FILE))).toBe('import { a } from "./a.js";\nimport {\n  b,\n  c,\n} from "./b.js";\n');
    expect(endOfImports("// header\nimport x from 'x'\nconst y = 1;\n")).toBe("// header\nimport x from 'x'\n".length);
    expect(endOfImports("const y = 1;\n")).toBe(0);
  });
});

describe("unifiedDiff", () => {
  it("shows only the changed region with three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 10", "line ten").replace("line 11\n", "");
    expect(unifiedDiff("f.ts", before, after)).toBe(
      ["--- a/f.ts", "+++ b/f.ts", "@@ -7,8 +7,7 @@", " line 7", " line 8", " line 9", "-line 10", "-line 11", "+line ten", " line 12", " line 13", " line 14"].join("\n"),
    );
    expect(unifiedDiff("f.ts", before, before)).toBe("");
  });
});

describe("applyDescriptionEdits", () => {
  it("applies set, add, and delete edits and marks the person's pieces", () => {
    const base = transferUnit();
    const draft = applyDescriptionEdits(base, [
      { op: "set", path: "steps[s_b2v7].text", before: base.steps[2]!.text, after: "Save both accounts in one database transaction." },
      { op: "set", path: "summary", before: base.summary, after: "Moves money between accounts." },
      { op: "set", path: "inputs[amountCents].meaning", before: "Amount to move, in cents.", after: "How much to move, in cents; must be positive." },
      { op: "add", id: "s_new2", text: "Check that the amount is positive.", after: "s_q2w6" },
      { op: "delete", step: "s_m7p2" },
    ]);
    expect(draft.steps.map((s) => [s.id, s.status, s.text])).toEqual([
      ["s_q2w6", undefined, "Get the source account from the database."],
      ["s_new2", "user-edited", "Check that the amount is positive."],
      ["s_h3k2", undefined, "If the source account does not belong to the requesting user,"],
      ["s_b2v7", "user-edited", "Save both accounts in one database transaction."],
    ]);
    expect(draft.steps[2]!.steps).toEqual([]);
    expect(draft.userEdited).toEqual(["summary", "inputs.amountCents"]);
    expect(base.steps).toHaveLength(3); // the base is not changed

    const diff = logicDiff(base, draft);
    expect(diff).toContainEqual({ field: "step", change: "added", id: "s_new2", after: "Check that the amount is positive." });
    expect(diff).toContainEqual({ field: "step", change: "removed", id: "s_m7p2", before: 'stop with a "forbidden" error.' });
    expect(diff).toContainEqual({ field: "summary", before: base.summary, after: "Moves money between accounts." });
  });

  it("refuses edits that no longer fit the description", () => {
    const base = transferUnit();
    let error: unknown;
    try {
      applyDescriptionEdits(base, [{ op: "set", path: "steps[s_b2v7].text", before: "something else", after: "x" }, { op: "delete", step: "s_zzzz" }]);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "EDIT_INVALID_STATE", details: ['edits[0]: step s_b2v7 no longer reads "something else"', "edits[1]: AccountService.transferFunds has no step s_zzzz"] });
  });
});

describe("plan and code validation", () => {
  const edited = "src/a.ts#A.f";
  const exists = (r: string) => ["src/a.ts#A.f", "src/a.ts#A.g", "src/b.ts#h"].includes(r);
  const plan = (over: Partial<EditPlan>) => ({ kind: "behavior", interpretation: "Do it.", questions: [], warnings: [], allowedUnits: [{ unit: edited, reason: "edited" }], helpers: [], examples: [], broader: null, ...over });

  it("requires the edited unit, names for other units in broader, and known units", () => {
    expect(validatePlan(plan({}), edited, exists).problems).toEqual([]);
    expect(validatePlan(plan({ allowedUnits: [{ unit: "src/a.ts#A.g", reason: "x" }, { unit: "src/nope.ts#x", reason: "y" }] }), edited, exists).problems).toEqual([
      'allowedUnits[1].unit "src/nope.ts#x" is not a unit in the project; use the file#Symbol names given.',
      "allowedUnits must include the edited unit, src/a.ts#A.f, for a behavior change.",
      "Units other than src/a.ts#A.f may change only when \"broader\" names them with a reason: src/a.ts#A.g, src/nope.ts#x.",
    ]);
    const questions = [1, 2, 3, 4].map((i) => ({ id: `q${i}`, text: "?", options: [] }));
    expect(validatePlan(plan({ questions }), edited, exists).problems).toEqual(["Ask at most 3 questions at a time; keep the ones that matter most."]);
  });

  it("allows only planned units, planned helpers, and imports", () => {
    const p = validatePlan(plan({}), edited, exists).plan!;
    expect(validateCode({ units: [{ unit: edited, text: "f() {}" }], insertions: [{ file: "src/a.ts", at: "imports", text: "import x from 'x';" }], notes: "" }, p).problems).toEqual([]);
    expect(
      validateCode({ units: [{ unit: "src/a.ts#A.g", text: "g() {}" }], insertions: [{ file: "src/a.ts", at: "end", text: "function h() {}" }, { file: "src/b.ts", at: "imports", text: "x" }], notes: "" }, p).problems,
    ).toEqual([
      'units[0].unit "src/a.ts#A.g" is not one of the units you may change (src/a.ts#A.f).',
      "insertions[0]: the plan allows no new functions in src/a.ts; only imports may be inserted there.",
      'insertions[1].file "src/b.ts" is not a file whose units you may change.',
    ]);
  });
});
