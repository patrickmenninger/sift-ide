// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeRequest, EditProposal, SiftUnit } from "@sift/core";
import { ReviewView } from "./review-view.js";
import type { ReviewState, ReviewWebviewMessage } from "./review-protocol.js";

const FILE = "src/accounts/account-service.ts";
const REF = `${FILE}#AccountService.withdraw`;

const unit = { id: "u_aaaaaaaa", symbol: "AccountService.withdraw" } as SiftUnit;

function proposal(extra: Partial<EditProposal> = {}): EditProposal {
  return {
    kind: "behavior",
    files: [{ path: FILE, beforeHash: "a", beforeFileHash: "b", afterFileHash: "c", text: "", diff: `--- a/${FILE}\n+++ b/${FILE}\n@@ -1,3 +1,6 @@\n   async withdraw() {\n+    if (amountCents <= 0) {\n+      throw new ValidationError("Withdrawal amount must be positive");\n+    }\n     const account = await this.repo.getAccount(accountId);\n` }],
    units: [
      {
        ref: REF,
        before: unit,
        after: unit,
        logic: [
          { field: "summary", before: "Takes money out of an account.", after: "Takes money out of an account, if the amount is positive." },
          { field: "step", change: "added", id: "s_new1", after: "If the amount is zero or less, reject it with a validation error." },
          { field: "step", change: "removed", id: "s_old1", before: "Log the call." },
          { field: "effects", added: ["throws"], removed: [] },
          { field: "warning", change: "resolved", kind: "missing-check", text: "Negative amounts are not rejected." },
        ],
      },
    ],
    newUnits: [],
    scope: { changed: [REF], allowed: [REF], affected: { units: [`src/http/routes.ts#withdrawHandler`], routes: ["route:POST /withdrawals"] }, broader: null },
    checks: [
      { name: "parses", kind: "parse", status: "passed", details: [] },
      { name: "type-checks", kind: "type-check", status: "passed", details: [] },
      { name: "scope", kind: "scope", status: "passed", details: [] },
      { name: "npm run lint", kind: "command", status: "skipped", details: ["Run the checks to see."] },
    ],
    effects: { added: ["throws"], removed: [] },
    verify: { satisfied: true, gaps: [], unrequested: [] },
    warnings: [],
    notes: "Used ValidationError as the other checks do.",
    ...extra,
  };
}

function request(state: ChangeRequest["state"], extra: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: "e_aaaaaaaa",
    unitId: unit.id,
    file: FILE,
    symbol: unit.symbol,
    base: { bodyHash: "h", fileHash: "f", description: unit },
    edits: [],
    request: "Reject amounts of zero or less.",
    answers: [{ questionId: "q1", question: "Is zero allowed?", answer: "No" }],
    state,
    plan: { kind: "behavior", interpretation: "Reject a withdrawal of zero or less before reading the account.", questions: [], warnings: [], allowedUnits: [], helpers: [], examples: [], broader: null },
    proposal: proposal(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, tasks: {} },
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

let container: HTMLElement;
let posted: ReviewWebviewMessage[];

function show(state: Partial<ReviewState>) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: { request: null, error: null, activity: null, dirty: [], ...state } } }));
  });
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const click = (el: Element | null, init: MouseEventInit = {}) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));
const button = (text: string) => $$("button").find((b) => b.textContent === text) ?? null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  posted = [];
  act(() => render(<ReviewView post={(m) => posted.push(m)} />, container));
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe("ReviewView", () => {
  it("shows, in order, the request, the logic diff word by word, the code diff, scope, checks, and notes", () => {
    expect(posted).toEqual([{ type: "ready" }]);
    show({ request: request("ready") });
    expect($("h1")!.textContent).toBe("Change to AccountService.withdraw");
    expect($$("section h2").map((h) => h.textContent)).toEqual(["What you asked", "Logic changes", "Code changes", "Scope", "Checks", "Warnings and notes"]);
    expect($("blockquote.asked")!.textContent).toBe("Reject amounts of zero or less.");
    expect($(".answers")!.textContent).toContain("Is zero allowed?No");
    expect($(".interpretation")!.textContent).toContain("Reject a withdrawal of zero or less");

    const summary = $(".logic-diff li")!;
    expect([...summary.querySelectorAll("ins")].map((e) => e.textContent).join("")).toBe("account, if the amount is positive.");
    expect([...summary.querySelectorAll("del")].map((e) => e.textContent).join("")).toBe("account.");
    expect($(".step-change.added ins")!.textContent).toBe("If the amount is zero or less, reject it with a validation error.");
    expect($(".step-change.removed del")!.textContent).toBe("Log the call.");
    expect($(".warning-change.resolved")!.textContent).toContain("Warning resolved");

    expect($$(".unified-diff .add").map((l) => l.textContent)).toHaveLength(3);
    click(button("Open diff"));
    expect(posted.at(-1)).toEqual({ type: "openDiff", path: FILE });

    expect($(".scope")!.textContent).toContain("POST /withdrawals");
    // Checks say what ran; nothing is called "correct".
    expect($$(".check").map((c) => c.textContent!.trim())).toEqual(["✓ parses", "✓ type-checks", "✓ changes only what the plan allowed", "– npm run lint not runRun the checks to see."]);
    expect(container.textContent).not.toMatch(/correct/i);
    click(button("Run configured checks"));
    expect(posted.at(-1)).toEqual({ type: "runChecks" });
    expect(container.textContent).toContain("matches what you asked, as far as Sift can tell");
    expect($(".code-notes")!.textContent).toContain("Used ValidationError");
  });

  it("approves, rejects, goes back to the request, and opens units", () => {
    show({ request: request("ready") });
    const approve = $$(".decision button").filter((b) => b.textContent === "Approve and apply");
    expect(approve).toHaveLength(2); // top and bottom
    click(approve[0]!);
    expect(posted.at(-1)).toEqual({ type: "approve" });
    click(button("Reject"));
    expect(posted.at(-1)).toEqual({ type: "reject" });
    click(button("Change the request"));
    expect(posted.at(-1)).toEqual({ type: "openLogic" });
    click($(".unit-changes h3 a"), { altKey: true });
    expect(posted.at(-1)).toEqual({ type: "openUnit", ref: REF, source: true });
    click($(".scope .unit-list a"));
    expect(posted.at(-1)).toEqual({ type: "openUnit", ref: REF, source: false });

    // Busy or unsaved files: no approving.
    show({ request: request("ready"), activity: "applying" });
    expect($(".decision button")!.textContent).toBe("Applying…");
    expect($<HTMLButtonElement>(".decision button")!.disabled).toBe(true);
    show({ request: request("ready"), dirty: [FILE] });
    expect($(".decision .banner.warning")!.textContent).toContain(`${FILE} has unsaved changes`);
    expect($<HTMLButtonElement>(".decision button")!.disabled).toBe(true);
  });

  it("puts a broader scope and unmet intent up front", () => {
    show({
      request: request("ready", {
        proposal: proposal({
          scope: { changed: [REF], allowed: [REF], affected: { units: [], routes: [] }, broader: { reason: "The return type changes, so two callers change too.", units: ["src/http/routes.ts#withdrawHandler"] } },
          verify: { satisfied: false, gaps: ["Zero is still accepted."], unrequested: ["Also logs the amount."] },
        }),
      }),
    });
    const banners = $$(".banner.warning").map((b) => b.textContent);
    expect(banners[0]).toContain("This change reaches beyond AccountService.withdraw.");
    expect(banners[0]).toContain("two callers change too");
    expect(banners[0]).toContain("withdrawHandler");
    expect(banners[1]).toContain("may not do everything you asked");
    expect($$(".notes li").map((n) => n.textContent)).toEqual(["Not done Zero is still accepted.", "Not asked for Also logs the amount."]);
  });

  it("offers Undo once applied, and says what happened otherwise", () => {
    show({ request: request("applied") });
    expect($(".badge")!.textContent).toBe("Applied");
    expect(button("Approve and apply")).toBeNull();
    click(button("Undo"));
    expect(posted.at(-1)).toEqual({ type: "undo" });
    show({ request: request("needs-review", { review: "src/accounts/account-service.ts changed since this change was proposed." }) });
    expect($(".banner.warning")!.textContent).toContain("changed since this change was proposed. It will not be applied.");
    show({ request: request("rejected") });
    expect(container.textContent).toContain("Rejected. Nothing was written.");
    show({ request: null, error: "There is no change request e_aaaaaaaa." });
    expect($(".banner.error")!.textContent).toContain("no change request");
  });
});
