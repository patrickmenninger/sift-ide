import { loadPrompt, SiftError, type Provider, type Route } from "@sift/core";
import type { JudgeUsage } from "./judge.js";

/** The edit judge's verdict on one change request (prompts/edit-judge.md). */
export interface EditVerdict {
  ideas: { idea: string; present: boolean; where: string }[];
  asks: { topic: string; asked: boolean; question: string }[];
  /** null when no code change was proposed. */
  intent: "correct" | "minor-issues" | "wrong" | null;
  issues: { severity: "minor" | "major"; text: string }[];
}

const ISSUES = {
  type: "array",
  items: {
    type: "object",
    properties: { severity: { enum: ["minor", "major"] }, text: { type: "string" } },
    required: ["severity", "text"],
    additionalProperties: false,
  },
} as const;

export const EDIT_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: { idea: { type: "string" }, present: { type: "boolean" }, where: { type: "string" } },
        required: ["idea", "present", "where"],
        additionalProperties: false,
      },
    },
    asks: {
      type: "array",
      items: {
        type: "object",
        properties: { topic: { type: "string" }, asked: { type: "boolean" }, question: { type: "string" } },
        required: ["topic", "asked", "question"],
        additionalProperties: false,
      },
    },
    intent: { enum: ["correct", "minor-issues", "wrong", null] },
    issues: ISSUES,
  },
  required: ["ideas", "asks", "intent", "issues"],
  additionalProperties: false,
} as const;

export interface EditJudgeInput {
  file: string;
  symbol: string;
  kind: string;
  /** The unit's code before the change. */
  code: string;
  /** What was asked, rendered as the edit prompts render it. */
  request: string[];
  /** Every question asked, in order, with the answer given (if any). */
  questions: { text: string; answer?: string }[];
  /** Unified diffs of the proposed change, one per file; empty when no code change was proposed. */
  diffs: string[];
  /** The unit's description re-derived from the new code, as a reader sees it. */
  description: string | null;
  ideas: string[];
  asks: string[];
}

export function renderEditJudgeInput(i: EditJudgeInput): string {
  const lang = i.file.endsWith(".tsx") ? "tsx" : i.file.endsWith(".ts") ? "ts" : "js";
  return [
    `File: ${i.file}`,
    `Unit: ${i.symbol} (${i.kind})`,
    "",
    "Code before the change:",
    "```" + lang,
    i.code,
    "```",
    "",
    "What the developer asked for:",
    ...i.request,
    "",
    "Questions Sift asked:",
    ...(i.questions.length === 0 ? ["(none)"] : i.questions.map((q) => `- ${q.text}${q.answer ? `\n  Answer: ${q.answer}` : ""}`)),
    "",
    ...(i.diffs.length === 0 ? ["Proposed change: (no code change was proposed)"] : ["Proposed change:", "```diff", ...i.diffs.map((d) => d.trimEnd()), "```"]),
    "",
    ...(i.description ? ["Description re-derived from the new code:", "```text", i.description, "```", ""] : []),
    `Expected ideas: ${JSON.stringify(i.ideas)}`,
    "",
    `Expected questions: ${JSON.stringify(i.asks)}`,
  ].join("\n");
}

export function validateEditVerdict(json: unknown, ideas: string[], asks: string[], hasDiff: boolean): { verdict: EditVerdict | null; problems: string[] } {
  const problems: string[] = [];
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!rec(json)) return { verdict: null, problems: ["The response must be a single JSON object."] };
  const entries = <T>(key: string, expected: string[], flag: string, text: string, make: (label: string, r: Record<string, unknown>) => T): T[] => {
    const list = Array.isArray(json[key]) ? (json[key] as unknown[]) : [];
    if (!Array.isArray(json[key]) || list.length !== expected.length) problems.push(`"${key}" must have exactly ${expected.length} entries, one per expected item, in order.`);
    return list.map((v, i) => {
      if (!rec(v) || typeof v[flag] !== "boolean") problems.push(`${key}[${i}] must have a boolean "${flag}".`);
      const r = rec(v) ? v : {};
      if (r[text] !== undefined && typeof r[text] !== "string") problems.push(`${key}[${i}].${text} must be a string.`);
      return make(expected[i] ?? "", r);
    });
  };
  const ideaList = entries("ideas", ideas, "present", "where", (idea, r) => ({ idea, present: r.present === true, where: typeof r.where === "string" ? r.where : "" }));
  const askList = entries("asks", asks, "asked", "question", (topic, r) => ({ topic, asked: r.asked === true, question: typeof r.question === "string" ? r.question : "" }));
  const intent = json.intent;
  if (hasDiff && !["correct", "minor-issues", "wrong"].includes(intent as string)) problems.push('"intent" must be "correct", "minor-issues", or "wrong" when a change is shown.');
  if (!hasDiff && intent !== null) problems.push('"intent" must be null when no code change is shown.');
  if (!Array.isArray(json.issues)) problems.push('"issues" must be a list.');
  const issues = (Array.isArray(json.issues) ? json.issues : []).flatMap((v: unknown, i: number) => {
    if (!rec(v) || (v.severity !== "minor" && v.severity !== "major") || typeof v.text !== "string") {
      problems.push(`issues[${i}] must have "severity" (minor or major) and "text".`);
      return [];
    }
    return [{ severity: v.severity as "minor" | "major", text: v.text }];
  });
  if (problems.length > 0) return { verdict: null, problems };
  return { verdict: { ideas: ideaList, asks: askList, intent: hasDiff ? (intent as EditVerdict["intent"]) : null, issues }, problems };
}

/** Ask the edit judge about one change request, with one retry on an invalid reply. */
export async function judgeEdit(provider: Provider, route: Route, input: EditJudgeInput, usage: JudgeUsage): Promise<{ verdict: EditVerdict } | { error: string }> {
  const template = await loadPrompt("edit-judge");
  const prompt = renderEditJudgeInput(input);
  const hasDiff = input.diffs.length > 0;
  const schemaNote = provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(EDIT_JUDGE_SCHEMA)}`;
  let request = `${prompt}${schemaNote}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await provider.complete({
        task: "edit-judge", model: route.choice, promptVersion: template.id, system: template.text, prompt: request, jsonSchema: EDIT_JUDGE_SCHEMA,
      });
      usage.calls++;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      usage.costUsd += result.usage.costUsd ?? 0;
      const { verdict, problems } = result.json === undefined ? { verdict: null, problems: ["The response was not valid JSON."] } : validateEditVerdict(result.json, input.ideas, input.asks, hasDiff);
      if (verdict) return { verdict };
      if (attempt === 2) return { error: `invalid judge reply: ${problems.join(" ")}` };
      request = `${prompt}${schemaNote}\n\nYour previous response had these problems. Return a corrected JSON object.\n${problems.map((p) => `- ${p}`).join("\n")}`;
    } catch (err) {
      if (err instanceof SiftError && err.code === "PROVIDER_AUTH") throw err;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { error: "unreachable" };
}
