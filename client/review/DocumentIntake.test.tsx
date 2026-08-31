/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentIntake } from "./DocumentIntake";

vi.mock("../components/PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../lib/documentExtraction", () => ({ extractPdfInBrowser: vi.fn() }));
vi.mock("../state/ToastContext", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

afterEach(cleanup);

describe("DocumentIntake upload control", () => {
  it("keeps the hidden file input named and out of the keyboard tab order", () => {
    render(
      <DocumentIntake
        vendorName="Synthetic Vendor"
        confirmationMode="staff"
        submitLabel="Confirm"
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    const input = screen.getByLabelText("Certificate PDF file");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("tabindex", "-1");

    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Choose PDF" }));
    expect(click).toHaveBeenCalledOnce();
  });
});
