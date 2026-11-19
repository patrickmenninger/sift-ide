import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractedUnit, StructureNode } from "@sift/core";
import { typescriptAdapter } from "./index.js";

/** Write files to a fresh temp project (no tsconfig unless given) and extract one of them. */
async function extract(files: Record<string, string>, target: string, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "sift-ts-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const project = await typescriptAdapter.openProject(root, Object.keys(files), options);
  try {
    return project.extractFile(target);
  } finally {
    project.dispose();
  }
}

async function single(source: string, path = "a.ts"): Promise<ExtractedUnit> {
  const file = await extract({ [path]: source }, path);
  if (file.units.length !== 1) throw new Error(`expected one unit, got ${file.units.map((u) => u.symbol).join(", ")}`);
  return file.units[0]!;
}

const keys = (nodes: StructureNode[]): string[] => nodes.flatMap((n) => [`${n.key}:${n.kind}`, ...keys(n.children)]);

describe("hashing", () => {
  const base = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;

  it("ignores whitespace, comments, and JSDoc", async () => {
    const reformatted = `/** Adds two numbers. */\nexport function add(a: number,b: number): number { // sum\n\n    return a+b; }\n`;
    expect((await single(reformatted)).bodyHash).toBe((await single(base)).bodyHash);
  });

  it("changes when the code changes", async () => {
    const changed = base.replace("a + b", "a - b");
    expect((await single(changed)).bodyHash).not.toBe((await single(base)).bodyHash);
  });

  it("gives the file a hash that also ignores formatting", async () => {
    const a = await extract({ "a.ts": base }, "a.ts");
    const b = await extract({ "a.ts": `// header\n${base.replace(/\n/g, "\n\n")}` }, "a.ts");
    expect(a.fileHash).toBe(b.fileHash);
  });
});

describe("unit discovery", () => {
  it("names object-literal methods, class arrow properties, accessors, and default exports", async () => {
    const file = await extract(
      {
        "a.ts": `
export const handlers = {
  create() { return 1; },
  remove: (id: string) => id.length,
};
export class Store {
  private n = 0;
  increment = () => { this.n++; };
  get size() { return this.n; }
  set size(v: number) { this.n = v; }
}
export default function () { return handlers.create(); }
`,
      },
      "a.ts",
    );
    expect(file.units.map((u) => u.symbol)).toEqual([
      "handlers.create",
      "handlers.remove",
      "Store.increment",
      "Store.get size",
      "Store.set size",
      "default",
    ]);
  });

  it("collects top-level code that does work into one module unit", async () => {
    const file = await extract(
      { "a.ts": `const LIMIT = 5;\nexport function f() { return LIMIT; }\nconsole.log(f());\nif (LIMIT > 1) f();\n` },
      "a.ts",
    );
    const mod = file.units.find((u) => u.symbol === "<module>")!;
    expect(keys(mod.body)).toEqual(["0:statement", "1:if", "1.then.0:statement"]);
  });
});

describe("structure", () => {
  it("nests else-if chains under else nodes", async () => {
    const u = await single(`export function grade(n: number) {
  if (n > 90) { return "A"; } else if (n > 80) { return "B"; } else { return "C"; }
}`);
    expect(keys(u.body)).toEqual(["0:if", "0.then.0:return", "0.else:else", "0.else.0:if", "0.else.0.then.0:return", "0.else.0.else:else", "0.else.0.else.0:return"]);
  });

  it("handles do-while, labels, finally, and nested functions", async () => {
    const u = await single(`export function f(xs: number[]) {
  let i = 0;
  outer: do { i++; } while (i < xs.length);
  try { g(); } finally { i = 0; }
  function g() { return xs[0]; }
}`);
    expect(keys(u.body)).toEqual([
      "0:statement",
      "1:loop", "1.body.0:statement",
      "2:try", "2.try.0:statement", "2.finally:finally", "2.finally.0:statement",
      "3:statement", "3.cb0:callback", "3.cb0.0:return",
    ]);
  });
});

describe("name matching", () => {
  it("matches an untyped call to a uniquely named project function, and says so", async () => {
    const file = await extract(
      {
        "lib.ts": `export function rebalanceLedger() { return 1; }\n`,
        "use.js": `export function run(service) { return service.rebalanceLedger(); }\n`,
      },
      "use.js",
    );
    const site = file.units[0]!.body[0]!.calls[0]!;
    expect(site.target).toEqual({ file: "lib.ts", symbol: "rebalanceLedger" });
    expect(site.confidence).toBe("name-match");
  });

  it("does not guess when several functions share the name", async () => {
    const file = await extract(
      {
        "a.ts": `export function save() {}\n`,
        "b.ts": `export class Repo { save() {} }\n`,
        "use.js": `export function run(x) { x.save(); }\n`,
      },
      "use.js",
    );
    expect(file.units[0]!.body[0]!.calls[0]).toMatchObject({ target: null, confidence: null });
  });
});

describe("project loading", () => {
  it("respects the lite statement limit option", async () => {
    const source = `export function f() { const a = 1; const b = 2; return a + b; }`;
    const u3 = (await extract({ "a.ts": source }, "a.ts", { liteMaxStatements: 3 })).units[0]!;
    const u2 = (await extract({ "a.ts": source }, "a.ts", { liteMaxStatements: 2 })).units[0]!;
    expect([u3.isSmall, u2.isSmall]).toEqual([true, false]);
  });

  it("reports a missing file clearly", async () => {
    await expect(extract({ "a.ts": "export {};" }, "missing.ts")).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });
});
