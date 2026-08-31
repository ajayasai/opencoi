import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATABASE_SCHEMA_VERSION = 4;

/**
 * Canonical foundation schema installed for a new database.
 *
 * This string is also checksum material for the migration ledger. Never edit a
 * released migration in place; add a new ordered migration instead.
 */
export const FOUNDATION_SCHEMA_V4_SQL = `
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(slug) BETWEEN 1 AND 64),
  CHECK (length(name) BETWEEN 1 AND 200)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, email),
  CHECK (length(email) BETWEEN 3 AND 320),
  CHECK (length(display_name) BETWEEN 1 AND 200)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_address TEXT,
  user_agent TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES users(organization_id, id) ON DELETE CASCADE,
  CHECK (length(token_hash) = 64),
  CHECK (length(csrf_token_hash) = 64)
) STRICT;

CREATE TABLE oidc_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email_at_binding TEXT COLLATE NOCASE,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, issuer, subject),
  UNIQUE (organization_id, issuer, user_id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES users(organization_id, id) ON DELETE CASCADE,
  CHECK (length(issuer) BETWEEN 1 AND 2048),
  CHECK (length(subject) BETWEEN 1 AND 512)
) STRICT;

CREATE TABLE oidc_login_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  transaction_token_hash TEXT NOT NULL UNIQUE,
  state_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  CHECK (length(transaction_token_hash) = 64),
  CHECK (length(state_hash) = 64),
  CHECK (length(code_verifier) BETWEEN 43 AND 256),
  CHECK (length(nonce) BETWEEN 32 AND 256)
) STRICT;

CREATE TABLE vendor_types (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name),
  CHECK (length(name) BETWEEN 1 AND 160)
) STRICT;

CREATE TABLE coverage_requirements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_type_id TEXT NOT NULL,
  coverage_type TEXT NOT NULL,
  minimum_each_occurrence INTEGER CHECK (minimum_each_occurrence >= 0),
  minimum_aggregate INTEGER CHECK (minimum_aggregate >= 0),
  minimum_combined_single_limit INTEGER CHECK (minimum_combined_single_limit >= 0),
  maximum_deductible INTEGER CHECK (maximum_deductible >= 0),
  requires_additional_insured INTEGER NOT NULL DEFAULT 0 CHECK (requires_additional_insured IN (0, 1)),
  requires_waiver_of_subrogation INTEGER NOT NULL DEFAULT 0 CHECK (requires_waiver_of_subrogation IN (0, 1)),
  requires_primary_noncontributory INTEGER NOT NULL DEFAULT 0 CHECK (requires_primary_noncontributory IN (0, 1)),
  requires_cancellation_notice INTEGER NOT NULL DEFAULT 0 CHECK (requires_cancellation_notice IN (0, 1)),
  required_endorsements_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_endorsements_json)),
  rule_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rule_config_json)),
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_type_id)
    REFERENCES vendor_types(organization_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_type_id TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  contact_name TEXT,
  contact_email TEXT COLLATE NOCASE,
  contact_phone TEXT,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, external_reference),
  FOREIGN KEY (organization_id, vendor_type_id)
    REFERENCES vendor_types(organization_id, id) ON DELETE RESTRICT,
  CHECK (length(legal_name) BETWEEN 1 AND 240)
) STRICT;

CREATE TABLE upload_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT,
  label TEXT,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT,
  CHECK (length(token_hash) = 64),
  CHECK (use_count <= max_uses)
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  upload_link_id TEXT,
  uploaded_by_user_id TEXT,
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  processing_status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (processing_status IN ('uploaded', 'processing', 'review_required', 'confirmed', 'rejected', 'failed')),
  ocr_text TEXT,
  extraction_json TEXT CHECK (extraction_json IS NULL OR json_valid(extraction_json)),
  extraction_confidence REAL CHECK (extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1),
  processing_error TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, storage_key),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, upload_link_id)
    REFERENCES upload_links(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, uploaded_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reviewed_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  certificate_number TEXT,
  insured_name TEXT,
  producer_name TEXT,
  producer_email TEXT,
  issued_on TEXT,
  earliest_effective_date TEXT,
  earliest_expiration_date TEXT,
  confirmation_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (confirmation_status IN ('draft', 'confirmed', 'superseded', 'rejected')),
  compliance_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (compliance_status IN ('pending_review', 'compliant', 'non_compliant', 'exception', 'expired')),
  confirmed_by_user_id TEXT,
  confirmed_at TEXT,
  superseded_by_certificate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, document_id)
    REFERENCES documents(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, confirmed_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, superseded_by_certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  coverage_type TEXT NOT NULL,
  insurer_name TEXT,
  insurer_naic TEXT,
  policy_number TEXT,
  effective_date TEXT,
  expiration_date TEXT,
  each_occurrence_limit INTEGER CHECK (each_occurrence_limit >= 0),
  aggregate_limit INTEGER CHECK (aggregate_limit >= 0),
  products_completed_operations_limit INTEGER CHECK (products_completed_operations_limit >= 0),
  personal_advertising_injury_limit INTEGER CHECK (personal_advertising_injury_limit >= 0),
  combined_single_limit INTEGER CHECK (combined_single_limit >= 0),
  deductible INTEGER CHECK (deductible >= 0),
  additional_insured INTEGER CHECK (additional_insured IS NULL OR additional_insured IN (0, 1)),
  waiver_of_subrogation INTEGER CHECK (waiver_of_subrogation IS NULL OR waiver_of_subrogation IN (0, 1)),
  primary_noncontributory INTEGER CHECK (primary_noncontributory IS NULL OR primary_noncontributory IN (0, 1)),
  cancellation_notice INTEGER CHECK (cancellation_notice IS NULL OR cancellation_notice IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, certificate_id, coverage_type, policy_number),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE certificate_endorsements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  endorsement_type TEXT NOT NULL,
  form_number TEXT,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'missing', 'unclear')),
  source_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, certificate_id, endorsement_type, form_number),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  requirement_id TEXT,
  category TEXT NOT NULL DEFAULT 'COVERAGE'
    CHECK (category IN ('RULE_PROFILE', 'COVERAGE', 'POLICY_FIELD', 'POLICY_PERIOD', 'LIMIT', 'ENDORSEMENT')),
  evaluation_status TEXT NOT NULL DEFAULT 'FAIL'
    CHECK (evaluation_status IN ('PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE')),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  coverage_type TEXT,
  title TEXT,
  message TEXT NOT NULL,
  expected_json TEXT CHECK (expected_json IS NULL OR json_valid(expected_json)),
  actual_json TEXT CHECK (actual_json IS NULL OR json_valid(actual_json)),
  evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'waived')),
  resolved_by_user_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, requirement_id)
    REFERENCES coverage_requirements(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, resolved_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  finding_id TEXT,
  requested_by_user_id TEXT NOT NULL,
  request_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'expired')),
  decided_by_user_id TEXT,
  decision_note TEXT,
  decided_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, finding_id)
    REFERENCES findings(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, requested_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, decided_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  certificate_id TEXT,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('renewal', 'expiration', 'deficiency', 'exception_expiration')),
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'in_app')),
  recipient TEXT,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  sent_at TEXT,
  error_message TEXT,
  retry_eligible INTEGER NOT NULL DEFAULT 0 CHECK (retry_eligible IN (0, 1)),
  next_attempt_at TEXT,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, dedupe_key),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE certificate_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  upload_link_id TEXT NOT NULL,
  source_certificate_id TEXT,
  submitted_certificate_id TEXT,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('initial', 'renewal')),
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('manual', 'smtp')),
  delivery_status TEXT NOT NULL
    CHECK (delivery_status IN ('manual_ready', 'queued', 'processing', 'accepted', 'failed', 'cancelled', 'superseded', 'expired')),
  recipient_name TEXT,
  recipient_email TEXT COLLATE NOCASE,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'submitted', 'cancelled', 'expired')),
  upload_token_ciphertext TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  accepted_at TEXT,
  delivery_error TEXT,
  created_by_user_id TEXT,
  submitted_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, upload_link_id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, upload_link_id)
    REFERENCES upload_links(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, source_certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, submitted_certificate_id)
    REFERENCES certificates(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT,
  CHECK (delivery_method <> 'smtp' OR recipient_email IS NOT NULL),
  CHECK (delivery_method <> 'manual' OR delivery_status = 'manual_ready'),
  CHECK (delivery_method <> 'smtp' OR delivery_status <> 'manual_ready'),
  CHECK (state <> 'open' OR delivery_status NOT IN ('queued', 'processing') OR upload_token_ciphertext IS NOT NULL),
  CHECK (delivery_status = 'processing' OR (claim_token IS NULL AND claimed_at IS NULL)),
  CHECK (delivery_status <> 'processing' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (state = 'open' OR upload_token_ciphertext IS NULL),
  CHECK (state <> 'submitted' OR (submitted_certificate_id IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK (state = 'submitted' OR (submitted_certificate_id IS NULL AND submitted_at IS NULL)),
  CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (state = 'cancelled' OR cancelled_at IS NULL)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'vendor', 'system')),
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  occurred_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sequence_number),
  UNIQUE (organization_id, event_hash),
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES users(organization_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX sessions_active_lookup_idx
  ON sessions (organization_id, token_hash, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX oidc_transactions_active_idx
  ON oidc_login_transactions (organization_id, transaction_token_hash, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX requirements_vendor_type_idx
  ON coverage_requirements (organization_id, vendor_type_id, is_active);
CREATE UNIQUE INDEX coverage_requirements_active_unique_idx
  ON coverage_requirements (organization_id, vendor_type_id, coverage_type)
  WHERE is_active = 1;
CREATE INDEX vendors_status_idx
  ON vendors (organization_id, status, legal_name);
CREATE INDEX documents_vendor_idx
  ON documents (organization_id, vendor_id, uploaded_at DESC);
CREATE INDEX certificates_vendor_idx
  ON certificates (organization_id, vendor_id, created_at DESC);
CREATE INDEX certificates_expiration_idx
  ON certificates (organization_id, earliest_expiration_date, compliance_status);
CREATE INDEX policies_certificate_idx
  ON policies (organization_id, certificate_id);
CREATE INDEX findings_open_idx
  ON findings (organization_id, certificate_id, status, severity);
CREATE INDEX exceptions_status_idx
  ON exceptions (organization_id, status, expires_at);
CREATE INDEX upload_links_active_idx
  ON upload_links (organization_id, token_hash, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX reminders_due_idx
  ON reminders (organization_id, status, retry_eligible, next_attempt_at, scheduled_for);
CREATE INDEX certificate_requests_vendor_idx
  ON certificate_requests (organization_id, vendor_id, created_at DESC);
CREATE INDEX certificate_requests_delivery_idx
  ON certificate_requests (organization_id, state, delivery_status, next_attempt_at, created_at);
CREATE INDEX audit_events_chain_idx
  ON audit_events (organization_id, sequence_number);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
`;

/** Immutable transition used when upgrading the historical foundation v1 schema. */
export const FOUNDATION_SCHEMA_V1_TO_V2_SQL = `
  ALTER TABLE reminders
    ADD COLUMN retry_eligible INTEGER NOT NULL DEFAULT 0 CHECK (retry_eligible IN (0, 1));
  ALTER TABLE reminders ADD COLUMN next_attempt_at TEXT;
  DROP INDEX IF EXISTS reminders_due_idx;
  CREATE INDEX reminders_due_idx
    ON reminders (organization_id, status, retry_eligible, next_attempt_at, scheduled_for);
  PRAGMA user_version = 2;
`;

/** Immutable transition used when upgrading the historical foundation v2 schema. */
export const FOUNDATION_SCHEMA_V2_TO_V3_SQL = `
  CREATE TABLE oidc_identities (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email_at_binding TEXT COLLATE NOCASE,
    created_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, issuer, subject),
    UNIQUE (organization_id, issuer, user_id),
    FOREIGN KEY (organization_id, user_id)
      REFERENCES users(organization_id, id) ON DELETE CASCADE,
    CHECK (length(issuer) BETWEEN 1 AND 2048),
    CHECK (length(subject) BETWEEN 1 AND 512)
  ) STRICT;
  CREATE TABLE oidc_login_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    transaction_token_hash TEXT NOT NULL UNIQUE,
    state_hash TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, id),
    CHECK (length(transaction_token_hash) = 64),
    CHECK (length(state_hash) = 64),
    CHECK (length(code_verifier) BETWEEN 43 AND 256),
    CHECK (length(nonce) BETWEEN 32 AND 256)
  ) STRICT;
  CREATE INDEX oidc_transactions_active_idx
    ON oidc_login_transactions (organization_id, transaction_token_hash, expires_at)
    WHERE consumed_at IS NULL;
  PRAGMA user_version = 3;
`;

/** Immutable transition used when upgrading the historical foundation v3 schema. */
export const FOUNDATION_SCHEMA_V3_TO_V4_SQL = `
  CREATE TABLE certificate_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    upload_link_id TEXT NOT NULL,
    source_certificate_id TEXT,
    submitted_certificate_id TEXT,
    request_kind TEXT NOT NULL CHECK (request_kind IN ('initial', 'renewal')),
    delivery_method TEXT NOT NULL CHECK (delivery_method IN ('manual', 'smtp')),
    delivery_status TEXT NOT NULL
      CHECK (delivery_status IN ('manual_ready', 'queued', 'processing', 'accepted', 'failed', 'cancelled', 'superseded', 'expired')),
    recipient_name TEXT,
    recipient_email TEXT COLLATE NOCASE,
    state TEXT NOT NULL DEFAULT 'open'
      CHECK (state IN ('open', 'submitted', 'cancelled', 'expired')),
    upload_token_ciphertext TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    claim_token TEXT,
    claimed_at TEXT,
    accepted_at TEXT,
    delivery_error TEXT,
    created_by_user_id TEXT,
    submitted_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, upload_link_id),
    FOREIGN KEY (organization_id, vendor_id)
      REFERENCES vendors(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, upload_link_id)
      REFERENCES upload_links(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, source_certificate_id)
      REFERENCES certificates(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, submitted_certificate_id)
      REFERENCES certificates(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, created_by_user_id)
      REFERENCES users(organization_id, id) ON DELETE RESTRICT,
    CHECK (delivery_method <> 'smtp' OR recipient_email IS NOT NULL),
    CHECK (delivery_method <> 'manual' OR delivery_status = 'manual_ready'),
    CHECK (delivery_method <> 'smtp' OR delivery_status <> 'manual_ready'),
    CHECK (state <> 'open' OR delivery_status NOT IN ('queued', 'processing') OR upload_token_ciphertext IS NOT NULL),
    CHECK (delivery_status = 'processing' OR (claim_token IS NULL AND claimed_at IS NULL)),
    CHECK (delivery_status <> 'processing' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
    CHECK (state = 'open' OR upload_token_ciphertext IS NULL),
    CHECK (state <> 'submitted' OR (submitted_certificate_id IS NOT NULL AND submitted_at IS NOT NULL)),
    CHECK (state = 'submitted' OR (submitted_certificate_id IS NULL AND submitted_at IS NULL)),
    CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL),
    CHECK (state = 'cancelled' OR cancelled_at IS NULL)
  ) STRICT;
  CREATE INDEX certificate_requests_vendor_idx
    ON certificate_requests (organization_id, vendor_id, created_at DESC);
  CREATE INDEX certificate_requests_delivery_idx
    ON certificate_requests (organization_id, state, delivery_status, next_attempt_at, created_at);
  PRAGMA user_version = 4;
`;

export type OpenCoiDatabase = DatabaseSync;

export interface OpenDatabaseOptions {
  timeoutMs?: number;
  initialize?: boolean;
}

const isInMemoryDatabase = (filename: string): boolean =>
  filename === ":memory:" || filename.startsWith("file::memory:");

/** Open a hardened Node 24 SQLite connection and optionally initialize its schema. */
export const openDatabase = (
  filename: string,
  options: OpenDatabaseOptions = {},
): OpenCoiDatabase => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new RangeError("SQLite timeout must be between 0 and 60000 milliseconds");
  }
  if (!isInMemoryDatabase(filename) && !filename.startsWith("file:")) {
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  }
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: timeoutMs,
  });
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
  `);
  if (options.initialize !== false) {
    initializeDatabase(database);
  }
  return database;
};

const withImmediateTransaction = <T>(database: OpenCoiDatabase, work: () => T): T => {
  if (database.isTransaction) {
    return work();
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const initializeDatabase = (database: OpenCoiDatabase): void =>
  withImmediateTransaction(database, () => {
    // Read the version only after holding SQLite's write reservation. The web
    // process and optional workers may start together against the same file;
    // none may act on a stale pre-lock schema version.
    const row = database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    let version = row?.user_version ?? 0;
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than supported version ${DATABASE_SCHEMA_VERSION}`,
      );
    }
    if (version === 0) {
      database.exec(FOUNDATION_SCHEMA_V4_SQL);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      version = DATABASE_SCHEMA_VERSION;
    }
    if (version === 1) {
      database.exec(FOUNDATION_SCHEMA_V1_TO_V2_SQL);
      version = 2;
    }
    if (version === 2) {
      database.exec(FOUNDATION_SCHEMA_V2_TO_V3_SQL);
      version = 3;
    }
    if (version === 3) {
      database.exec(FOUNDATION_SCHEMA_V3_TO_V4_SQL);
    }
  });

const nowIso = (): string => new Date().toISOString();
const newId = (): string => randomUUID();
const asJson = (value: unknown): string => JSON.stringify(value ?? {});

export interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: "owner" | "admin" | "reviewer" | "viewer";
  status: "invited" | "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorTypeRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface VendorRow {
  id: string;
  organization_id: string;
  vendor_type_id: string;
  legal_name: string;
  trade_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  external_reference: string | null;
  status: "active" | "inactive" | "archived";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  organization_id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface OidcIdentityRow {
  id: string;
  organization_id: string;
  issuer: string;
  subject: string;
  user_id: string;
  email_at_binding: string | null;
  created_at: string;
  last_login_at: string;
}

export interface OidcLoginTransactionRow {
  id: string;
  organization_id: string;
  issuer: string;
  transaction_token_hash: string;
  state_hash: string;
  code_verifier: string;
  nonce: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface UploadLinkRow {
  id: string;
  organization_id: string;
  vendor_id: string;
  token_hash: string;
  created_by_user_id: string | null;
  label: string | null;
  expires_at: string;
  max_uses: number;
  use_count: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CertificateRequestRow {
  id: string;
  organization_id: string;
  vendor_id: string;
  upload_link_id: string;
  source_certificate_id: string | null;
  submitted_certificate_id: string | null;
  request_kind: "initial" | "renewal";
  delivery_method: "manual" | "smtp";
  delivery_status:
    | "manual_ready"
    | "queued"
    | "processing"
    | "accepted"
    | "failed"
    | "cancelled"
    | "superseded"
    | "expired";
  recipient_name: string | null;
  recipient_email: string | null;
  state: "open" | "submitted" | "cancelled" | "expired";
  upload_token_ciphertext: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  delivery_error: string | null;
  created_by_user_id: string | null;
  submitted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  organization_id: string;
  vendor_id: string;
  upload_link_id: string | null;
  uploaded_by_user_id: string | null;
  original_filename: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  processing_status: string;
  ocr_text: string | null;
  extraction_json: string | null;
  extraction_confidence: number | null;
  processing_error: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  uploaded_at: string;
  updated_at: string;
}

export interface CertificateRow {
  id: string;
  organization_id: string;
  vendor_id: string;
  document_id: string;
  certificate_number: string | null;
  insured_name: string | null;
  producer_name: string | null;
  producer_email: string | null;
  issued_on: string | null;
  earliest_effective_date: string | null;
  earliest_expiration_date: string | null;
  confirmation_status: string;
  compliance_status: string;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  superseded_by_certificate_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyRow {
  id: string;
  organization_id: string;
  certificate_id: string;
  coverage_type: string;
  insurer_name: string | null;
  insurer_naic: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  each_occurrence_limit: number | null;
  aggregate_limit: number | null;
  combined_single_limit: number | null;
  deductible: number | null;
  additional_insured: number | null;
  waiver_of_subrogation: number | null;
  primary_noncontributory: number | null;
  cancellation_notice: number | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface FindingRow {
  id: string;
  organization_id: string;
  certificate_id: string;
  requirement_id: string | null;
  category:
    | "RULE_PROFILE"
    | "COVERAGE"
    | "POLICY_FIELD"
    | "POLICY_PERIOD"
    | "LIMIT"
    | "ENDORSEMENT";
  evaluation_status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
  code: string;
  severity: "info" | "warning" | "critical";
  coverage_type: string | null;
  title: string | null;
  message: string;
  expected_json: string | null;
  actual_json: string | null;
  evidence_ids_json: string;
  status: "open" | "resolved" | "waived";
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const castRow = <T>(row: Record<string, unknown> | undefined): T | null =>
  (row as T | undefined) ?? null;
const castRows = <T>(rows: Record<string, unknown>[]): T[] => rows as T[];

export interface CreateUserInput {
  id?: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role?: UserRow["role"];
  status?: UserRow["status"];
}

export interface CreateVendorInput {
  id?: string;
  vendorTypeId: string;
  legalName: string;
  tradeName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  externalReference?: string;
  notes?: string;
}

export interface CreateDocumentInput {
  id?: string;
  vendorId: string;
  uploadLinkId?: string;
  uploadedByUserId?: string;
  originalFilename: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
}

export interface CreateCertificateInput {
  id?: string;
  vendorId: string;
  documentId: string;
  certificateNumber?: string;
  insuredName?: string;
  producerName?: string;
  producerEmail?: string;
  issuedOn?: string;
  earliestEffectiveDate?: string;
  earliestExpirationDate?: string;
}

export interface CreatePolicyInput {
  id?: string;
  coverageType: string;
  insurerName?: string;
  insurerNaic?: string;
  policyNumber?: string;
  effectiveDate?: string;
  expirationDate?: string;
  eachOccurrenceLimit?: number;
  aggregateLimit?: number;
  combinedSingleLimit?: number;
  deductible?: number;
  additionalInsured?: boolean;
  waiverOfSubrogation?: boolean;
  primaryNoncontributory?: boolean;
  cancellationNotice?: boolean;
  metadata?: unknown;
}

export interface CreateFindingInput {
  id?: string;
  requirementId?: string;
  category?: FindingRow["category"];
  evaluationStatus?: FindingRow["evaluation_status"];
  code: string;
  severity: FindingRow["severity"];
  coverageType?: string;
  title?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  evidenceIds?: string[];
}

/**
 * Every method on this repository is permanently bound to one organization.
 * All reads, updates, and deletes include organization_id in their predicate;
 * all inserts include it in their values.
 */
export class OrganizationRepository {
  readonly organizationId: string;
  readonly #database: OpenCoiDatabase;

  constructor(database: OpenCoiDatabase, organizationId: string) {
    if (!organizationId) {
      throw new TypeError("organizationId is required");
    }
    this.#database = database;
    this.organizationId = organizationId;
  }

  transaction<T>(work: (repository: OrganizationRepository) => T): T {
    return withImmediateTransaction(this.#database, () => work(this));
  }

  getOrganization(): OrganizationRow | null {
    return castRow<OrganizationRow>(
      this.#database.prepare("SELECT * FROM organizations WHERE id = ?").get(this.organizationId),
    );
  }

  updateOrganization(input: { name?: string; settings?: unknown }): boolean {
    const current = this.getOrganization();
    if (!current) {
      return false;
    }
    const result = this.#database
      .prepare(
        `UPDATE organizations
         SET name = ?, settings_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? current.name,
        input.settings === undefined ? current.settings_json : asJson(input.settings),
        nowIso(),
        this.organizationId,
      );
    return Number(result.changes) === 1;
  }

  createUser(input: CreateUserInput): UserRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.email.trim().toLowerCase(),
        input.displayName.trim(),
        input.passwordHash,
        input.role ?? "viewer",
        input.status ?? "active",
        timestamp,
        timestamp,
      );
    return this.getUser(id) as UserRow;
  }

  getUser(id: string): UserRow | null {
    return castRow<UserRow>(
      this.#database
        .prepare("SELECT * FROM users WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  getUserByEmail(email: string): UserRow | null {
    return castRow<UserRow>(
      this.#database
        .prepare("SELECT * FROM users WHERE organization_id = ? AND email = ? COLLATE NOCASE")
        .get(this.organizationId, email.trim().toLowerCase()),
    );
  }

  listUsers(): UserRow[] {
    return castRows<UserRow>(
      this.#database
        .prepare("SELECT * FROM users WHERE organization_id = ? ORDER BY display_name, id")
        .all(this.organizationId),
    );
  }

  setUserStatus(id: string, status: UserRow["status"]): boolean {
    const result = this.#database
      .prepare("UPDATE users SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
      .run(status, nowIso(), this.organizationId, id);
    return Number(result.changes) === 1;
  }

  createSession(input: {
    id?: string;
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: string;
    ipAddress?: string;
    userAgent?: string;
  }): SessionRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO sessions
          (id, organization_id, user_id, token_hash, csrf_token_hash, expires_at,
           last_seen_at, created_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.userId,
        input.tokenHash,
        input.csrfTokenHash,
        input.expiresAt,
        timestamp,
        timestamp,
        input.ipAddress ?? null,
        input.userAgent ?? null,
      );
    return this.getSessionById(id) as SessionRow;
  }

  getSessionById(id: string): SessionRow | null {
    return castRow<SessionRow>(
      this.#database
        .prepare("SELECT * FROM sessions WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  getActiveSessionByHash(tokenHash: string, at = nowIso()): SessionRow | null {
    return castRow<SessionRow>(
      this.#database
        .prepare(
          `SELECT s.* FROM sessions s
           JOIN users u ON u.organization_id = s.organization_id AND u.id = s.user_id
           WHERE s.organization_id = ? AND s.token_hash = ? AND s.revoked_at IS NULL
             AND s.expires_at > ? AND u.status = 'active'`,
        )
        .get(this.organizationId, tokenHash, at),
    );
  }

  touchSession(id: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE sessions SET last_seen_at = ?
         WHERE organization_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM users u
             WHERE u.organization_id = sessions.organization_id
               AND u.id = sessions.user_id AND u.status = 'active'
           )`,
      )
      .run(at, this.organizationId, id, at);
    return Number(result.changes) === 1;
  }

  revokeSession(id: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .run(at, this.organizationId, id);
    return Number(result.changes) === 1;
  }

  deleteExpiredSessions(at = nowIso()): number {
    const result = this.#database
      .prepare("DELETE FROM sessions WHERE organization_id = ? AND expires_at <= ?")
      .run(this.organizationId, at);
    return Number(result.changes);
  }

  createOidcLoginTransaction(input: {
    id?: string;
    issuer: string;
    transactionTokenHash: string;
    stateHash: string;
    codeVerifier: string;
    nonce: string;
    expiresAt: string;
    createdAt?: string;
  }): OidcLoginTransactionRow {
    const id = input.id ?? newId();
    const createdAt = input.createdAt ?? nowIso();
    this.#database
      .prepare(
        `INSERT INTO oidc_login_transactions
          (id, organization_id, issuer, transaction_token_hash, state_hash,
           code_verifier, nonce, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.issuer,
        input.transactionTokenHash,
        input.stateHash,
        input.codeVerifier,
        input.nonce,
        input.expiresAt,
        createdAt,
      );
    return this.#database
      .prepare("SELECT * FROM oidc_login_transactions WHERE organization_id = ? AND id = ?")
      .get(this.organizationId, id) as unknown as OidcLoginTransactionRow;
  }

  getActiveOidcLoginTransaction(
    transactionTokenHash: string,
    at = nowIso(),
  ): OidcLoginTransactionRow | null {
    return castRow<OidcLoginTransactionRow>(
      this.#database
        .prepare(
          `SELECT * FROM oidc_login_transactions
           WHERE organization_id = ? AND transaction_token_hash = ?
             AND consumed_at IS NULL AND expires_at > ?`,
        )
        .get(this.organizationId, transactionTokenHash, at),
    );
  }

  consumeOidcLoginTransaction(id: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE oidc_login_transactions SET consumed_at = ?
         WHERE organization_id = ? AND id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(at, this.organizationId, id, at);
    return Number(result.changes) === 1;
  }

  deleteExpiredOidcLoginTransactions(at = nowIso()): number {
    const result = this.#database
      .prepare(
        `DELETE FROM oidc_login_transactions
         WHERE organization_id = ? AND expires_at <= ?`,
      )
      .run(this.organizationId, at);
    return Number(result.changes);
  }

  getUserByOidcIdentity(issuer: string, subject: string): UserRow | null {
    return castRow<UserRow>(
      this.#database
        .prepare(
          `SELECT u.* FROM oidc_identities i
           JOIN users u ON u.organization_id = i.organization_id AND u.id = i.user_id
           WHERE i.organization_id = ? AND i.issuer = ? AND i.subject = ?`,
        )
        .get(this.organizationId, issuer, subject),
    );
  }

  getOidcIdentityForUser(issuer: string, userId: string): OidcIdentityRow | null {
    return castRow<OidcIdentityRow>(
      this.#database
        .prepare(
          `SELECT * FROM oidc_identities
           WHERE organization_id = ? AND issuer = ? AND user_id = ?`,
        )
        .get(this.organizationId, issuer, userId),
    );
  }

  bindOidcIdentity(input: {
    id?: string;
    issuer: string;
    subject: string;
    userId: string;
    email?: string;
    at?: string;
  }): boolean {
    const at = input.at ?? nowIso();
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO oidc_identities
          (id, organization_id, issuer, subject, user_id, email_at_binding,
           created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id ?? newId(),
        this.organizationId,
        input.issuer,
        input.subject,
        input.userId,
        input.email?.trim().toLowerCase() ?? null,
        at,
        at,
      );
    return Number(result.changes) === 1;
  }

  touchOidcIdentity(issuer: string, subject: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE oidc_identities SET last_login_at = ?
         WHERE organization_id = ? AND issuer = ? AND subject = ?`,
      )
      .run(at, this.organizationId, issuer, subject);
    return Number(result.changes) === 1;
  }

  createVendorType(input: { id?: string; name: string; description?: string }): VendorTypeRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO vendor_types
          (id, organization_id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.name.trim(),
        input.description ?? null,
        timestamp,
        timestamp,
      );
    return this.getVendorType(id) as VendorTypeRow;
  }

  getVendorType(id: string): VendorTypeRow | null {
    return castRow<VendorTypeRow>(
      this.#database
        .prepare("SELECT * FROM vendor_types WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  listVendorTypes(activeOnly = true): VendorTypeRow[] {
    return castRows<VendorTypeRow>(
      this.#database
        .prepare(
          `SELECT * FROM vendor_types
           WHERE organization_id = ? AND (? = 0 OR is_active = 1)
           ORDER BY name, id`,
        )
        .all(this.organizationId, activeOnly ? 1 : 0),
    );
  }

  createCoverageRequirement(input: {
    id?: string;
    vendorTypeId: string;
    coverageType: string;
    minimumEachOccurrence?: number;
    minimumAggregate?: number;
    minimumCombinedSingleLimit?: number;
    maximumDeductible?: number;
    requiresAdditionalInsured?: boolean;
    requiresWaiverOfSubrogation?: boolean;
    requiresPrimaryNoncontributory?: boolean;
    requiresCancellationNotice?: boolean;
    requiredEndorsements?: unknown[];
    ruleConfig?: unknown;
    notes?: string;
  }): string {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO coverage_requirements
          (id, organization_id, vendor_type_id, coverage_type, minimum_each_occurrence,
           minimum_aggregate, minimum_combined_single_limit, maximum_deductible,
           requires_additional_insured, requires_waiver_of_subrogation,
           requires_primary_noncontributory, requires_cancellation_notice,
           required_endorsements_json, rule_config_json, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorTypeId,
        input.coverageType,
        input.minimumEachOccurrence ?? null,
        input.minimumAggregate ?? null,
        input.minimumCombinedSingleLimit ?? null,
        input.maximumDeductible ?? null,
        input.requiresAdditionalInsured ? 1 : 0,
        input.requiresWaiverOfSubrogation ? 1 : 0,
        input.requiresPrimaryNoncontributory ? 1 : 0,
        input.requiresCancellationNotice ? 1 : 0,
        JSON.stringify(input.requiredEndorsements ?? []),
        asJson(input.ruleConfig),
        input.notes ?? null,
        timestamp,
        timestamp,
      );
    return id;
  }

  listCoverageRequirements(vendorTypeId: string): Record<string, unknown>[] {
    return this.#database
      .prepare(
        `SELECT * FROM coverage_requirements
         WHERE organization_id = ? AND vendor_type_id = ? AND is_active = 1
         ORDER BY coverage_type, id`,
      )
      .all(this.organizationId, vendorTypeId) as Record<string, unknown>[];
  }

  createVendor(input: CreateVendorInput): VendorRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO vendors
          (id, organization_id, vendor_type_id, legal_name, trade_name, contact_name,
           contact_email, contact_phone, external_reference, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorTypeId,
        input.legalName.trim(),
        input.tradeName ?? null,
        input.contactName ?? null,
        input.contactEmail?.trim().toLowerCase() ?? null,
        input.contactPhone ?? null,
        input.externalReference ?? null,
        input.notes ?? null,
        timestamp,
        timestamp,
      );
    return this.getVendor(id) as VendorRow;
  }

  getVendor(id: string): VendorRow | null {
    return castRow<VendorRow>(
      this.#database
        .prepare("SELECT * FROM vendors WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  listVendors(status?: VendorRow["status"]): VendorRow[] {
    return castRows<VendorRow>(
      this.#database
        .prepare(
          `SELECT * FROM vendors
           WHERE organization_id = ? AND (? IS NULL OR status = ?)
           ORDER BY legal_name, id`,
        )
        .all(this.organizationId, status ?? null, status ?? null),
    );
  }

  setVendorStatus(id: string, status: VendorRow["status"]): boolean {
    const result = this.#database
      .prepare("UPDATE vendors SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
      .run(status, nowIso(), this.organizationId, id);
    return Number(result.changes) === 1;
  }

  createUploadLink(input: {
    id?: string;
    vendorId: string;
    tokenHash: string;
    expiresAt: string;
    createdByUserId?: string;
    label?: string;
    maxUses?: number;
  }): UploadLinkRow {
    const id = input.id ?? newId();
    this.#database
      .prepare(
        `INSERT INTO upload_links
          (id, organization_id, vendor_id, token_hash, created_by_user_id, label,
           expires_at, max_uses, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorId,
        input.tokenHash,
        input.createdByUserId ?? null,
        input.label ?? null,
        input.expiresAt,
        input.maxUses ?? 1,
        nowIso(),
      );
    return this.getUploadLink(id) as UploadLinkRow;
  }

  getUploadLink(id: string): UploadLinkRow | null {
    return castRow<UploadLinkRow>(
      this.#database
        .prepare("SELECT * FROM upload_links WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  getActiveUploadLinkByHash(tokenHash: string, at = nowIso()): UploadLinkRow | null {
    return castRow<UploadLinkRow>(
      this.#database
        .prepare(
          `SELECT * FROM upload_links
           WHERE organization_id = ? AND token_hash = ? AND revoked_at IS NULL
             AND expires_at > ? AND use_count < max_uses`,
        )
        .get(this.organizationId, tokenHash, at),
    );
  }

  consumeUploadLink(id: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE upload_links
         SET use_count = use_count + 1, last_used_at = ?
         WHERE organization_id = ? AND id = ? AND revoked_at IS NULL
           AND expires_at > ? AND use_count < max_uses`,
      )
      .run(at, this.organizationId, id, at);
    return Number(result.changes) === 1;
  }

  revokeUploadLink(id: string, at = nowIso()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE upload_links SET revoked_at = ?
         WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .run(at, this.organizationId, id);
    return Number(result.changes) === 1;
  }

  createDocument(input: CreateDocumentInput): DocumentRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO documents
          (id, organization_id, vendor_id, upload_link_id, uploaded_by_user_id,
           original_filename, storage_key, byte_size, sha256, uploaded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorId,
        input.uploadLinkId ?? null,
        input.uploadedByUserId ?? null,
        input.originalFilename,
        input.storageKey,
        input.byteSize,
        input.sha256.toLowerCase(),
        timestamp,
        timestamp,
      );
    return this.getDocument(id) as DocumentRow;
  }

  getDocument(id: string): DocumentRow | null {
    return castRow<DocumentRow>(
      this.#database
        .prepare("SELECT * FROM documents WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  listDocumentsForVendor(vendorId: string): DocumentRow[] {
    return castRows<DocumentRow>(
      this.#database
        .prepare(
          `SELECT * FROM documents
           WHERE organization_id = ? AND vendor_id = ? ORDER BY uploaded_at DESC, id`,
        )
        .all(this.organizationId, vendorId),
    );
  }

  updateDocumentProcessing(
    id: string,
    input: {
      status: DocumentRow["processing_status"];
      ocrText?: string | null;
      extraction?: unknown;
      confidence?: number | null;
      error?: string | null;
      reviewedByUserId?: string;
    },
  ): boolean {
    const timestamp = nowIso();
    const result = this.#database
      .prepare(
        `UPDATE documents
         SET processing_status = ?, ocr_text = COALESCE(?, ocr_text),
             extraction_json = COALESCE(?, extraction_json),
             extraction_confidence = ?, processing_error = ?,
             reviewed_by_user_id = COALESCE(?, reviewed_by_user_id),
             reviewed_at = CASE WHEN ? IS NULL THEN reviewed_at ELSE ? END,
             updated_at = ?
         WHERE organization_id = ? AND id = ?`,
      )
      .run(
        input.status,
        input.ocrText ?? null,
        input.extraction === undefined ? null : asJson(input.extraction),
        input.confidence ?? null,
        input.error ?? null,
        input.reviewedByUserId ?? null,
        input.reviewedByUserId ?? null,
        timestamp,
        timestamp,
        this.organizationId,
        id,
      );
    return Number(result.changes) === 1;
  }

  createCertificate(input: CreateCertificateInput): CertificateRow {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO certificates
          (id, organization_id, vendor_id, document_id, certificate_number, insured_name,
           producer_name, producer_email, issued_on, earliest_effective_date,
           earliest_expiration_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorId,
        input.documentId,
        input.certificateNumber ?? null,
        input.insuredName ?? null,
        input.producerName ?? null,
        input.producerEmail ?? null,
        input.issuedOn ?? null,
        input.earliestEffectiveDate ?? null,
        input.earliestExpirationDate ?? null,
        timestamp,
        timestamp,
      );
    return this.getCertificate(id) as CertificateRow;
  }

  getCertificate(id: string): CertificateRow | null {
    return castRow<CertificateRow>(
      this.#database
        .prepare("SELECT * FROM certificates WHERE organization_id = ? AND id = ?")
        .get(this.organizationId, id),
    );
  }

  listCertificatesForVendor(vendorId: string): CertificateRow[] {
    return castRows<CertificateRow>(
      this.#database
        .prepare(
          `SELECT * FROM certificates
           WHERE organization_id = ? AND vendor_id = ? ORDER BY created_at DESC, id`,
        )
        .all(this.organizationId, vendorId),
    );
  }

  setCertificateStatus(
    id: string,
    input: {
      confirmationStatus: string;
      complianceStatus: string;
      confirmedByUserId?: string;
    },
  ): boolean {
    const timestamp = nowIso();
    const result = this.#database
      .prepare(
        `UPDATE certificates
         SET confirmation_status = ?, compliance_status = ?, confirmed_by_user_id = ?,
             confirmed_at = CASE WHEN ? IS NULL THEN confirmed_at ELSE ? END,
             updated_at = ?
         WHERE organization_id = ? AND id = ?`,
      )
      .run(
        input.confirmationStatus,
        input.complianceStatus,
        input.confirmedByUserId ?? null,
        input.confirmedByUserId ?? null,
        timestamp,
        timestamp,
        this.organizationId,
        id,
      );
    return Number(result.changes) === 1;
  }

  replacePolicies(certificateId: string, policies: CreatePolicyInput[]): PolicyRow[] {
    return this.transaction(() => {
      const certificate = this.getCertificate(certificateId);
      if (!certificate) {
        throw new Error("Certificate does not exist in this organization");
      }
      this.#database
        .prepare("DELETE FROM policies WHERE organization_id = ? AND certificate_id = ?")
        .run(this.organizationId, certificateId);
      const insert = this.#database.prepare(
        `INSERT INTO policies
          (id, organization_id, certificate_id, coverage_type, insurer_name, insurer_naic,
           policy_number, effective_date, expiration_date, each_occurrence_limit,
           aggregate_limit, combined_single_limit, deductible, additional_insured,
           waiver_of_subrogation, primary_noncontributory, cancellation_notice,
           metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const timestamp = nowIso();
      for (const policy of policies) {
        insert.run(
          policy.id ?? newId(),
          this.organizationId,
          certificateId,
          policy.coverageType,
          policy.insurerName ?? null,
          policy.insurerNaic ?? null,
          policy.policyNumber ?? null,
          policy.effectiveDate ?? null,
          policy.expirationDate ?? null,
          policy.eachOccurrenceLimit ?? null,
          policy.aggregateLimit ?? null,
          policy.combinedSingleLimit ?? null,
          policy.deductible ?? null,
          policy.additionalInsured === undefined ? null : policy.additionalInsured ? 1 : 0,
          policy.waiverOfSubrogation === undefined ? null : policy.waiverOfSubrogation ? 1 : 0,
          policy.primaryNoncontributory === undefined
            ? null
            : policy.primaryNoncontributory
              ? 1
              : 0,
          policy.cancellationNotice === undefined ? null : policy.cancellationNotice ? 1 : 0,
          asJson(policy.metadata),
          timestamp,
          timestamp,
        );
      }
      return this.listPolicies(certificateId);
    });
  }

  listPolicies(certificateId: string): PolicyRow[] {
    return castRows<PolicyRow>(
      this.#database
        .prepare(
          `SELECT * FROM policies
           WHERE organization_id = ? AND certificate_id = ? ORDER BY coverage_type, id`,
        )
        .all(this.organizationId, certificateId),
    );
  }

  replaceFindings(certificateId: string, findings: CreateFindingInput[]): FindingRow[] {
    return this.transaction(() => {
      const certificate = this.getCertificate(certificateId);
      if (!certificate) {
        throw new Error("Certificate does not exist in this organization");
      }
      this.#database
        .prepare("DELETE FROM findings WHERE organization_id = ? AND certificate_id = ?")
        .run(this.organizationId, certificateId);
      const insert = this.#database.prepare(
        `INSERT INTO findings
          (id, organization_id, certificate_id, requirement_id, category,
           evaluation_status, code, severity, coverage_type, title, message,
           expected_json, actual_json, evidence_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const timestamp = nowIso();
      for (const finding of findings) {
        insert.run(
          finding.id ?? newId(),
          this.organizationId,
          certificateId,
          finding.requirementId ?? null,
          finding.category ?? "COVERAGE",
          finding.evaluationStatus ?? "FAIL",
          finding.code,
          finding.severity,
          finding.coverageType ?? null,
          finding.title ?? null,
          finding.message,
          finding.expected === undefined ? null : asJson(finding.expected),
          finding.actual === undefined ? null : asJson(finding.actual),
          JSON.stringify(finding.evidenceIds ?? []),
          timestamp,
          timestamp,
        );
      }
      return this.listFindings(certificateId);
    });
  }

  listFindings(certificateId: string): FindingRow[] {
    return castRows<FindingRow>(
      this.#database
        .prepare(
          `SELECT * FROM findings
           WHERE organization_id = ? AND certificate_id = ?
           ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id`,
        )
        .all(this.organizationId, certificateId),
    );
  }

  createException(input: {
    id?: string;
    vendorId: string;
    findingId?: string;
    requestedByUserId: string;
    requestReason: string;
    expiresAt?: string;
  }): string {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO exceptions
          (id, organization_id, vendor_id, finding_id, requested_by_user_id,
           request_reason, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorId,
        input.findingId ?? null,
        input.requestedByUserId,
        input.requestReason,
        input.expiresAt ?? null,
        timestamp,
        timestamp,
      );
    return id;
  }

  listExceptions(status?: string): Record<string, unknown>[] {
    return this.#database
      .prepare(
        `SELECT * FROM exceptions
         WHERE organization_id = ? AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC, id`,
      )
      .all(this.organizationId, status ?? null, status ?? null) as Record<string, unknown>[];
  }

  decideException(input: {
    id: string;
    status: "approved" | "rejected" | "revoked";
    decidedByUserId: string;
    decisionNote?: string;
    expiresAt?: string;
  }): boolean {
    const timestamp = nowIso();
    const result = this.#database
      .prepare(
        `UPDATE exceptions
         SET status = ?, decided_by_user_id = ?, decision_note = ?, decided_at = ?,
             expires_at = COALESCE(?, expires_at), updated_at = ?
         WHERE organization_id = ? AND id = ? AND status IN ('pending', 'approved')`,
      )
      .run(
        input.status,
        input.decidedByUserId,
        input.decisionNote ?? null,
        timestamp,
        input.expiresAt ?? null,
        timestamp,
        this.organizationId,
        input.id,
      );
    return Number(result.changes) === 1;
  }

  createReminder(input: {
    id?: string;
    vendorId: string;
    certificateId?: string;
    reminderType: string;
    channel?: "email" | "in_app";
    recipient?: string;
    scheduledFor: string;
    dedupeKey: string;
    payload?: unknown;
  }): string {
    const id = input.id ?? newId();
    const timestamp = nowIso();
    this.#database
      .prepare(
        `INSERT INTO reminders
          (id, organization_id, vendor_id, certificate_id, reminder_type, channel,
           recipient, scheduled_for, dedupe_key, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.organizationId,
        input.vendorId,
        input.certificateId ?? null,
        input.reminderType,
        input.channel ?? "email",
        input.recipient ?? null,
        input.scheduledFor,
        input.dedupeKey,
        asJson(input.payload),
        timestamp,
        timestamp,
      );
    return id;
  }

  listDueReminders(
    at = nowIso(),
    limit = 100,
    maxAttempts = 1,
    staleBefore?: string,
  ): Record<string, unknown>[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const safeMaxAttempts = Math.max(1, Math.min(10, Math.trunc(maxAttempts)));
    return this.#database
      .prepare(
        `SELECT * FROM reminders
         WHERE organization_id = ? AND (
           (status = 'pending' AND scheduled_for <= ?)
           OR (
             status = 'failed' AND channel = 'email' AND retry_eligible = 1
             AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
             AND attempt_count < ?
           )
           OR (
             status = 'processing' AND last_attempt_at IS NOT NULL
             AND ? IS NOT NULL AND last_attempt_at <= ? AND attempt_count < ?
           )
         )
         ORDER BY scheduled_for, id LIMIT ?`,
      )
      .all(
        this.organizationId,
        at,
        at,
        safeMaxAttempts,
        staleBefore ?? null,
        staleBefore ?? null,
        safeMaxAttempts,
        safeLimit,
      ) as Record<string, unknown>[];
  }

  failExhaustedStaleReminderClaims(input: {
    staleBefore: string;
    maxAttempts: number;
    errorMessage: string;
    at?: string;
  }): number {
    const timestamp = input.at ?? nowIso();
    const safeMaxAttempts = Math.max(1, Math.min(10, Math.trunc(input.maxAttempts)));
    const result = this.#database
      .prepare(
        `UPDATE reminders
         SET status = 'failed', retry_eligible = 0, next_attempt_at = NULL,
             error_message = ?, updated_at = ?
         WHERE organization_id = ? AND status = 'processing'
           AND last_attempt_at IS NOT NULL AND last_attempt_at <= ?
           AND attempt_count >= ?`,
      )
      .run(input.errorMessage, timestamp, this.organizationId, input.staleBefore, safeMaxAttempts);
    return Number(result.changes);
  }

  claimReminder(input: {
    id: string;
    at?: string;
    staleBefore?: string;
    maxAttempts?: number;
  }): { claimedAt: string; attemptNumber: number } | null {
    const timestamp = input.at ?? nowIso();
    const safeMaxAttempts = Math.max(1, Math.min(10, Math.trunc(input.maxAttempts ?? 1)));
    const claimed = this.#database
      .prepare(
        `UPDATE reminders
         SET status = 'processing', attempt_count = attempt_count + 1,
             last_attempt_at = ?, retry_eligible = 0, next_attempt_at = NULL,
             updated_at = ?
         WHERE organization_id = ? AND id = ? AND (
           (status = 'pending' AND scheduled_for <= ?)
           OR (
             status = 'failed' AND retry_eligible = 1
             AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
           )
           OR (
             status = 'processing' AND last_attempt_at IS NOT NULL
             AND ? IS NOT NULL AND last_attempt_at <= ? AND attempt_count < ?
           )
         )
         RETURNING last_attempt_at AS claimed_at, attempt_count AS attempt_number`,
      )
      .get(
        timestamp,
        timestamp,
        this.organizationId,
        input.id,
        timestamp,
        timestamp,
        input.staleBefore ?? null,
        input.staleBefore ?? null,
        safeMaxAttempts,
      ) as { claimed_at: string; attempt_number: number } | undefined;
    return claimed
      ? { claimedAt: claimed.claimed_at, attemptNumber: claimed.attempt_number }
      : null;
  }

  markReminder(input: {
    id: string;
    status: "processing" | "sent" | "cancelled" | "failed";
    errorMessage?: string;
    retryAt?: string;
    claimedAt?: string;
    attemptNumber?: number;
    staleBefore?: string;
    maxAttempts?: number;
    at?: string;
  }): boolean {
    const timestamp = input.at ?? nowIso();
    if (input.status === "processing") {
      return Boolean(
        this.claimReminder({
          id: input.id,
          at: timestamp,
          ...(input.staleBefore ? { staleBefore: input.staleBefore } : {}),
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        }),
      );
    }
    if (input.retryAt) {
      const retryAt = Date.parse(input.retryAt);
      if (
        input.status !== "failed" ||
        !Number.isFinite(retryAt) ||
        retryAt <= Date.parse(timestamp)
      ) {
        throw new RangeError("A reminder retry must be a valid future time on a failed delivery");
      }
    }
    const completion = input.status === "sent" || input.status === "failed";
    if (
      completion &&
      (!input.claimedAt ||
        !Number.isSafeInteger(input.attemptNumber) ||
        (input.attemptNumber ?? 0) < 1)
    ) {
      throw new RangeError("A reminder completion must identify its claimed attempt");
    }
    const result = this.#database
      .prepare(
        `UPDATE reminders
               SET status = ?,
                   sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
                   error_message = CASE WHEN ? = 'sent' THEN NULL ELSE ? END,
                   retry_eligible = CASE WHEN ? = 'failed' AND ? IS NOT NULL THEN 1 ELSE 0 END,
                   next_attempt_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
                   updated_at = ?
               WHERE organization_id = ? AND id = ?
                 AND (
                   (
                     ? IN ('sent', 'failed') AND status = 'processing'
                     AND last_attempt_at = ? AND attempt_count = ?
                   )
                   OR (? = 'cancelled' AND status IN ('pending', 'failed'))
                 )`,
      )
      .run(
        input.status,
        input.status,
        timestamp,
        input.status,
        input.errorMessage ?? null,
        input.status,
        input.retryAt ?? null,
        input.status,
        input.retryAt ?? null,
        timestamp,
        this.organizationId,
        input.id,
        input.status,
        input.claimedAt ?? null,
        input.attemptNumber ?? null,
        input.status,
      );
    return Number(result.changes) === 1;
  }
}

export const createOrganizationRepository = (
  database: OpenCoiDatabase,
  organizationId: string,
): OrganizationRepository => new OrganizationRepository(database, organizationId);

export interface BootstrapOrganizationInput {
  organizationId?: string;
  organizationName: string;
  organizationSlug: string;
  administratorId?: string;
  administratorName: string;
  administratorEmail: string;
  administratorPasswordHash: string;
}

export type BootstrapResult =
  | { status: "created" | "already_configured"; organizationId: string; userId: string }
  | { status: "skipped_nonempty" };

/**
 * One-time system provisioning. It refuses to create a bootstrap administrator
 * after any unrelated user already exists, preventing environment-variable
 * credentials from silently taking over an established installation.
 */
export const bootstrapOrganization = (
  database: OpenCoiDatabase,
  input: BootstrapOrganizationInput,
): BootstrapResult =>
  withImmediateTransaction(database, () => {
    const existing = database
      .prepare(
        `SELECT o.id AS organization_id, u.id AS user_id
         FROM organizations o
         JOIN users u ON u.organization_id = o.id
         WHERE o.slug = ? COLLATE NOCASE AND u.email = ? COLLATE NOCASE`,
      )
      .get(input.organizationSlug, input.administratorEmail.trim().toLowerCase()) as
      | { organization_id: string; user_id: string }
      | undefined;
    if (existing) {
      return {
        status: "already_configured",
        organizationId: existing.organization_id,
        userId: existing.user_id,
      };
    }

    const userCount = database.prepare("SELECT count(*) AS count FROM users").get() as {
      count: number;
    };
    if (userCount.count > 0) {
      return { status: "skipped_nonempty" };
    }

    const organizationId = input.organizationId ?? newId();
    const userId = input.administratorId ?? newId();
    const timestamp = nowIso();
    database
      .prepare(
        `INSERT INTO organizations (id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(organizationId, input.organizationSlug, input.organizationName, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash, role, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?, ?)`,
      )
      .run(
        userId,
        organizationId,
        input.administratorEmail.trim().toLowerCase(),
        input.administratorName,
        input.administratorPasswordHash,
        timestamp,
        timestamp,
      );
    return { status: "created", organizationId, userId };
  });
