import type { ChangeRequest } from "@sift/core";
import type { EditActivity } from "./protocol.js";

/**
 * Messages between the extension host and the review panel (phase-2-design §8.8). Types only, like
 * `protocol.ts`: the panel renders the change request the host sends and answers with intents.
 */

export interface ReviewState {
  /** Null while loading, or when it could not be read (`error`). */
  request: ChangeRequest | null;
  error: string | null;
  /** What the host is doing with the request. */
  activity: EditActivity | null;
  /** Files the change writes that have unsaved changes in an editor (approving waits for them). */
  dirty: string[];
}

export type ReviewHostMessage = { type: "state"; state: ReviewState };

export type ReviewWebviewMessage =
  | { type: "ready" }
  /** Open a file's change in VS Code's diff editor. */
  | { type: "openDiff"; path: string }
  /** Open a unit ("file#Symbol"): its logic, or with `source` its code. */
  | { type: "openUnit"; ref: string; source: boolean }
  /** Run the configured checks (edit.checks) on a copy of the project with the change. */
  | { type: "runChecks" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "undo" }
  /** Back to the unit in its logic document, to change the draft. */
  | { type: "openLogic" };
