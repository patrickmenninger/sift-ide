import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3 +3 @@ export function f() {",
  "-  return 1;",
  "+  return 2;",
  "@@ -10,0 +11,2 @@",
  "+  added();",
  "+  more();",
  "@@ -20,3 +21,0 @@",
  "-  gone();",
  "-  gone();",
  "-  gone();",
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,4 @@",
  "+a",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("collects new-side line ranges per file and deleted files", () => {
    const diff = parseUnifiedDiff(DIFF);
    expect(Object.fromEntries(diff.changed)).toEqual({
      "src/a.ts": [
        { start: 3, end: 3 },
        { start: 11, end: 12 },
        { start: 21, end: 22 }, // a pure deletion marks the lines around it
      ],
      "src/new.ts": [{ start: 1, end: 4 }],
    });
    expect(diff.deleted).toEqual(["src/old.ts"]);
  });
});
