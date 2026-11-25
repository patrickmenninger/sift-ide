// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { impactModel, neighbourhoodModel } from "../graph-model.js";
import { estimate, layoutGraph } from "./graph-layout.js";
import type { GraphModel, GraphWebviewMessage } from "./graph-protocol.js";
import { GraphApp } from "./graph-view.js";

const site = { range: { start: { line: 3, col: 5 }, end: { line: 3, col: 20 } } };
const SUBJECT = "src/a.ts#Service.run";
const CALLER = "src/b.ts#caller";
const GUESS = "src/c.ts#guess";
const LIB = "ext:@prisma/client#update";

function neighbourhood(): GraphModel {
  const via = (extra = {}) => ({ kind: "calls" as const, confidence: "resolved" as const, file: "src/b.ts", sites: [{ stepKey: "0", ...site }], ...extra });
  return neighbourhoodModel(
    {
      subject: SUBJECT,
      callers: [
        { id: CALLER, parent: SUBJECT, depth: 1, via: via() },
        { id: GUESS, parent: SUBJECT, depth: 1, via: via({ confidence: "name-match" }) },
        { id: "route:POST /run", parent: SUBJECT, depth: 1, via: via({ kind: "handles-route", confidence: "rule" }) },
      ],
      possibleCallers: [{ kind: "unresolved-call", unit: "src/d.ts#d", expression: "svc.run()", file: "src/d.ts", site }],
    },
    { subject: SUBJECT, effects: ["db.write"], callees: [{ id: LIB, parent: SUBJECT, depth: 1, via: via({ effects: ["db.write"] }) }], unresolved: [] },
  );
}

let root: HTMLElement;
let sent: GraphWebviewMessage[];

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  sent = [];
});
afterEach(() => {
  render(null, root);
  root.remove();
});

async function show(model: GraphModel | null, extra: { error?: string; dirty?: boolean; diagram?: boolean } = {}) {
  await act(() => {
    render(<GraphApp post={(m) => sent.push(m)} measure={estimate} diagram={extra.diagram ?? false} />, root);
  });
  await act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: { model, error: extra.error ?? null, loading: false, dirty: extra.dirty ?? false } } }));
  });
}

/** elkjs lays out asynchronously; wait until the diagram is drawn. */
async function drawn(): Promise<void> {
  for (let i = 0; i < 200 && !root.querySelector("svg g.nodes"); i++) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  expect(root.querySelector("svg g.nodes")).not.toBeNull();
}

const nodeEl = (id: string) => root.querySelector<SVGGElement>(`g.node[data-id="${CSS.escape(id)}"]`)!;
const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));

describe("graph layout", () => {
  it("places every node without overlaps, callers above the subject and callees below", async () => {
    const model = neighbourhood();
    const layout = await layoutGraph(model, estimate, 6);
    expect(layout.nodes).toHaveLength(model.nodes.length);
    expect(layout.edges).toHaveLength(model.edges.length);
    const at = (id: string) => layout.nodes.find((n) => n.node.id === id)!;
    expect(at(CALLER).y).toBeLessThan(at(SUBJECT).y);
    expect(at(LIB).y).toBeGreaterThan(at(SUBJECT).y);
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a === b) continue;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.node.id} overlaps ${b.node.id}`).toBe(true);
      }
    }
    // The node with effect chips is tall enough for them.
    expect(at(SUBJECT).height).toBeGreaterThan(at(CALLER).height);
  });
});

describe("GraphApp", () => {
  it("asks for its state, then draws the neighbourhood: nodes, dashed weak edges, chips, and the gap list", async () => {
    await show(neighbourhood());
    expect(sent[0]).toEqual({ type: "ready" });
    expect(root.querySelector("h1")!.textContent).toBe("Service.run");
    expect(root.querySelector(".view-name")!.textContent).toBe("Neighbourhood");
    await drawn();
    expect(root.querySelectorAll("g.node")).toHaveLength(6);
    expect(nodeEl(SUBJECT).classList.contains("role-subject")).toBe(true);
    expect([...nodeEl(SUBJECT).querySelectorAll(".chip text")].map((t) => t.textContent)).toEqual(["db.write"]);
    // Name match, rule-pack route, and the gap: three dashed edges; the resolved call and library call are solid.
    expect(root.querySelectorAll("path.edge.weak")).toHaveLength(3);
    expect(root.querySelectorAll("path.edge:not(.weak)")).toHaveLength(2);
    expect(nodeEl("gaps:callers").querySelector(".gap-line")!.textContent).toContain("svc.run()");
    // Library calls do not open anything; they explain themselves in the tooltip.
    expect(nodeEl(LIB).getAttribute("role")).toBe("img");
    expect(nodeEl(CALLER).getAttribute("role")).toBe("button");
    expect(nodeEl(CALLER).getAttribute("tabindex")).toBe("0");
    expect(nodeEl(LIB).querySelector("title")!.textContent).toContain("effects: db.write");
  });

  it("click opens logic, Alt+click code, Shift+click the neighbourhood; Enter works too; gaps open their site", async () => {
    await show(neighbourhood());
    await drawn();
    expect(sent).toContainEqual({ type: "drawn", nodes: 6 });
    sent = [];
    await click(nodeEl(CALLER));
    await click(nodeEl(CALLER), { altKey: true });
    await click(nodeEl(CALLER), { shiftKey: true });
    await act(() => void nodeEl(GUESS).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await click(nodeEl("route:POST /run"));
    await click(nodeEl(LIB));
    await click(nodeEl("gaps:callers").querySelector(".gap-line")!);
    expect(sent).toEqual([
      { type: "open", nodeId: CALLER, source: false },
      { type: "open", nodeId: CALLER, source: true },
      { type: "neighbourhood", nodeId: CALLER },
      { type: "open", nodeId: GUESS, source: false },
      { type: "open", nodeId: "route:POST /run", source: false },
      { type: "openSite", file: "src/d.ts", range: site.range },
    ]);
  });

  it("impact: grouped list first, the diagram on request; notes, weak paths, and the empty case", async () => {
    const changed = "src/a.ts#a";
    const model = impactModel(
      {
        subjects: [changed],
        notes: ["src/x.ts: changes are outside any unit (imports, types, or comments)"],
        units: [
          { id: "src/b.ts#b", depth: 1, confidence: "resolved", path: [changed, "src/b.ts#b"], via: { kind: "calls" } },
          { id: "src/c.ts#c", depth: 2, confidence: "name-match", path: [changed, "src/b.ts#b", "src/c.ts#c"], via: { kind: "calls" } },
        ],
        routes: [{ id: "route:GET /c", handler: "src/c.ts#c", confidence: "name-match", path: [changed, "src/b.ts#b", "src/c.ts#c", "route:GET /c"] }],
        tests: [],
        gaps: [],
      },
      "uncommitted changes",
    );
    await show(model);
    expect(root.querySelector(".banner.info")!.textContent).toContain("outside any unit");
    expect([...root.querySelectorAll(".impact-group h2")].map((h) => h.textContent)).toEqual(["Changed 1", "Routes reached 1", "Direct callers 1", "2 calls away 1"]);
    expect(root.querySelector('li[data-id="route:GET /c"]')!.textContent).toContain("handled by c");
    expect(root.querySelector('li[data-id="src/c.ts#c"] .confidence')!.textContent).toBe("name match");
    expect(root.querySelector("svg g.nodes")).toBeNull();

    sent = [];
    await click(root.querySelector('li[data-id="src/b.ts#b"] a')!);
    expect(sent).toEqual([{ type: "open", nodeId: "src/b.ts#b", source: false }]);

    const toggle = [...root.querySelectorAll("button")].find((b) => b.textContent === "Show diagram")!;
    await click(toggle);
    await drawn();
    expect(nodeEl("src/c.ts#c").classList.contains("weak-path")).toBe(true);

    await show(impactModel({ subjects: [], notes: [], units: [], routes: [], tests: [], gaps: [] }, "uncommitted changes"));
    expect(root.querySelector(".empty")!.textContent).toContain("No changed units");
    expect(root.querySelector(".impact-list")).toBeNull();
  });

  it("shows errors and the unsaved-changes banner; Refresh asks again", async () => {
    await show(null, { error: 'No unit or symbol named "nope".', dirty: true });
    expect(root.querySelector(".banner.error")!.textContent).toContain("nope");
    expect(root.querySelector(".banner.warning")!.textContent).toContain("unsaved changes");
    sent = [];
    await click([...root.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!);
    expect(sent).toEqual([{ type: "refresh" }]);
  });
});
