import type { OpenCoiDatabase } from "../db.js";

/** Immutable checksum material for the integration schema v1 migration. */
export const INTEGRATION_SCHEMA_V1_SQL = `
    CREATE TABLE IF NOT EXISTS service_accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_by_user_id TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, name),
      FOREIGN KEY (organization_id, created_by_user_id)
        REFERENCES users(organization_id, id) ON DELETE RESTRICT,
      CHECK (length(name) BETWEEN 1 AND 120)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS service_account_secrets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      token_prefix TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, service_account_id)
        REFERENCES service_accounts(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, created_by_user_id)
        REFERENCES users(organization_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      description TEXT,
      event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
      signing_secret_ciphertext TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, url),
      FOREIGN KEY (organization_id, created_by_user_id)
        REFERENCES users(organization_id, id) ON DELETE RESTRICT,
      CHECK (length(url) BETWEEN 8 AND 2048)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS domain_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
      type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'service_account', 'system')),
      actor_id TEXT,
      occurred_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, sequence_number),
      CHECK (length(type) BETWEEN 3 AND 160),
      CHECK (length(resource_type) BETWEEN 1 AND 80)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead_letter')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      claim_token TEXT,
      claimed_at TEXT,
      response_status INTEGER,
      response_body_excerpt TEXT,
      error_message TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, endpoint_id, event_id),
      FOREIGN KEY (organization_id, endpoint_id)
        REFERENCES webhook_endpoints(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, event_id)
        REFERENCES domain_events(organization_id, id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS api_idempotency_keys (
      organization_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      response_headers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(response_headers_json)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, service_account_id, idempotency_key),
      FOREIGN KEY (organization_id, service_account_id)
        REFERENCES service_accounts(organization_id, id) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS service_account_secrets_lookup_idx
      ON service_account_secrets (id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS domain_events_feed_idx
      ON domain_events (organization_id, sequence_number DESC);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
      ON webhook_deliveries (status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS api_idempotency_expiry_idx
      ON api_idempotency_keys (expires_at);
    CREATE INDEX IF NOT EXISTS vendors_api_cursor_idx
      ON vendors (organization_id, legal_name COLLATE NOCASE, id);

    CREATE TRIGGER IF NOT EXISTS domain_events_no_update
    BEFORE UPDATE ON domain_events
    BEGIN
      SELECT RAISE(ABORT, 'domain events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS domain_events_no_delete
    BEFORE DELETE ON domain_events
    BEGIN
      SELECT RAISE(ABORT, 'domain events are append-only');
    END;
`;

/** Immutable checksum material for the idempotency replay-header upgrade. */
export const IDEMPOTENCY_RESPONSE_HEADERS_MIGRATION_SQL = `
  ALTER TABLE api_idempotency_keys
    ADD COLUMN response_headers_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(response_headers_json));
`;

/**
 * Additive schema for machine-to-machine access and durable integrations.
 * Keeping it additive lets existing self-hosted installations upgrade in place.
 */
export const ensureIntegrationSchema = (database: OpenCoiDatabase): void => {
  database.exec(INTEGRATION_SCHEMA_V1_SQL);

  const idempotencyColumns = database
    .prepare("PRAGMA table_info(api_idempotency_keys)")
    .all() as Array<{ name: string }>;
  if (!idempotencyColumns.some((column) => column.name === "response_headers_json")) {
    database.exec(IDEMPOTENCY_RESPONSE_HEADERS_MIGRATION_SQL);
  }
};
