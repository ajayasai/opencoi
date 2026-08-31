import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileCheck2,
  FileQuestion,
  FileText,
  Fingerprint,
  Scale,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AppShell } from "../components/AppShell";
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  LifecycleBadge,
  Modal,
  PageLoader,
  StatusBadge,
  Textarea,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type { CertificateRecord, FindingRecord } from "../types";
import { formatDate, formatMoney, titleCase } from "../utils";
import {
  type CertificateCorrectionDraft,
  CertificateCorrectionEditor,
  correctionDraftFromCertificate,
  correctionInputFromDraft,
} from "./CertificateCorrectionEditor";
import "./review.css";

function FindingIcon({ finding }: { finding: FindingRecord }) {
  if (finding.outcome === "PASS") return <Check size={17} />;
  if (finding.outcome === "FAIL") return <X size={17} />;
  if (finding.outcome === "NOT_APPLICABLE") return <FileQuestion size={17} />;
  return <AlertTriangle size={17} />;
}

function ExceptionModal({
  finding,
  vendorId,
  onClose,
  onRequested,
}: {
  finding: FindingRecord | null;
  vendorId: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const [reason, setReason] = useState("");
  const [controls, setControls] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!finding || reason.trim().length < 10 || !expiresAt) {
      setError("Provide a specific reason and expiration date.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.requestException({
        vendorId,
        findingId: finding.id,
        reason: reason.trim(),
        compensatingControls: controls.trim() || null,
        expiresAt,
      });
      onRequested();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The exception could not be requested.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={Boolean(finding)}
      title="Request a risk exception"
      description="The base deficiency remains visible even if an exception is approved."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={loading} onClick={submit}>
            <Scale size={16} /> Submit request
          </Button>
        </>
      }
    >
      <div className="exception-form">
        {finding && (
          <Callout tone="warning" title={finding.message}>
            {finding.expected && <>Required: {finding.expected}. </>}
            {finding.observed && <>Observed: {finding.observed}.</>}
          </Callout>
        )}
        <Field
          label="Business rationale"
          hint="Explain why the organization should accept this specific risk temporarily."
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="At least 10 characters"
          />
        </Field>
        <Field
          label="Compensating controls"
          hint="Optional safeguards, contract terms, or operational restrictions."
        >
          <Textarea value={controls} onChange={(event) => setControls(event.target.value)} />
        </Field>
        <Field label="Exception expires">
          <TextInput
            type="date"
            value={expiresAt}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>
        {error && (
          <Callout tone="danger" title="Request not ready">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

export function CertificateDetailPage() {
  const { certificateId = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [certificate, setCertificate] = useState<CertificateRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exceptionFinding, setExceptionFinding] = useState<FindingRecord | null>(null);
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [correctionDraft, setCorrectionDraft] = useState<CertificateCorrectionDraft | null>(null);
  const [confirmationError, setConfirmationError] = useState("");
  const [rejectionOpen, setRejectionOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectionError, setRejectionError] = useState("");

  useEffect(() => {
    api
      .certificate(certificateId)
      .then((record) => {
        setCertificate(record);
        setCorrectionDraft(
          record.documentStatus === "pending_review"
            ? correctionDraftFromCertificate(record)
            : null,
        );
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Certificate not found."))
      .finally(() => setLoading(false));
  }, [certificateId]);

  if (loading)
    return (
      <AppShell>
        <PageLoader />
      </AppShell>
    );
  if (!certificate || error) {
    return (
      <AppShell>
        <Callout tone="danger" title="Certificate unavailable">
          {error || "Certificate not found."}
        </Callout>
      </AppShell>
    );
  }

  const failures = certificate.findings.filter((finding) => finding.outcome === "FAIL");
  const unknown = certificate.findings.filter((finding) => finding.outcome === "UNKNOWN");
  const passes = certificate.findings.filter((finding) => finding.outcome === "PASS");
  const canReview = user?.role === "owner" || user?.role === "admin" || user?.role === "reviewer";
  const isPending = certificate.documentStatus === "pending_review";
  const isRejected = certificate.documentStatus === "rejected";
  const isConfirmed = certificate.documentStatus === "confirmed";

  const confirmExistingExtraction = async () => {
    if (!sourceReviewed || !correctionDraft || !canReview) return;
    setConfirming(true);
    setConfirmationError("");
    try {
      const corrections = correctionInputFromDraft(correctionDraft);
      const updated = await api.confirmCertificate(certificate.id, corrections);
      setCertificate(updated);
      setCorrectionDraft(null);
      setSourceReviewed(false);
      toast("Certificate confirmed and evaluated", {
        message: "The displayed fields were checked against the published requirement version.",
      });
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : "Try again.");
      toast("Confirmation failed", {
        tone: "error",
        message: cause instanceof Error ? cause.message : "Try again.",
      });
    } finally {
      setConfirming(false);
    }
  };

  const rejectSubmission = async () => {
    if (!canReview || rejectionReason.trim().length < 10) {
      setRejectionError("Provide a specific rejection reason of at least 10 characters.");
      return;
    }
    setRejecting(true);
    setRejectionError("");
    try {
      const updated = await api.rejectCertificate(certificate.id, rejectionReason.trim());
      setCertificate(updated);
      setCorrectionDraft(null);
      setSourceReviewed(false);
      setRejectionOpen(false);
      toast("Submission rejected", {
        message:
          "It was removed from the review queue; the original PDF and decision remain auditable.",
      });
    } catch (cause) {
      setRejectionError(cause instanceof Error ? cause.message : "Try again.");
    } finally {
      setRejecting(false);
    }
  };

  return (
    <AppShell
      actions={
        <a
          className="button button--secondary button--sm"
          href={`/api/certificates/${certificate.id}/download`}
        >
          <Download size={15} /> Download original
        </a>
      }
    >
      <div className="certificate-heading">
        <button type="button" onClick={() => navigate(`/vendors/${certificate.vendorId}`)}>
          <ArrowLeft size={15} /> Vendor record
        </button>
        <div className="certificate-heading__row">
          <div>
            <span>
              {isPending
                ? "Pending vendor extraction"
                : isRejected
                  ? "Rejected vendor submission"
                  : "Confirmed document revision"}
            </span>
            <h2>{certificate.namedInsured || certificate.originalFilename}</h2>
            {isPending ? (
              <p>Uploaded {formatDate(certificate.uploadedAt)} · awaiting human confirmation</p>
            ) : isRejected ? (
              <p>Reviewed and rejected {formatDate(certificate.reviewDecision?.reviewedAt)}</p>
            ) : (
              <p>
                Evaluated {formatDate(certificate.evaluationDate)} against requirement version{" "}
                {certificate.requirementVersion ?? "—"}
              </p>
            )}
          </div>
          <div className="certificate-heading__status">
            {isRejected ? (
              <Badge tone="danger">Rejected</Badge>
            ) : (
              <>
                <StatusBadge status={certificate.checkStatus} />
                <LifecycleBadge status={certificate.lifecycleStatus} />
              </>
            )}
          </div>
        </div>
      </div>

      <Callout
        tone={isRejected ? "danger" : "info"}
        title={
          isPending
            ? "Provisional extraction only"
            : isRejected
              ? "Submission rejected"
              : "What this result means"
        }
      >
        {isPending
          ? "These fields came from a vendor submission and local extraction. They remain unconfirmed and cannot pass a configured rule until an authorized reviewer checks and corrects them."
          : isRejected
            ? certificate.reviewDecision?.reason ||
              "An authorized reviewer rejected this submission. It is not used as current compliance evidence."
            : "OpenCOI compared human-confirmed fields in this uploaded document with your configured requirements. It did not contact the insurer, verify that a policy remains active, interpret policy language, or guarantee coverage."}
      </Callout>

      {isPending && (
        <>
          <section className="pending-confirmation" aria-labelledby="pending-confirmation-title">
            <div className="pending-confirmation__icon">
              <FileCheck2 size={22} />
            </div>
            <div>
              <span>Human review required</span>
              <h3 id="pending-confirmation-title">
                {canReview
                  ? "Correct and confirm the extraction against the original PDF"
                  : "An authorized reviewer must confirm this extraction"}
              </h3>
              <p>
                Use “Download original” above and compare every party, date, policy, exact limit
                label, and endorsement. Blank values remain unknown.
              </p>
            </div>
            {!canReview && <Badge tone="neutral">Read only</Badge>}
          </section>

          {canReview && correctionDraft && (
            <Card className="pending-review-editor">
              <CertificateCorrectionEditor value={correctionDraft} onChange={setCorrectionDraft} />
              {confirmationError && (
                <Callout tone="danger" title="Confirmation not ready">
                  {confirmationError}
                </Callout>
              )}
              <div className="pending-review-editor__footer">
                <label className="confirmation-check">
                  <input
                    type="checkbox"
                    checked={sourceReviewed}
                    onChange={(event) => setSourceReviewed(event.target.checked)}
                  />
                  <span>
                    <Check size={14} />
                  </span>
                  I reviewed every corrected field against the source PDF.
                </label>
                <div>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setRejectionReason("");
                      setRejectionError("");
                      setRejectionOpen(true);
                    }}
                  >
                    <X size={17} /> Reject submission
                  </Button>
                  <Button
                    disabled={!sourceReviewed}
                    loading={confirming}
                    onClick={confirmExistingExtraction}
                  >
                    <ShieldCheck size={17} /> Save corrections & evaluate
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      <div className="certificate-grid">
        <section className="certificate-main">
          <Card className="evaluation-card">
            <header className="section-header">
              <div>
                <span>
                  {isPending
                    ? "Provisional preview"
                    : isRejected
                      ? "Archived preview"
                      : "Explainable decision"}
                </span>
                <h3>
                  {isPending || isRejected
                    ? "Unconfirmed rule outcomes"
                    : "Requirement-by-requirement results"}
                </h3>
              </div>
              <div className="finding-totals">
                <span className="finding-total finding-total--fail">
                  {failures.length} deficient
                </span>
                <span className="finding-total finding-total--unknown">
                  {unknown.length} unknown
                </span>
                <span className="finding-total finding-total--pass">{passes.length} pass</span>
              </div>
            </header>
            <div className="finding-list">
              {certificate.findings.map((finding) => (
                <article
                  className={`finding finding--${finding.outcome.toLowerCase()}`}
                  key={finding.id}
                >
                  <div className="finding__icon">
                    <FindingIcon finding={finding} />
                  </div>
                  <div className="finding__content">
                    <div>
                      <Badge
                        tone={
                          finding.outcome === "PASS"
                            ? "success"
                            : finding.outcome === "FAIL"
                              ? "danger"
                              : "warning"
                        }
                        dot={false}
                      >
                        {finding.outcome.replace("_", " ")}
                      </Badge>
                      <span>{titleCase(finding.coverageType)}</span>
                      <code>{finding.ruleCode}</code>
                    </div>
                    <h4>{finding.message}</h4>
                    {(finding.expected || finding.observed) && (
                      <dl>
                        {finding.expected && (
                          <div>
                            <dt>Required</dt>
                            <dd>{finding.expected}</dd>
                          </div>
                        )}
                        {finding.observed && (
                          <div>
                            <dt>Observed</dt>
                            <dd>{finding.observed}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                  </div>
                  {isConfirmed && canReview && finding.outcome === "FAIL" && !finding.excepted && (
                    <Button variant="quiet" size="sm" onClick={() => setExceptionFinding(finding)}>
                      <Scale size={15} /> Request exception
                    </Button>
                  )}
                  {finding.excepted && <Badge tone="violet">Exception approved</Badge>}
                </article>
              ))}
            </div>
          </Card>

          <Card className="policies-card">
            <header className="section-header">
              <div>
                <span>{isPending || isRejected ? "Submitted extraction" : "Confirmed facts"}</span>
                <h3>
                  {isPending
                    ? "Policies awaiting review"
                    : isRejected
                      ? "Policies from rejected submission"
                      : "Policies shown on document"}
                </h3>
              </div>
            </header>
            <div className="policy-facts-list">
              {certificate.policies.map((policy) => (
                <article key={policy.id ?? `${policy.coverageType}-${policy.policyNumber}`}>
                  <header>
                    <div className="coverage-icon">
                      <ShieldCheck size={18} />
                    </div>
                    <div>
                      <strong>{titleCase(policy.coverageType)}</strong>
                      <span>{policy.insurer || "Insurer not shown"}</span>
                    </div>
                    <code>{policy.policyNumber || "No policy number"}</code>
                  </header>
                  <div className="policy-facts-grid">
                    <div>
                      <span>Effective</span>
                      <strong>{formatDate(policy.effectiveDate)}</strong>
                    </div>
                    <div>
                      <span>Expires</span>
                      <strong>{formatDate(policy.expirationDate)}</strong>
                    </div>
                    {Object.entries(policy.limits ?? {}).length > 0 ? (
                      Object.entries(policy.limits).map(([limitType, amount]) => (
                        <div key={limitType}>
                          <span>{titleCase(limitType)}</span>
                          <strong>{formatMoney(amount, policy.currency)}</strong>
                        </div>
                      ))
                    ) : (
                      <>
                        <div>
                          <span>Each occurrence / claim</span>
                          <strong>{formatMoney(policy.eachOccurrence, policy.currency)}</strong>
                        </div>
                        <div>
                          <span>Aggregate</span>
                          <strong>{formatMoney(policy.aggregate, policy.currency)}</strong>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="policy-indications">
                    {[
                      [policy.additionalInsured, "Additional insured"],
                      [policy.waiverOfSubrogation, "Waiver of subrogation"],
                      [policy.primaryNoncontributory, "Primary & non-contributory"],
                    ].map(([present, label]) => (
                      <span className={present ? "is-present" : ""} key={String(label)}>
                        {present ? <Check size={13} /> : <X size={13} />} {label}
                      </span>
                    ))}
                  </div>
                  {policy.endorsements.length > 0 && (
                    <div className="policy-endorsements">
                      <span>Recorded endorsement evidence</span>
                      <ul>
                        {policy.endorsements.map((endorsement) => (
                          <li
                            key={`${endorsement.name}-${endorsement.formCode ?? ""}-${endorsement.evidenceLevel}`}
                          >
                            <FileCheck2 size={13} />
                            <strong>{endorsement.name}</strong>
                            {endorsement.formCode && <code>{endorsement.formCode}</code>}
                            <Badge
                              tone={
                                endorsement.evidence === "reviewed_document"
                                  ? "success"
                                  : endorsement.evidence === "document"
                                    ? "info"
                                    : "warning"
                              }
                              dot={false}
                            >
                              {titleCase(endorsement.evidenceLevel)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </Card>
        </section>

        <aside className="certificate-aside">
          <Card className="evidence-card">
            <header>
              <FileText size={18} />
              <h3>Evidence record</h3>
            </header>
            <dl>
              <div>
                <dt>Original file</dt>
                <dd>{certificate.originalFilename}</dd>
              </div>
              <div>
                <dt>Uploaded</dt>
                <dd>{formatDate(certificate.uploadedAt)}</dd>
              </div>
              <div>
                <dt>
                  {isPending ? "Review status" : isRejected ? "Review decision" : "Human confirmed"}
                </dt>
                <dd>
                  {isPending
                    ? "Awaiting human confirmation"
                    : isRejected
                      ? `Rejected ${formatDate(certificate.reviewDecision?.reviewedAt)}`
                      : formatDate(certificate.confirmedAt)}
                </dd>
              </div>
              <div>
                <dt>Issue date</dt>
                <dd>{formatDate(certificate.issueDate)}</dd>
              </div>
              <div>
                <dt>Named insured</dt>
                <dd>{certificate.namedInsured || "Not shown"}</dd>
              </div>
              <div>
                <dt>Producer</dt>
                <dd>{certificate.producer || "Not shown"}</dd>
              </div>
              <div>
                <dt>Certificate holder</dt>
                <dd>{certificate.certificateHolder || "Not shown"}</dd>
              </div>
            </dl>
          </Card>
          <Card className="hash-card">
            <Fingerprint size={18} />
            <div>
              <span>Original SHA-256</span>
              <code>{certificate.sha256}</code>
            </div>
          </Card>
          {(certificate.evidence?.length ?? 0) > 0 && (
            <Card className="evidence-citations-card">
              <details>
                <summary>
                  <FileCheck2 size={17} /> Page-linked extraction evidence (
                  {certificate.evidence?.length ?? 0})
                </summary>
                <p>
                  These are client-submitted extraction proposals, normally produced by the browser,
                  and checked by the server for a matching normalized line in the submitted per-page
                  text. They are not independent server OCR or proof of PDF contents.{" "}
                  {isConfirmed
                    ? "A reviewer attested to the source document; any correction remains separate from these proposals."
                    : "They remain unverified until a reviewer checks the original PDF."}
                </p>
                <ul>
                  {certificate.evidence?.map((citation) => (
                    <li
                      key={`${citation.field}-${citation.policyIndex ?? "document"}-${citation.endorsementIndex ?? "field"}-${citation.limitType ?? "value"}-${citation.page}-${citation.rawText}`}
                    >
                      <div>
                        <strong>
                          {citation.limitType
                            ? titleCase(citation.limitType)
                            : titleCase(citation.field)}
                        </strong>
                        {citation.confidenceBps !== null && (
                          <span>{Math.round(citation.confidenceBps / 100)}% OCR confidence</span>
                        )}
                        <span>
                          {citation.attestationStatus === "reviewer_attested"
                            ? "Reviewer-attested client citation"
                            : "Unverified client citation"}
                        </span>
                      </div>
                      <q>{citation.rawText}</q>
                      <a
                        href={`/api/certificates/${certificate.id}/view#page=${citation.page}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original at page {citation.page}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          )}
          <Card className="scope-card">
            <ShieldAlert size={19} />
            <h3>Document scope</h3>
            <p>
              A certificate is informational. Required endorsements and policy provisions should be
              reviewed with qualified insurance or legal professionals.
            </p>
            <Link to="/audit">View audit trail</Link>
          </Card>
        </aside>
      </div>

      <Modal
        open={rejectionOpen}
        onClose={() => !rejecting && setRejectionOpen(false)}
        title="Reject vendor submission"
        description="The PDF remains in the audit record, but this extraction will not count as current evidence."
        size="sm"
        footer={
          <>
            <Button variant="quiet" disabled={rejecting} onClick={() => setRejectionOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={rejecting} onClick={rejectSubmission}>
              Reject submission
            </Button>
          </>
        }
      >
        <div className="modal-form">
          <Field
            label="Rejection reason"
            hint="Explain what the vendor should correct before submitting a replacement."
          >
            <Textarea
              value={rejectionReason}
              minLength={10}
              maxLength={5000}
              onChange={(event) => setRejectionReason(event.target.value)}
              placeholder="For example: the certificate is issued to a different legal entity."
            />
          </Field>
          {rejectionError && (
            <Callout tone="danger" title="Rejection not ready">
              {rejectionError}
            </Callout>
          )}
        </div>
      </Modal>

      <ExceptionModal
        finding={exceptionFinding}
        vendorId={certificate.vendorId}
        onClose={() => setExceptionFinding(null)}
        onRequested={() => {
          setExceptionFinding(null);
          toast("Exception requested", {
            message: "A different approver should review the risk decision.",
          });
        }}
      />
    </AppShell>
  );
}
