import type { CompletionRequest, CompletionResult, Provider, ProviderCapabilities } from "./provider.js";

export type FakeResponder = (req: CompletionRequest, attempt: number) => unknown | Promise<unknown>;

/**
 * A provider that answers from a function instead of a model (design §4.1), for engine tests and
 * dry runs. `requests` records every call so tests can check prompts and routing.
 */
export class FakeProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    nativeJsonSchema: false,
    contextTokens: () => 200_000,
    effortLevels: true,
    local: true,
  };
  readonly requests: CompletionRequest[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly respond: FakeResponder,
    id = "claude-code",
  ) {
    this.id = id;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    // A batch is answered unit by unit, so responders written for single units work unchanged.
    const json = req.parts
      ? { units: await Promise.all(req.parts.map(async (p) => ({ symbol: p.symbol, ...(await this.answer({ ...req, prompt: p.prompt, jsonSchema: p.jsonSchema })) as object }))) }
      : await this.answer(req);
    return { json, text: JSON.stringify(json), usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 100 }, model: req.model.model, durationMs: 1 };
  }

  private async answer(req: CompletionRequest): Promise<unknown> {
    const key = `${req.task}\n${req.prompt.split("\nCode:")[0]}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    return this.respond(req, attempt);
  }
}
