import { describe, expect, it } from "vitest";
import { SiftError } from "./errors.js";
import { carryProvenance, displayStatus, hasPersonWording, keepsPersonWording, personWordingNote } from "./provenance.js";
import { requiredSchemaVersion, type SiftFile } from "./schema.js";
import { parseSiftText, serializeSiftFile, updateSiftText } from "./sift-yaml.js";
import { sampleSiftFile, transferUnit } from "./test-support.js";

function withPersonStep(): SiftFile {
  const file = sampleSiftFile();
  file.units[0]!.steps[0]!.status = "user-edited";
  return file;
}

describe("schema v1", () => {
  it("leaves a v0 file at v0 when nothing needs v1", () => {
    const file = sampleSiftFile();
    expect(requiredSchemaVersion(file)).toBe(0);
    expect(serializeSiftFile(file).startsWith("sift: 0\n")).toBe(true);
  });

  it("upgrades a file to v1 when it holds a step status, userEdited, or a resolved warning", () => {
    expect(serializeSiftFile(withPersonStep()).startsWith("sift: 1\n")).toBe(true);

    const fields = sampleSiftFile();
    fields.units[0]!.userEdited = ["summary", "inputs.userId"];
    expect(requiredSchemaVersion(fields)).toBe(1);

    const resolved = sampleSiftFile();
    resolved.units[0]!.warnings[0]!.resolved = { by: "edit", note: "Both saves now run in one transaction." };
    expect(requiredSchemaVersion(resolved)).toBe(1);
  });

  it("round-trips the v1 fields in a fixed key order", () => {
    const file = withPersonStep();
    file.sift = 1;
    file.units[0]!.userEdited = ["summary", "returns"];
    file.units[0]!.warnings[0]!.resolved = { by: "edit", note: "Answered by an edit." };
    const text = serializeSiftFile(file);
    expect(text).toContain("    status: generated\n    userEdited: [summary, returns]\n    bodyHash:");
    expect(text).toContain("      - id: s_q2w6\n        status: user-edited\n        text: Get the source account");
    expect(text).toContain("        resolved:\n          by: edit\n          note: Answered by an edit.\n");
    expect(parseSiftText(text, "x")).toEqual(file);
  });

  it("keeps the declared version when reading", () => {
    const text = serializeSiftFile(sampleSiftFile());
    expect(parseSiftText(text, "x").sift).toBe(0);
    expect(parseSiftText(text.replace("sift: 0", "sift: 1"), "x").sift).toBe(1);
  });

  it("rejects v1 fields in a file that declares v0, and bad userEdited names", () => {
    const text = serializeSiftFile(withPersonStep()).replace("sift: 1", "sift: 0");
    expect(() => parseSiftText(text, "x")).toThrow(SiftError);

    const bad = sampleSiftFile();
    bad.sift = 1;
    bad.units[0]!.userEdited = ["inputs.nope"];
    try {
      parseSiftText(serializeSiftFile(bad), "x");
      expect.unreachable();
    } catch (err) {
      expect((err as SiftError).details.join("\n")).toContain("names an input the unit does not have: nope");
    }
  });

  it("refuses a file from a newer Sift", () => {
    const text = serializeSiftFile(sampleSiftFile()).replace("sift: 0", "sift: 2");
    expect(() => parseSiftText(text, "x")).toThrow(expect.objectContaining({ code: "SIFT_TOO_NEW" }));
  });

  it("does not rewrite untouched units when another unit gains a v1 field", () => {
    const before = serializeSiftFile(sampleSiftFile());
    const next = sampleSiftFile();
    next.units[1]!.userEdited = ["summary"];
    const after = updateSiftText(before, next);
    expect(after.startsWith("sift: 1\n")).toBe(true);
    const chunk = (t: string) => t.slice(t.indexOf("  - id: u_7f3k2a6q"), t.indexOf("  - id: u_m2c6d2aa"));
    expect(chunk(after)).toBe(chunk(before));
  });
});

describe("provenance", () => {
  it("treats a v0 user-edited unit as entirely a person's wording", () => {
    const unit = transferUnit();
    unit.status = "user-edited";
    expect(personWordingNote(unit)).toBe("A person edited this description. Keep their wording wherever it is still accurate.");
    const next = structuredClone(unit);
    next.steps[2]!.text = "Save both accounts.";
    expect(keepsPersonWording(unit, next)).toBe(false);
  });

  it("protects only the parts a person wrote when the unit says so", () => {
    const unit = transferUnit();
    unit.steps[0]!.status = "user-edited";
    unit.userEdited = ["inputs.amountCents"];
    expect(hasPersonWording(unit)).toBe(true);
    expect(displayStatus(unit)).toBe("user-edited");
    expect(personWordingNote(unit)).toBe("A person wrote the meaning of input `amountCents` and step s_q2w6. Keep their wording wherever it is still accurate.");

    const reworded = structuredClone(unit);
    reworded.summary = "A new summary.";
    reworded.steps[2]!.text = "Save both accounts.";
    expect(keepsPersonWording(unit, reworded)).toBe(true);

    reworded.steps[0]!.text = "Load the source account.";
    expect(keepsPersonWording(unit, reworded)).toBe(false);
  });

  it("carries provenance only for unchanged text, and drops verified when the code changed", () => {
    const unit = transferUnit();
    unit.userEdited = ["summary", "returns"];
    unit.steps[0]!.status = "user-edited";
    unit.steps[2]!.status = "verified";
    const next = structuredClone(unit);
    for (const s of next.steps) delete s.status;
    delete next.userEdited;
    next.returns!.meaning = "Something else.";

    const updated = structuredClone(next);
    carryProvenance(unit, updated, { keepVerified: false });
    expect(updated.userEdited).toEqual(["summary"]);
    expect(updated.steps[0]!.status).toBe("user-edited");
    expect(updated.steps[2]!.status).toBeUndefined();

    const checked = structuredClone(next);
    checked.steps[0]!.text = "Reworded.";
    carryProvenance(unit, checked, { keepVerified: true });
    expect(checked.steps[0]!.status).toBeUndefined();
    expect(checked.steps[2]!.status).toBe("verified");
  });

  it("shows stale over everything else", () => {
    const unit = transferUnit();
    unit.status = "stale";
    unit.steps[0]!.status = "user-edited";
    expect(displayStatus(unit)).toBe("stale");
  });
});
