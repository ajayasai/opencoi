import { describe, expect, it, vi } from "vitest";
import {
  assertPdfMagicBytes,
  createSessionTokens,
  createUploadLinkToken,
  hashOpaqueToken,
  hashPassword,
  hasPdfMagicBytes,
  neutralizeCsvFormula,
  passwordHashNeedsUpgrade,
  verifyOpaqueToken,
  verifyPassword,
  verifyPasswordOrDummy,
} from "./security.js";

describe("password security", () => {
  it("uses salted scrypt hashes and constant-time verification", async () => {
    const password = "correct horse battery staple";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^scrypt\$v=1\$N=65536,r=8,p=1,l=32\$/);
    expect(first).not.toBe(second);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword("incorrect password value", first)).resolves.toBe(false);
    await expect(verifyPassword(password, "not-a-hash")).resolves.toBe(false);
    expect(passwordHashNeedsUpgrade(first)).toBe(false);
  });

  it("performs one valid dummy-hash verification when no login row exists", async () => {
    const verifier = vi.fn().mockResolvedValue(false);

    await expect(
      verifyPasswordOrDummy("unknown-account-password", undefined, verifier),
    ).resolves.toBe(false);
    expect(verifier).toHaveBeenCalledOnce();
    expect(verifier.mock.calls[0]?.[1]).toMatch(/^scrypt\$v=1\$N=65536,r=8,p=1,l=32\$/);
  });

  it("enforces useful password length bounds", async () => {
    await expect(hashPassword("too short")).rejects.toThrow(RangeError);
    await expect(hashPassword("x".repeat(1_025))).rejects.toThrow(RangeError);
  });
});

describe("opaque tokens", () => {
  it("returns bearer values separately from one-way storage hashes", () => {
    const credentials = createSessionTokens("a".repeat(32));
    expect(credentials.sessionToken).not.toContain(credentials.sessionTokenHash);
    expect(credentials.sessionTokenHash).toHaveLength(64);
    expect(credentials.csrfTokenHash).toHaveLength(64);
    expect(
      verifyOpaqueToken(credentials.sessionToken, credentials.sessionTokenHash, "a".repeat(32)),
    ).toBe(true);
    expect(
      verifyOpaqueToken(
        `${credentials.sessionToken}x`,
        credentials.sessionTokenHash,
        "a".repeat(32),
      ),
    ).toBe(false);
  });

  it("generates high-entropy public upload tokens", () => {
    const first = createUploadLinkToken();
    const second = createUploadLinkToken();
    expect(first.token).not.toBe(second.token);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.tokenHash).toBe(hashOpaqueToken(first.token));
  });
});

describe("untrusted files and exports", () => {
  it("validates the PDF signature using the actual buffer offset", () => {
    const backing = Buffer.from("junk%PDF-1.7\ncontents");
    const sliced = backing.subarray(4);
    expect(hasPdfMagicBytes(sliced)).toBe(true);
    expect(hasPdfMagicBytes(Buffer.from("not a pdf"))).toBe(false);
    expect(() => assertPdfMagicBytes(Buffer.from("%PDF-1.4"))).not.toThrow();
    expect(() => assertPdfMagicBytes(Buffer.from(" PDF-1.4"))).toThrow(/signature/);
  });

  it.each([
    ["=2+2", "'=2+2"],
    [" +SUM(A1:A2)", "' +SUM(A1:A2)"],
    ["\tcmd", "'\tcmd"],
    ["\ncmd", "'\ncmd"],
    ["\u00a0=WEBSERVICE(A1)", "'\u00a0=WEBSERVICE(A1)"],
    ["'=safe", "'=safe"],
    ["ordinary vendor", "ordinary vendor"],
  ])("neutralizes spreadsheet formulas in %j", (input, expected) => {
    expect(neutralizeCsvFormula(input)).toBe(expected);
  });
});
