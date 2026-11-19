import { SiftError, type CompletionResult, type Provider } from "@sift/core";

export const claudeCodeProvider: Provider = {
  id: "claude-code",
  capabilities: {
    // Output is validated by core; native schema enforcement is checked against the installed CLI in milestone 6.
    nativeJsonSchema: false,
    contextTokens: () => 200_000,
    effortLevels: true,
    local: false,
  },
  async complete(): Promise<CompletionResult> {
    throw new SiftError("NOT_IMPLEMENTED", "The Claude Code provider is not implemented yet (milestone 6).");
  },
};
