import { randomUUID } from "node:crypto";
import type { OpenCoiDatabase } from "../db.js";
import { hashOpaqueToken, randomToken, verifyOpaqueToken } from "../security.js";

export const SERVICE_ACCOUNT_SCOPES = [
  "vendors:read",
  "vendors:write",
  "requirements:read",
  "compliance:read",
  "events:read",
] as const;

export type ServiceAccountScope = (typeof SERVICE_ACCOUNT_SCOPES)[number];

export interface ServiceAccountRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  scopes_json: string;
  status: "active" | "disabled";
  created_by_user_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ServiceAccountSecretRow {
  id: string;
  organization_id: string;
  service_account_id: string;
  token_hash: string;
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

interface AuthenticationRow extends ServiceAccountSecretRow {
  account_name: string;
  account_description: string | null;
  account_scopes_json: string;
  account_status: ServiceAccountRow["status"];
  account_created_at: string;
  account_updated_at: string;
}

export interface AuthenticatedServiceAccount {
  id: string;
  organizationId: string;
  secretId: string;
  name: string;
  description: string | null;
  scopes: ServiceAccountScope[];
}

export interface IssuedServiceAccountSecret {
  id: string;
  token: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

const transact = <T>(database: OpenCoiDatabase, work: () => T): T => {
  if (database.isTransaction) return work();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
};

const normalizedScopes = (scopes: readonly string[]): ServiceAccountScope[] => {
  const allowed = new Set<string>(SERVICE_ACCOUNT_SCOPES);
  const unique = [...new Set(scopes)].sort();
  if (unique.length === 0 || unique.some((scope) => !allowed.has(scope))) {
    throw new TypeError("At least one valid service-account scope is required");
  }
  return unique as ServiceAccountScope[];
};

const scopesFor = (encoded: string): ServiceAccountScope[] => {
  try {
    const value = JSON.parse(encoded) as unknown;
    return Array.isArray(value) ? normalizedScopes(value.map(String)) : [];
  } catch {
    return [];
  }
};

const issueSecret = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    serviceAccountId: string;
    createdByUserId?: string;
    expiresAt?: string;
    tokenPepper?: string;
    at: string;
  },
): IssuedServiceAccountSecret => {
  const id = randomUUID();
  const token = `ocoi_sk_${id}.${randomToken()}`;
  const tokenPrefix = token.slice(0, 24);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new TypeError("Service-account secret expiration is invalid");
  }
  const normalizedExpiresAt = expiresAt?.toISOString() ?? null;
  database
    .prepare(
      `INSERT INTO service_account_secrets
        (id, organization_id, service_account_id, token_hash, token_prefix, expires_at,
         created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.organizationId,
      input.serviceAccountId,
      hashOpaqueToken(token, input.tokenPepper),
      tokenPrefix,
      normalizedExpiresAt,
      input.createdByUserId ?? null,
      input.at,
    );
  return { id, token, tokenPrefix, expiresAt: normalizedExpiresAt, createdAt: input.at };
};

export const createServiceAccount = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    name: string;
    description?: string;
    scopes: readonly string[];
    createdByUserId?: string;
    secretExpiresAt?: string;
    tokenPepper?: string;
    at?: string;
  },
): { account: ServiceAccountRow; secret: IssuedServiceAccountSecret } =>
  transact(database, () => {
    const id = randomUUID();
    const at = input.at ?? new Date().toISOString();
    const name = input.name.trim();
    if (!name || name.length > 120) throw new TypeError("Service-account name is required");
    const scopes = normalizedScopes(input.scopes);
    database
      .prepare(
        `INSERT INTO service_accounts
          (id, organization_id, name, description, scopes_json, created_by_user_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.organizationId,
        name,
        input.description?.trim() || null,
        JSON.stringify(scopes),
        input.createdByUserId ?? null,
        at,
        at,
      );
    const secret = issueSecret(database, {
      organizationId: input.organizationId,
      serviceAccountId: id,
      createdByUserId: input.createdByUserId,
      expiresAt: input.secretExpiresAt,
      tokenPepper: input.tokenPepper,
      at,
    });
    const account = database
      .prepare("SELECT * FROM service_accounts WHERE organization_id = ? AND id = ?")
      .get(input.organizationId, id) as unknown as ServiceAccountRow;
    return { account, secret };
  });

export const rotateServiceAccountSecret = (
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    serviceAccountId: string;
    createdByUserId?: string;
    expiresAt?: string;
    tokenPepper?: string;
    at?: string;
  },
): IssuedServiceAccountSecret => {
  const account = database
    .prepare("SELECT id FROM service_accounts WHERE organization_id = ? AND id = ?")
    .get(input.organizationId, input.serviceAccountId);
  if (!account) throw new TypeError("Service account does not exist");
  return issueSecret(database, {
    ...input,
    at: input.at ?? new Date().toISOString(),
  });
};

export const revokeServiceAccountSecret = (
  database: OpenCoiDatabase,
  organizationId: string,
  serviceAccountId: string,
  secretId: string,
  at = new Date().toISOString(),
): boolean =>
  Number(
    database
      .prepare(
        `UPDATE service_account_secrets SET revoked_at = ?
         WHERE organization_id = ? AND service_account_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .run(at, organizationId, serviceAccountId, secretId).changes,
  ) === 1;

export const setServiceAccountStatus = (
  database: OpenCoiDatabase,
  organizationId: string,
  serviceAccountId: string,
  status: ServiceAccountRow["status"],
  at = new Date().toISOString(),
): boolean =>
  Number(
    database
      .prepare(
        `UPDATE service_accounts SET status = ?, updated_at = ?
         WHERE organization_id = ? AND id = ?`,
      )
      .run(status, at, organizationId, serviceAccountId).changes,
  ) === 1;

export const listServiceAccounts = (
  database: OpenCoiDatabase,
  organizationId: string,
): Array<
  Omit<ServiceAccountRow, "scopes_json"> & {
    scopes: ServiceAccountScope[];
    secrets: Array<
      Pick<
        ServiceAccountSecretRow,
        "id" | "token_prefix" | "expires_at" | "last_used_at" | "revoked_at" | "created_at"
      >
    >;
  }
> => {
  const accounts = database
    .prepare("SELECT * FROM service_accounts WHERE organization_id = ? ORDER BY name, id")
    .all(organizationId) as unknown as ServiceAccountRow[];
  const secretStatement = database.prepare(
    `SELECT id, token_prefix, expires_at, last_used_at, revoked_at, created_at
     FROM service_account_secrets WHERE organization_id = ? AND service_account_id = ?
     ORDER BY created_at DESC, id`,
  );
  return accounts.map(({ scopes_json: scopesJson, ...account }) => ({
    ...account,
    scopes: scopesFor(scopesJson),
    secrets: secretStatement.all(organizationId, account.id) as unknown as Array<
      Pick<
        ServiceAccountSecretRow,
        "id" | "token_prefix" | "expires_at" | "last_used_at" | "revoked_at" | "created_at"
      >
    >,
  }));
};

const secretIdFromToken = (token: string): string | null => {
  const match =
    /^ocoi_sk_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i.exec(
      token,
    );
  return match?.[1] ?? null;
};

export const authenticateServiceAccount = (
  database: OpenCoiDatabase,
  token: string,
  tokenPepper?: string,
  at = new Date().toISOString(),
): AuthenticatedServiceAccount | null => {
  const secretId = secretIdFromToken(token);
  // Hash every candidate before returning so malformed and unknown credentials
  // do not create a zero-cryptography fast path.
  const candidateHash = hashOpaqueToken(token || "invalid-service-account-token", tokenPepper);
  if (!secretId) return null;
  const row = database
    .prepare(
      `SELECT s.*, a.name AS account_name, a.description AS account_description,
              a.scopes_json AS account_scopes_json, a.status AS account_status,
              a.created_at AS account_created_at, a.updated_at AS account_updated_at
       FROM service_account_secrets s
       JOIN service_accounts a
         ON a.organization_id = s.organization_id AND a.id = s.service_account_id
       WHERE s.id = ? AND s.revoked_at IS NULL
         AND (s.expires_at IS NULL OR julianday(s.expires_at) > julianday(?))
       LIMIT 1`,
    )
    .get(secretId, at) as unknown as AuthenticationRow | undefined;
  if (
    row?.account_status !== "active" ||
    !verifyOpaqueToken(token, row.token_hash, tokenPepper) ||
    candidateHash !== row.token_hash
  ) {
    return null;
  }
  database
    .prepare(
      "UPDATE service_account_secrets SET last_used_at = ? WHERE organization_id = ? AND id = ?",
    )
    .run(at, row.organization_id, row.id);
  database
    .prepare("UPDATE service_accounts SET last_used_at = ? WHERE organization_id = ? AND id = ?")
    .run(at, row.organization_id, row.service_account_id);
  return {
    id: row.service_account_id,
    organizationId: row.organization_id,
    secretId: row.id,
    name: row.account_name,
    description: row.account_description,
    scopes: scopesFor(row.account_scopes_json),
  };
};
