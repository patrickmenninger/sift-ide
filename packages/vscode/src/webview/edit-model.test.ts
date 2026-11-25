import { describe, expect, it } from "vitest";
import type { SiftUnit } from "@sift/core";
import { addStep, allSteps, changes, draftOf, fieldPath, removeStep, revert, setText, wordDiff } from "./edit-model.js";

function unit(): SiftUnit {
  return {
    id: "u_aaaaaaaa",
    symbol: "AccountService.withdraw",
    kind: "method",
    status: "generated",
    bodyHash: "h",
    summary: "Takes money out of an account.",
    inputs: [{ name: "amountCents", type: "number", meaning: "How much to take, in cents." }],
    returns: { type: "Promise<Account>", meaning: "The account after the withdrawal." },
    effects: ["db.write"],
    steps: [
      { id: "s_aaaa", kind: "if", text: "If the account is not the caller's, refuse.", covers: ["0"], calls: [], effects: ["throws"], steps: [{ id: "s_aaab", text: "Throw a forbidden error.", covers: ["0.0"], calls: [], effects: [], steps: [] }] },
      { id: "s_bbbb", text: "Subtract the amount from the balance.", covers: ["1"], calls: [], effects: [], steps: [] },
      { id: "s_cccc", text: "Save the account.", covers: ["2"], calls: [], effects: ["db.write"], steps: [] },
    ],
    warnings: [],
    tests: [],
  };
}

describe("drafts", () => {
  it("sets a field once, keeps the base text as `before`, and drops the edit when the text goes back", () => {
    const base = unit();
    let edits = setText(base, [], fieldPath.summary, "Takes money out, if there is enough.");
    edits = setText(base, edits, fieldPath.summary, "Takes money out, only if there is enough.");
    expect(edits).toEqual([{ op: "set", path: "summary", before: "Takes money out of an account.", after: "Takes money out, only if there is enough." }]);
    expect(draftOf(base, edits).summary).toBe("Takes money out, only if there is enough.");
    expect(draftOf(base, edits).userEdited).toEqual(["summary"]);
    expect(setText(base, edits, fieldPath.summary, " Takes money out of an account. ")).toEqual([]);
    // Emptying a field is not an edit either.
    expect(setText(base, edits, fieldPath.summary, "  ")).toEqual([]);
  });

  it("edits step text, input and return meanings", () => {
    const base = unit();
    let edits = setText(base, [], fieldPath.step("s_bbbb"), "Subtract the amount, refusing if the balance is too low.");
    edits = setText(base, edits, fieldPath.input("amountCents"), "How much to take, in cents; must be positive.");
    edits = setText(base, edits, fieldPath.returns, "The updated account.");
    const draft = draftOf(base, edits);
    expect(draft.steps[1]).toMatchObject({ text: "Subtract the amount, refusing if the balance is too low.", status: "user-edited" });
    expect(draft.inputs[0]!.meaning).toBe("How much to take, in cents; must be positive.");
    expect(draft.returns!.meaning).toBe("The updated account.");
    expect(changes(base, edits).set).toEqual(new Set(["steps[s_bbbb].text", "inputs[amountCents].meaning", "returns.meaning"]));
  });

  it("adds steps after one, inside one, and first; editing an added step changes its text", () => {
    const base = unit();
    const first = addStep(base, [], {}, "Check the amount is positive.");
    const after = addStep(base, first.edits, { after: "s_bbbb" }, "Log the withdrawal.");
    const inside = addStep(base, after.edits, { parent: "s_aaaa" }, "Record the attempt.");
    expect(new Set([first.id, after.id, inside.id]).size).toBe(3);
    for (const id of [first.id, after.id, inside.id]) expect(id).toMatch(/^s_[a-z2-7]{4}$/);

    let edits = setText(base, inside.edits, fieldPath.step(after.id), "Log the withdrawal with its amount.");
    expect(edits.filter((e) => e.op === "set")).toEqual([]);
    const draft = draftOf(base, edits);
    expect(draft.steps.map((s) => s.text)).toEqual(["Check the amount is positive.", "If the account is not the caller's, refuse.", "Subtract the amount from the balance.", "Log the withdrawal with its amount.", "Save the account."]);
    expect(draft.steps[1]!.steps.map((s) => s.text)).toEqual(["Record the attempt.", "Throw a forbidden error."]);
    expect(changes(base, edits).added).toEqual(new Set([first.id, after.id, inside.id]));

    // Emptying an added step removes it.
    edits = setText(base, edits, fieldPath.step(first.id), "");
    expect(allSteps(draftOf(base, edits).steps).some((s) => s.id === first.id)).toBe(false);
  });

  it("removes a base step (with its edits) and an added step (with the steps placed after it); revert restores", () => {
    const base = unit();
    let edits = setText(base, [], fieldPath.step("s_aaab"), "Throw.");
    edits = removeStep(base, edits, "s_aaaa");
    expect(edits).toEqual([{ op: "delete", step: "s_aaaa" }]);
    expect(changes(base, edits).deleted.map((s) => s.id)).toEqual(["s_aaaa"]);
    expect(draftOf(base, edits).steps.map((s) => s.id)).toEqual(["s_bbbb", "s_cccc"]);
    expect(revert(base, edits, { stepId: "s_aaaa" })).toEqual([]);

    const a = addStep(base, [], { after: "s_cccc" }, "Send a receipt.");
    const b = addStep(base, a.edits, { after: a.id }, "Log it.");
    expect(removeStep(base, b.edits, a.id)).toEqual([]);
    expect(revert(base, b.edits, { stepId: b.id }).map((e) => e.op === "add" && e.id)).toEqual([a.id]);
  });

  it("adds keep their anchors when a later delete removes a neighbour", () => {
    const base = unit();
    const deleted = removeStep(base, [], "s_bbbb");
    const added = addStep(base, deleted, { after: "s_bbbb" }, "Check the balance first.");
    // The add goes before the delete, so it still finds s_bbbb when applied.
    expect(added.edits.map((e) => e.op)).toEqual(["add", "delete"]);
    expect(draftOf(base, added.edits).steps.map((s) => s.text)).toEqual(["If the account is not the caller's, refuse.", "Check the balance first.", "Save the account."]);
  });

  it("shows the base when edits no longer fit it", () => {
    const base = unit();
    expect(draftOf(base, [{ op: "delete", step: "s_zzzz" }])).toBe(base);
  });
});

describe("wordDiff", () => {
  const show = (before: string, after: string) => wordDiff(before, after).map((p) => (p.kind === "same" ? p.text : p.kind === "added" ? `[+${p.text}]` : `[-${p.text}]`)).join("");

  it("marks words added and removed, removed first, and joins back to both texts", () => {
    expect(show("Save both accounts.", "Inside a transaction, save both accounts.")).toBe("[-Save ][+Inside a transaction, save ]both accounts.");
    expect(show("Subtract the amount.", "Subtract the amount if the balance allows.")).toBe("Subtract the [-amount.][+amount if the balance allows.]");
    const parts = wordDiff("a b c", "a x c");
    expect(parts.filter((p) => p.kind !== "added").map((p) => p.text).join("")).toBe("a b c");
    expect(parts.filter((p) => p.kind !== "removed").map((p) => p.text).join("")).toBe("a x c");
  });

  it("handles empty texts", () => {
    expect(wordDiff("", "New step.")).toEqual([{ kind: "added", text: "New step." }]);
    expect(wordDiff("Old step.", "")).toEqual([{ kind: "removed", text: "Old step." }]);
    expect(wordDiff("Same.", "Same.")).toEqual([{ kind: "same", text: "Same." }]);
  });
});
