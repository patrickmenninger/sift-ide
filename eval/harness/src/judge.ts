import { loadPrompt, SiftError, unitText, type ExtractedUnit, type Provider, type Route, type SiftStep, type SiftUnit } from "@sift/core";

/** The judge's verdict on one description (prompts/judge.md). */
export interface Verdict {
  ideas: { idea: string; present: boolean; where: string }[];
  accuracy: "correct" | "minor-issues" | "wrong";
  issues: { severity: "minor" | "major"; text: string }[];
}

export const JUDGE_SCHEMA = {
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
    accuracy: { enum: ["correct", "minor-issues", "wrong"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: { severity: { enum: ["minor", "major"] }, text: { type: "string" } },
        required: ["severity", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas", "accuracy", "issues"],
  additionalProperties: false,
} as const;

/** The description as a reader sees it, without IDs, keys, or derived facts. */
export function renderDescription(u: SiftUnit): string {
  const lines = [`Summary: ${u.summary}`];
  if (u.inputs.length > 0) lines.push("Inputs:", ...u.inputs.map((i) => `- ${i.name}: ${i.meaning}`));
  lines.push(`Returns: ${u.returns ? u.returns.meaning : "(nothing)"}`);
  const steps = (list: SiftStep[], depth: number): string[] => list.flatMap((s) => [`${"  ".repeat(depth)}- ${s.kind ? `[${s.kind}] ` : ""}${s.text}`, ...steps(s.steps, depth + 1)]);
  if (u.steps.length > 0) lines.push("Steps:", ...steps(u.steps, 0));
  if (u.warnings.length > 0) lines.push("Warnings:", ...u.warnings.map((w) => `- ${w.kind}: ${w.text}`));
  return lines.join("\n");
}

/** A call the unit makes, with what the description writer was told about it. */
export interface JudgeCallee {
  expression: string;
  /** "library <module>: <name>", or the callee's name. */
  target: string;
  signature?: string;
  summary?: string;
}

/**
 * The judge sees what the description writer saw (design §7.4): the code with its doc comment, and
 * each call with its signature and summary. Without them it marks correct statements about
 * comments and callees as unsupported.
 */
export function renderJudgeInput(file: string, code: ExtractedUnit, fileText: string, described: SiftUnit, ideas: string[], callees: JudgeCallee[] = []): string {
  const calls = callees.length === 0 ? ["- (none)"] : callees.flatMap((c) => [
    `- \`${c.expression.replace(/\s+/g, " ").slice(0, 160)}\` → ${c.target}`,
    ...(c.signature ? [`  signature: ${c.signature.replace(/\s+/g, " ")}`] : []),
    ...(c.summary ? [`  summary: ${c.summary}`] : []),
  ]);
  return [
    `File: ${file}`,
    `Unit: ${code.symbol} (${code.kind})`,
    "",
    ...(code.docComment ? ["Comment directly above the unit:", code.docComment, ""] : []),
    "Code:",
    "```" + (file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : "js"),
    unitText(fileText, code),
    "```",
    "",
    "Calls (as described elsewhere in the project):",
    ...calls,
    "",
    "Description:",
    "```text",
    renderDescription(described),
    "```",
    "",
    `Expected ideas: ${JSON.stringify(ideas)}`,
  ].join("\n");
}

export function validateVerdict(json: unknown, ideas: string[]): { verdict: Verdict | null; problems: string[] } {
  const problems: string[] = [];
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!rec(json)) return { verdict: null, problems: ["The response must be a single JSON object."] };
  const list = Array.isArray(json.ideas) ? json.ideas : [];
  if (!Array.isArray(json.ideas) || list.length !== ideas.length) problems.push(`"ideas" must have exactly ${ideas.length} entries, one per expected idea, in order.`);
  const parsed = list.map((v: unknown, i: number) => {
    if (!rec(v) || typeof v.present !== "boolean") problems.push(`ideas[${i}] must have a boolean "present".`);
    const r = rec(v) ? v : {};
    return { idea: ideas[i] ?? "", present: r.present === true, where: typeof r.where === "string" ? r.where : "" };
  });
  if (!["correct", "minor-issues", "wrong"].includes(json.accuracy as string)) problems.push('"accuracy" must be "correct", "minor-issues", or "wrong".');
  const issues = (Array.isArray(json.issues) ? json.issues : []).flatMap((v: unknown, i: number) => {
    if (!rec(v) || (v.severity !== "minor" && v.severity !== "major") || typeof v.text !== "string") {
      problems.push(`issues[${i}] must have "severity" (minor or major) and "text".`);
      return [];
    }
    return [{ severity: v.severity as "minor" | "major", text: v.text }];
  });
  if (!Array.isArray(json.issues)) problems.push('"issues" must be a list.');
  return problems.length > 0 ? { verdict: null, problems } : { verdict: { ideas: parsed, accuracy: json.accuracy as Verdict["accuracy"], issues }, problems };
}

export interface JudgeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Ask the judge about one description, with one retry on an invalid reply (as for describe, design §8). */
export async function judgeUnit(
  provider: Provider,
  route: Route,
  prompt: string,
  ideas: string[],
  usage: JudgeUsage,
): Promise<{ verdict: Verdict } | { error: string }> {
  const template = await loadPrompt("judge");
  const schemaNote = provider.capabilities.nativeJsonSchema ? "" : `\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(JUDGE_SCHEMA)}`;
  let request = `${prompt}${schemaNote}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await provider.complete({
        task: "judge", model: route.choice, promptVersion: template.id, system: template.text, prompt: request, jsonSchema: JUDGE_SCHEMA,
      });
      usage.calls++;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      usage.costUsd += result.usage.costUsd ?? 0;
      const { verdict, problems } = result.json === undefined ? { verdict: null, problems: ["The response was not valid JSON."] } : validateVerdict(result.json, ideas);
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
