import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileExtraction } from "./adapter.js";
import { SiftCache } from "./cache.js";
import { ID_PATTERNS, newId } from "./ids.js";
import { deleteSiftFile, listSiftFiles, readSiftFile, siftPathFor, sourcePathFor, writeSiftFile } from "./store.js";
import { sampleSiftFile } from "./test-support.js";

const tempRoot = () => mkdtemp(join(tmpdir(), "sift-store-"));

describe("paths", () => {
  it("mirrors the full source path and keeps the extension", () => {
    expect(siftPathFor("src/accounts/transfer.ts")).toBe(".sift/src/accounts/transfer.ts.sift");
    expect(siftPathFor("src\\a.js")).toBe(".sift/src/a.js.sift");
    expect(sourcePathFor(".sift/src/accounts/transfer.ts.sift")).toBe("src/accounts/transfer.ts");
  });

  it("refuses paths outside the project and ignores reserved .sift entries", () => {
    expect(() => siftPathFor("../other/a.ts")).toThrowError(/outside the project/);
    expect(sourcePathFor(".sift/.cache/files/x.ts.sift")).toBeNull();
    expect(sourcePathFor(".sift/rules/prisma.yaml")).toBeNull();
    expect(sourcePathFor("src/a.ts")).toBeNull();
  });
});

describe("read / write / list", () => {
  it("writes, reads back, and skips identical rewrites", async () => {
    const root = await tempRoot();
    const file = sampleSiftFile();

    expect(await writeSiftFile(root, file)).toEqual({ path: ".sift/src/accounts/account-service.ts.sift", changed: true });
    const abs = join(root, ".sift/src/accounts/account-service.ts.sift");
    const firstMtime = (await stat(abs)).mtimeMs;

    expect(await writeSiftFile(root, file)).toMatchObject({ changed: false });
    expect((await stat(abs)).mtimeMs).toBe(firstMtime);

    const stored = await readSiftFile(root, file.source);
    expect(stored?.file).toEqual(file);
    expect(stored?.text).toBe(await readFile(abs, "utf8"));
  });

  it("returns null for a source without a .sift file, and throws for an invalid one", async () => {
    const root = await tempRoot();
    expect(await readSiftFile(root, "src/none.ts")).toBeNull();
    await mkdir(join(root, ".sift/src"), { recursive: true });
    await writeFile(join(root, ".sift/src/bad.ts.sift"), "sift: 0\nunits: 3\n");
    await expect(readSiftFile(root, "src/bad.ts")).rejects.toMatchObject({ code: "SIFT_INVALID" });
  });

  it("lists logic files only, sorted, and deletes them", async () => {
    const root = await tempRoot();
    for (const source of ["src/b.ts", "src/a/x.tsx", "lib/c.js"]) await writeSiftFile(root, { ...sampleSiftFile(), source });
    await mkdir(join(root, ".sift/.cache/files/src"), { recursive: true });
    await writeFile(join(root, ".sift/.cache/files/src/b.ts.sift"), "{}");
    await mkdir(join(root, ".sift/rules"), { recursive: true });
    await writeFile(join(root, ".sift/rules/mine.yaml"), "pack: mine\n");

    expect(await listSiftFiles(root)).toEqual(["lib/c.js", "src/a/x.tsx", "src/b.ts"]);
    expect(await deleteSiftFile(root, "src/b.ts")).toBe(true);
    expect(await deleteSiftFile(root, "src/b.ts")).toBe(false);
    expect(await listSiftFiles(root)).toEqual(["lib/c.js", "src/a/x.tsx"]);
  });
});

describe("ids", () => {
  it("generates IDs in the documented formats and avoids taken ones", () => {
    expect(newId("unit")).toMatch(ID_PATTERNS.unit);
    expect(newId("step")).toMatch(ID_PATTERNS.step);
    expect(newId("warning")).toMatch(ID_PATTERNS.warning);
    const taken = new Set(Array.from({ length: 500 }, () => newId("step")));
    expect(taken.has(newId("step", taken))).toBe(false);
  });
});

describe("SiftCache", () => {
  const extraction: FileExtraction = { path: "src/a.ts", language: "typescript", fileHash: "0123456789abcdef", units: [] };

  it("returns an extraction only for the same content and adapter", async () => {
    const cache = new SiftCache(await tempRoot());
    expect(await cache.getExtraction("src/a.ts", extraction.fileHash, "typescript")).toBeNull();
    await cache.putExtraction(extraction, "typescript");
    expect(await cache.getExtraction("src/a.ts", extraction.fileHash, "typescript")).toEqual(extraction);
    expect(await cache.getExtraction("src/a.ts", "ffffffffffffffff", "typescript")).toBeNull();
    expect(await cache.getExtraction("src/a.ts", extraction.fileHash, "python")).toBeNull();
  });

  it("treats corrupt or outdated cache files as missing", async () => {
    const root = await tempRoot();
    const cache = new SiftCache(root);
    await cache.putExtraction(extraction, "typescript");
    await writeFile(join(root, ".sift/.cache/files/src/a.ts.json"), "{ not json");
    expect(await cache.getExtraction("src/a.ts", extraction.fileHash, "typescript")).toBeNull();

    await writeFile(join(root, ".sift/.cache/fingerprints.json"), JSON.stringify({ version: 0, files: { "src/a.ts": {} } }));
    expect(await cache.getFingerprints()).toEqual(new Map());
  });

  it("stores fingerprints sorted, and clears everything", async () => {
    const root = await tempRoot();
    const cache = new SiftCache(root);
    await cache.putFingerprints(
      new Map([
        ["src/b.ts", { size: 2, mtimeMs: 2, fileHash: "b".repeat(16) }],
        ["src/a.ts", { size: 1, mtimeMs: 1, fileHash: "a".repeat(16) }],
      ]),
    );
    expect([...(await cache.getFingerprints()).keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    await cache.clear();
    expect(await cache.getFingerprints()).toEqual(new Map());
  });
});
