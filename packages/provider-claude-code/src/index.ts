import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiftError, type CompletionRequest, type CompletionResult, type Provider } from "@sift/core";

/**
 * Runs Claude Code headless (`claude -p`) on the user's own login or subscription (design §4.1).
 *
 * - No tools: the model only reads the prompt and never acts on the repository.
 * - Runs in an empty temporary folder with no setting sources and no MCP servers, so nothing from
 *   the project or the user's configuration is picked up.
 * - The prompt goes in on stdin; the system prompt through a file (it is too long for some shells).
 */

export interface ClaudeCodeOptions {
  /** Executable to run. Default "claude", or the SIFT_CLAUDE_COMMAND environment variable. */
  command?: string;
  /** Arguments placed before Sift's own (used by tests to run a stand-in script with node). */
  prefixArgs?: string[];
  /** Per-call timeout. Default 10 minutes. */
  timeoutMs?: number;
  /** Ask Claude Code to enforce the JSON schema itself (--json-schema). Off until verified per version. */
  nativeJsonSchema?: boolean;
}

/** The fields of Claude Code's `--output-format json` result that Sift reads. */
interface Envelope {
  type?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export function createClaudeCodeProvider(options: ClaudeCodeOptions = {}): Provider {
  const command = options.command ?? process.env.SIFT_CLAUDE_COMMAND ?? "claude";
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const nativeJsonSchema = options.nativeJsonSchema ?? false;

  return {
    id: "claude-code",
    capabilities: {
      nativeJsonSchema,
      contextTokens: () => 200_000,
      effortLevels: true,
      local: false,
    },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const dir = await mkdtemp(join(tmpdir(), "sift-claude-"));
      try {
        const systemFile = join(dir, "system.md");
        await writeFile(systemFile, req.system);
        const args = [
          ...(options.prefixArgs ?? []),
          "-p",
          "--output-format", "json",
          "--model", req.model.model,
          ...(req.model.effort ? ["--effort", req.model.effort] : []),
          "--system-prompt-file", systemFile,
          "--tools", "",
          "--setting-sources", "",
          "--strict-mcp-config",
          "--no-session-persistence",
          ...(nativeJsonSchema ? ["--json-schema", JSON.stringify(req.jsonSchema)] : []),
        ];
        const started = Date.now();
        const { stdout, stderr, code } = await run(command, args, req.prompt, dir, timeoutMs, req.signal);
        return parseEnvelope(stdout, stderr, code, req.model.model, Date.now() - started);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const claudeCodeProvider: Provider = createClaudeCodeProvider();

export function parseEnvelope(stdout: string, stderr: string, code: number | null, model: string, durationMs: number): CompletionResult {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout) as Envelope;
  } catch {
    const detail = (stderr.trim() || stdout.trim() || `exit code ${code}`).slice(0, 2000);
    if (/not found|ENOENT|is not recognized/i.test(detail)) {
      throw new SiftError("PROVIDER_FAILED", "Could not run Claude Code. Install it and make sure `claude` is on your PATH (or set SIFT_CLAUDE_COMMAND).", [detail]);
    }
    throw new SiftError("PROVIDER_FAILED", "Claude Code did not return a result.", [detail]);
  }

  const text = typeof envelope.result === "string" ? envelope.result : "";
  if (envelope.is_error) {
    if (/authenticat|log ?in|oauth|credential|api key/i.test(text)) {
      throw new SiftError("PROVIDER_AUTH", "Claude Code is not logged in. Run `claude` in a terminal, log in, then run this again.", [text]);
    }
    if (/model/i.test(text) && /not (?:found|available|supported|exist|allowed)|not have access|no access|invalid/i.test(text)) {
      throw new SiftError("MODEL_UNAVAILABLE", `The model ${model} is not available: ${text}`, [text]);
    }
    throw new SiftError("PROVIDER_FAILED", `Claude Code reported an error: ${text || "no details"}`, [text]);
  }

  const usage = envelope.usage ?? {};
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const result: CompletionResult = {
    json: envelope.structured_output !== undefined ? envelope.structured_output : parseJsonText(text),
    text,
    usage: { inputTokens, outputTokens: usage.output_tokens ?? 0, ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}) },
    model: Object.keys(envelope.modelUsage ?? {})[0] ?? model,
    durationMs: envelope.duration_ms ?? durationMs,
  };
  return result;
}

/** The JSON object in a response: the whole text, a fenced block, or the outermost braces. Undefined if none parses. */
export function parseJsonText(text: string): unknown {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  if (fenced) candidates.push(fenced[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new SiftError("PROVIDER_FAILED", `Claude Code did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(() => reject(new SiftError("PROVIDER_FAILED", "Cancelled.")));
    };
    signal?.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => finish(() => resolve({ stdout: "", stderr: err.message, code: null })));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.on("error", () => {}); // the process may exit before reading everything; the result says why
    child.stdin.end(input);
  });
}
