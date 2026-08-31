import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  auditActorLabel,
  listAuditEvents,
  parseAuditMetadata,
  verifyAuditChain,
} from "./audit.js";
import { bootstrapOrganization, openDatabase } from "./db.js";

const databases: DatabaseSync[] = [];

const setup = () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  bootstrapOrganization(database, {
    organizationId: "org-a",
    organizationName: "Organization A",
    organizationSlug: "organization-a",
    administratorId: "user-a",
    administratorName: "Admin A",
    administratorEmail: "a@example.test",
    administratorPasswordHash: "test-password-hash",
  });
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO organizations (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("org-b", "organization-b", "Organization B", timestamp, timestamp);
  return database;
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("hash-chained audit events", () => {
  it("labels API events with a resolved service account and an explicit fallback", () => {
    const row = {
      actor_type: "system" as const,
      actor_user_id: null,
      metadata_json: JSON.stringify({ serviceAccountId: "service-account-a" }),
    };

    expect(auditActorLabel(row, { serviceAccountName: "ERP synchronizer" })).toBe(
      "Service account: ERP synchronizer",
    );
    expect(auditActorLabel(row)).toBe("Service account service-account-a");
    expect(parseAuditMetadata("not-json")).toEqual({});
  });

  it("creates an independently verifiable chain for each organization", () => {
    const database = setup();
    const first = appendAuditEvent(database, "org-a", {
      actorType: "system",
      action: "vendor.created",
      entityType: "vendor",
      entityId: "vendor-a",
      metadata: { z: 1, a: { second: true, first: false } },
    });
    const second = appendAuditEvent(database, "org-a", {
      actorType: "user",
      actorUserId: "user-a",
      action: "exception.approved",
      entityType: "exception",
      entityId: "exception-a",
    });
    appendAuditEvent(database, "org-b", {
      actorType: "system",
      action: "organization.created",
      entityType: "organization",
      entityId: "org-b",
    });

    expect(first.sequence_number).toBe(1);
    expect(second.sequence_number).toBe(2);
    expect(second.previous_hash).toBe(first.event_hash);
    expect(verifyAuditChain(database, "org-a")).toEqual({
      valid: true,
      checkedEvents: 2,
    });
    expect(listAuditEvents(database, "org-a")).toHaveLength(2);
    expect(listAuditEvents(database, "org-b")).toHaveLength(1);
  });

  it("prevents update and deletion of audit rows", () => {
    const database = setup();
    const event = appendAuditEvent(database, "org-a", {
      actorType: "system",
      action: "test.created",
      entityType: "test",
    });
    expect(() =>
      database.prepare("UPDATE audit_events SET action = ? WHERE id = ?").run("tampered", event.id),
    ).toThrow(/append-only/);
    expect(() => database.prepare("DELETE FROM audit_events WHERE id = ?").run(event.id)).toThrow(
      /append-only/,
    );
  });

  it("rejects an actor from another organization", () => {
    const database = setup();
    expect(() =>
      appendAuditEvent(database, "org-b", {
        actorType: "user",
        actorUserId: "user-a",
        action: "cross_org.attempted",
        entityType: "vendor",
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(listAuditEvents(database, "org-b")).toEqual([]);
  });

  it("detects historical tampering if database protections are bypassed", () => {
    const database = setup();
    const event = appendAuditEvent(database, "org-a", {
      actorType: "system",
      action: "test.created",
      entityType: "test",
    });
    database.exec("DROP TRIGGER audit_events_no_update");
    database
      .prepare("UPDATE audit_events SET action = ? WHERE organization_id = ? AND id = ?")
      .run("tampered", "org-a", event.id);
    expect(verifyAuditChain(database, "org-a")).toMatchObject({
      valid: false,
      sequenceNumber: 1,
      error: "Event hash does not match event contents",
    });
  });
});
