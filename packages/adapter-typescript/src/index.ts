import { SiftError, type AdapterProject, type LanguageAdapter } from "@sift/core";

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  async openProject(): Promise<AdapterProject> {
    throw new SiftError("NOT_IMPLEMENTED", "TypeScript extraction is not implemented yet (milestone 2).");
  },
};
