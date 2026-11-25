import type { ChangeRequest, DescriptionEdit, LogicFile, NavTarget } from "@sift/core";

/**
 * Messages between the extension host and the logic document webview (phase-2-design §6.1).
 * The webview never reads files: it gets a `LogicFile` and sends back intents. Shared by both
 * sides, so it holds types only (no `vscode`, no DOM).
 */

/** A call target inside the project. */
export type UnitTarget = Extract<NavTarget, { kind: "unit" }>;

/** What the document shows. */
export interface LogicDocumentState {
  /** Project-relative source path. */
  source: string;
  /** Null while loading, or when it could not be read (`error`). */
  file: LogicFile | null;
  error: string | null;
  /** The source file has unsaved changes in an editor; the document describes the saved file. */
  dirty: boolean;
  /** Open change requests for this file's units (phase-2-design §8), newest first. */
  edits: UnitEdit[];
  /** Where proposing sends code (null: the project has no AI provider). */
  provider: { id: string; local: boolean } | null;
}

/** A change request and what the host is doing with it right now. */
export interface UnitEdit {
  request: ChangeRequest;
  /** A stage of proposing (`planning`, `coding`, …), `checks`, or `applying`; null when idle. */
  activity: EditActivity | null;
}

export type EditActivity = "starting" | "planning" | "coding" | "fixing" | "validating" | "describing" | "verifying" | "checks" | "applying" | "undoing";

/** A step (or, without `stepId`, a whole unit). */
export interface StepRef {
  unitId: string;
  stepId?: string;
}

export type HostMessage =
  | { type: "state"; state: LogicDocumentState }
  /** The step that owns the cursor in the source editor (null: none). The document scrolls it into view. */
  | { type: "current"; at: StepRef | null }
  /** Scroll to a unit and expand it (after navigating to it). */
  | { type: "reveal"; unitId: string }
  /** Where a step's calls lead, for the hover card (asked with `targets`). `pinned`: shown after Ctrl+click found nothing to open. */
  | { type: "targets"; at: StepRef; targets: NavTarget[]; pinned: boolean }
  /** A `draft` was handled (saved, or refused); the state sent before this one shows the outcome. */
  | { type: "draftSaved"; unitId: string; seq: number }
  /** Open a unit for editing and scroll to it. */
  | { type: "edit"; unitId: string };

export type WebviewMessage =
  | { type: "ready" }
  /** Highlight the step's (or unit's) code in the source editor; null clears it. */
  | { type: "hover"; at: StepRef | null }
  /** Plain click: show the step's (or unit's) code in the source editor. */
  | { type: "showSource"; at: StepRef }
  /** Ctrl+click or F12: follow the step's calls. `source`: Alt+click, open the callee's code instead of its logic. */
  | { type: "navigate"; at: StepRef; source: boolean }
  /** The hover card needs the step's targets. */
  | { type: "targets"; at: StepRef }
  /** A unit picked in the hover card. `source`: Alt+click, open its code instead of its logic. */
  | { type: "openTarget"; target: UnitTarget; source: boolean }
  | { type: "verify"; unitId: string }
  /** Describe or update this file's units (asks with an estimate first). */
  | { type: "describe" }
  // Editing (phase-2-design §8.1). The host finds the unit's open change request itself.
  /** Save the unit's draft: create its change request, or change it. Nothing asked for discards it. */
  | { type: "draft"; unitId: string; edits: DescriptionEdit[]; request: string; seq: number }
  /** Save the draft, then plan and write the change. */
  | { type: "propose"; unitId: string; edits: DescriptionEdit[]; request: string; seq: number }
  /** Stop a running proposal. */
  | { type: "cancel"; id: string }
  /** Answer the open questions, then propose again. */
  | { type: "answer"; id: string; answers: { questionId: string; answer: string }[] }
  /** Open the review panel of a ready change. */
  | { type: "review"; id: string }
  /** Reject the change request. */
  | { type: "discard"; id: string }
  /** Start a request whose code changed over from the current code, and propose it again. */
  | { type: "replan"; id: string };
