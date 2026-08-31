/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { LoginPage } from "./LoginPage";

vi.mock("../api", () => ({
  api: {
    oidcStatus: vi.fn(),
    beginOidcLogin: vi.fn(),
  },
}));

vi.mock("../state/AuthContext", () => ({
  useAuth: () => ({
    user: null,
    login: vi.fn(),
  }),
}));

describe("LoginPage OIDC status", () => {
  beforeEach(() => {
    vi.mocked(api.oidcStatus).mockResolvedValue({
      enabled: true,
      displayName: "Company SSO",
      organizationName: "Organization A",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the configured SSO option while retaining local sign-in", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Continue with Company SSO" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("or use a local account")).toBeInTheDocument();
  });

  it("shows one generic failure status after an unsuccessful callback", async () => {
    render(
      <MemoryRouter initialEntries={["/login?sso=failed"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Sign-in failed")).toBeInTheDocument();
    expect(screen.getByText(/account may not be provisioned/i)).toBeInTheDocument();
    expect(screen.queryByText(/subject|nonce|state|provider-secret/i)).not.toBeInTheDocument();
  });
});
