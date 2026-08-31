/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfInBrowser } from "../lib/documentExtraction";
import { DocumentIntake, type IntakeSubmission } from "./DocumentIntake";

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

  it("requires and submits exact source pages for human-verified endorsement evidence", async () => {
    vi.mocked(extractPdfInBrowser).mockResolvedValueOnce({
      rawText: "NAMED INSURED: Synthetic Vendor LLC",
      pages: [{ page: 1, text: "NAMED INSURED: Synthetic Vendor LLC", method: "text_layer" }],
      pageCount: 1,
      method: "text_layer",
      warnings: [],
    });
    const onSubmit = vi.fn<(file: File, submission: IntakeSubmission) => Promise<void>>(
      async () => undefined,
    );
    render(
      <DocumentIntake
        vendorName="Synthetic Vendor"
        confirmationMode="staff"
        submitLabel="Confirm"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Certificate PDF file"), {
      target: { files: [new File(["pdf"], "certificate.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: /add endorsement/i }));
    fireEvent.change(screen.getByLabelText("Endorsement name"), {
      target: { value: "Additional insured" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/needs a source page/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    const sourcePageInputs = screen.getAllByLabelText("PDF source page(s)");
    fireEvent.change(sourcePageInputs.at(-1) as HTMLInputElement, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[1].policies[0]?.endorsements).toContainEqual(
      expect.objectContaining({
        name: "Additional insured",
        evidenceLevel: "HUMAN_VERIFIED",
        sourcePages: [1],
      }),
    );
  });
});
