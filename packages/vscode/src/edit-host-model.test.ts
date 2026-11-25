import { describe, expect, it } from "vitest";
import { textHash as coreTextHash, type ChangeRequest, type EditState } from "@sift/core";
import { activityOf, draftAction, filesOf, openRequestFor, textHash } from "./edit-host-model.js";

function request(id: string, state: EditState, extra: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id,
    unitId: "u_aaaaaaaa",
    file: "src/a.ts",
    symbol: "a",
    base: { bodyHash: "b", fileHash: "f", description: {} as ChangeRequest["base"]["description"] },
    edits: [],
    answers: [],
    state,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, tasks: {} },
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const set = { op: "set" as const, path: "summary", before: "A.", after: "B." };

describe("change requests on the host", () => {
  it("finds a unit's open request, skipping finished ones", () => {
    const list = [request("e_applied1", "applied"), request("e_ready001", "ready"), request("e_draft001", "draft")];
    expect(openRequestFor(list, "u_aaaaaaaa")?.id).toBe("e_ready001");
    expect(openRequestFor(list, "u_bbbbbbbb")).toBeUndefined();
    expect(openRequestFor([request("e_rejected", "rejected")], "u_aaaaaaaa")).toBeUndefined();
  });

  it("decides what saving a draft does", () => {
    expect(draftAction(undefined, { edits: [], request: "  " })).toEqual({ kind: "none" });
    expect(draftAction(undefined, { edits: [set], request: "" })).toEqual({ kind: "create" });
    expect(draftAction(undefined, { edits: [], request: "Reject negatives" })).toEqual({ kind: "create" });
    const draft = request("e_draft001", "draft", { edits: [set], request: "Reject negatives" });
    expect(draftAction(draft, { edits: [set], request: "Reject negatives " })).toEqual({ kind: "none" });
    expect(draftAction(draft, { edits: [], request: "Reject negatives" })).toEqual({ kind: "update", id: "e_draft001" });
    expect(draftAction(draft, { edits: [], request: "" })).toEqual({ kind: "discard", id: "e_draft001" });
    // A ready proposal takes new edits (it goes back to draft); one whose code changed does not.
    expect(draftAction(request("e_ready001", "ready"), { edits: [set], request: "" })).toEqual({ kind: "update", id: "e_ready001" });
    expect(draftAction(request("e_review01", "needs-review"), { edits: [set], request: "" }).kind).toBe("refuse");
    expect(draftAction(request("e_running1", "proposing"), { edits: [set], request: "" }).kind).toBe("refuse");
  });

  it("maps proposal progress to what the document shows", () => {
    expect(activityOf({ type: "stage", id: "e", stage: "planning" })).toBe("planning");
    expect(activityOf({ type: "stage", id: "e", stage: "coding", attempt: 1 })).toBe("coding");
    expect(activityOf({ type: "stage", id: "e", stage: "coding", attempt: 2 })).toBe("fixing");
    expect(activityOf({ type: "state", id: "e", state: "ready" })).toBeNull();
  });

  it("hashes text as core does, and lists the files an apply writes", () => {
    expect(textHash("const a = 1;\r\n")).toBe(coreTextHash("const a = 1;\r\n"));
    const ready = request("e_ready001", "ready", {
      proposal: {
        files: [{ path: "src/a.ts", beforeHash: "", beforeFileHash: "", afterFileHash: "", text: "", diff: "" }],
        units: [
          { ref: "src/a.ts#a", before: null, after: {} as never, logic: [] },
          { ref: "src/b.ts#b", before: null, after: {} as never, logic: [] },
        ],
      } as unknown as ChangeRequest["proposal"],
    });
    expect(filesOf(ready)).toEqual(["src/a.ts", ".sift/src/a.ts.sift", ".sift/src/b.ts.sift"]);
    expect(filesOf(request("e_draft001", "draft"))).toEqual([]);
  });
});
