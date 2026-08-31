/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const auth = vi.hoisted(() => ({ logout: vi.fn(async () => undefined) }));

vi.mock("../state/AuthContext", () => ({
  useAuth: () => ({
    loading: false,
    login: vi.fn(),
    logout: auth.logout,
    refresh: vi.fn(),
    user: {
      csrfToken: "test-csrf",
      email: "ada@example.test",
      id: "user-a",
      name: "Ada Reviewer",
      organizationId: "org-a",
      organizationName: "Example Organization",
      role: "reviewer",
    },
  }),
}));

let mobileNavigation = false;

const renderShell = (entry = "/") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AppShell>
        <p>Page body</p>
      </AppShell>
    </MemoryRouter>,
  );

beforeEach(() => {
  mobileNavigation = false;
  auth.logout.mockClear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(max-width: 980px)" && mobileNavigation,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  document.body.className = "";
  document.title = "";
});

describe("AppShell accessibility", () => {
  it("provides a skip target and moves focus when client-side navigation changes", async () => {
    renderShell();

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    await waitFor(() => expect(main).toHaveFocus());
    expect(document.title).toBe("Overview · OpenCOI");

    fireEvent.click(screen.getByRole("link", { name: "Vendors" }));
    await waitFor(() => expect(document.title).toBe("Vendors · OpenCOI"));
    expect(main).toHaveFocus();
  });

  it("opens the account disclosure with the keyboard and restores focus on Escape", async () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "Account menu for Ada Reviewer" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const dialog = await screen.findByRole("dialog", { name: "Account menu" });
    expect(trigger).toHaveAttribute("aria-controls", dialog.id);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Account menu" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("treats mobile navigation as a focus-managed drawer", async () => {
    mobileNavigation = true;
    renderShell();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    const navigation = document.getElementById("main-navigation");
    expect(navigation).toHaveAttribute("aria-hidden", "true");

    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Primary navigation" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(drawer).not.toHaveAttribute("aria-hidden");
    expect(document.querySelector(".app-main")).toHaveAttribute("inert");
    await waitFor(() =>
      expect(within(drawer).getByRole("button", { name: "Close navigation" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(drawer).toHaveAttribute("aria-hidden", "true"));
    expect(trigger).toHaveFocus();
    expect(document.querySelector(".app-main")).not.toHaveAttribute("inert");
  });
});
