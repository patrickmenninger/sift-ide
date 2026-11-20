import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SiftCache } from "./cache.js";
import { listSourceFiles, refreshFingerprints } from "./freshness.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sift-fresh-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

describe("listSourceFiles", () => {
  it("applies include, exclude, and extensions, and never looks in node_modules or .sift", async () => {
    const root = await project({
      "src/a.ts": "",
      "src/deep/b.tsx": "",
      "src/a.test.ts": "",
      "src/notes.md": "",
      "src/generated/g.ts": "",
      "src/node_modules/x/index.js": "",
      "lib/c.ts": "",
      ".sift/src/a.ts.sift": "",
    });
    const files = await listSourceFiles(root, { include: ["src/**"], exclude: ["**/*.test.*", "**/generated/**"] }, [".ts", ".tsx", ".js"]);
    expect(files).toEqual(["src/a.ts", "src/deep/b.tsx"]);
  });
});

describe("refreshFingerprints", () => {
  it("hashes only new and changed files, unless asked to hash everything", async () => {
    const root = await project({ "src/a.ts": "a", "src/b.ts": "b" });
    const cache = new SiftCache(root);
    const files = ["src/a.ts", "src/b.ts"];
    const hashFile = (_path: string, text: string) => `h(${text})`;

    const first = await refreshFingerprints(root, files, cache, hashFile);
    expect(first.hashed).toEqual(files);
    expect(first.hashes.get("src/a.ts")).toBe("h(a)");

    const second = await refreshFingerprints(root, files, cache, hashFile);
    expect(second.hashed).toEqual([]);
    expect(second.hashes.get("src/b.ts")).toBe("h(b)");

    await writeFile(join(root, "src/b.ts"), "bb");
    await utimes(join(root, "src/b.ts"), new Date(), new Date(Date.now() + 5000));
    const third = await refreshFingerprints(root, files, cache, hashFile);
    expect(third.hashed).toEqual(["src/b.ts"]);
    expect(third.hashes.get("src/b.ts")).toBe("h(bb)");

    const full = await refreshFingerprints(root, files, cache, hashFile, { fullHash: true });
    expect(full.hashed).toEqual(files);
  });

  it("forgets files that are gone", async () => {
    const root = await project({ "src/a.ts": "a", "src/b.ts": "b" });
    const cache = new SiftCache(root);
    await refreshFingerprints(root, ["src/a.ts", "src/b.ts"], cache, (_p, t) => t);
    await refreshFingerprints(root, ["src/a.ts"], cache, (_p, t) => t);
    expect([...(await cache.getFingerprints()).keys()]).toEqual(["src/a.ts"]);
  });
});
