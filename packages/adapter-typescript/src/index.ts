import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { SiftError, type AdapterOptions, type AdapterProject, type LanguageAdapter } from "@sift/core";
import { hashFileText } from "./hash-file.js";
import { TsProject } from "./project.js";

export { TsProject } from "./project.js";

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  skipLibCheck: true,
};

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],

  hashFile: hashFileText,

  async openProject(root: string, files: string[], options?: AdapterOptions): Promise<AdapterProject> {
    const absRoot = resolve(root);
    const config = loadCompilerConfig(absRoot);
    const rootNames = [...new Set([...config.fileNames, ...files.map((f) => resolve(absRoot, f))])];
    const program = ts.createProgram({
      rootNames,
      // Sift only reads the project: never emit, and always accept JavaScript files it is asked about.
      options: { ...config.options, noEmit: true, allowJs: true },
    });
    return new TsProject(absRoot, program, options);
  },
};

/**
 * Read tsconfig.json or jsconfig.json from the project root only. ts.findConfigFile is not used
 * because it searches parent directories and could pick up an unrelated config.
 */
function loadCompilerConfig(root: string): { options: ts.CompilerOptions; fileNames: string[] } {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error) {
      throw new SiftError("CONFIG_INVALID", `${name} could not be read.`, [
        ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
      ]);
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, path);
    return { options: parsed.options, fileNames: parsed.fileNames };
  }
  return { options: DEFAULT_OPTIONS, fileNames: [] };
}
