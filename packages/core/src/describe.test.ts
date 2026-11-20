import { describe, expect, it } from "vitest";
import type { CallSite, ExtractedUnit, StructureNode } from "./adapter.js";
import { annotatedSource, renderDescribeInput } from "./describe-input.js";
import { contextHashOf, deriveSiftUnit, foldDestructured, validateDescribeResponse, type DescribeResponse } from "./describe-output.js";
import { loadPrompt, parsePromptFile } from "./prompts.js";
import { ext, internal } from "./test-support.js";
import { validateSiftFile } from "./validate.js";

// function load(id: string) {
//   const a = repo.find(id);
//   if (!a) {
//     throw new Error("missing");
//   }
//   return a;
// }
const FILE = [
  "// header",
  "function load(id: string) {",
  "  const a = repo.find(id);",
  "  if (!a) {",
  '    throw new Error("missing");',
  "  }",
  "  return a;",
  "}",
  "",
].join("\n");

const at = (line: number, col: number, endLine = line, endCol = col + 5) => ({ start: { line, col }, end: { line: endLine, col: endCol } });

function node(key: string, kind: StructureNode["kind"], range: StructureNode["range"], calls: CallSite[] = [], children: StructureNode[] = []): StructureNode {
  return { key, kind, range, text: key, calls, children };
}

const findCall = { ...internal("src/repo.ts", "Repo.find"), expression: "repo.find(id)" };
const errorCall = { ...ext("global", "Error"), expression: 'new Error("missing")' };

const UNIT: ExtractedUnit = {
  symbol: "load",
  kind: "function",
  isSmall: false,
  signature: "function load(id: string)",
  inputs: [{ name: "id", type: "string", typeInferred: false }],
  returns: { type: "Account", typeInferred: true },
  bodyHash: "abcdefabcdefabcd",
  range: at(2, 1, 8, 2),
  body: [
    node("0", "statement", at(3, 3), [findCall]),
    node("1", "if", at(4, 3, 6, 4), [], [node("1.then.0", "throw", at(5, 5), [errorCall])]),
    node("2", "return", at(7, 3)),
  ],
  docComment: null,
  sourceText: "",
  typeRefs: [],
  implementsMember: null,
};

const RESPONSE: DescribeResponse = {
  summary: "Loads a record by ID.",
  inputs: [{ name: "id", meaning: "The record ID." }],
  returns: { meaning: "The record." },
  steps: [
    { kind: null, text: "Find the record.", covers: ["0"], steps: [] },
    { kind: "if", text: "If there is none,", covers: ["1"], steps: [{ kind: null, text: "stop with an error.", covers: ["1.then.0"], steps: [] }] },
    { kind: null, text: "Return it.", covers: ["2"], steps: [] },
  ],
  warnings: [{ kind: "missing-check", text: "The ID is not checked.", covers: ["0"] }],
};

describe("annotatedSource", () => {
  it("puts a key marker before every structure node and removes shared indentation", () => {
    expect(annotatedSource(FILE, UNIT)).toBe(
      [
        "function load(id: string) {",
        "  /*[0]*/ const a = repo.find(id);",
        "  /*[1]*/ if (!a) {",
        '    /*[1.then.0]*/ throw new Error("missing");',
        "  }",
        "  /*[2]*/ return a;",
        "}",
      ].join("\n"),
    );
  });

  it("writes outer markers first when nodes start at the same place", () => {
    const unit = { ...UNIT, body: [node("0", "else", at(3, 3), [], [node("0.else.0", "if", at(3, 3))])] };
    expect(annotatedSource(FILE, unit)).toContain("/*[0]*/ /*[0.else.0]*/ const a");
  });
});

describe("renderDescribeInput", () => {
  it("lists inputs, keys with effects, and calls with summaries", () => {
    const { prompt } = renderDescribeInput({
      file: "src/load.ts",
      unit: UNIT,
      fileText: FILE,
      lite: false,
      nodeEffects: new Map([["1.then.0", ["throws"]]]),
      callees: [{ expression: "repo.find(id)", key: "0", target: "src/repo.ts#Repo.find", kind: "unit", signature: "find(id: string)", summary: "Finds a record.", effects: ["db.read"] }],
    });
    expect(prompt).toContain("- `id`: string\n");
    expect(prompt).toContain("Returns: Account (type inferred)");
    expect(prompt).toContain("- 1.then.0: throw — effects: throws");
    expect(prompt).toContain("- [0] `repo.find(id)` → Repo.find — effects: db.read\n  signature: find(id: string)\n  summary: Finds a record.");
  });
});

describe("validateDescribeResponse", () => {
  it("accepts a response that covers every key", () => {
    expect(validateDescribeResponse(RESPONSE, UNIT, false).problems).toEqual([]);
  });

  it("reports every problem in words the model can act on", () => {
    const bad = {
      ...RESPONSE,
      inputs: [{ name: "key", meaning: "x" }],
      returns: null,
      steps: [
        { kind: "loop", text: "Find the record.", covers: ["0", "9"], steps: [] },
        { kind: null, text: "Return it.", covers: ["2"], steps: [] },
      ],
    };
    const result = validateDescribeResponse(bad, UNIT, false);
    expect(result.problems).toEqual([
      '"inputs" must list exactly these parameters, in order: [id]; got [key].',
      '"returns" must describe the returned Account.',
      'steps[0] covers "9", which is not a structure key of this unit.',
      'steps[0] has kind "loop" but covers no "loop" key; use kind null or cover the loop key.',
      "These structure keys are not covered by any step: 1.",
    ]);
    expect(result.uncovered).toEqual(["1"]);
  });

  it("counts a parent's coverage for its children", () => {
    const flat = { ...RESPONSE, steps: [{ kind: null, text: "All of it.", covers: ["0", "1", "2"], steps: [] }] };
    expect(validateDescribeResponse(flat, UNIT, false).uncovered).toEqual([]);
  });

  it("folds inputs that name a destructured parameter's elements into that parameter", () => {
    const props = { ...UNIT, inputs: [{ name: "{ account, highlight = false }", type: "Props", typeInferred: false }] };
    const { steps: _steps, ...lite } = RESPONSE;
    const split = { ...lite, warnings: [], inputs: [{ name: "account", meaning: "The account." }, { name: "highlight", meaning: "Whether to warn." }] };
    const result = validateDescribeResponse(split, props, true);
    expect(result.problems).toEqual([]);
    expect(result.response!.inputs).toEqual([{ name: "{ account, highlight = false }", meaning: "`account`: The account. `highlight`: Whether to warn." }]);
    expect(foldDestructured(["{ a, b }", "c"], [{ name: "{a,b}", meaning: "x" }, { name: "c", meaning: "y" }])).toEqual([{ name: "{a,b}", meaning: "x" }, { name: "c", meaning: "y" }]);
    expect(foldDestructured(["{ a, b }"], [{ name: "b", meaning: "x" }, { name: "a", meaning: "y" }])).toHaveLength(2);
  });

  it("rejects malformed shapes", () => {
    expect(validateDescribeResponse("text", UNIT, false).problems).toEqual(["The response must be a single JSON object."]);
    expect(validateDescribeResponse({ ...RESPONSE, steps: [{ text: "" }], extra: 1 }, UNIT, false).problems).toEqual([
      'Unexpected field "extra"; allowed fields are summary, inputs, returns, steps, warnings.',
      "steps[0].text must be a non-empty string.",
      "steps[0].covers must be a list of structure keys (strings).",
    ]);
  });
});

describe("deriveSiftUnit", () => {
  it("takes prose from the response and calls and effects from the covered code", () => {
    const unit = deriveSiftUnit({
      unit: UNIT,
      response: RESPONSE,
      id: "u_aaaaaaaa",
      lite: false,
      uncovered: [],
      nodeEffects: new Map([["1.then.0", ["throws"]]]),
      callRefs: (call) => (call.external ? [`ext:${call.external.module}#${call.external.name}`] : ["u_rrrrrrrr"]),
      calleeEffects: (call) => (call.external ? [] : ["db.read"]),
      generatedBy: { provider: "claude-code", model: "m", prompt: "describe@1", belowTier: false },
      contextHash: "1234123412341234",
    });
    expect(unit.steps[0]).toMatchObject({ text: "Find the record.", calls: ["u_rrrrrrrr"], effects: ["db.read"] });
    expect(unit.steps[1]).toMatchObject({ kind: "if", calls: [], effects: [] });
    expect(unit.steps[1]!.steps[0]).toMatchObject({ calls: ["ext:global#Error"], effects: ["throws"] });
    expect(unit.effects).toEqual(["db.read", "throws"]);
    expect(unit.inputs).toEqual([{ name: "id", type: "string", meaning: "The record ID." }]);
    expect(unit.returns).toEqual({ type: "Account", typeInferred: true, meaning: "The record." });
    expect(unit.warnings).toEqual([{ id: expect.stringMatching(/^w_/), kind: "missing-check", text: "The ID is not checked.", steps: [unit.steps[0]!.id] }]);
    expect(unit.status).toBe("generated");
    // The result is a valid .sift unit.
    validateSiftFile(JSON.parse(JSON.stringify({ sift: 0, source: "src/load.ts", language: "typescript", fileHash: "0000000000000000", units: [unit] })), "x");
  });

  it("gives a node to its parent step when no nested step covers it, and marks incomplete units stale", () => {
    const response = { ...RESPONSE, steps: [RESPONSE.steps[0]!, { ...RESPONSE.steps[1]!, steps: [] }] };
    const unit = deriveSiftUnit({
      unit: UNIT, response, id: "u_aaaaaaaa", lite: false, uncovered: ["2"], nodeEffects: new Map(),
      callRefs: (c) => (c.external ? ["ext:global#Error"] : []), calleeEffects: () => [],
      generatedBy: { provider: "p", model: "m", prompt: "describe@1", belowTier: true },
    });
    expect(unit.steps[1]!.calls).toEqual(["ext:global#Error"]);
    expect(unit.status).toBe("stale");
  });
});

describe("contextHashOf", () => {
  it("depends on callee summaries, not their order", () => {
    const a = contextHashOf([{ id: "u_a", summary: "A" }, { id: "u_b", summary: "B" }]);
    expect(contextHashOf([{ id: "u_b", summary: "B" }, { id: "u_a", summary: "A" }])).toBe(a);
    expect(contextHashOf([{ id: "u_a", summary: "A2" }, { id: "u_b", summary: "B" }])).not.toBe(a);
    expect(contextHashOf([])).toBeUndefined();
  });
});

describe("prompt files", () => {
  it("have versions and load for both describe tasks", async () => {
    expect((await loadPrompt("describe")).id).toBe("describe@2");
    expect((await loadPrompt("describe-lite")).id).toBe("describe-lite@2");
    expect(() => parsePromptFile("describe", "no front matter")).toThrow("front matter");
  });
});
