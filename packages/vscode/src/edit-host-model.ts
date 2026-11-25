import { createHash } from "node:crypto";
import type { ChangeRequest, DescriptionEdit, EditEvent, EditState } from "@sift/core";
import { SHOWN_STATES } from "./webview/edit-model.js";
import type { EditActivity } from "./webview/protocol.js";

export { SHOWN_STATES };

/**
 * What the extension host decides about change requests (phase-2-design §8), without `vscode`, so
 * it is tested on its own: which request belongs to a unit, what to do with a draft, and the
 * files an apply or undo touches.
 */

/** States in which `sift/edit/update` accepts new edits. */
const UPDATABLE: EditState[] = ["draft", "needs-answers", "failed", "ready"];

/** The open request for a unit: the newest one the document would show. `requests` are newest first, as `sift/edit/list` returns them. */
export function openRequestFor(requests: readonly ChangeRequest[], unitId: string): ChangeRequest | undefined {
  return requests.find((r) => r.unitId === unitId && SHOWN_STATES.includes(r.state));
}

export type DraftAction =
  | { kind: "create" }
  | { kind: "update"; id: string }
  | { kind: "discard"; id: string }
  | { kind: "none" }
  /** The request cannot take edits now (being proposed, or the code changed underneath). */
  | { kind: "refuse"; message: string };

/** What saving a unit's draft means, given its open request (if any). */
export function draftAction(open: ChangeRequest | undefined, draft: { edits: DescriptionEdit[]; request: string }): DraftAction {
  const asks = draft.edits.length > 0 || draft.request.trim() !== "";
  if (!open) return asks ? { kind: "create" } : { kind: "none" };
  if (sameDraft(open, draft)) return { kind: "none" };
  if (!UPDATABLE.includes(open.state)) {
    return { kind: "refuse", message: open.state === "needs-review" ? "The code changed since this edit was written. Re-plan it before changing it." : "This change is being proposed. Wait for it, or cancel it, before changing it." };
  }
  return asks ? { kind: "update", id: open.id } : { kind: "discard", id: open.id };
}

/** Whether a request already holds this draft. */
export function sameDraft(req: ChangeRequest, draft: { edits: DescriptionEdit[]; request: string }): boolean {
  return JSON.stringify(req.edits) === JSON.stringify(draft.edits) && (req.request ?? "") === draft.request.trim();
}

/** The activity shown for a progress event of a propose. */
export function activityOf(event: EditEvent): EditActivity | null {
  if (event.type !== "stage") return null;
  if (event.stage === "coding" && (event.attempt ?? 1) > 1) return "fixing";
  return event.stage;
}

/** Same as core's `textHash`: tells whether a file still holds the text a change was proposed for. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Source and `.sift` files an apply writes (and an undo restores), project-relative. */
export function filesOf(req: ChangeRequest): string[] {
  const proposal = req.proposal;
  if (!proposal) return [];
  const sources = proposal.files.map((f) => f.path);
  const descriptions = [...new Set(proposal.units.map((u) => u.ref.slice(0, u.ref.indexOf("#"))))].map((s) => `.sift/${s}.sift`);
  return [...sources, ...descriptions];
}

/** The request in a few words, for messages and pickers. */
export function describeRequest(req: ChangeRequest): string {
  const text = req.plan?.interpretation ?? req.request ?? `${req.edits.length} edit${req.edits.length === 1 ? "" : "s"} to the description`;
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/** "AccountService.withdraw" from a request. */
export function shortName(req: ChangeRequest): string {
  return req.symbol === "<module>" ? `top-level code of ${req.file}` : req.symbol;
}
