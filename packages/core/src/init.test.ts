import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { writeFileAtomic } from "./fs.js";
import { initProject } from "./init.js";

const tempDir = () => mkdtemp(join(tmpdir(), "sift-init-"));

describe("initProject", () => {
  it("creates the .sift directory, a valid config, and .gitignore entries", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"));

    const result = await initProject(root);

    expect(result.created).toEqual([".sift/", ".sift/rules/", "sift.config.yaml", ".gitignore"]);
    expect(existsSync(join(root, ".sift", "rules"))).toBe(true);
    const config = parseConfig(await readFile(join(root, "sift.config.yaml"), "utf8"));
    expect(config.include).toEqual(["src/**"]);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "# Sift (derived data and per-machine model settings)\n.sift/.cache/\n.sift/models.local.yaml\n",
    );
  });

  it("includes the whole project when there is no src directory", async () => {
    const root = await tempDir();
    await initProject(root);
    const config = parseConfig(await readFile(join(root, "sift.config.yaml"), "utf8"));
    expect(config.include).toEqual(["**"]);
  });

  it("is idempotent and never overwrites an existing config", async () => {
    const root = await tempDir();
    await writeFile(join(root, "sift.config.yaml"), "concurrency: 9\n");
    await initProject(root);

    const again = await initProject(root);

    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(await readFile(join(root, "sift.config.yaml"), "utf8")).toBe("concurrency: 9\n");
  });

  it("appends only missing .gitignore entries and keeps CRLF line endings", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitignore"), "node_modules/\r\n.sift/.cache/");

    const result = await initProject(root);

    expect(result.updated).toEqual([".gitignore"]);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\r\n.sift/.cache/\r\n\r\n# Sift (derived data and per-machine model settings)\r\n.sift/models.local.yaml\r\n",
    );
  });
});

describe("writeFileAtomic", () => {
  it("creates parent directories and leaves no temp files behind", async () => {
    const root = await tempDir();
    const target = join(root, "a", "b", "file.txt");

    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");

    expect(await readFile(target, "utf8")).toBe("two");
    expect(await readdir(join(root, "a", "b"))).toEqual(["file.txt"]);
  });
});
