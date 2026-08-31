import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const AUDIT_HASH_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);

export type AuditActorType = "user" | "vendor" | "system";

export interface AppendAuditEventInput {
  id?: string;
  actorType: AuditActorType;
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  occurredAt?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}

export interface AuditEventRow {
  id: string;
  organization_id: string;
  sequence_number: number;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata_json: string;
  previous_hash: string;
  event_hash: string;
}

export interface AuditChainVerification {
  valid: boolean;
  checkedEvents: number;
  error?: string;
  sequenceNumber?: number;
}

type AuditActorRow = Pick<AuditEventRow, "actor_type" | "actor_user_id" | "metadata_json">;

export const parseAuditMetadata = (metadataJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Build the actor label shown in audit and activity views without losing API attribution. */
export const auditActorLabel = (
  row: AuditActorRow,
  names: { userName?: string; serviceAccountName?: string } = {},
): string => {
  if (row.actor_user_id) return names.userName ?? `User ${row.actor_user_id}`;
  if (row.actor_type === "vendor") return "Vendor uploader";
  const serviceAccountId = parseAuditMetadata(row.metadata_json).serviceAccountId;
  if (typeof serviceAccountId === "string" && serviceAccountId.length > 0) {
    return names.serviceAccountName
      ? `Service account: ${names.serviceAccountName}`
      : `Service account ${serviceAccountId}`;
  }
  return "OpenCOI";
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const normalizeJson = (value: unknown): JsonValue => {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === undefined) {
    return {};
  }
  return JSON.parse(serialized) as JsonValue;
};

const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`)
    .join(",")}}`;
};

const hashEvent = (event: {
  organizationId: string;
  sequenceNumber: number;
  id: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  occurredAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: JsonValue;
  previousHash: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalize({
        version: AUDIT_HASH_VERSION,
        organizationId: event.organizationId,
        sequenceNumber: event.sequenceNumber,
        id: event.id,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        occurredAt: event.occurredAt,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: event.metadata,
        previousHash: event.previousHash,
      }),
      "utf8",
    )
    .digest("hex");

const withImmediateTransaction = <T>(database: DatabaseSync, work: () => T): T => {
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

/** Append one immutable, organization-scoped event to its SHA-256 hash chain. */
export const appendAuditEvent = (
  database: DatabaseSync,
  organizationId: string,
  input: AppendAuditEventInput,
): AuditEventRow => {
  if (!organizationId) {
    throw new TypeError("organizationId is required");
  }
  if (!input.action.trim() || !input.entityType.trim()) {
    throw new TypeError("Audit action and entityType are required");
  }

  return withImmediateTransaction(database, () => {
    const previous = database
      .prepare(
        `SELECT sequence_number, event_hash FROM audit_events
         WHERE organization_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      )
      .get(organizationId) as { sequence_number: number; event_hash: string } | undefined;
    const sequenceNumber = (previous?.sequence_number ?? 0) + 1;
    const previousHash = previous?.event_hash ?? GENESIS_HASH;
    const id = input.id ?? randomUUID();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const actorUserId = input.actorUserId ?? null;
    const entityId = input.entityId ?? null;
    const ipAddress = input.ipAddress ?? null;
    const userAgent = input.userAgent ?? null;
    const metadata = normalizeJson(input.metadata);
    const eventHash = hashEvent({
      organizationId,
      sequenceNumber,
      id,
      actorType: input.actorType,
      actorUserId,
      action: input.action.trim(),
      entityType: input.entityType.trim(),
      entityId,
      occurredAt,
      ipAddress,
      userAgent,
      metadata,
      previousHash,
    });
    database
      .prepare(
        `INSERT INTO audit_events
          (id, organization_id, sequence_number, actor_type, actor_user_id, action,
           entity_type, entity_id, occurred_at, ip_address, user_agent, metadata_json,
           previous_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        organizationId,
        sequenceNumber,
        input.actorType,
        actorUserId,
        input.action.trim(),
        input.entityType.trim(),
        entityId,
        occurredAt,
        ipAddress,
        userAgent,
        canonicalize(metadata),
        previousHash,
        eventHash,
      );
    return database
      .prepare("SELECT * FROM audit_events WHERE organization_id = ? AND id = ?")
      .get(organizationId, id) as unknown as AuditEventRow;
  });
};

export const listAuditEvents = (
  database: DatabaseSync,
  organizationId: string,
  options: { afterSequence?: number; limit?: number } = {},
): AuditEventRow[] => {
  if (!organizationId) {
    throw new TypeError("organizationId is required");
  }
  const afterSequence = Math.max(0, Math.trunc(options.afterSequence ?? 0));
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  return database
    .prepare(
      `SELECT * FROM audit_events
       WHERE organization_id = ? AND sequence_number > ?
       ORDER BY sequence_number LIMIT ?`,
    )
    .all(organizationId, afterSequence, limit) as unknown as AuditEventRow[];
};

/** Recompute every hash and link for exactly one organization. */
export const verifyAuditChain = (
  database: DatabaseSync,
  organizationId: string,
): AuditChainVerification => {
  if (!organizationId) {
    throw new TypeError("organizationId is required");
  }
  const rows = database
    .prepare(
      `SELECT * FROM audit_events
       WHERE organization_id = ? ORDER BY sequence_number`,
    )
    .all(organizationId) as unknown as AuditEventRow[];

  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const row of rows) {
    if (row.sequence_number !== expectedSequence) {
      return {
        valid: false,
        checkedEvents: expectedSequence - 1,
        sequenceNumber: row.sequence_number,
        error: `Expected sequence ${expectedSequence}, found ${row.sequence_number}`,
      };
    }
    if (row.previous_hash !== previousHash) {
      return {
        valid: false,
        checkedEvents: expectedSequence - 1,
        sequenceNumber: row.sequence_number,
        error: "Previous hash does not match",
      };
    }
    let metadata: JsonValue;
    try {
      metadata = normalizeJson(JSON.parse(row.metadata_json) as unknown);
    } catch {
      return {
        valid: false,
        checkedEvents: expectedSequence - 1,
        sequenceNumber: row.sequence_number,
        error: "Metadata is not valid JSON",
      };
    }
    const expectedHash = hashEvent({
      organizationId,
      sequenceNumber: row.sequence_number,
      id: row.id,
      actorType: row.actor_type,
      actorUserId: row.actor_user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      occurredAt: row.occurred_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      metadata,
      previousHash,
    });
    if (row.event_hash !== expectedHash) {
      return {
        valid: false,
        checkedEvents: expectedSequence - 1,
        sequenceNumber: row.sequence_number,
        error: "Event hash does not match event contents",
      };
    }
    previousHash = row.event_hash;
    expectedSequence += 1;
  }

  return { valid: true, checkedEvents: rows.length };
};
