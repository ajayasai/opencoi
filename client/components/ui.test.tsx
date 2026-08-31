/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Field, Modal, Select, Textarea, TextInput } from "./ui";

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

describe("Field", () => {
  it("provides a visible accessible name, descriptions, and error state", () => {
    render(
      <Field
        label="Contact email"
        hint="Used for renewal reminders."
        error="Enter a valid email address."
      >
        <TextInput type="email" />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: "Contact email" });
    expect(input).toHaveAccessibleDescription(
      "Used for renewal reminders. Enter a valid email address.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("id");
  });

  it("labels controls nested inside visual wrappers", () => {
    render(
      <Field label="Password">
        <span>
          <TextInput type="password" />
          <button type="button" aria-label="Show password">
            Show
          </button>
        </span>
      </Field>,
    );

    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  it("associates compound controls without reusing an id", () => {
    render(
      <Field label="Primary limit" hint="Choose the exact document label.">
        <Select defaultValue="EACH_OCCURRENCE">
          <option value="EACH_OCCURRENCE">Each occurrence</option>
        </Select>
        <TextInput inputMode="decimal" />
      </Field>,
    );

    const select = screen.getByRole("combobox", { name: "Primary limit" });
    const input = screen.getByRole("textbox", { name: "Primary limit" });
    expect(select).toHaveAccessibleDescription("Choose the exact document label.");
    expect(input).toHaveAccessibleDescription("Choose the exact document label.");
    expect(select.id).not.toBe(input.id);
  });

  it("preserves an explicit accessible name while connecting a hint", () => {
    render(
      <Field label="Currency" hint="Only U.S. dollars are supported.">
        <Select aria-label="Requirement currency" defaultValue="USD">
          <option value="USD">USD</option>
        </Select>
      </Field>,
    );

    expect(
      screen.getByRole("combobox", { name: "Requirement currency" }),
    ).toHaveAccessibleDescription("Only U.S. dollars are supported.");
  });

  it("applies the same contract to multiline controls", () => {
    render(
      <Field label="Business rationale">
        <Textarea />
      </Field>,
    );

    expect(screen.getByRole("textbox", { name: "Business rationale" }).tagName).toBe("TEXTAREA");
  });
});
