/**
 * The boundary between core and AI providers (design §4).
 * Prompt content is provider-neutral; providers handle only transport and formatting.
 */

export const TASKS = ["describe", "describe-lite", "update", "context-check", "judge"] as const;
export type Task = (typeof TASKS)[number];

export const TIERS = ["frontier", "mid", "small"] as const;
export type Tier = (typeof TIERS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ProviderCapabilities {
  /** Can the provider enforce the output JSON schema itself? */
  nativeJsonSchema: boolean;
  /** Prompt budget for this model, in tokens. */
  contextTokens(model: string): number;
  /** Does the provider accept an effort / reasoning setting? */
  effortLevels: boolean;
  /** Does code stay on the user's machine? */
  local: boolean;
}

export interface Provider {
  /** e.g. "claude-code", later "anthropic", "openai", "google", "openai-compatible". */
  id: string;
  capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ModelChoice {
  provider: string;
  model: string;
  tier: Tier | "unqualified";
  /** Ignored by providers without effort levels. */
  effort?: Effort;
}

export interface CompletionRequest {
  /** Lets a caller cancel the request (for example on Ctrl+C). */
  signal?: AbortSignal;
  task: Task;
  model: ModelChoice;
  /** e.g. "describe@3"; recorded with every result. */
  promptVersion: string;
  system: string;
  prompt: string;
  /** Expected output shape. */
  jsonSchema: object;
  maxOutputTokens?: number;
}

export interface CompletionResult {
  /** Parsed JSON, or undefined if the response was not JSON; core validates it against the schema. */
  json: unknown;
  /** The raw response text, for error messages when it could not be parsed. */
  text?: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  model: string;
  durationMs: number;
}
