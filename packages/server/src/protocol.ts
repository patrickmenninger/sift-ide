import type {
  ChangeRequest,
  DescriptionEdit,
  EditEvent,
  EditState,
  Effect,
  FileExtraction,
  FlowResult,
  GapNote,
  GenerateEvent,
  GenerateReport,
  ImpactResult,
  LogicFile,
  NavTarget,
  QueryHit,
  SiftUnit,
  SourcePosition,
  SourceRanges,
  StatusReport,
  StepLocation,
  VerifyResult,
  WorkspaceChange,
} from "@sift/core";

/**
 * The `sift serve` protocol (phase-2-design §4.1): JSON-RPC 2.0 over stdio, one method per
 * Workspace operation. The extension imports these types, so client and server cannot drift.
 *
 * Bump PROTOCOL_VERSION on any incompatible change; `sift/initialize` refuses a mismatch.
 */
export const PROTOCOL_VERSION = 1;

/** Method name → params and result. */
export interface Requests {
  /** `provider` is the project's AI provider (null when the server runs without one). */
  "sift/initialize": {
    params: { protocolVersion: number };
    result: { protocolVersion: number; root: string; serverVersion: string; provider: { id: string; local: boolean } | null };
  };
  "sift/refresh": { params: { fullHash?: boolean }; result: { rebuilt: string[]; removed: string[] } };
  "sift/logicFile": { params: { source: string }; result: LogicFile };
  "sift/unit": { params: { query: string }; result: { source: string; unit: SiftUnit } };
  "sift/extraction": { params: { source: string }; result: FileExtraction };
  "sift/status": { params: { paths?: string[]; fullHash?: boolean }; result: StatusReport & { inSync: boolean } };
  "sift/callers": { params: { query: string; depth?: number }; result: { subject: string; callers: QueryHit[]; possibleCallers: GapNote[] } };
  "sift/callees": { params: { query: string; depth?: number }; result: { subject: string; effects: Effect[]; callees: QueryHit[]; unresolved: GapNote[] } };
  "sift/impact": { params: { queries: string[]; diff?: string }; result: ImpactResult & { subjects: string[]; notes: string[] } };
  "sift/routes": { params: Record<string, never>; result: string[] };
  "sift/flow": { params: { route: string; depth?: number }; result: FlowResult[] };
  "sift/sourceRanges": { params: { unit: string; step?: string }; result: SourceRanges };
  "sift/stepAt": { params: { source: string; position: SourcePosition }; result: StepLocation | null };
  "sift/stepTargets": { params: { unit: string; step: string }; result: NavTarget[] };
  /** Progress arrives as `sift/generateProgress` notifications carrying the request's `token`. */
  "sift/generate": { params: { paths?: string[]; force?: boolean; dryRun?: boolean; token?: string }; result: GenerateReport };
  "sift/verify": { params: { targets: string[] }; result: VerifyResult };
  // Editing (phase-2-design §8). Progress of a propose arrives as `sift/editProgress` with its `token`;
  // cancelling a propose or runChecks request stops it.
  "sift/edit/create": { params: { unit: string; edits?: DescriptionEdit[]; request?: string }; result: ChangeRequest };
  "sift/edit/update": { params: { id: string; edits?: DescriptionEdit[]; request?: string | null }; result: ChangeRequest };
  "sift/edit/get": { params: { id: string }; result: ChangeRequest };
  "sift/edit/list": { params: { states?: EditState[] }; result: ChangeRequest[] };
  "sift/edit/propose": { params: { id: string; token?: string }; result: ChangeRequest };
  "sift/edit/answer": { params: { id: string; answers: { questionId: string; answer: string }[] }; result: ChangeRequest };
  "sift/edit/runChecks": { params: { id: string }; result: ChangeRequest };
  /** With `sourceWritten`, the client already wrote the source (through its own undo stack); only descriptions are written. */
  "sift/edit/apply": { params: { id: string; confirmBroader?: boolean; sourceWritten?: boolean }; result: { request: ChangeRequest; written: string[] } };
  "sift/edit/reject": { params: { id: string }; result: ChangeRequest };
  "sift/edit/rebase": { params: { id: string }; result: ChangeRequest };
  "sift/edit/undo": { params: { id: string }; result: { request: ChangeRequest; restored: string[] } };
}

export type RequestMethod = keyof Requests;

/** Server → client notifications. */
export interface Notifications {
  "sift/didChange": WorkspaceChange;
  "sift/generateProgress": { token: string; event: GenerateEvent };
  "sift/editProgress": { token: string; event: EditEvent };
}

/** JSON-RPC error code for Sift's own errors; `data` carries the SiftError code and details. */
export const SIFT_ERROR = -32001;

export interface SiftErrorData {
  code: string;
  details: string[];
}
