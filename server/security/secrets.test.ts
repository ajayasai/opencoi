import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.js";

const key = "test-only-key-material-that-is-longer-than-thirty-two-bytes";

describe("integration secret encryption", () => {
  it("round trips while producing randomized ciphertext", () => {
    const first = encryptSecret("whsec_example", key, "org-1:webhook:one");
    const second = encryptSecret("whsec_example", key, "org-1:webhook:one");
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key, "org-1:webhook:one")).toBe("whsec_example");
  });

  it("rejects tampering, a wrong deployment key, and cross-tenant context", () => {
    const ciphertext = encryptSecret("whsec_example", key, "org-1:webhook:one");
    const parts = ciphertext.split(":");
    parts[4] = `${parts[4]?.startsWith("A") ? "B" : "A"}${parts[4]?.slice(1)}`;
    expect(() => decryptSecret(parts.join(":"), key, "org-1:webhook:one")).toThrow();
    expect(() => decryptSecret(ciphertext, `${key}-different`, "org-1:webhook:one")).toThrow();
    expect(() => decryptSecret(ciphertext, key, "org-2:webhook:one")).toThrow();
  });

  it("requires meaningful key material", () => {
    expect(() => encryptSecret("secret", "short", "context")).toThrow(RangeError);
  });
});
