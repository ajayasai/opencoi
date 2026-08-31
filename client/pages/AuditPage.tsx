import { neutralizeCsvInjection } from "@shared/csv";
import { CheckCircle2, Download, Fingerprint, Search, ShieldCheck, ShieldX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  PageLoader,
  Select,
  TextInput,
} from "../components/ui";
import type { AuditRecord } from "../types";
import { formatDate, formatRelativeDate, titleCase } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

function csvCell(value: unknown) {
  const safe = neutralizeCsvInjection(String(value ?? ""));
  return `"${safe.replaceAll('"', '""')}"`;
}

export function AuditPage() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("all");
  const [entity, setEntity] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRecords(await api.audit());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = useMemo(
    () => [...new Set(records.map((record) => record.action))].sort(),
    [records],
  );
  const entities = useMemo(
    () => [...new Set(records.map((record) => record.entityType))].sort(),
    [records],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery =
        !needle ||
        [
          record.actor,
          record.action,
          record.entityType,
          record.entityLabel,
          JSON.stringify(record.metadata),
        ].some((value) => value.toLowerCase().includes(needle));
      return (
        matchesQuery &&
        (action === "all" || record.action === action) &&
        (entity === "all" || record.entityType === entity)
      );
    });
  }, [action, entity, query, records]);

  const chainFailures = records.filter((record) => record.chainValid === false).length;
  const chainVerified = records.filter((record) => record.chainValid === true).length;

  const download = () => {
    const header = [
      "timestamp",
      "actor",
      "action",
      "entity_type",
      "entity_label",
      "chain_valid",
      "metadata",
    ];
    const rows = visible.map((record) => [
      record.createdAt,
      record.actor,
      record.action,
      record.entityType,
      record.entityLabel,
      record.chainValid ?? "",
      JSON.stringify(record.metadata),
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `opencoi-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Audit trail"
        description="An append-only account of document, rule, vendor, link, and exception activity in this workspace."
        actions={
          <Button variant="secondary" onClick={download} disabled={!visible.length}>
            <Download size={16} />
            Export view
          </Button>
        }
      />

      {chainFailures > 0 ? (
        <Callout tone="danger" title="Integrity check needs attention">
          {chainFailures} {chainFailures === 1 ? "record is" : "records are"} not consistent with
          the stored audit chain. Preserve the database and investigate before relying on this
          export.
        </Callout>
      ) : records.length > 0 && chainVerified === records.length ? (
        <Callout tone="success" title="Audit chain is consistent">
          All returned records passed the server’s stored-chain integrity check.
        </Callout>
      ) : records.length > 0 ? (
        <Callout tone="info" title="Integrity status not returned">
          These events are available for review, but the server did not include a chain-verification
          result for every record.
        </Callout>
      ) : null}

      <Card className="directory-card">
        <div className="directory-toolbar audit-toolbar">
          <div className="search-input">
            <Search size={17} />
            <TextInput
              aria-label="Search audit trail"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actor, action, or record"
            />
          </div>
          <div className="filter-row">
            <Select
              aria-label="Filter by action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="all">All actions</option>
              {actions.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by record type"
              value={entity}
              onChange={(event) => setEntity(event.target.value)}
            >
              <option value="all">All record types</option>
              {entities.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="result-summary" aria-live="polite">
          Showing <strong>{visible.length}</strong> of {records.length} events
          {(query || action !== "all" || entity !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setAction("all");
                setEntity("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<Fingerprint size={25} />}
            title={records.length ? "No events match this view" : "No audit events yet"}
            description={
              records.length
                ? "Clear a filter or try another search term."
                : "Workspace activity will be recorded here as users begin managing documents."
            }
          />
        ) : (
          <div className="audit-list">
            {visible.map((record) => (
              <details className="audit-row" key={record.id}>
                <summary>
                  <span
                    className={`audit-row__icon ${record.chainValid === false ? "audit-row__icon--bad" : ""}`}
                  >
                    {record.chainValid === false ? (
                      <ShieldX size={17} />
                    ) : (
                      <ShieldCheck size={17} />
                    )}
                  </span>
                  <span className="audit-row__event">
                    <strong>{titleCase(record.action)}</strong>
                    <span>
                      {record.actor} · {record.entityLabel}
                    </span>
                  </span>
                  <Badge tone="neutral" dot={false}>
                    {titleCase(record.entityType)}
                  </Badge>
                  <span className="audit-row__time">
                    <time dateTime={record.createdAt}>{formatRelativeDate(record.createdAt)}</time>
                    <small>{formatDate(record.createdAt)}</small>
                  </span>
                </summary>
                <div className="audit-detail">
                  <dl>
                    <div>
                      <dt>Event ID</dt>
                      <dd className="mono">{record.id}</dd>
                    </div>
                    <div>
                      <dt>Actor</dt>
                      <dd>{record.actor}</dd>
                    </div>
                    <div>
                      <dt>Record</dt>
                      <dd>
                        {record.entityType} · {record.entityLabel}
                      </dd>
                    </div>
                    <div>
                      <dt>Integrity</dt>
                      <dd>
                        {record.chainValid === false ? (
                          <span className="text-danger">Chain check failed</span>
                        ) : record.chainValid === true ? (
                          <span className="audit-valid">
                            <CheckCircle2 size={14} />
                            Consistent
                          </span>
                        ) : (
                          <span className="text-muted">Not returned</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div>
                    <span>Event metadata</span>
                    <pre>{JSON.stringify(record.metadata, null, 2)}</pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
