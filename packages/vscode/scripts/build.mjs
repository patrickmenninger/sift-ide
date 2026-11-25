// Bundles the extension and the Sift server for the .vsix (phase-2-design §3.1):
//
//   dist/extension.cjs   the extension host side (CommonJS; `vscode` is provided by the editor)
//   dist/server.mjs      `sift serve` with the engine, the TypeScript adapter, and the pinned
//                        `typescript`, run as a child process with VS Code's own Node
//   dist/webview.js/css  the logic document (Preact), loaded by the extension's webviews
//   dist/graph.js/css    the graph views (Preact, elkjs layout)
//   dist/review.js/css   the review panel for a proposed edit (Preact)
//   dist/lib.*.d.ts      TypeScript's default libraries, found next to the bundle
//   prompts/ models/     read by the engine next to the bundle (`../prompts`, `../models`)
//   rules/               the built-in rule packs
//
// Packages are bundled from source, so this does not need `tsc -b` first.
//
//   node scripts/build.mjs [--watch] [--minify]
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const packages = join(pkg, "..");
const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

const source = (name) => join(packages, name, "src", "index.ts");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: "linked",
  minify,
  logLevel: "info",
  legalComments: "none",
};

const extension = {
  ...common,
  entryPoints: [join(pkg, "src", "extension.ts")],
  outfile: join(pkg, "dist", "extension.cjs"),
  format: "cjs",
  external: ["vscode"],
  alias: {
    // The extension host takes only the error type from core at runtime (see core-runtime.ts).
    "@sift/core": join(pkg, "src", "core-runtime.ts"),
    "@sift/server": source("server"),
  },
};

const server = {
  ...common,
  entryPoints: [join(pkg, "src", "server-main.ts")],
  outfile: join(pkg, "dist", "server.mjs"),
  format: "esm",
  // `typescript` and other CommonJS dependencies call require() for Node built-ins, and
  // `typescript` finds its lib.*.d.ts files next to __filename (copied into dist/ below).
  banner: {
    js: [
      'import { createRequire as __siftCreateRequire } from "node:module";',
      'import { fileURLToPath as __siftFileURLToPath } from "node:url";',
      'import { dirname as __siftDirname } from "node:path";',
      "const require = __siftCreateRequire(import.meta.url);",
      "const __filename = __siftFileURLToPath(import.meta.url);",
      "const __dirname = __siftDirname(__filename);",
    ].join(" "),
  },
  alias: {
    "@sift/core": source("core"),
    "@sift/adapter-typescript": source("adapter-typescript"),
    "@sift/provider-claude-code": source("provider-claude-code"),
    "@sift/server": source("server"),
  },
};

const webview = {
  ...common,
  entryPoints: { webview: join(pkg, "src", "webview", "main.tsx"), graph: join(pkg, "src", "webview", "graph-main.tsx"), review: join(pkg, "src", "webview", "review-main.tsx") },
  outdir: join(pkg, "dist"),
  platform: "browser",
  target: "es2022",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  // Types only: the webview takes no runtime code from the engine.
  alias: { "@sift/core": join(pkg, "src", "core-runtime.ts") },
};

/** TypeScript's default library files: the adapter's program needs them to type the code. */
async function copyTypeScriptLibs() {
  const lib = dirname(createRequire(join(packages, "adapter-typescript", "package.json")).resolve("typescript"));
  await mkdir(join(pkg, "dist"), { recursive: true });
  for (const name of await readdir(lib)) {
    if (/^lib\..*\.d\.ts$/.test(name)) await copyFile(join(lib, name), join(pkg, "dist", name));
  }
}

async function copyAssets() {
  for (const [from, to] of [
    [join(packages, "core", "prompts"), join(pkg, "prompts")],
    [join(packages, "core", "models"), join(pkg, "models")],
    [join(packages, "rules", "packs"), join(pkg, "rules")],
  ]) {
    await rm(to, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
}

await rm(join(pkg, "dist"), { recursive: true, force: true });
await copyAssets();
await copyTypeScriptLibs();
if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(server), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(server), esbuild.build(webview)]);
}
