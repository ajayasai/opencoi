import { ArrowRight, CalendarX2, Check, Scale, Search, ShieldAlert, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Modal,
  PageLoader,
  Textarea,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type { ExceptionRecord } from "../types";
import { formatDate, formatRelativeDate, titleCase } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

type ExceptionFilter = "all" | "pending" | "approved" | "rejected" | "closed";
type Decision = "approved" | "rejected";

function exceptionTone(
  status: ExceptionRecord["status"],
): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

export function ExceptionsPage() {
  const [items, setItems] = useState<ExceptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ExceptionFilter>("pending");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ExceptionRecord | null>(null);
  const [decision, setDecision] = useState<Decision>("approved");
  const [reason, setReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const { user } = useAuth();
  const { toast } = useToast();
  const canDecide = user?.role === "owner" || user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await api.exceptions());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      all: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      approved: items.filter((item) => item.status === "approved").length,
      rejected: items.filter((item) => item.status === "rejected").length,
      closed: items.filter((item) => item.status === "expired" || item.status === "revoked").length,
    }),
    [items],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "closed"
          ? ["expired", "revoked"].includes(item.status)
          : item.status === filter);
      const matchesQuery =
        !needle ||
        [item.vendorName, item.coverageType, item.ruleCode, item.reason, item.requestedBy].some(
          (value) => value.toLowerCase().includes(needle),
        );
      return matchesFilter && matchesQuery;
    });
  }, [filter, items, query]);

  const openDecision = (item: ExceptionRecord, nextDecision: Decision) => {
    setSelected(item);
    setDecision(nextDecision);
    setReason("");
    setDecisionError("");
  };

  const submitDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    if (reason.trim().length < 10) {
      setDecisionError("Add a specific decision rationale of at least 10 characters.");
      return;
    }
    setDeciding(true);
    setDecisionError("");
    try {
      const updated = await api.decideException(selected.id, {
        decision,
        decisionReason: reason.trim(),
      });
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelected(null);
      toast(decision === "approved" ? "Exception approved" : "Exception rejected", {
        message: `${updated.vendorName} now reflects the recorded risk decision.`,
      });
    } catch (cause) {
      setDecisionError(errorMessage(cause));
    } finally {
      setDeciding(false);
    }
  };

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Exception decisions"
        description="Review time-bound requests to accept a specific document finding, with a rationale and compensating controls preserved for audit."
      />

      <Callout tone="warning" title="An exception is not proof of coverage">
        Approval accepts a configured rule deficiency for a limited period. It does not change the
        uploaded certificate or verify the policy with an insurer.
      </Callout>

      <Card className="directory-card">
        <div className="tabs-toolbar">
          <div className="tabs" role="tablist" aria-label="Exception status">
            {(["pending", "approved", "rejected", "closed", "all"] as ExceptionFilter[]).map(
              (value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  className={filter === value ? "tab--active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {titleCase(value)}
                  <span>{counts[value]}</span>
                </button>
              ),
            )}
          </div>
          <div className="search-input search-input--compact">
            <Search size={16} />
            <TextInput
              aria-label="Search exceptions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search exceptions"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={filter === "pending" ? <Scale size={25} /> : <CalendarX2 size={25} />}
            title={
              query
                ? "No matching exceptions"
                : filter === "pending"
                  ? "No decisions are waiting"
                  : `No ${filter} exceptions`
            }
            description={
              query
                ? "Try another vendor, rule, or requester."
                : "Exception requests originate from a specific document finding and appear here with their stated rationale."
            }
          />
        ) : (
          <div className="exception-list">
            {visible.map((item) => (
              <article className="exception-card" key={item.id}>
                <header>
                  <div>
                    <Badge tone={exceptionTone(item.status)}>{titleCase(item.status)}</Badge>
                    <span className="mono">{item.ruleCode}</span>
                  </div>
                  <time dateTime={item.requestedAt}>
                    Requested {formatRelativeDate(item.requestedAt)}
                  </time>
                </header>
                <div className="exception-card__body">
                  <div>
                    <span className="section-kicker">{titleCase(item.coverageType)}</span>
                    <h3>
                      <Link to={`/vendors/${item.vendorId}`}>{item.vendorName}</Link>
                    </h3>
                    <blockquote>{item.reason}</blockquote>
                    {item.compensatingControls && (
                      <p>
                        <strong>Compensating controls:</strong> {item.compensatingControls}
                      </p>
                    )}
                  </div>
                  <dl>
                    <div>
                      <dt>Requested by</dt>
                      <dd>{item.requestedBy}</dd>
                    </div>
                    <div>
                      <dt>Exception expires</dt>
                      <dd>
                        {formatDate(item.expiresAt)}
                        <small>{formatRelativeDate(item.expiresAt)}</small>
                      </dd>
                    </div>
                    {item.decidedBy && (
                      <div>
                        <dt>Decided by</dt>
                        <dd>
                          {item.decidedBy}
                          <small>{formatDate(item.decidedAt)}</small>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
                {item.decisionReason && (
                  <div className="decision-note">
                    <strong>Decision rationale</strong>
                    <p>{item.decisionReason}</p>
                  </div>
                )}
                <footer>
                  <Link className="text-link" to={`/vendors/${item.vendorId}`}>
                    Open vendor record <ArrowRight size={14} />
                  </Link>
                  {item.status === "pending" && canDecide && (
                    <div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openDecision(item, "rejected")}
                      >
                        <X size={15} />
                        Reject
                      </Button>
                      <Button size="sm" onClick={() => openDecision(item, "approved")}>
                        <Check size={15} />
                        Approve
                      </Button>
                    </div>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(selected)}
        onClose={() => !deciding && setSelected(null)}
        title="Record exception decision"
        description={
          selected ? `${selected.vendorName} · ${titleCase(selected.coverageType)}` : undefined
        }
        footer={
          <>
            <Button variant="quiet" onClick={() => setSelected(null)} disabled={deciding}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="decision-form"
              variant={decision === "rejected" ? "danger" : "primary"}
              loading={deciding}
            >
              {decision === "approved" ? "Approve exception" : "Reject request"}
            </Button>
          </>
        }
      >
        {selected && (
          <form id="decision-form" className="modal-form" onSubmit={submitDecision}>
            <div className="decision-context">
              <ShieldAlert size={19} />
              <div>
                <span>{selected.ruleCode}</span>
                <strong>{selected.reason}</strong>
                <small>
                  Requested by {selected.requestedBy} · expires {formatDate(selected.expiresAt)}
                </small>
              </div>
            </div>
            <fieldset className="choice-fieldset">
              <legend>Decision</legend>
              <div>
                <label
                  className={
                    decision === "approved" ? "choice-card choice-card--selected" : "choice-card"
                  }
                >
                  <input
                    type="radio"
                    name="decision"
                    value="approved"
                    checked={decision === "approved"}
                    onChange={() => setDecision("approved")}
                  />
                  <Check size={18} />
                  <span>
                    <strong>Approve</strong>
                    <small>Accept this finding until the requested expiration.</small>
                  </span>
                </label>
                <label
                  className={
                    decision === "rejected"
                      ? "choice-card choice-card--selected choice-card--danger"
                      : "choice-card"
                  }
                >
                  <input
                    type="radio"
                    name="decision"
                    value="rejected"
                    checked={decision === "rejected"}
                    onChange={() => setDecision("rejected")}
                  />
                  <X size={18} />
                  <span>
                    <strong>Reject</strong>
                    <small>Leave the document finding unresolved.</small>
                  </span>
                </label>
              </div>
            </fieldset>
            <Field
              label="Decision rationale"
              hint="This note is permanent audit context for the decision."
            >
              <Textarea
                required
                minLength={10}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain the risk judgment and any conditions…"
              />
            </Field>
            {decisionError && (
              <div className="form-error" role="alert">
                {decisionError}
              </div>
            )}
            {decision === "approved" && (
              <Callout tone="warning" title="Time-bound acceptance">
                The exception ends {formatDate(selected.expiresAt)}. The underlying document finding
                remains visible.
              </Callout>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}
