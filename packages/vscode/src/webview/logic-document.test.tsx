// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogicFile, LogicUnit, SiftUnit } from "@sift/core";
import { LogicDocument } from "./logic-document.js";
import type { HostMessage, LogicDocumentState, WebviewMessage } from "./protocol.js";

const SOURCE = "src/accounts/account-service.ts";

function siftUnit(id: string, symbol: string, extra: Partial<SiftUnit> = {}): SiftUnit {
  return {
    id,
    symbol,
    kind: "method",
    status: "generated",
    bodyHash: "h",
    generatedBy: { provider: "claude-code", model: "sonnet", prompt: "describe@3", belowTier: false },
    summary: `Summary of ${symbol}.`,
    inputs: [{ name: "amountCents", type: "number", meaning: "How much to move, in cents." }],
    returns: { type: "Promise<void>", typeInferred: true, meaning: "Nothing." },
    effects: ["db.write"],
    steps: [
      { id: "s_aaaa", kind: "if", text: "If the amount is not positive, reject it.", covers: ["0"], calls: [], effects: ["throws"], steps: [{ id: "s_aaab", text: "Throw an error.", covers: ["0.0"], calls: [], effects: [], steps: [] }] },
      { id: "s_bbbb", status: "user-edited", text: "Save the account.", covers: ["1"], calls: ["u_impl0001", "u_impl0002"], effects: [], steps: [] },
      { id: "s_cccc", text: "Update the row.", covers: ["2"], calls: ["ext:@prisma/client#update"], effects: ["db.write"], steps: [] },
    ],
    warnings: [{ id: "w_aaaa", kind: "missing-transaction", text: "The two saves are not in a transaction.", steps: ["s_bbbb"] }],
    tests: [],
    ...extra,
  };
}

function logicUnit(unit: SiftUnit, extra: Partial<LogicUnit> = {}): LogicUnit {
  return { ref: `${SOURCE}#${unit.symbol}`, unit, status: unit.status, freshness: "fresh", ...extra };
}

function file(units: LogicUnit[], undescribed: string[] = []): LogicFile {
  return { source: SOURCE, sift: { sift: 1, source: SOURCE, language: "typescript", fileHash: "f", units: units.map((u) => u.unit) }, units, undescribed };
}

let container: HTMLElement;
let posted: WebviewMessage[];
let toggled: string[];

function send(message: HostMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  });
}

function show(state: Partial<LogicDocumentState> & { file: LogicFile | null }) {
  send({ type: "state", state: { source: SOURCE, error: null, dirty: false, ...state } });
}

const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const click = (el: Element | null, init: MouseEventInit = {}) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  posted = [];
  toggled = [];
  act(() => render(<LogicDocument post={(m) => posted.push(m)} onToggled={(t) => (toggled = t)} />, container));
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe("LogicDocument", () => {
  it("asks for its state, then renders each unit with badge, inputs, effects, nested steps, and warnings", () => {
    expect(posted).toEqual([{ type: "ready" }]);
    expect(container.textContent).toContain("Loading");
    show({ file: file([logicUnit(siftUnit("u_aaaaaaaa", "AccountService.deposit"))]) });

    const unit = $('[data-unit="u_aaaaaaaa"]')!;
    expect(unit.querySelector(".name")!.textContent).toBe("AccountService.deposit");
    expect(unit.querySelector(".badge")!.textContent).toBe("Unverified");
    expect(unit.querySelector(".badge")!.getAttribute("title")).toContain("sonnet");
    // Generated text is faint until verified.
    expect(unit.classList.contains("faint")).toBe(true);
    expect(unit.querySelector(".summary")!.textContent).toBe("Summary of AccountService.deposit.");
    expect(unit.querySelector(".io")!.textContent).toContain("amountCents");
    expect(unit.querySelector(".io")!.textContent).toContain("inferred");
    expect($$(".unit-body > .effects .chip").map((c) => c.textContent)).toEqual(["db.write"]);
    // Nested steps keep their structure; a person's step is marked.
    expect($('[data-key="u_aaaaaaaa/s_aaaa"] [data-key="u_aaaaaaaa/s_aaab"]')).not.toBeNull();
    expect($('[data-key="u_aaaaaaaa/s_bbbb"] .mark.edited')).not.toBeNull();
    expect($('[data-key="u_aaaaaaaa/s_bbbb"] .calls')!.textContent).toBe("→ 2");
    expect(unit.querySelector(".warnings")!.textContent).toContain("The two saves are not in a transaction.");
  });

  it("sends hover, show-source, navigate (Ctrl/Alt/F12), and verify intents", () => {
    show({ file: file([logicUnit(siftUnit("u_aaaaaaaa", "AccountService.deposit"))]) });
    posted = [];
    const line = $('[data-key="u_aaaaaaaa/s_bbbb"] > .step-line')!;
    const at = { unitId: "u_aaaaaaaa", stepId: "s_bbbb" };

    act(() => void line.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => void line.dispatchEvent(new MouseEvent("mouseenter")));
    click(line);
    click(line, { ctrlKey: true });
    click(line, { metaKey: true });
    click(line, { altKey: true });
    act(() => void line.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true })));
    click($(".unit-header button.secondary"));

    expect(posted).toEqual([
      { type: "hover", at },
      { type: "showSource", at },
      { type: "navigate", at, source: false },
      { type: "navigate", at, source: false },
      { type: "navigate", at, source: true },
      { type: "navigate", at, source: false },
      { type: "verify", unitId: "u_aaaaaaaa" },
    ]);
  });

  it("marks stale units, offers Verify only for fresh unverified ones, and shows other badges", () => {
    const stale = logicUnit(siftUnit("u_aaaaaaaa", "A.stale"), { freshness: "code-changed" });
    const verified = logicUnit(siftUnit("u_bbbbbbbb", "A.verified", { status: "verified" }), { status: "verified" });
    const edited = logicUnit(siftUnit("u_cccccccc", "A.edited", { status: "user-edited" }), { status: "user-edited" });
    const review = logicUnit(siftUnit("u_dddddddd", "A.review", { status: "stale" }), { status: "stale" });
    show({ file: file([stale, verified, edited, review]) });

    const badge = (id: string) => $(`[data-unit="${id}"] .badge`)!.textContent;
    const verify = (id: string) => $(`[data-unit="${id}"] .unit-header button.secondary`);
    expect(badge("u_aaaaaaaa")).toBe("Stale");
    expect($('[data-unit="u_aaaaaaaa"] .banner')!.textContent).toContain("the code changed");
    expect(verify("u_aaaaaaaa")).toBeNull();
    expect(badge("u_bbbbbbbb")).toBe("Verified");
    expect(verify("u_bbbbbbbb")).toBeNull();
    expect($('[data-unit="u_bbbbbbbb"]')!.classList.contains("faint")).toBe(false);
    expect(badge("u_cccccccc")).toBe("Edited");
    expect(verify("u_cccccccc")).not.toBeNull();
    expect(badge("u_dddddddd")).toBe("Needs review");
    expect(verify("u_dddddddd")).toBeNull();
    // Out-of-date units: the header offers an update (with an estimate first, in the host).
    click($(".doc-header button"));
    expect(posted.at(-1)).toEqual({ type: "describe" });
  });

  it("collapses lite units to one line, toggles sections, and remembers the choice", () => {
    const lite = logicUnit(siftUnit("u_aaaaaaaa", "A.lite", { lite: true, steps: [] }));
    show({ file: file([lite, logicUnit(siftUnit("u_bbbbbbbb", "A.full"))]) });
    expect($('[data-unit="u_aaaaaaaa"]')!.classList.contains("collapsed")).toBe(true);
    expect($('[data-unit="u_aaaaaaaa"] .one-line')!.textContent).toBe("Summary of A.lite.");
    expect($('[data-unit="u_aaaaaaaa"] .unit-body')).toBeNull();
    click($('[data-unit="u_aaaaaaaa"] .twisty'));
    expect($('[data-unit="u_aaaaaaaa"] .unit-body')).not.toBeNull();
    click($('[data-unit="u_bbbbbbbb"] .twisty'));
    expect($('[data-unit="u_bbbbbbbb"] .unit-body')).toBeNull();
    expect(toggled.sort()).toEqual(["u_aaaaaaaa", "u_bbbbbbbb"]);
  });

  it("follows the source cursor: marks the owning step and opens its collapsed unit", () => {
    show({ file: file([logicUnit(siftUnit("u_aaaaaaaa", "A.one"))]) });
    click($('[data-unit="u_aaaaaaaa"] .twisty'));
    expect($('[data-unit="u_aaaaaaaa"] .unit-body')).toBeNull();
    send({ type: "current", at: { unitId: "u_aaaaaaaa", stepId: "s_aaab" } });
    expect($('[data-key="u_aaaaaaaa/s_aaab"]')!.classList.contains("current")).toBe(true);
    expect($$(".step.current")).toHaveLength(1);
    send({ type: "current", at: null });
    expect($$(".current")).toHaveLength(0);
  });

  it("shows the calls card on hover and pinned after Ctrl+click on library calls", async () => {
    show({ file: file([logicUnit(siftUnit("u_aaaaaaaa", "A.one"))]) });
    const at = { unitId: "u_aaaaaaaa", stepId: "s_cccc" };
    posted = [];
    act(() => void $('[data-key="u_aaaaaaaa/s_cccc"] .calls')!.dispatchEvent(new MouseEvent("mouseenter")));
    expect(posted).toEqual([{ type: "targets", at }]);
    expect($(".card")!.textContent).toContain("Loading");
    send({ type: "targets", at, pinned: false, targets: [{ kind: "external", ref: "ext:@prisma/client#update", module: "@prisma/client", name: "update", effects: ["db.write"] }] });
    expect($(".card code")!.textContent).toBe("@prisma/client#update");
    expect($(".card .chip")!.textContent).toBe("db.write");

    // A pinned card for another step replaces it and stays until Escape.
    const target = { kind: "unit" as const, unitId: "u_impl0001", ref: "src/r.ts#R.save", file: "src/r.ts", symbol: "R.save", summary: "Saves it." };
    send({ type: "targets", at: { unitId: "u_aaaaaaaa", stepId: "s_bbbb" }, pinned: true, targets: [target] });
    expect($(".card.pinned")!.textContent).toContain("Saves it.");
    click($(".card a"), { altKey: true });
    expect(posted.at(-1)).toEqual({ type: "openTarget", target, source: true });
    expect($(".card")).toBeNull();
  });

  it("says when the source has unsaved changes, errors, and units not described yet", () => {
    show({ file: file([], ["AccountService.deposit", "<module>"]), dirty: true });
    expect($(".banner.warning")!.textContent).toContain("unsaved changes");
    expect(container.textContent).toContain("no description yet");
    expect($(".doc-header button")!.textContent).toBe("Describe this file…");
    show({ file: file([logicUnit(siftUnit("u_aaaaaaaa", "A.one"))], ["A.two", "<module>"]) });
    expect($(".undescribed")!.textContent).toContain("A.two, Top-level code");
    show({ file: null, error: "src/x.ts is not a source file Sift reads." });
    expect($(".banner.error")!.textContent).toContain("not a source file");
  });
});
