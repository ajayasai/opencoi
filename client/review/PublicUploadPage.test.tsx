/** @vitest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PublicUploadPage } from "./PublicUploadPage";

vi.mock("../api", () => ({
  api: {
    publicUploadContext: vi.fn(),
    publicUpload: vi.fn(),
  },
}));
vi.mock("../components/PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../lib/documentExtraction", () => ({ extractPdfInBrowser: vi.fn() }));
vi.mock("../state/ToastContext", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("PublicUploadPage bearer handling", () => {
  beforeEach(() => {
    vi.mocked(api.publicUploadContext).mockReset();
    vi.mocked(api.publicUploadContext).mockReturnValue(new Promise(() => undefined));
  });

  it("consumes the fragment token and removes it from browser history before API use", async () => {
    const token = `v1.org-a.${"x".repeat(48)}`;
    window.history.replaceState({}, "", `/upload#token=${encodeURIComponent(token)}`);

    render(
      <StrictMode>
        <PublicUploadPage />
      </StrictMode>,
    );

    expect(window.location.pathname).toBe("/upload");
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(api.publicUploadContext).toHaveBeenCalledWith(token));
  });
});
