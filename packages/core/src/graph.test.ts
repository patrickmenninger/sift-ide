import { describe, expect, it } from "vitest";
import type { CallSite, ExtractedUnit, FileExtraction, StructureNode, SymbolRef } from "./adapter.js";
import { buildFileGraph, calleeName, CodeGraph, GRAPH_VERSION, type GraphData } from "./graph.js";
import { parseRulePack, RuleSet } from "./rules.js";
import { ext, internal } from "./test-support.js";

const R = (line: number) => ({ start: { line, col: 1 }, end: { line, col: 10 } });

function node(key: string, calls: CallSite[] = [], children: StructureNode[] = [], kind: StructureNode["kind"] = "statement"): StructureNode {
  return { key, kind, range: R(1), text: key, calls, children };
}

function unit(symbol: string, body: StructureNode[], extra: Partial<ExtractedUnit> = {}): ExtractedUnit {
  return {
    symbol, kind: "function", isSmall: false, signature: `${symbol}()`, inputs: [], returns: null, bodyHash: "0000000000000000",
    range: R(1), body, docComment: null, sourceText: "", typeRefs: [], implementsMember: null, ...extra,
  };
}

function file(path: string, units: ExtractedUnit[]): FileExtraction {
  return { path, language: "typescript", fileHash: `hash-${path}`, units };
}

const RULES = new RuleSet([
  parseRulePack(
    [
      "pack: test",
      "rules:",
      "  - match: { module: db, member: \"Client.write\" }",
      "    effect: db.write",
      "  - match: { module: global, member: \"Console.log\" }",
      "    effect: log",
      "edges:",
      "  - match: { module: web, member: \"Router.{get,post}\" }",
      "    edge: handles-route",
      "    from: { arg: -1 }",
      "    route: { method: member, path: { arg: 0 } }",
      "  - match: { symbol: Bus.emit }",
      "    edge: emits",
      "    key: { arg: 0 }",
      "  - match: { symbol: Bus.on }",
      "    edge: listens",
      "    key: { arg: 0 }",
      "    from: { arg: 1 }",
    ].join("\n"),
    "test.yaml",
  ),
]);

const repoMember: SymbolRef = { file: "src/repo.ts", symbol: "Repo.save" };

/**
 * routes.ts:  register() — POST /a → inline callback calling service.run; GET /b → callback calling other()
 * service.ts: Service.run → Repo.save (interface) and bus.emit("done"); other(); helper() with an unresolved call
 * db-repo.ts: DbRepo.save implements Repo.save → db write
 * listener.ts: <module> registers onDone for "done"; onDone logs
 */
function graph(): CodeGraph {
  const files = [
    file("src/routes.ts", [
      unit("register", [
        node("0", [ext("web", "Router.post", [{ kind: "string", value: "/a" }, { kind: "callback", key: "0.cb0" }])], [
          node("0.cb0", [], [node("0.cb0.0", [internal("src/service.ts", "Service.run")])], "callback"),
        ]),
        node("1", [ext("web", "Router.get", [{ kind: "string", value: "/b" }, { kind: "callback", key: "1.cb0" }])], [
          node("1.cb0", [], [node("1.cb0.0", [internal("src/service.ts", "other")])], "callback"),
        ]),
        node("2", [ext("web", "Router.get", [{ kind: "unknown" }, { kind: "callback", key: "2.cb0" }])]),
      ]),
    ]),
    file("src/service.ts", [
      unit("Service.run", [
        node("0", [internal("src/repo.ts", "Repo.save")]),
        node("1", [internal("src/bus.ts", "Bus.emit", [{ kind: "string", value: "done" }, { kind: "unknown" }])]),
        node("2", [], [], "throw"),
      ]),
      unit("other", [node("0", [internal("src/service.ts", "helper")])], { isSmall: true }),
      unit("helper", [node("0", [{ ...ext("x", "y"), external: null, target: null, confidence: null, expression: "callbacks.run(x)" }])]),
    ]),
    file("src/db-repo.ts", [
      unit("DbRepo.save", [node("0", [ext("db", "Client.write")])], { implementsMember: repoMember, isSmall: true }),
    ]),
    file("src/listener.ts", [
      unit("<module>", [node("0", [internal("src/bus.ts", "Bus.on", [{ kind: "string", value: "done" }, { kind: "unit", ref: { file: "src/listener.ts", symbol: "onDone" } }])])], { kind: "module" }),
      unit("onDone", [node("0", [ext("global", "Console.log")])], { isSmall: true }),
    ]),
  ];
  const data: GraphData = { version: GRAPH_VERSION, rules: RULES.hash, files: {} };
  for (const f of files) data.files[f.path] = buildFileGraph(f, RULES, "typescript");
  return new CodeGraph(data);
}

describe("buildFileGraph", () => {
  it("records effects, clears lite for effectful units, and keeps lite for logging", () => {
    const g = graph();
    expect(g.unit("src/service.ts#Service.run")?.effects).toEqual(["event.emit", "throws"]);
    expect(g.unit("src/db-repo.ts#DbRepo.save")).toMatchObject({ effects: ["db.write"], lite: false });
    expect(g.unit("src/listener.ts#onDone")).toMatchObject({ effects: ["log"], lite: true });
    expect(g.unit("src/service.ts#other")?.lite).toBe(true);
  });

  it("turns edge rules into route, emit, and listen edges, and unreadable registrations into gaps", () => {
    const g = graph();
    expect(g.edgesTo("src/routes.ts#register", "handles-route").map((e) => [e.from, e.handlerKey])).toEqual([
      ["route:POST /a", "0.cb0"],
      ["route:GET /b", "1.cb0"],
    ]);
    expect(g.edgesFrom("src/service.ts#Service.run", "emits").map((e) => e.to)).toEqual(["event:done"]);
    expect(g.edgesFrom("event:done", "listens").map((e) => e.to)).toEqual(["src/listener.ts#onDone"]);
    expect(g.gaps().map((x) => [x.kind, x.unit])).toEqual([
      ["unknown-route", "src/routes.ts#register"],
      ["unresolved-call", "src/service.ts#helper"],
    ]);
    expect(g.unmatchedEvents()).toEqual({ emittedOnly: [], listenedOnly: [] });
  });
});

describe("CodeGraph queries", () => {
  it("finds symbols by file#symbol, qualified name, or last part", () => {
    const g = graph();
    expect(g.find("src/service.ts#other")).toEqual(["src/service.ts#other"]);
    expect(g.find("run")).toEqual(["src/service.ts#Service.run"]);
    expect(g.find("save")).toEqual(["src/db-repo.ts#DbRepo.save", "src/repo.ts#Repo.save"]);
    expect(g.find("Repo.save")).toEqual(["src/repo.ts#Repo.save"]);
    expect(g.kindOf("src/repo.ts#Repo.save")).toBe("declaration");
  });

  it("finds callers through interface dispatch, events, and route callbacks", () => {
    const g = graph();
    const dbCallers = g.callers("src/db-repo.ts#DbRepo.save", 3);
    expect(dbCallers.map((h) => [h.id, h.depth, h.via.dispatch ?? null])).toEqual([
      ["src/service.ts#Service.run", 1, "src/repo.ts#Repo.save"],
      ["src/routes.ts#register", 2, null],
      // Only the route whose callback contains the call to Service.run.
      ["route:POST /a", 3, null],
    ]);
    expect(g.callers("src/listener.ts#onDone").map((h) => [h.id, h.via.kind, h.via.event])).toEqual([
      ["src/service.ts#Service.run", "emits", "event:done"],
    ]);
    // Asked directly, every route the unit registers is a caller.
    expect(g.callers("src/routes.ts#register").map((h) => h.id)).toEqual(["route:POST /a", "route:GET /b"]);
  });

  it("lists callees with interface implementations and event listeners", () => {
    const g = graph();
    expect(g.callees("src/service.ts#Service.run").map((h) => [h.id, h.via.kind, h.via.dispatch ?? h.via.event ?? null])).toEqual([
      ["src/repo.ts#Repo.save", "calls", null],
      ["src/db-repo.ts#DbRepo.save", "calls", "src/repo.ts#Repo.save"],
      ["src/bus.ts#Bus.emit", "calls", null],
      ["src/listener.ts#onDone", "emits", "event:done"],
    ]);
    expect(g.callees("src/listener.ts#onDone")[0]).toMatchObject({ id: "ext:global#Console.log", via: { effects: ["log"] } });
  });

  it("propagates callee effects one level, without throws", () => {
    const g = graph();
    expect(g.effectsOf("src/service.ts#Service.run")).toEqual(["event.emit", "throws"]);
    expect(g.effectsOf("src/service.ts#Service.run", { propagated: true })).toEqual(["db.write", "event.emit", "throws"]);
    // One level only: register → Service.run → DbRepo.save does not reach register.
    expect(g.effectsOf("src/routes.ts#register", { propagated: true })).toEqual(["event.emit"]);
  });

  it("reports impact as units, routes reached through the right callback, and gaps", () => {
    const g = graph();
    const result = g.impact(["src/db-repo.ts#DbRepo.save"]);
    expect(result.units.map((u) => [u.id, u.depth, u.via])).toEqual([
      ["src/service.ts#Service.run", 1, { kind: "calls", dispatch: "src/repo.ts#Repo.save" }],
      ["src/routes.ts#register", 2, { kind: "calls" }],
    ]);
    expect(result.routes.map((r) => r.id)).toEqual(["route:POST /a"]);
    expect(result.gaps.map((x) => x.kind)).toEqual(["unknown-route"]);

    const fromListener = g.impact(["src/listener.ts#onDone"]);
    expect(fromListener.units[0]).toMatchObject({ id: "src/service.ts#Service.run", via: { kind: "emits", event: "event:done" }, confidence: "rule" });

    const fromHelper = g.impact(["src/service.ts#helper"]);
    expect(fromHelper.routes.map((r) => r.id)).toEqual(["route:GET /b"]);
  });

  it("flags unresolved calls with a matching name as possible callers", () => {
    const g = graph();
    expect(g.possibleCallers("src/service.ts#Service.run").map((x) => x.expression)).toEqual(["callbacks.run(x)"]);
    expect(g.possibleCallers("src/listener.ts#onDone")).toEqual([]);
  });

  it("maps changed lines to units", () => {
    const g = graph();
    expect(g.unitsAt("src/service.ts", [{ start: 1, end: 1 }])).toEqual(["src/service.ts#Service.run", "src/service.ts#other", "src/service.ts#helper"]);
    expect(g.unitsAt("src/service.ts", [{ start: 5, end: 9 }])).toEqual([]);
  });
});

describe("calleeName", () => {
  it("takes the last name before the arguments", () => {
    expect(calleeName("this.repo.save(account)")).toBe("save");
    expect(calleeName("handler(payload)")).toBe("handler");
    expect(calleeName("new Thing(1)")).toBe("Thing");
    expect(calleeName("obj?.run?.(x)")).toBe("run");
  });
});
