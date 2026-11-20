import { describe, expect, it } from "vitest";
import type { ExtractedUnit, FileExtraction } from "./adapter.js";
import { deriveSiftUnit, rederiveFacts, validateContextCheckResponse, validateDescribeResponse } from "./describe-output.js";
import type { SiftFile, SiftUnit } from "./schema.js";
import { matchMovedFiles, matchUnits, stronglyConnected } from "./sync.js";
import { lineDiff, similarity, tokenize } from "./text-diff.js";

const extracted = (symbol: string, sourceText: string, bodyHash: string, kind: ExtractedUnit["kind"] = "function"): ExtractedUnit => ({
  symbol,
  kind,
  isSmall: false,
  signature: symbol,
  inputs: [],
  returns: null,
  bodyHash,
  range: { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } },
  body: [],
  docComment: null,
  sourceText,
  typeRefs: [],
  implementsMember: null,
});

const described = (id: string, symbol: string, bodyHash: string, kind: SiftUnit["kind"] = "function"): SiftUnit => ({
  id, symbol, kind, status: "generated", bodyHash, summary: `${symbol}.`, inputs: [], effects: [], steps: [], warnings: [], tests: [],
});

const LOAD = "function load(id) { const a = repo.find(id); if (!a) { throw new Error('missing'); } return a; }";

describe("matchUnits (design §7.2)", () => {
  const sources = new Map([["h_load", LOAD], ["h_save", "function save(a) { repo.save(a); log(a.id); }"]]);
  const sourceOf = async (h: string) => sources.get(h) ?? null;

  it("pairs by symbol, then by code, then by similar code, and leaves the rest deleted or new", async () => {
    const result = await matchUnits(
      [described("u_a", "same", "h_same"), described("u_b", "edited", "h_old"), described("u_c", "load", "h_load"), described("u_d", "moved", "h_moved"), described("u_e", "gone", "h_gone")],
      [
        extracted("same", "x", "h_same"),
        extracted("edited", "y", "h_new"),
        extracted("fetch", LOAD.replace("load", "fetch").replace("'missing'", "'not found'"), "h_fetch"),
        extracted("relocated", "z", "h_moved"),
        extracted("fresh", "w", "h_fresh"),
      ],
      sourceOf,
    );
    expect(result.matches.map((m) => [m.change, m.previous?.id ?? null, m.current?.symbol ?? null])).toEqual([
      ["unchanged", "u_a", "same"],
      ["changed", "u_b", "edited"],
      ["probable-rename", "u_c", "fetch"],
      ["renamed", "u_d", "relocated"],
      ["new", null, "fresh"],
      ["deleted", "u_e", null],
    ]);
    expect(result.matches[2]!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(result.ambiguous).toEqual([]);
  });

  it("does not guess when several units are similar enough, or the kind differs, or the old code is unknown", async () => {
    const twins = await matchUnits(
      [described("u_c", "load", "h_load")],
      [extracted("fetchA", LOAD.replace("load", "fetchA"), "h1"), extracted("fetchB", LOAD.replace("load", "fetchB"), "h2")],
      sourceOf,
    );
    expect(twins.matches.map((m) => m.change)).toEqual(["new", "new", "deleted"]);
    expect(twins.ambiguous).toEqual([{ previous: "load", candidates: ["fetchA", "fetchB"] }]);

    const otherKind = await matchUnits([described("u_c", "load", "h_load")], [extracted("Load", LOAD, "h1", "method")], sourceOf);
    expect(otherKind.matches.map((m) => m.change)).toEqual(["new", "deleted"]);

    const unknown = await matchUnits([described("u_x", "load", "h_unknown")], [extracted("fetch", LOAD, "h1")], sourceOf);
    expect(unknown.matches.map((m) => m.change)).toEqual(["new", "deleted"]);
  });

  it("does not pair by code when the same code appears more than once", async () => {
    const r = await matchUnits([described("u_a", "a", "h"), described("u_b", "b", "h")], [extracted("c", "x", "h")], sourceOf);
    expect(r.matches.map((m) => m.change)).toEqual(["new", "deleted", "deleted"]);
  });
});

describe("matchMovedFiles", () => {
  const sift = (path: string, fileHash: string, hashes: string[]): { path: string; file: SiftFile } => ({
    path,
    file: { sift: 0, source: path, language: "typescript", fileHash, units: hashes.map((h, i) => described(`u_${i}`, `f${i}`, h)) },
  });
  const extraction = (path: string, fileHash: string, hashes: string[]) => ({ path, fileHash, units: hashes.map((h, i) => extracted(`f${i}`, "", h)) }) as unknown as FileExtraction;

  it("follows a file to the new path with the same content or most of the same units", () => {
    expect(matchMovedFiles([sift("a.ts", "f1", ["x"]), sift("b.ts", "f2", ["p", "q", "r", "s", "t"])], [extraction("lib/a.ts", "f1", ["x"]), extraction("lib/b.ts", "f9", ["p", "q", "r", "s", "u"])])).toEqual([
      { from: "a.ts", to: "lib/a.ts" },
      { from: "b.ts", to: "lib/b.ts" },
    ]);
  });

  it("does not guess between two copies", () => {
    expect(matchMovedFiles([sift("a.ts", "f1", ["x"])], [extraction("one.ts", "f1", ["x"]), extraction("two.ts", "f1", ["x"])])).toEqual([]);
    expect(matchMovedFiles([sift("a.ts", "f3", ["x", "y"])], [extraction("one.ts", "f4", ["x", "z"])])).toEqual([]);
  });
});

describe("text comparison", () => {
  it("tokenizes code without comments and scores similarity", () => {
    expect(tokenize("a.b(1) // note\n/* x */ 'q'")).toEqual(["a", ".", "b", "(", "1", ")", "'q'"]);
    expect(similarity(tokenize(LOAD), tokenize(LOAD))).toBe(1);
    expect(similarity(tokenize(LOAD), tokenize("class X {}"))).toBeLessThan(0.3);
  });

  it("shows the whole new text with removed and added lines, ignoring re-indentation", () => {
    expect(lineDiff("a\n  b\nc", "a\nb\nd\nc")).toBe(["  a", "  b", "+ d", "  c"].join("\n"));
    expect(lineDiff("x = 1\ny", "x = 2\ny")).toBe(["- x = 1", "+ x = 2", "  y"].join("\n"));
  });

  it("finds cycles callees first, without recursion limits", () => {
    const edges: Record<string, string[]> = { a: ["b"], b: ["c"], c: ["b"], d: [] };
    expect(stronglyConnected(["a", "b", "c", "d"], (id) => edges[id] ?? []).map((c) => c.sort())).toEqual([["b", "c"], ["a"], ["d"]]);
    const chain = Array.from({ length: 20_000 }, (_, i) => `n${i}`);
    expect(stronglyConnected(chain, (id) => [`n${Number(id.slice(1)) + 1}`])).toHaveLength(20_000);
  });
});

describe("update and context-check responses", () => {
  const unit: ExtractedUnit = {
    ...extracted("load", LOAD, "h"),
    body: [
      { key: "0", kind: "statement", range: { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } }, text: "", calls: [], children: [] },
      { key: "1", kind: "return", range: { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } }, text: "", calls: [], children: [] },
    ],
  };
  const response = (ids: (string | null)[]) => ({
    summary: "Loads it.",
    inputs: [],
    returns: null,
    steps: ids.map((id, i) => ({ id, kind: null, text: `Step ${i}.`, covers: [String(i)], steps: [] })),
    warnings: [{ kind: "missing-check", text: "Same as before.", covers: ["0"] }],
  });

  it("accepts previous step IDs and null, and rejects unknown or repeated IDs", () => {
    const previous = new Set(["s_aaaa", "s_bbbb"]);
    expect(validateDescribeResponse(response(["s_bbbb", null]), unit, false, previous).problems).toEqual([]);
    expect(validateDescribeResponse(response(["s_zzzz", "s_zzzz"]), unit, false, new Set(["s_zzzz"])).problems).toEqual([
      'steps[1].id "s_zzzz" is used twice; a previous step can be kept only once.',
    ]);
    expect(validateDescribeResponse(response(["s_cccc", null]), unit, false, previous).problems).toEqual([
      'steps[0].id "s_cccc" is not a step of the previous description; use null for a new step.',
    ]);
  });

  it("keeps step IDs and the IDs of unchanged warnings, and gives new steps fresh IDs", () => {
    const { response: parsed } = validateDescribeResponse(response(["s_bbbb", null]), unit, false, new Set(["s_bbbb"]));
    const derived = deriveSiftUnit({
      unit, response: parsed!, id: "u_aaaaaaaa", lite: false, uncovered: [], nodeEffects: new Map(), callRefs: () => [], calleeEffects: () => [],
      generatedBy: { provider: "p", model: "m", prompt: "update@1", belowTier: false },
      previousWarnings: [{ id: "w_keep", kind: "missing-check", text: "Same as before.", steps: [] }],
    });
    expect(derived.steps[0]!.id).toBe("s_bbbb");
    expect(derived.steps[1]!.id).toMatch(/^s_[a-z2-7]{4}$/);
    expect(derived.steps[1]!.id).not.toBe("s_bbbb");
    expect(derived.warnings[0]!.id).toBe("w_keep");
  });

  it("recomputes calls and effects of an unchanged unit without touching its prose", () => {
    const withCall: ExtractedUnit = {
      ...unit,
      symbol: "loadRenamed",
      body: [{ ...unit.body[0]!, calls: [{ expression: "repo.find(id)", target: { file: "r.ts", symbol: "find" }, external: null, confidence: "exact", args: [] } as never] }, unit.body[1]!],
    };
    const before: SiftUnit = {
      ...described("u_a", "load", "h"),
      steps: [{ id: "s_aaaa", text: "Find it.", covers: ["0"], calls: ["u_old"], effects: [], steps: [] }],
    };
    const after = rederiveFacts(before, withCall, { nodeEffects: new Map([["1", ["log"]]]), callRefs: () => ["u_new"], calleeEffects: () => ["db.read"] });
    expect(after.symbol).toBe("loadRenamed");
    expect(after.steps[0]).toEqual({ id: "s_aaaa", text: "Find it.", covers: ["0"], calls: ["u_new"], effects: ["db.read"], steps: [] });
    expect(after.effects).toEqual(["db.read", "log"]);
    expect(before.steps[0]!.calls).toEqual(["u_old"]);
  });

  it("checks context-check replies against the unit's steps", () => {
    const ids = new Set(["s_aaaa"]);
    expect(validateContextCheckResponse({ summary: null, steps: [] }, ids)).toEqual({ response: { summary: null, steps: [] }, problems: [] });
    expect(validateContextCheckResponse({ summary: "New.", steps: [{ id: "s_bbbb", text: "x" }] }, ids).problems).toEqual(['steps[0].id "s_bbbb" is not a step of this unit.']);
    expect(validateContextCheckResponse({ summary: null, steps: [], extra: 1 }, ids).problems).toEqual(['Unexpected field "extra"; allowed fields are summary, steps.']);
  });
});
