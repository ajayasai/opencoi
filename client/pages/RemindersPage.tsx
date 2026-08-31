import {
  ArrowRight,
  CalendarCheck2,
  CalendarClock,
  History,
  Mail,
  Search,
  Send,
  TimerReset,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  LifecycleBadge,
  PageLoader,
  Select,
  StatusBadge,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type { ReminderRecord, ReminderRunResult, VendorSummary } from "../types";
import { formatDate, formatRelativeDate } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

type ReminderStage = "expired" | "urgent" | "upcoming" | "watch";

function daysUntil(value: string) {
  const target = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target.getTime() - today) / 86_400_000);
}

function stageFor(days: number): ReminderStage {
  if (days < 0) return "expired";
  if (days <= 7) return "urgent";
  if (days <= 30) return "upcoming";
  return "watch";
}

const stageCopy: Record<
  ReminderStage,
  { label: string; tone: "danger" | "warning" | "info" | "neutral"; note: string }
> = {
  expired: { label: "Expired document", tone: "danger", note: "Follow up now" },
  urgent: { label: "7 days or less", tone: "danger", note: "Final reminder window" },
  upcoming: { label: "8–30 days", tone: "warning", note: "Renewal reminder window" },
  watch: { label: "More than 30 days", tone: "info", note: "Profile reminder window" },
};

function reminderMailto(vendor: VendorSummary, expiration: string) {
  const subject = `Insurance certificate renewal — ${vendor.legalName}`;
  const body = [
    `Hello${vendor.contactName ? ` ${vendor.contactName}` : ""},`,
    "",
    `Our records show the insurance certificate submitted for ${vendor.legalName} has a document expiration date of ${formatDate(expiration)}.`,
    "",
    "Please submit an updated certificate through the secure upload link provided by our team. This request is based on the submitted document and is not a statement about the insurer’s current policy records.",
    "",
    "Thank you.",
  ].join("\n");
  return `mailto:${encodeURIComponent(vendor.contactEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function deliveryTone(
  reminder: ReminderRecord,
): "success" | "danger" | "warning" | "info" | "neutral" {
  if (reminder.status === "sent") return "success";
  if (reminder.status === "failed") return reminder.retryEligible ? "warning" : "danger";
  if (reminder.status === "processing") return "info";
  if (reminder.status === "pending") return "warning";
  return "neutral";
}

function deliveryLabel(reminder: ReminderRecord) {
  if (reminder.status === "sent" && reminder.channel === "in_app") return "Recorded";
  if (reminder.status === "failed" && reminder.retryEligible) return "Retry queued";
  return reminder.status.charAt(0).toUpperCase() + reminder.status.slice(1);
}

function formatTimestamp(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function RemindersPage() {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [history, setHistory] = useState<ReminderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ReminderRunResult | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<ReminderStage | "all">("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const { user } = useAuth();
  const { toast } = useToast();
  const canRun = user?.role === "owner" || user?.role === "admin";

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setError("");
    try {
      const [nextVendors, nextHistory] = await Promise.all([api.vendors(), api.reminders()]);
      setVendors(nextVendors);
      setHistory(nextHistory);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async () => {
    if (
      !window.confirm(
        "Run the reminder cycle now? If SMTP is configured, this can send email to due vendors.",
      )
    ) {
      return;
    }
    setRunning(true);
    setRunError("");
    setLastRun(null);
    try {
      const result = await api.runReminders();
      setLastRun(result);
      await load(false);
      toast("Reminder cycle finished", {
        tone: result.failed > 0 ? "error" : "success",
        message: `${result.created} created · ${result.sent} processed · ${result.failed} failed · ${result.skipped} skipped`,
      });
    } catch (cause) {
      const message = errorMessage(cause);
      setRunError(message);
      toast("Reminder cycle failed", { tone: "error", message });
    } finally {
      setRunning(false);
    }
  };

  const candidates = useMemo(
    () =>
      vendors
        .filter(
          (vendor): vendor is VendorSummary & { reminderExpiration: string } =>
            vendor.reminderEligible && Boolean(vendor.reminderExpiration),
        )
        .map((vendor) => ({
          vendor,
          days: daysUntil(vendor.reminderExpiration),
          stage: stageFor(daysUntil(vendor.reminderExpiration)),
        }))
        .filter((item) => item.days >= -365 && item.days <= item.vendor.expirationWarningDays)
        .sort((a, b) => a.days - b.days),
    [vendors],
  );
  const vendorTypes = useMemo(
    () => [
      ...new Map(
        candidates.map(({ vendor }) => [vendor.vendorTypeId, vendor.vendorTypeName]),
      ).entries(),
    ],
    [candidates],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates.filter((item) => {
      const matchesQuery =
        !needle ||
        [item.vendor.legalName, item.vendor.contactName, item.vendor.contactEmail].some((value) =>
          value?.toLowerCase().includes(needle),
        );
      return (
        matchesQuery &&
        (stage === "all" || item.stage === stage) &&
        (typeFilter === "all" || item.vendor.vendorTypeId === typeFilter)
      );
    });
  }, [candidates, query, stage, typeFilter]);
  const expired = candidates.filter((item) => item.stage === "expired").length;
  const nextSeven = candidates.filter((item) => item.stage === "urgent").length;
  const laterInWindow = candidates.filter((item) => item.days > 7).length;

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Renewal reminders"
        description="Prioritize vendor outreach using expiration dates shown on confirmed certificate documents."
        actions={
          canRun ? (
            <Button variant="secondary" loading={running} onClick={runNow}>
              <Send size={16} /> Run reminder cycle
            </Button>
          ) : undefined
        }
      />

      {runError && (
        <Callout tone="danger" title="Reminder cycle did not finish">
          {runError}
        </Callout>
      )}
      {lastRun && (
        <Callout tone={lastRun.failed > 0 ? "warning" : "success"} title="Reminder cycle completed">
          {lastRun.created} created, {lastRun.sent} processed, {lastRun.failed} failed, and{" "}
          {lastRun.skipped} skipped. Per-reminder results are shown in delivery history.
        </Callout>
      )}

      <div className="review-metrics reminder-metrics">
        <Card>
          <span className={expired ? "metric-danger" : ""}>
            <TimerReset size={18} />
          </span>
          <div>
            <strong>{expired}</strong>
            <small>documents expired</small>
          </div>
        </Card>
        <Card>
          <span className={nextSeven ? "metric-warn" : ""}>
            <CalendarClock size={18} />
          </span>
          <div>
            <strong>{nextSeven}</strong>
            <small>due in 7 days</small>
          </div>
        </Card>
        <Card>
          <span>
            <CalendarCheck2 size={18} />
          </span>
          <div>
            <strong>{laterInWindow}</strong>
            <small>later in profile window</small>
          </div>
        </Card>
      </div>

      <Callout tone="info" title="Reminders follow document dates">
        The renewal worker and this queue use the expiration printed on the last confirmed
        certificate and each vendor type&apos;s configured warning window. Delivery does not verify
        that coverage is active, cancelled, or renewed in an insurer system.
      </Callout>

      <Card className="directory-card">
        <div className="directory-toolbar">
          <div className="search-input">
            <Search size={17} />
            <TextInput
              aria-label="Search reminder queue"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search vendor or contact"
            />
          </div>
          <div className="filter-row">
            <Select
              aria-label="Filter reminder window"
              value={stage}
              onChange={(event) => setStage(event.target.value as ReminderStage | "all")}
            >
              <option value="all">All reminder windows</option>
              <option value="expired">Expired documents</option>
              <option value="urgent">7 days or less</option>
              <option value="upcoming">8–30 days</option>
              <option value="watch">More than 30 days</option>
            </Select>
            <Select
              aria-label="Filter by vendor type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="all">All vendor types</option>
              {vendorTypes.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="result-summary">
          Showing <strong>{visible.length}</strong> of {candidates.length} renewal candidates
          {(query || stage !== "all" || typeFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStage("all");
                setTypeFilter("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck2 size={25} />}
            title={
              candidates.length ? "No reminders match this view" : "No document renewals are due"
            }
            description={
              candidates.length
                ? "Change or clear a filter to see the rest of the queue."
                : "Confirmed documents inside their vendor type's warning window will appear here."
            }
          />
        ) : (
          <div className="reminder-list">
            {visible.map(({ vendor, days, stage: reminderStage }) => {
              const copy = stageCopy[reminderStage];
              return (
                <article className="reminder-row" key={vendor.id}>
                  <div className="reminder-date">
                    <strong>{days < 0 ? Math.abs(days) : days}</strong>
                    <span>{days < 0 ? "days past" : days === 1 ? "day left" : "days left"}</span>
                  </div>
                  <div className="reminder-vendor">
                    <Badge tone={copy.tone} dot={false}>
                      {copy.label}
                    </Badge>
                    <h3>
                      <Link to={`/vendors/${vendor.id}`}>{vendor.legalName}</Link>
                    </h3>
                    <p>
                      {vendor.contactName ? `${vendor.contactName} · ` : ""}
                      {vendor.contactEmail}
                    </p>
                  </div>
                  <div className="reminder-document">
                    <span>Document expiration</span>
                    <strong>{formatDate(vendor.reminderExpiration)}</strong>
                    <small>
                      {copy.note} ({vendor.expirationWarningDays} days) ·{" "}
                      {formatRelativeDate(vendor.reminderExpiration)}
                    </small>
                  </div>
                  <div className="reminder-status">
                    <StatusBadge status={vendor.status} />
                    <LifecycleBadge status={vendor.lifecycleStatus} />
                  </div>
                  <div className="reminder-actions">
                    <a
                      className="button button--secondary button--sm"
                      href={reminderMailto(vendor, vendor.reminderExpiration)}
                    >
                      <Mail size={15} />
                      Email vendor
                    </a>
                    <Link
                      className="row-link"
                      to={`/vendors/${vendor.id}`}
                      aria-label={`Open ${vendor.legalName}`}
                    >
                      <ArrowRight size={17} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <div className="reminder-footer">
          <Send size={16} />
          <p>
            <strong>Automated delivery is deployment-controlled.</strong> Configure the reminder
            worker and SMTP settings on the server. Manual cycle runs are recorded in the audit
            trail; individual attempt and delivery results are shown below.
          </p>
          <Link to="/audit">
            View audit trail <ArrowRight size={14} />
          </Link>
        </div>
      </Card>

      <Card className="reminder-history-card">
        <div className="reminder-history-header">
          <div>
            <span className="section-kicker">Worker results</span>
            <h3>Delivery history</h3>
            <p>Email attempts and in-app reminder records returned by the server.</p>
          </div>
          <Badge tone="neutral" dot={false}>
            Latest {history.length}
          </Badge>
        </div>

        {history.length === 0 ? (
          <EmptyState
            icon={<History size={25} />}
            title="No reminder runs recorded"
            description="The scheduled worker or an authorized manual run will create delivery history here."
          />
        ) : (
          <div className="reminder-history-list">
            {history.map((reminder) => (
              <article className="reminder-history-row" key={reminder.id}>
                <span className="reminder-history-icon">
                  {reminder.channel === "email" ? <Mail size={17} /> : <CalendarCheck2 size={17} />}
                </span>
                <div className="reminder-history-summary">
                  <div>
                    <Badge tone={deliveryTone(reminder)} dot={false}>
                      {deliveryLabel(reminder)}
                    </Badge>
                    <span>{reminder.channel === "email" ? "Email" : "In app"}</span>
                  </div>
                  <h4>
                    <Link to={`/vendors/${reminder.vendorId}`}>{reminder.vendorName}</Link>
                  </h4>
                  <p>{reminder.recipient || "No external recipient"}</p>
                </div>
                <dl className="reminder-history-facts">
                  <div>
                    <dt>Scheduled</dt>
                    <dd>{formatTimestamp(reminder.scheduledFor)}</dd>
                  </div>
                  <div>
                    <dt>Last attempt</dt>
                    <dd>{formatTimestamp(reminder.lastAttemptAt)}</dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{formatTimestamp(reminder.sentAt)}</dd>
                  </div>
                  <div>
                    <dt>Attempts</dt>
                    <dd>{reminder.attemptCount} / 3</dd>
                  </div>
                  <div>
                    <dt>Next attempt</dt>
                    <dd>{formatTimestamp(reminder.nextAttemptAt)}</dd>
                  </div>
                </dl>
                {reminder.error && (
                  <div className="reminder-history-error" role="alert">
                    <strong>Delivery error</strong>
                    <span>{reminder.error}</span>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
