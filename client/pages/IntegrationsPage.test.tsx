/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceAccountRecord, WebhookDeliveryRecord, WebhookEndpointRecord } from "../types";
import { IntegrationsPage } from "./IntegrationsPage";

const apiMocks = vi.hoisted(() => ({
  createServiceAccount: vi.fn(),
  createWebhook: vi.fn(),
  replayWebhookDelivery: vi.fn(),
  revokeServiceAccountSecret: vi.fn(),
  rotateServiceAccount: vi.fn(),
  serviceAccounts: vi.fn(),
  setServiceAccountStatus: vi.fn(),
  setWebhookStatus: vi.fn(),
  webhooks: vi.fn(),
}));

vi.mock("../api", () => ({ api: apiMocks }));
vi.mock("../state/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "admin-a",
      name: "Ada Admin",
      email: "ada@example.test",
      role: "admin",
      organizationId: "org-a",
      organizationName: "Example Organization",
      csrfToken: "csrf-test",
    },
  }),
}));

const account: ServiceAccountRecord = {
  id: "account-a",
  name: "ERP sync",
  description: "Synthetic integration",
  scopes: ["vendors:read"],
  status: "active",
  lastUsedAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  secrets: [
    {
      id: "secret-a",
      tokenPrefix: "ocoi_abc",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-08-31T00:00:00.000Z",
    },
  ],
};

const endpoint: WebhookEndpointRecord = {
  id: "endpoint-a",
  url: "https://hooks.example.test/opencoi",
  description: "Operations hook",
  eventTypes: ["vendor.created"],
  status: "active",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const delivery: WebhookDeliveryRecord = {
  id: "delivery-a",
  endpointId: endpoint.id,
  endpointUrl: endpoint.url,
  eventId: "event-a",
  eventType: "vendor.created",
  status: "failed",
  attemptCount: 1,
  nextAttemptAt: "2026-08-31T00:00:00.000Z",
  responseStatus: 503,
  responseBodyExcerpt: null,
  errorMessage: null,
  deliveredAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.serviceAccounts.mockResolvedValue([]);
  apiMocks.webhooks.mockResolvedValue({ configured: true, deliveries: [], endpoints: [] });
  apiMocks.createServiceAccount.mockResolvedValue({
    account,
    secret: {
      id: "new-secret",
      token: "ocoi_test_secret",
      tokenPrefix: "ocoi_test",
      expiresAt: null,
    },
    warning: "Shown once",
  });
  apiMocks.revokeServiceAccountSecret.mockResolvedValue(undefined);
  apiMocks.setServiceAccountStatus.mockResolvedValue(undefined);
  apiMocks.setWebhookStatus.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.className = "";
});

describe("IntegrationsPage safety and accessibility", () => {
  it("focus-manages and announces a one-time service-account token", async () => {
    render(<IntegrationsPage />);
    await screen.findByRole("heading", { name: "API & webhooks" });

    fireEvent.change(screen.getByRole("textbox", { name: "Account name" }), {
      target: { value: "Synthetic sync" },
    });
    const create = screen.getByRole("button", { name: "Create & reveal token" });
    create.focus();
    fireEvent.click(create);

    const dialog = await screen.findByRole("dialog", {
      name: "Synthetic sync API token — shown once",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Copy this secret to its approved destination now. OpenCOI stores no retrievable copy and cannot show it again.",
    );
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(within(dialog).getByRole("textbox", { name: "Synthetic sync API token" })).toHaveValue(
      "ocoi_test_secret",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent("Select and copy the full value.");

    const confirm = vi.mocked(window.confirm);
    confirm.mockReturnValue(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalledWith(
      "Close this one-time secret without confirming it was saved? OpenCOI cannot reveal it again.",
    );
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "I saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Account name" })).toHaveFocus();
  });

  it("requires confirmation before destructive integration changes", async () => {
    apiMocks.serviceAccounts.mockResolvedValue([account]);
    apiMocks.webhooks.mockResolvedValue({
      configured: true,
      deliveries: [delivery],
      endpoints: [endpoint],
    });
    const confirm = vi.mocked(window.confirm);
    confirm.mockReturnValue(false);
    render(<IntegrationsPage />);

    const revoke = await screen.findByRole("button", {
      name: "Revoke credential ocoi_abc for ERP sync",
    });
    const disableAccount = screen.getByRole("button", { name: "Disable service account ERP sync" });
    const disableWebhook = screen.getByRole("button", {
      name: "Disable webhook Operations hook",
    });
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();

    fireEvent.click(revoke);
    fireEvent.click(disableAccount);
    fireEvent.click(disableWebhook);
    expect(apiMocks.revokeServiceAccountSecret).not.toHaveBeenCalled();
    expect(apiMocks.setServiceAccountStatus).not.toHaveBeenCalled();
    expect(apiMocks.setWebhookStatus).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(revoke);
    await waitFor(() =>
      expect(apiMocks.revokeServiceAccountSecret).toHaveBeenCalledWith("account-a", "secret-a"),
    );
    await waitFor(() => expect(disableAccount).toBeEnabled());
    fireEvent.click(disableAccount);
    await waitFor(() =>
      expect(apiMocks.setServiceAccountStatus).toHaveBeenCalledWith("account-a", "disabled"),
    );
    await waitFor(() => expect(disableWebhook).toBeEnabled());
    fireEvent.click(disableWebhook);
    await waitFor(() =>
      expect(apiMocks.setWebhookStatus).toHaveBeenCalledWith("endpoint-a", "disabled"),
    );
  });
});
