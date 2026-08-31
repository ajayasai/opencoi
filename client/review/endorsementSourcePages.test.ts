import { describe, expect, it } from "vitest";
import { parseEndorsementSourcePages } from "./endorsementSourcePages";

describe("endorsement source page parsing", () => {
  it("normalizes a reviewer's page list into ascending order", () => {
    expect(parseEndorsementSourcePages("4, 2, 9", { required: true, maxPage: 9 })).toEqual([
      2, 4, 9,
    ]);
  });

  it("rejects missing, repeated, malformed, or out-of-document page references", () => {
    expect(() => parseEndorsementSourcePages("", { required: true })).toThrow(/needs a source/i);
    expect(() => parseEndorsementSourcePages("2, 2", { required: false })).toThrow(/repeated/i);
    expect(() => parseEndorsementSourcePages("1-2", { required: false })).toThrow(
      /comma-separated/i,
    );
    expect(() => parseEndorsementSourcePages("3", { required: false, maxPage: 2 })).toThrow(
      /between 1 and 2/i,
    );
  });
});
