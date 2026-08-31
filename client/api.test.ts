import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("public upload API bearer transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a fixed request target and carries the token only in Authorization", async () => {
    const token = `v1.org-a.${"x".repeat(48)}`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            organizationName: "Organization A",
            vendorName: "Vendor A",
            expiresAt: "2026-09-02T00:00:00.000Z",
            requirements: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.publicUploadContext(token);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/public/upload");
    expect(path).not.toContain(token);
    expect(new Headers(init.headers).get("Authorization")).toBe(`UploadLink ${token}`);
  });
});
