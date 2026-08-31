import {
  ArrowRight,
  ClipboardCheck,
  Clock3,
  FileSearch,
  Search,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Callout, Card, EmptyState, PageLoader, Select, TextInput } from "../components/ui";
import type { CertificateRecord, VendorSummary } from "../types";
import { formatDate, formatRelativeDate } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

interface ReviewItem {
  vendor: VendorSummary;
  certificate: CertificateRecord;
}

function ageInDays(value: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
}

export function ReviewsPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [ageFilter, setAgeFilter] = useState("all");
  const [unavailable, setUnavailable] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnavailable(0);
    try {
      const vendors = await api.vendors();
      const candidates = vendors.filter((vendor) => vendor.status === "needs_review");
      const details = await Promise.allSettled(candidates.map((vendor) => api.vendor(vendor.id)));
      const queue: ReviewItem[] = [];
      details.forEach((result, index) => {
        if (result.status === "rejected") {
          setUnavailable((count) => count + 1);
          return;
        }
        const vendor = candidates[index];
        if (!vendor) return;
        result.value.certificates
          .filter((certificate) => certificate.documentStatus === "pending_review")
          .forEach((certificate) => {
            queue.push({ vendor, certificate });
          });
      });
      queue.sort((a, b) => a.certificate.uploadedAt.localeCompare(b.certificate.uploadedAt));
      setItems(queue);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const vendorTypes = useMemo(
    () => [
      ...new Map(
        items.map((item) => [item.vendor.vendorTypeId, item.vendor.vendorTypeName]),
      ).entries(),
    ],
    [items],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter(({ vendor, certificate }) => {
      const age = ageInDays(certificate.uploadedAt);
      const matchesAge =
        ageFilter === "all" ||
        (ageFilter === "today" ? age < 1 : ageFilter === "older" ? age >= 2 : age >= 1 && age < 2);
      const matchesQuery =
        !needle ||
        [
          vendor.legalName,
          vendor.contactEmail,
          certificate.originalFilename,
          certificate.namedInsured,
        ].some((value) => value.toLowerCase().includes(needle));
      return (
        matchesAge && matchesQuery && (typeFilter === "all" || vendor.vendorTypeId === typeFilter)
      );
    });
  }, [ageFilter, items, query, typeFilter]);
  const olderCount = items.filter((item) => ageInDays(item.certificate.uploadedAt) >= 2).length;
  const unknownCount = items.reduce(
    (total, item) =>
      total + item.certificate.findings.filter((finding) => finding.outcome === "UNKNOWN").length,
    0,
  );

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Review queue"
        description="Confirm OCR-assisted fields against the original PDF before OpenCOI treats a document result as reviewed evidence."
      />

      <div className="review-metrics">
        <Card>
          <span>
            <ClipboardCheck size={18} />
          </span>
          <div>
            <strong>{items.length}</strong>
            <small>documents waiting</small>
          </div>
        </Card>
        <Card>
          <span className={olderCount ? "metric-warn" : ""}>
            <Clock3 size={18} />
          </span>
          <div>
            <strong>{olderCount}</strong>
            <small>waiting 2+ days</small>
          </div>
        </Card>
        <Card>
          <span>
            <FileSearch size={18} />
          </span>
          <div>
            <strong>{unknownCount}</strong>
            <small>unknown rule outcomes</small>
          </div>
        </Card>
      </div>

      <Callout tone="warning" title="OCR suggests; a person confirms">
        Compare names, policy dates, limits, insurers, and endorsement evidence with the rendered
        PDF. A certificate is evidence provided by the vendor—not live policy confirmation.
      </Callout>
      {unavailable > 0 && (
        <Callout tone="info" title="Some records were unavailable">
          {unavailable} vendor {unavailable === 1 ? "record could" : "records could"} not be loaded.
          Refresh to try again.
        </Callout>
      )}

      <Card className="directory-card">
        <div className="directory-toolbar">
          <div className="search-input">
            <Search size={17} />
            <TextInput
              aria-label="Search review queue"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search vendor or file name"
            />
          </div>
          <div className="filter-row">
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
            <Select
              aria-label="Filter by queue age"
              value={ageFilter}
              onChange={(event) => setAgeFilter(event.target.value)}
            >
              <option value="all">Any queue age</option>
              <option value="today">Uploaded today</option>
              <option value="yesterday">Waiting 1 day</option>
              <option value="older">Waiting 2+ days</option>
            </Select>
          </div>
        </div>
        <div className="result-summary">
          Showing <strong>{visible.length}</strong> of {items.length} documents
          {(query || typeFilter !== "all" || ageFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setTypeFilter("all");
                setAgeFilter("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<UserCheck size={25} />}
            title={
              items.length ? "No reviews match this view" : "Every extraction has been reviewed"
            }
            description={
              items.length
                ? "Change or clear a filter to see the rest of the queue."
                : "New certificate uploads that need human confirmation will appear here."
            }
          />
        ) : (
          <div className="review-list">
            {visible.map(({ vendor, certificate }) => {
              const age = ageInDays(certificate.uploadedAt);
              const unknowns = certificate.findings.filter(
                (finding) => finding.outcome === "UNKNOWN",
              ).length;
              const extractedFields = certificate.policies.reduce(
                (count, policy) =>
                  count +
                  [
                    policy.insurer,
                    policy.policyNumber,
                    policy.expirationDate,
                    policy.eachOccurrence,
                  ].filter((value) => value !== "" && value !== null && value !== undefined).length,
                0,
              );
              return (
                <article className="review-card" key={certificate.id}>
                  <div className="review-card__file">
                    <span>
                      <Sparkles size={19} />
                    </span>
                    <div>
                      <Badge tone={age >= 2 ? "danger" : age >= 1 ? "warning" : "info"} dot={false}>
                        {age < 1 ? "New" : `${age}d waiting`}
                      </Badge>
                      <h3>{vendor.legalName}</h3>
                      <p>{certificate.originalFilename}</p>
                    </div>
                  </div>
                  <dl className="review-card__facts">
                    <div>
                      <dt>Uploaded</dt>
                      <dd>
                        {formatRelativeDate(certificate.uploadedAt)}
                        <small>{formatDate(certificate.uploadedAt)}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Named insured</dt>
                      <dd>{certificate.namedInsured || "Not extracted"}</dd>
                    </div>
                    <div>
                      <dt>Extraction</dt>
                      <dd>
                        {extractedFields} fields
                        <small>{certificate.policies.length} policy rows</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Rule uncertainty</dt>
                      <dd className={unknowns ? "text-danger" : ""}>
                        {unknowns} unknown<small>Confirm evidence</small>
                      </dd>
                    </div>
                  </dl>
                  <div className="review-card__actions">
                    <span>{vendor.vendorTypeName}</span>
                    <Link
                      className="button button--primary button--md"
                      to={`/certificates/${certificate.id}`}
                    >
                      Start review <ArrowRight size={15} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
