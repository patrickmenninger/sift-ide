import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources, so they don't need a build first.
    alias: {
      "@sift/core": pkg("core"),
      "@sift/adapter-typescript": pkg("adapter-typescript"),
      "@sift/provider-claude-code": pkg("provider-claude-code"),
      "@sift/server": pkg("server"),
      "@sift/mcp": pkg("mcp-server"),
      "@sift/eval": fileURLToPath(new URL("./eval/harness/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "eval/harness/src/**/*.test.ts"],
    // Fixture tests build a TypeScript program each; run side by side they can take well over the 5s default.
    testTimeout: 30_000,
  },
});
