import type { LogicFile, NavTarget } from "@sift/core";

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
}

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
  | { type: "targets"; at: StepRef; targets: NavTarget[]; pinned: boolean };

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
  | { type: "describe" };
