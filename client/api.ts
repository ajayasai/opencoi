import type {
  AuditRecord,
  CertificateCorrectionInput,
  CertificateRecord,
  DashboardData,
  ExceptionRecord,
  PublicUploadContext,
  ReminderRecord,
  ReminderRunResult,
  SessionUser,
  VendorDetail,
  VendorSummary,
  VendorType,
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

export const api = {
  setCsrf(token: string) {
    csrfToken = token;
  },

  async me() {
    const user = await request<SessionUser>("/api/auth/me");
    csrfToken = user.csrfToken;
    return user;
  },

  async login(email: string, password: string) {
    const user = await request<SessionUser>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    csrfToken = user.csrfToken;
    return user;
  },

  async logout() {
    await request<void>("/api/auth/logout", { method: "POST" });
    csrfToken = "";
  },

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
