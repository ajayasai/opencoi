import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { cookiesFor } from "./middleware.js";

describe("HTTP middleware", () => {
  it("stores attacker-controlled cookie names without object-property writes", () => {
    const request = {
      headers: {
        cookie: "__proto__=polluted; constructor=shadowed; safe=value%20with%20spaces",
      },
    } as Request;

    const cookies = cookiesFor(request);

    expect(cookies).toBeInstanceOf(Map);
    expect(cookies.get("__proto__")).toBe("polluted");
    expect(cookies.get("constructor")).toBe("shadowed");
    expect(cookies.get("safe")).toBe("value with spaces");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores malformed percent-encoded cookie values", () => {
    const request = { headers: { cookie: "broken=%E0%A4%A; safe=ok" } } as Request;

    expect([...cookiesFor(request)]).toEqual([["safe", "ok"]]);
  });
});
