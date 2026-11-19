/**
 * The boundary between core and language support (design §3).
 * Everything crossing it is plain, serializable data, so adapters could later run out of process.
 */

export interface LanguageAdapter {
  /** e.g. "typescript" */
  id: string;
  /** e.g. [".ts", ".tsx", ".js"] */
  extensions: string[];
  /** Load the project (tsconfig/jsconfig or defaults). Called once per run. */
  openProject(root: string, files: string[], options?: AdapterOptions): Promise<AdapterProject>;
}

export interface AdapterOptions {
  /** Statement limit for the lite-unit heuristic (design §6.4). Default 3. */
  liteMaxStatements?: number;
}

export interface AdapterProject {
  /** Extract every unit in a file, with structure, types, calls, and normalized hashes. */
  extractFile(path: string): FileExtraction;
  /** All implementations of an interface or abstract member. */
  findImplementations(symbol: SymbolRef): SymbolRef[];
  dispose(): void;
}

export interface FileExtraction {
  path: string;
  language: string;
  fileHash: string;
  units: ExtractedUnit[];
}

export type UnitKind = "function" | "method" | "constructor" | "component" | "module";

export interface ExtractedUnit {
  /** Qualified name, e.g. "AccountService.transferFunds". */
  symbol: string;
  kind: UnitKind;
  /** Adapter's lite-unit heuristic (design §6.4). */
  isSmall: boolean;
  signature: string;
  inputs: { name: string; type: string; typeInferred: boolean }[];
  returns: { type: string; typeInferred: boolean } | null;
  bodyHash: string;
  range: SourceRange;
  body: StructureNode[];
  docComment: string | null;
  sourceText: string;
  /** Project types used in the signature or body. */
  typeRefs: SymbolRef[];
  /** Interface or abstract member this method implements. */
  implementsMember: SymbolRef | null;
}

export type StructureKind =
  | "statement"
  | "if"
  | "else"
  | "switch"
  | "case"
  | "loop"
  | "try"
  | "catch"
  | "finally"
  | "return"
  | "throw"
  | "callback";

export interface StructureNode {
  /** Structural path, e.g. "3", "3.then.0" (design §3.1). Only meaningful against one bodyHash. */
  key: string;
  kind: StructureKind;
  range: SourceRange;
  text: string;
  calls: CallSite[];
  children: StructureNode[];
}

export type EdgeConfidence = "resolved" | "language-server" | "rule" | "name-match" | "inferred";

export interface CallSite {
  expression: string;
  target: SymbolRef | null;
  confidence: Extract<EdgeConfidence, "resolved" | "language-server" | "name-match"> | null;
  /** When the target is an interface or abstract member. */
  implementations: SymbolRef[];
  /** Set when the call resolves into a library or platform API. */
  external: { module: string; name: string } | null;
  awaited: boolean;
  /** Simplified arguments, for edge rules (design §9.1). */
  args: CallArg[];
  range: SourceRange;
}

export type CallArg =
  | { kind: "string"; value: string }
  /** A reference to a named function or method in the project. */
  | { kind: "unit"; ref: SymbolRef }
  /** An inline function, identified by its `callback` structure node key in the same unit. */
  | { kind: "callback"; key: string }
  | { kind: "unknown" };

export interface SymbolRef {
  /** Project-relative path, forward slashes. */
  file: string;
  symbol: string;
}

export interface SourcePosition {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}
