/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "./ui";

afterEach(cleanup);

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open review
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Review certificate"
        description="Confirm the document facts."
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button">Save</button>
          </>
        }
      >
        <input aria-label="Named insured" />
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("keeps keyboard focus inside and restores it after closing", () => {
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "Open review" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Review certificate" });
    expect(dialog).toHaveAccessibleDescription("Confirm the document facts.");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
