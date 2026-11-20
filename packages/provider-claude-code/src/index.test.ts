import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompletionRequest } from "@sift/core";
import { createClaudeCodeProvider, parseEnvelope, parseJsonText } from "./index.js";

/** Stands in for `claude`: echoes what it received inside a Claude Code style JSON envelope. */
const FAKE_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o));
  const mode = process.env.FAKE_CLAUDE_MODE;
  if (mode === "auth") return out({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" });
  if (mode === "model") return out({ type: "result", is_error: true, result: "There's an issue with the selected model (nope). It may not exist or you may not have access to it." });
  if (mode === "crash") { process.stderr.write("boom"); process.exit(3); }
  const system = fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
  const answer = { args, input, system, cwd: process.cwd() };
  out({ type: "result", is_error: false, result: "Here it is:\\n\`\`\`json\\n" + JSON.stringify(answer) + "\\n\`\`\`", total_cost_usd: 0.25,
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, modelUsage: { "claude-haiku-5-5": {} }, duration_ms: 42 });
});
`;

let script: string;
beforeAll(async () => {
  script = join(await mkdtemp(join(tmpdir(), "sift-fake-claude-")), "claude.cjs");
  await writeFile(script, FAKE_CLAUDE);
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
});

const request: CompletionRequest = {
  task: "describe-lite",
  model: { provider: "claude-code", model: "claude-haiku-5-5", tier: "small", effort: "low" },
  promptVersion: "describe-lite@1",
  system: "You describe code.\nSecond line.",
  prompt: "Unit: formatCents",
  jsonSchema: { type: "object" },
};

const provider = () => createClaudeCodeProvider({ command: process.execPath, prefixArgs: [script] });

describe("claude-code provider", () => {
  it("runs claude -p without tools, settings, or MCP servers, in an empty folder", async () => {
    const result = await provider().complete(request);
    const echo = result.json as { args: string[]; input: string; system: string; cwd: string };
    expect(echo.input).toBe("Unit: formatCents");
    expect(echo.system).toBe("You describe code.\nSecond line.");
    expect(echo.cwd).toContain("sift-claude-");
    const args = echo.args;
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--json-schema");
    expect(result).toMatchObject({ usage: { inputTokens: 15, outputTokens: 3, costUsd: 0.25 }, model: "claude-haiku-5-5", durationMs: 42 });
  });

  it("turns login and model errors into errors Sift can act on", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    await expect(provider().complete(request)).rejects.toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("not logged in") });
    process.env.FAKE_CLAUDE_MODE = "model";
    await expect(provider().complete(request)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    process.env.FAKE_CLAUDE_MODE = "crash";
    await expect(provider().complete(request)).rejects.toMatchObject({ code: "PROVIDER_FAILED", details: ["boom"] });
  });

  it("explains a missing claude command", async () => {
    const missing = createClaudeCodeProvider({ command: "sift-no-such-claude-command" });
    await expect(missing.complete(request)).rejects.toMatchObject({ code: "PROVIDER_FAILED", message: expect.stringContaining("Could not run Claude Code") });
  });

  it("passes the schema to Claude Code only when native schemas are switched on", async () => {
    const native = createClaudeCodeProvider({ command: process.execPath, prefixArgs: [script], nativeJsonSchema: true });
    expect(native.capabilities.nativeJsonSchema).toBe(true);
    const args = ((await native.complete(request)).json as { args: string[] }).args;
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });
});

describe("parseEnvelope and parseJsonText", () => {
  it("prefers structured output and otherwise finds the JSON in the text", () => {
    expect(parseEnvelope(JSON.stringify({ result: "ignored", structured_output: { a: 1 } }), "", 0, "m", 1).json).toEqual({ a: 1 });
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('Sure.\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonText('Result: {"a":3} done')).toEqual({ a: 3 });
    expect(parseJsonText("no json here")).toBeUndefined();
  });
});
