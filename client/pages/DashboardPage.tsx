import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileWarning,
  History,
  Inbox,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Card, EmptyState, PageLoader } from "../components/ui";
import type { DashboardData } from "../types";
import { formatDate, formatRelativeDate } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

const queueIcons = {
  review: ClipboardCheck,
  deficiency: FileWarning,
  expiration: CalendarClock,
  exception: ShieldCheck,
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.dashboard());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <PageLoader />;
  if (error || !data)
    return <PageError message={error || "No dashboard data was returned."} onRetry={load} />;

  const reviewed = data.stats.meets + data.stats.deficient + data.stats.needsReview;
  const completion = data.stats.totalVendors
    ? Math.round((reviewed / data.stats.totalVendors) * 100)
    : 0;

  return (
    <div className="page-stack">
      <PageHeading
        title="Document compliance at a glance"
        description="A prioritized view of submitted certificates, configured checks, and upcoming document expirations."
        actions={
          <Link className="button button--secondary button--md" to="/vendors">
            View directory <ArrowRight size={16} aria-hidden="true" />
          </Link>
        }
      />

      <section className="metric-grid" aria-label="Portfolio summary">
        <Card className="metric-card metric-card--feature">
          <div className="metric-card__icon">
            <Building2 size={19} />
          </div>
          <div>
            <span>Total vendors</span>
            <strong>{data.stats.totalVendors}</strong>
          </div>
          <small>{completion}% have a document result</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-card__icon metric-card__icon--success">
            <CheckCircle2 size={19} />
          </div>
          <div>
            <span>Meets checks</span>
            <strong>{data.stats.meets}</strong>
          </div>
          <small>Based on submitted documents</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-card__icon metric-card__icon--danger">
            <AlertTriangle size={19} />
          </div>
          <div>
            <span>Deficient</span>
            <strong>{data.stats.deficient}</strong>
          </div>
          <small>Has one or more blocking findings</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-card__icon metric-card__icon--warning">
            <ClipboardCheck size={19} />
          </div>
          <div>
            <span>Needs review</span>
            <strong>{data.stats.needsReview}</strong>
          </div>
          <small>Waiting for human confirmation</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-card__icon metric-card__icon--info">
            <CalendarClock size={19} />
          </div>
          <div>
            <span>Expiring soon</span>
            <strong>{data.stats.expiring}</strong>
          </div>
          <small>Inside the configured warning window</small>
        </Card>
      </section>

      <div className="dashboard-grid">
        <Card className="panel-card">
          <div className="panel-card__header">
            <div>
              <span className="section-kicker">Next up</span>
              <h3>Action queue</h3>
            </div>
            <Badge tone={data.actionQueue.length ? "warning" : "success"}>
              {data.actionQueue.length} open
            </Badge>
          </div>
          {data.actionQueue.length === 0 ? (
            <EmptyState
              icon={<Inbox size={25} />}
              title="The queue is clear"
              description="New reviews, deficiencies, expirations, and exception requests will appear here."
            />
          ) : (
            <div className="action-list">
              {data.actionQueue.map((item) => {
                const Icon = queueIcons[item.kind];
                const destination =
                  item.kind === "exception" ? "/exceptions" : `/vendors/${item.vendorId}`;
                return (
                  <Link className="action-row" to={destination} key={item.id}>
                    <span className={`action-row__icon action-row__icon--${item.kind}`}>
                      <Icon size={18} />
                    </span>
                    <span className="action-row__copy">
                      <span>
                        <strong>{item.title}</strong>
                        <Badge
                          tone={
                            item.priority === "high"
                              ? "danger"
                              : item.priority === "medium"
                                ? "warning"
                                : "neutral"
                          }
                          dot={false}
                        >
                          {item.priority}
                        </Badge>
                      </span>
                      <small>{item.vendorName}</small>
                      <p>{item.detail}</p>
                    </span>
                    <span className="action-row__due">
                      {item.dueAt ? formatRelativeDate(item.dueAt) : "Open"}
                      <ArrowRight size={15} aria-hidden="true" />
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="panel-card activity-card">
          <div className="panel-card__header">
            <div>
              <span className="section-kicker">Traceability</span>
              <h3>Recent activity</h3>
            </div>
            <Link to="/audit" className="text-link">
              Full audit trail <ArrowRight size={14} />
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <EmptyState
              icon={<History size={24} />}
              title="No activity yet"
              description="Document and decision activity will be recorded here."
            />
          ) : (
            <ol className="timeline">
              {data.recentActivity.map((item) => (
                <li key={item.id}>
                  <span className="timeline__mark" aria-hidden="true" />
                  <div>
                    <p>
                      <strong>{item.actor}</strong> {item.action.toLowerCase()} <b>{item.target}</b>
                    </p>
                    <time dateTime={item.createdAt} title={formatDate(item.createdAt)}>
                      {formatRelativeDate(item.createdAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
