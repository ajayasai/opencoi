import type {
  AuditRecord,
  CertificateCorrectionInput,
  CertificateRecord,
  CertificateRequestRecord,
  DashboardData,
  ExceptionRecord,
  OidcStatus,
  PublicUploadContext,
  ReminderRecord,
  ReminderRunResult,
  ServiceAccountRecord,
  ServiceAccountScope,
  SessionUser,
  VendorDetail,
  VendorSummary,
  VendorType,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "./types";

let csrfToken = "";

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface ApiEnvelope<T> {
  data: T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken && !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Request failed" }));
    throw new ApiError(
      body.error ?? body.message ?? "Request failed",
      response.status,
      body.details,
    );
  }

  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as ApiEnvelope<T>;
  return body.data;
}

async function download(path: string): Promise<Blob> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Download failed" }));
    throw new ApiError(
      body.error ?? body.message ?? "Download failed",
      response.status,
      body.details,
    );
  }
  return response.blob();
}

export const api = {
  setCsrf(token: string) {
    csrfToken = token;
  },

  async me() {
    const user = await request<SessionUser>("/api/auth/me");
    csrfToken = user.csrfToken;
    return user;
  },

  async login(email: string, password: string, organizationSlug?: string) {
    const user = await request<SessionUser>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, ...(organizationSlug ? { organizationSlug } : {}) }),
    });
    csrfToken = user.csrfToken;
    return user;
  },

  async logout() {
    await request<void>("/api/auth/logout", { method: "POST" });
    csrfToken = "";
  },

  oidcStatus: () => request<OidcStatus>("/api/auth/oidc/config"),
  beginOidcLogin: () =>
    request<{ authorizationUrl: string; expiresAt: string }>("/api/auth/oidc/start", {
      method: "POST",
      body: "{}",
    }),

  dashboard: () => request<DashboardData>("/api/dashboard"),
  vendors: (query = "") => request<VendorSummary[]>(`/api/vendors${query ? `?${query}` : ""}`),
  vendor: (id: string) => request<VendorDetail>(`/api/vendors/${id}`),
  createVendor: (input: Record<string, unknown>) =>
    request<VendorDetail>("/api/vendors", { method: "POST", body: JSON.stringify(input) }),
  updateVendor: (id: string, input: Record<string, unknown>) =>
    request<VendorDetail>(`/api/vendors/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  vendorTypes: () => request<VendorType[]>("/api/vendor-types"),
  createVendorType: (input: Record<string, unknown>) =>
    request<VendorType>("/api/vendor-types", { method: "POST", body: JSON.stringify(input) }),
  publishRequirements: (id: string, input: Record<string, unknown>) =>
    request<VendorType>(`/api/vendor-types/${id}/requirements`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  certificate: (id: string) => request<CertificateRecord>(`/api/certificates/${id}`),
  evidenceBundle: (id: string) => download(`/api/certificates/${id}/evidence-bundle`),
  confirmCertificate: (id: string, corrections?: CertificateCorrectionInput) =>
    request<CertificateRecord>(`/api/certificates/${id}/confirmation`, {
      method: "PUT",
      body: JSON.stringify({ confirmed: true, ...(corrections ? { corrections } : {}) }),
    }),
  rejectCertificate: (id: string, reason: string) =>
    request<CertificateRecord>(`/api/certificates/${id}/rejection`, {
      method: "PUT",
      body: JSON.stringify({ reason }),
    }),
  uploadCertificate: async (vendorId: string, file: File, metadata: Record<string, unknown>) => {
    const body = new FormData();
    body.append("document", file);
    body.append("metadata", JSON.stringify(metadata));
    return request<CertificateRecord>(`/api/vendors/${vendorId}/certificates`, {
      method: "POST",
      body,
    });
  },

  createUploadLink: (vendorId: string, ttlDays = 14) =>
    request<{ id: string; url: string; expiresAt: string }>(
      `/api/vendors/${vendorId}/upload-links`,
      {
        method: "POST",
        body: JSON.stringify({ ttlDays }),
      },
    ),
  certificateRequests: (vendorId: string) =>
    request<{ requests: CertificateRequestRecord[]; smtpConfigured: boolean }>(
      `/api/vendors/${vendorId}/certificate-requests`,
    ),
  createCertificateRequest: (
    vendorId: string,
    input: {
      kind: "initial" | "renewal";
      deliveryMethod: "manual" | "smtp";
      recipientName?: string | null;
      recipientEmail?: string | null;
      sourceCertificateId?: string | null;
      ttlDays: number;
    },
  ) =>
    request<{
      request: CertificateRequestRecord;
      uploadUrl: string | null;
      disclosure: string;
    }>(`/api/vendors/${vendorId}/certificate-requests`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelCertificateRequest: (requestId: string) =>
    request<CertificateRequestRecord>(`/api/certificate-requests/${requestId}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  revokeUploadLink: (id: string) =>
    request<void>(`/api/upload-links/${id}/revoke`, { method: "POST", body: "{}" }),

  exceptions: () => request<ExceptionRecord[]>("/api/exceptions"),
  requestException: (input: Record<string, unknown>) =>
    request<ExceptionRecord>("/api/exceptions", { method: "POST", body: JSON.stringify(input) }),
  decideException: (id: string, input: Record<string, unknown>) =>
    request<ExceptionRecord>(`/api/exceptions/${id}/decision`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  audit: () => request<AuditRecord[]>("/api/audit"),

  reminders: () => request<ReminderRecord[]>("/api/reminders"),
  runReminders: () =>
    request<ReminderRunResult>("/api/reminders/run", {
      method: "POST",
      body: "{}",
    }),

  serviceAccounts: () => request<ServiceAccountRecord[]>("/api/integrations/service-accounts"),
  createServiceAccount: (input: {
    name: string;
    description?: string | null;
    scopes: ServiceAccountScope[];
    secretExpiresAt?: string | null;
  }) =>
    request<{
      account: ServiceAccountRecord;
      secret: { id: string; token: string; tokenPrefix: string; expiresAt: string | null };
      warning: string;
    }>("/api/integrations/service-accounts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rotateServiceAccount: (accountId: string) =>
    request<{
      secret: { id: string; token: string; tokenPrefix: string; expiresAt: string | null };
      warning: string;
    }>(`/api/integrations/service-accounts/${accountId}/rotate`, {
      method: "POST",
      body: "{}",
    }),
  setServiceAccountStatus: (accountId: string, status: "active" | "disabled") =>
    request<void>(`/api/integrations/service-accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  revokeServiceAccountSecret: (accountId: string, secretId: string) =>
    request<void>(`/api/integrations/service-accounts/${accountId}/secrets/${secretId}/revoke`, {
      method: "POST",
      body: "{}",
    }),
  webhooks: () =>
    request<{
      endpoints: WebhookEndpointRecord[];
      deliveries: WebhookDeliveryRecord[];
      configured: boolean;
    }>("/api/integrations/webhooks"),
  createWebhook: (input: { url: string; description?: string | null; eventTypes: string[] }) =>
    request<{
      endpoint: WebhookEndpointRecord;
      signingSecret: string;
      warning: string;
    }>("/api/integrations/webhooks", { method: "POST", body: JSON.stringify(input) }),
  setWebhookStatus: (endpointId: string, status: "active" | "disabled") =>
    request<void>(`/api/integrations/webhooks/${endpointId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  replayWebhookDelivery: (deliveryId: string) =>
    request<{ status: "pending" }>(`/api/integrations/webhook-deliveries/${deliveryId}/replay`, {
      method: "POST",
      body: "{}",
    }),

  publicUploadContext: (token: string) =>
    request<PublicUploadContext>(`/api/public/upload/${encodeURIComponent(token)}`),
  publicUpload: async (token: string, file: File, metadata: Record<string, unknown>) => {
    const body = new FormData();
    body.append("document", file);
    body.append("metadata", JSON.stringify(metadata));
    return request<{ receiptId: string; uploadedAt: string }>(
      `/api/public/upload/${encodeURIComponent(token)}`,
      { method: "POST", body },
    );
  },
};
