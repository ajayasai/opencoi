import { randomUUID } from "node:crypto";
import type { OpenCoiDatabase } from "../db.js";

export interface DomainEvent<T = unknown> {
  id: string;
  sequence: number;
  type: string;
  occurredAt: string;
  resource: { type: string; id: string | null };
  data: T;
}

interface DomainEventRow {
  id: string;
  organization_id: string;
  sequence_number: number;
  type: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string;
  actor_type: "user" | "service_account" | "system";
  actor_id: string | null;
  occurred_at: string;
}

const eventTypePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export const domainEventFromRow = (row: DomainEventRow): DomainEvent => ({
  id: row.id,
  sequence: row.sequence_number,
  type: row.type,
  occurredAt: row.occurred_at,
  resource: { type: row.resource_type, id: row.resource_id },
  data: JSON.parse(row.payload_json) as unknown,
});

/**
 * Append an event and fan it out to current matching endpoints. Call this inside
 * the same database transaction as the business mutation for transactional
 * outbox semantics.
 */
export const publishDomainEvent = <T>(
  database: OpenCoiDatabase,
  input: {
    organizationId: string;
    type: string;
    resourceType: string;
    resourceId?: string;
    data: T;
    actorType: DomainEventRow["actor_type"];
    actorId?: string;
    at?: string;
    id?: string;
  },
): DomainEvent<T> => {
  if (!eventTypePattern.test(input.type)) throw new TypeError("Domain event type is invalid");
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(input.resourceType)) {
    throw new TypeError("Domain event resource type is invalid");
  }
  const id = input.id ?? randomUUID();
  const at = input.at ?? new Date().toISOString();
  const sequenceRow = database
    .prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM domain_events WHERE organization_id = ?`,
    )
    .get(input.organizationId) as { next_sequence: number };
  const payloadJson = JSON.stringify(input.data);
  database
    .prepare(
      `INSERT INTO domain_events
        (id, organization_id, sequence_number, type, resource_type, resource_id,
         payload_json, actor_type, actor_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.organizationId,
      sequenceRow.next_sequence,
      input.type,
      input.resourceType,
      input.resourceId ?? null,
      payloadJson,
      input.actorType,
      input.actorId ?? null,
      at,
    );
  database
    .prepare(
      `INSERT INTO webhook_deliveries
        (id, organization_id, endpoint_id, event_id, next_attempt_at, created_at, updated_at)
       SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
              substr(lower(hex(randomblob(2))), 2) || '-' ||
              substr('89ab', abs(random()) % 4 + 1, 1) ||
              substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
              e.organization_id, e.id, ?, ?, ?, ?
       FROM webhook_endpoints e
       WHERE e.organization_id = ? AND e.status = 'active'
         AND EXISTS (
           SELECT 1 FROM json_each(e.event_types_json)
           WHERE json_each.value IN ('*', ?)
         )`,
    )
    .run(id, at, at, at, input.organizationId, input.type);
  return {
    id,
    sequence: sequenceRow.next_sequence,
    type: input.type,
    occurredAt: at,
    resource: { type: input.resourceType, id: input.resourceId ?? null },
    data: input.data,
  };
};

export const listDomainEvents = (
  database: OpenCoiDatabase,
  organizationId: string,
  options: { afterSequence?: number; limit?: number } = {},
): { events: DomainEvent[]; hasMore: boolean } => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const afterSequence = options.afterSequence ?? 0;
  const rows = database
    .prepare(
      `SELECT * FROM domain_events
       WHERE organization_id = ? AND sequence_number > ?
       ORDER BY sequence_number, id LIMIT ?`,
    )
    .all(organizationId, afterSequence, limit + 1) as unknown as DomainEventRow[];
  return {
    events: rows.slice(0, limit).map(domainEventFromRow),
    hasMore: rows.length > limit,
  };
};

export const getDomainEvent = (
  database: OpenCoiDatabase,
  organizationId: string,
  eventId: string,
): DomainEvent | null => {
  const row = database
    .prepare("SELECT * FROM domain_events WHERE organization_id = ? AND id = ?")
    .get(organizationId, eventId) as unknown as DomainEventRow | undefined;
  return row ? domainEventFromRow(row) : null;
};
