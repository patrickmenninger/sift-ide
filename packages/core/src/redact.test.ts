import { describe, expect, it } from "vitest";
import { looksLikeSecret, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("replaces known key formats and random-looking string literals", () => {
    const source = [
      'const aws = "AKIAABCDEFGHIJKLMNOP";',
      "const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
      'const token = "q8Zr3Lx0Pw2Nv7Ks5Tb9Yc4Hd1Mg6Jf";',
      'const url = "https://example.com/api/v1/accounts";',
      'const msg = "You can only transfer from your own accounts";',
      'const id = "transfer.completed";',
    ].join("\n");
    const { text, count } = redactSecrets(source);
    expect(count).toBe(3);
    expect(text).toContain('const aws = "<redacted>";');
    expect(text).toContain("const gh = '<redacted>';");
    expect(text).toContain('const token = "<redacted>";');
    expect(text).toContain('"https://example.com/api/v1/accounts"');
    expect(text).toContain('"You can only transfer from your own accounts"');
  });

  it("removes private key blocks", () => {
    const { text, count } = redactSecrets("const k = `-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`;");
    expect(count).toBe(1);
    expect(text).not.toContain("MIIabc");
  });

  it("leaves ordinary identifiers alone", () => {
    expect(looksLikeSecret("AccountService.transferFunds")).toBe(false);
    expect(looksLikeSecret("account_balance_changed_event")).toBe(false);
    expect(looksLikeSecret("ERR_ACCOUNT_NOT_FOUND_2024")).toBe(false);
    expect(looksLikeSecret("short")).toBe(false);
  });
});
