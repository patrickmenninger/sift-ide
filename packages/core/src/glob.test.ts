import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob.js";

const path = (pattern: string, text: string) => globToRegExp(pattern).test(text);
const member = (pattern: string, text: string) => globToRegExp(pattern, ".").test(text);

describe("globToRegExp", () => {
  it("matches path patterns used in include and exclude", () => {
    expect(path("src/**", "src/a.ts")).toBe(true);
    expect(path("src/**", "src/a/b/c.ts")).toBe(true);
    expect(path("src/**", "srcx/a.ts")).toBe(false);
    expect(path("**/*.test.*", "src/a/b.test.ts")).toBe(true);
    expect(path("**/*.test.*", "b.test.ts")).toBe(true);
    expect(path("**/generated/**", "src/generated/x.ts")).toBe(true);
    expect(path("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(path("src/?.ts", "src/a.ts")).toBe(true);
  });

  it("matches qualified names with alternatives and one-segment wildcards", () => {
    expect(member("Prisma.*Delegate.{findMany,update}", "Prisma.AccountDelegate.update")).toBe(true);
    expect(member("Prisma.*Delegate.{findMany,update}", "Prisma.AccountDelegate.delete")).toBe(false);
    expect(member("Prisma.*Delegate.update", "Prisma.X.YDelegate.update")).toBe(false);
    expect(member("{,FileHandle.}readFile", "readFile")).toBe(true);
    expect(member("{,FileHandle.}readFile", "FileHandle.readFile")).toBe(true);
    expect(member("PrismaClient.$transaction", "PrismaClient.$transaction")).toBe(true);
    expect(member("**", "Any.Thing.At.All")).toBe(true);
  });

  it("rejects an unclosed alternative", () => {
    expect(() => globToRegExp("{a,b")).toThrow(/Unclosed/);
  });
});
