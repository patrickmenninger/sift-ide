import { cp, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionRequest, FakeProvider } from "@sift/core";
import { run } from "./program.js";

/** Shared by the CLI's fixture tests: a copy of bank-app, a CLI runner, and a stand-in model. Not shipped. */
export const FIXTURE = fileURLToPath(new URL("../../../eval/fixtures/bank-app", import.meta.url));
export const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));

export async function fixtureCopy(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "sift-gen-")), "bank-app");
  await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(".cache") });
  await symlink(NODE_MODULES, join(dir, "node_modules"), "junction");
  return dir;
}

export async function sift(provider: FakeProvider, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, { provider });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export const unitOf = (req: { prompt: string }) => /^Unit: (.+) \(/m.exec(req.prompt)![1]!;
/** The units a request describes: one, or several for a batch. */
export const unitsOf = (req: CompletionRequest) => (req.parts ? req.parts.map(unitOf) : [unitOf(req)]);
/** The prompt for one unit, whether it was sent alone or in a batch. */
export const promptFor = (requests: CompletionRequest[], unit: string) =>
  requests.flatMap((q): { prompt: string }[] => q.parts ?? [q]).find((q) => unitOf(q) === unit)!.prompt;

/** The previous description shown in an update prompt, if any. */
export function previousOf(req: CompletionRequest): { steps?: { id: string; covers: string[] }[] } | null {
  const m = /Previous description[^\n]*\n```json\n([\s\S]*?)\n```/.exec(req.prompt);
  return m ? (JSON.parse(m[1]!) as { steps?: { id: string; covers: string[] }[] }) : null;
}

/**
 * A stand-in model that reads the prompt like a model would: it answers with the parameter names it
 * was given and one step per top-level structure key, so every response is valid.
 */
export function answer(req: CompletionRequest, tweak: { dropKey?: string; summary?: string } = {}): Record<string, unknown> {
  const p = req.prompt;
  const unit = unitOf(req);
  if (req.task === "context-check") return { summary: null, steps: [] };
  const names = [...(/\nInputs[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]!);
  const returnsType = /\nReturns: (.+)/.exec(p)![1]!;
  const returns = /^(nothing|void|Promise<void>)/.test(returnsType) ? null : { meaning: `What ${unit} returns.` };
  const base = { summary: tweak.summary ?? `Does what ${unit} does.`, inputs: names.map((n) => ({ name: n, meaning: `The ${n}.` })), returns };
  if (req.task === "describe-lite") return { ...base, warnings: [] };

  const keys = [...(/Structure keys[^\n]*\n([\s\S]*?)\n\n/.exec(p)?.[1] ?? "").matchAll(/^- ([^:]+): (\w+)/gm)].map((m) => ({ key: m[1]!, kind: m[2]! }));
  const steps = keys
    .filter((k) => !k.key.includes(".") && k.key !== tweak.dropKey)
    .map((k) => ({ kind: ["if", "loop", "switch", "try"].includes(k.kind) ? k.kind : null, text: `Handle part ${k.key}.`, covers: [k.key], steps: [] as unknown[], id: null as string | null }));
  // An update keeps the ID of the previous step that covered the same key.
  const previous = previousOf(req);
  for (const s of steps) s.id = previous?.steps?.find((q) => q.covers[0] === s.covers[0])?.id ?? null;
  if (req.task !== "update") for (const s of steps) delete (s as { id?: unknown }).id;
  const warnings = unit === "AccountService.transferFunds" ? [{ kind: "missing-transaction", text: "The two saves are not in a transaction.", covers: ["5", "6"] }] : [];
  return { ...base, steps, warnings };
}
