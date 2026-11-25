// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeRequest, LogicFile, LogicUnit, SiftUnit } from "@sift/core";
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
  send({ type: "state", state: { source: SOURCE, error: null, dirty: false, edits: [], provider: null, ...state } });
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
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
    click($(".unit-header button.verify"));

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
    const verify = (id: string) => $(`[data-unit="${id}"] .unit-header button.verify`);
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

// ── Editing (phase-2-design §8.1, M15) ─────────────────────────────────────

function changeRequest(unit: SiftUnit, state: ChangeRequest["state"], extra: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: "e_aaaaaaaa",
    unitId: unit.id,
    file: SOURCE,
    symbol: unit.symbol,
    base: { bodyHash: unit.bodyHash, fileHash: "f", description: unit },
    edits: [],
    answers: [],
    state,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, tasks: {} },
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const keydown = (el: Element | null, key: string, init: KeyboardEventInit = {}) => act(() => void el!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init })));
const type = (el: HTMLTextAreaElement | HTMLInputElement, text: string) =>
  act(() => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const drafts = () => posted.filter((m): m is Extract<WebviewMessage, { type: "draft" | "propose" }> => m.type === "draft" || m.type === "propose");

describe("LogicDocument editing", () => {
  const unit = siftUnit("u_aaaaaaaa", "AccountService.withdraw");

  it("opens a unit for editing, edits a step and the summary in place, and saves each change as a draft", () => {
    show({ file: file([logicUnit(unit)]), provider: { id: "claude-code", local: false } });
    expect($(".unit-header button.verify")).not.toBeNull();
    click($(".unit-header button.edit-unit"));
    expect($(".unit")!.classList.contains("editing")).toBe(true);
    expect($(".unit-header button.verify")).toBeNull();
    expect($(".badge.draft")!.textContent).toBe("Editing");
    expect($(".edit-panel")!.textContent).toContain("sends this unit and the code around it to claude-code");
    // Nothing asked yet: Propose is disabled.
    expect($<HTMLButtonElement>(".edit-panel button")!.disabled).toBe(true);

    // Click a step: it becomes a text box; Enter keeps the text.
    posted = [];
    click($('[data-key="u_aaaaaaaa/s_bbbb"] .text'));
    const box = $<HTMLTextAreaElement>('[data-key="u_aaaaaaaa/s_bbbb"] textarea')!;
    expect(box.value).toBe("Save the account.");
    type(box, "Save the account inside a transaction.");
    keydown(box, "Enter");
    expect(posted).toEqual([
      { type: "draft", unitId: "u_aaaaaaaa", edits: [{ op: "set", path: "steps[s_bbbb].text", before: "Save the account.", after: "Save the account inside a transaction." }], request: "", seq: 1 },
    ]);
    // The draft shows at once, marked as changed, before the host answers.
    expect($('[data-key="u_aaaaaaaa/s_bbbb"] .text')!.textContent).toBe("Save the account inside a transaction.");
    expect($('[data-key="u_aaaaaaaa/s_bbbb"] .mark.changed')).not.toBeNull();

    // Escape cancels.
    click($(".summary"));
    const summary = $<HTMLTextAreaElement>(".summary textarea")!;
    type(summary, "Something else.");
    keydown(summary, "Escape");
    expect(drafts()).toHaveLength(1);
    expect($(".summary")!.textContent).toBe("Summary of AccountService.withdraw.");
  });

  it("adds a step after one and inside an if, removes one, and restores it", () => {
    show({ file: file([logicUnit(unit)]) });
    click($(".unit-header button.edit-unit"));
    click($('[data-key="u_aaaaaaaa/s_cccc"] button[aria-label="Add a step after"]'));
    const box = $<HTMLTextAreaElement>(".new-step textarea")!;
    type(box, "Send a receipt.");
    keydown(box, "Enter");
    const add = drafts().at(-1)!.edits[0]!;
    expect(add).toMatchObject({ op: "add", text: "Send a receipt.", after: "s_cccc" });
    expect($$(".unit-body > .steps > li > .step-line .text").map((e) => e.textContent)).toEqual(["If the amount is not positive, reject it.", "Save the account.", "Update the row.", "Send a receipt."]);
    expect($(".step.added .mark.added")!.textContent).toBe("new");

    click($('[data-key="u_aaaaaaaa/s_aaaa"] button[aria-label="Add a step inside"]'));
    const inner = $<HTMLTextAreaElement>(".new-step.nested textarea")!;
    type(inner, "Log the refusal.");
    keydown(inner, "Enter");
    expect(drafts().at(-1)!.edits[1]).toMatchObject({ op: "add", text: "Log the refusal.", parent: "s_aaaa" });

    click($('[data-key="u_aaaaaaaa/s_bbbb"] button[aria-label="Remove step"]'));
    expect(drafts().at(-1)!.edits.at(-1)).toEqual({ op: "delete", step: "s_bbbb" });
    expect($('[data-key="u_aaaaaaaa/s_bbbb"]')).toBeNull();
    expect($(".deleted-steps")!.textContent).toContain("Save the account.");
    click($(".deleted-steps button"));
    expect(drafts().at(-1)!.edits.some((e) => e.op === "delete")).toBe(false);
  });

  it("writes a request, proposes the draft with it, and drops its own copy once the host confirms", () => {
    show({ file: file([logicUnit(unit)]) });
    click($(".unit-header button.edit-unit"));
    const request = $<HTMLTextAreaElement>("textarea.request")!;
    type(request, "Reject amounts of zero or less.");
    expect(drafts()).toEqual([]); // typing alone saves nothing
    act(() => void request.dispatchEvent(new FocusEvent("blur")));
    expect(drafts()).toEqual([{ type: "draft", unitId: "u_aaaaaaaa", edits: [], request: "Reject amounts of zero or less.", seq: 2 }]);
    click($(".edit-panel button"));
    expect(posted.at(-1)).toEqual({ type: "propose", unitId: "u_aaaaaaaa", edits: [], request: "Reject amounts of zero or less.", seq: 3 });

    // The host saved it and is planning; the stored request is shown with progress and Cancel.
    const req = changeRequest(unit, "draft", { request: "Reject amounts of zero or less." });
    show({ file: file([logicUnit(unit)]), edits: [{ request: req, activity: "planning" }] });
    send({ type: "draftSaved", unitId: "u_aaaaaaaa", seq: 3 });
    expect($(".edit-panel.running")!.textContent).toContain("Planning the change");
    expect($(".badge.draft")!.textContent).toBe("Proposing…");
    expect($("textarea.request")).toBeNull();
    click($(".edit-panel.running button"));
    expect(posted.at(-1)).toEqual({ type: "cancel", id: "e_aaaaaaaa" });
  });

  it("asks the plan's questions and sends the answers", () => {
    const req = changeRequest(unit, "needs-answers", {
      request: "Don't let people overdraw.",
      questions: [
        { id: "q1", text: "What should happen when the balance is too low?", options: ["Throw an error", "Return the account unchanged"] },
        { id: "q2", text: "Should overdraft limits apply?", options: [] },
      ],
    });
    show({ file: file([logicUnit(unit)]), edits: [{ request: req, activity: null }] });
    expect($(".badge.draft")!.textContent).toBe("Questions");
    const submit = $<HTMLButtonElement>('.questions button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    click($('input[value="Throw an error"]'));
    type($<HTMLInputElement>('.question:nth-of-type(2) input[type="text"]')!, "No");
    expect(submit.disabled).toBe(false);
    act(() => void $(".questions")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(posted.at(-1)).toEqual({
      type: "answer",
      id: "e_aaaaaaaa",
      answers: [
        { questionId: "q1", answer: "Throw an error" },
        { questionId: "q2", answer: "No" },
      ],
    });
  });

  it("offers the review for a ready change, shows failures, and re-plans a change whose code moved", () => {
    const edits = [{ op: "set" as const, path: "summary", before: unit.summary, after: "Takes money out, if positive." }];
    const ready = changeRequest(unit, "ready", {
      edits,
      plan: { kind: "behavior", interpretation: "Reject non-positive amounts first.", questions: [], warnings: [], allowedUnits: [], helpers: [], examples: [], broader: null },
      proposal: {
        kind: "behavior",
        files: [{ path: SOURCE, beforeHash: "", beforeFileHash: "", afterFileHash: "", text: "", diff: "" }],
        units: [],
        newUnits: [],
        scope: { changed: [`${SOURCE}#AccountService.withdraw`], allowed: [], affected: { units: [], routes: [] }, broader: { reason: "Two callers change too.", units: [] } },
        checks: [],
        effects: { added: [], removed: [] },
        verify: { satisfied: false, gaps: ["Zero is still allowed."], unrequested: [] },
        warnings: [],
        notes: "",
      },
    });
    show({ file: file([logicUnit(unit)]), edits: [{ request: ready, activity: null }] });
    // The draft is shown in the document, still editable.
    expect($(".summary")!.textContent).toContain("Takes money out, if positive.");
    expect($(".summary")!.classList.contains("changed")).toBe(true);
    const panel = $(".edit-panel")!;
    expect(panel.textContent).toContain("Reject non-positive amounts first.");
    expect(panel.textContent).toContain("Reaches beyond this unit: Two callers change too.");
    expect(panel.textContent).toContain("may not do everything you asked");
    click(panel.querySelector(".ready button"));
    expect(posted.at(-1)).toEqual({ type: "review", id: "e_aaaaaaaa" });

    show({ file: file([logicUnit(unit)]), edits: [{ request: changeRequest(unit, "failed", { request: "x", error: { message: "The code did not type-check after one retry.", details: ["src/a.ts:3 TS2322"] } }), activity: null }] });
    expect($(".edit-panel .banner.error")!.textContent).toContain("did not type-check");
    expect($(".edit-panel .banner.error li")!.textContent).toBe("src/a.ts:3 TS2322");
    expect($$(".edit-panel button").map((b) => b.textContent)).toContain("Propose again");

    show({ file: file([logicUnit(unit)]), edits: [{ request: changeRequest(unit, "needs-review", { edits, request: "Reject negatives", review: "The code changed since this edit was written." }), activity: null }] });
    expect($(".edit-panel.needs-review")!.textContent).toContain("The code changed since this edit was written.");
    expect($(".edit-panel.needs-review")!.textContent).toContain("You asked for “Reject negatives” and 1 edit to the description.");
    // Shown against the current code, not editable.
    expect($(".summary")!.textContent).toBe(unit.summary);
    expect($(".unit")!.classList.contains("editing")).toBe(false);
    click($(".edit-panel.needs-review button"));
    expect(posted.at(-1)).toEqual({ type: "replan", id: "e_aaaaaaaa" });
    click($$(".edit-panel.needs-review button")[1]!);
    expect(posted.at(-1)).toEqual({ type: "discard", id: "e_aaaaaaaa" });
  });

  it("offers Edit only on fresh units, and opens one for editing when the host asks", () => {
    show({ file: file([logicUnit(unit, { freshness: "code-changed" }), logicUnit(siftUnit("u_bbbbbbbb", "B.b", { status: "stale" }), { status: "stale" }), logicUnit(siftUnit("u_cccccccc", "C.c", { lite: true }))]) });
    expect($('[data-unit="u_aaaaaaaa"] .edit-unit')).toBeNull();
    expect($('[data-unit="u_bbbbbbbb"] .edit-unit')).toBeNull();
    expect($('[data-unit="u_cccccccc"]')!.classList.contains("collapsed")).toBe(true);
    send({ type: "edit", unitId: "u_cccccccc" });
    expect($('[data-unit="u_cccccccc"]')!.classList.contains("collapsed")).toBe(false);
    expect($('[data-unit="u_cccccccc"]')!.classList.contains("editing")).toBe(true);
  });
});
