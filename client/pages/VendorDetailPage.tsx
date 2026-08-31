import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  Clipboard,
  FileCheck2,
  FileText,
  Link2,
  Mail,
  Pencil,
  Phone,
  Plus,
  ShieldAlert,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  LifecycleBadge,
  Modal,
  PageLoader,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type {
  CertificateRecord,
  CertificateRequestRecord,
  VendorDetail,
  VendorType,
} from "../types";
import { formatDate, formatMoney, formatRelativeDate, titleCase } from "../utils";
import { errorMessage, PageError } from "./pageHelpers";
import "./pages.css";

function certificateTone(status: CertificateRecord["documentStatus"]) {
  return status === "confirmed" ? "success" : status === "pending_review" ? "warning" : "neutral";
}

interface VendorEditForm {
  legalName: string;
  dbaName: string;
  vendorTypeId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  externalReference: string;
  notes: string;
}

const vendorEditForm = (vendor: VendorDetail): VendorEditForm => ({
  legalName: vendor.legalName,
  dbaName: vendor.dbaName ?? "",
  vendorTypeId: vendor.vendorTypeId,
  contactName: vendor.contactName ?? "",
  contactEmail: vendor.contactEmail ?? "",
  contactPhone: vendor.contactPhone ?? "",
  externalReference: vendor.externalReference ?? "",
  notes: vendor.notes ?? "",
});

export function VendorDetailPage() {
  const { vendorId: id = "" } = useParams();
  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [vendorTypes, setVendorTypes] = useState<VendorType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<CertificateRequestRecord[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestKind, setRequestKind] = useState<"initial" | "renewal">("initial");
  const [deliveryMethod, setDeliveryMethod] = useState<"manual" | "smtp">("manual");
  const [requestRecipientName, setRequestRecipientName] = useState("");
  const [requestRecipientEmail, setRequestRecipientEmail] = useState("");
  const [requestTtlDays, setRequestTtlDays] = useState("14");
  const [requestError, setRequestError] = useState("");
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [createdLink, setCreatedLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<VendorEditForm | null>(null);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [vendorRecord, types, requestData] = await Promise.all([
        api.vendor(id),
        api.vendorTypes(),
        api.certificateRequests(id),
      ]);
      setVendor(vendorRecord);
      setVendorTypes(types);
      setRequests(requestData.requests);
      setSmtpConfigured(requestData.smtpConfigured);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const certificates = useMemo(
    () =>
      [...(vendor?.certificates ?? [])].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    [vendor?.certificates],
  );

  const openRequest = () => {
    if (!vendor) return;
    setRequestKind(vendor.certificates.length > 0 ? "renewal" : "initial");
    setDeliveryMethod(smtpConfigured ? "smtp" : "manual");
    setRequestRecipientName(vendor.contactName ?? "");
    setRequestRecipientEmail(vendor.contactEmail ?? "");
    setRequestTtlDays("14");
    setRequestError("");
    setRequestOpen(true);
  };

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vendor) return;
    if (deliveryMethod === "smtp" && !requestRecipientEmail.trim()) {
      setRequestError("A recipient email is required for email delivery.");
      return;
    }
    setCreatingRequest(true);
    setRequestError("");
    try {
      const result = await api.createCertificateRequest(vendor.id, {
        kind: requestKind,
        deliveryMethod,
        recipientName: requestRecipientName.trim() || null,
        recipientEmail: requestRecipientEmail.trim() || null,
        sourceCertificateId: requestKind === "renewal" ? (certificates[0]?.id ?? null) : null,
        ttlDays: Number(requestTtlDays),
      });
      setRequestOpen(false);
      if (result.uploadUrl) {
        setCreatedLink({ url: result.uploadUrl, expiresAt: result.request.expiresAt });
        setLinkOpen(true);
      } else {
        toast("Certificate request queued", {
          message: "The worker will submit the fixed request email to SMTP for acceptance.",
        });
      }
      await load();
    } catch (cause) {
      setRequestError(errorMessage(cause));
    } finally {
      setCreatingRequest(false);
    }
  };

  const copyLink = async () => {
    if (!createdLink) return;
    const url = new URL(createdLink.url, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setActionError("Copy was blocked by the browser. Select the link and copy it manually.");
    }
  };

  const revokeLink = async (linkId: string) => {
    if (!window.confirm("Revoke this upload link? Vendors will no longer be able to use it."))
      return;
    try {
      await api.revokeUploadLink(linkId);
      toast("Upload link revoked");
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  };

  const cancelRequest = async (requestId: string) => {
    if (!window.confirm("Cancel this certificate request and revoke its upload link?")) return;
    try {
      await api.cancelCertificateRequest(requestId);
      toast("Certificate request cancelled");
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  };

  const openEdit = () => {
    if (!vendor) return;
    setEditForm(vendorEditForm(vendor));
    setEditError("");
    setEditOpen(true);
  };

  const updateEditForm = (key: keyof VendorEditForm, value: string) => {
    setEditForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveVendor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vendor || !editForm) return;
    if (!editForm.legalName.trim() || !editForm.vendorTypeId || !editForm.contactEmail.trim()) {
      setEditError("Legal name, vendor type, and contact email are required.");
      return;
    }
    setSaving(true);
    setEditError("");
    try {
      const updated = await api.updateVendor(
        vendor.id,
        Object.fromEntries(
          Object.entries(editForm).map(([key, value]) => [key, value.trim() || null]),
        ),
      );
      setVendor(updated);
      setEditOpen(false);
      toast("Vendor updated", {
        message: `${updated.legalName}'s contact and profile are current.`,
      });
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageLoader />;
  if (error || !vendor) return <PageError message={error || "Vendor not found."} onRetry={load} />;

  return (
    <div className="page-stack">
      <Link className="back-link" to="/vendors">
        <ArrowLeft size={15} />
        Back to vendors
      </Link>

      <section className="record-hero">
        <div className="record-hero__identity">
          <span className="record-avatar">
            <Building2 size={24} />
          </span>
          <div>
            <span className="section-kicker">{vendor.vendorTypeName}</span>
            <h2>{vendor.legalName}</h2>
            {vendor.dbaName && <p>Doing business as {vendor.dbaName}</p>}
          </div>
        </div>
        <div className="record-hero__status">
          <StatusBadge status={vendor.status} />
          <LifecycleBadge status={vendor.lifecycleStatus} />
        </div>
        <div className="record-hero__actions">
          {user?.role !== "viewer" && (
            <>
              <Button variant="quiet" onClick={openEdit}>
                <Pencil size={16} />
                Edit vendor
              </Button>
              <Button variant="secondary" onClick={openRequest}>
                <Mail size={16} />
                Request certificate
              </Button>
              <Button onClick={() => navigate(`/vendors/${vendor.id}/certificates/new`)}>
                <Upload size={16} />
                Upload certificate
              </Button>
            </>
          )}
        </div>
      </section>

      {actionError && (
        <Callout tone="danger" title="Action failed">
          {actionError}
        </Callout>
      )}
      <Callout tone="info" title="Document-scoped result">
        These statuses compare submitted certificate evidence with {vendor.vendorTypeName} rules.
        They do not confirm the policy’s current standing with the insurer.
      </Callout>

      <div className="record-layout">
        <div className="record-main">
          <Card className="panel-card">
            <div className="panel-card__header">
              <div>
                <span className="section-kicker">Evidence</span>
                <h3>Certificates</h3>
              </div>
              <span className="muted-count">{certificates.length} uploaded</span>
            </div>
            {certificates.length === 0 ? (
              <EmptyState
                icon={<FileText size={25} />}
                title="No certificate submitted"
                description="Upload a PDF or create a secure self-service link for the vendor. Every extraction must be confirmed by a person before checks are final."
                action={
                  user?.role !== "viewer" ? (
                    <Button onClick={() => navigate(`/vendors/${vendor.id}/certificates/new`)}>
                      <Upload size={16} />
                      Upload certificate
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="certificate-list">
                {certificates.map((certificate, index) => {
                  const failures = certificate.findings.filter(
                    (finding) => finding.outcome === "FAIL" && !finding.excepted,
                  ).length;
                  return (
                    <article className="certificate-row" key={certificate.id}>
                      <div className="certificate-row__file">
                        <FileCheck2 size={20} />
                        <span>
                          {index === 0 && <small>Latest</small>}
                          <strong>{certificate.originalFilename}</strong>
                          <em>Uploaded {formatRelativeDate(certificate.uploadedAt)}</em>
                        </span>
                      </div>
                      <div className="certificate-row__meta">
                        <Badge tone={certificateTone(certificate.documentStatus)}>
                          {titleCase(certificate.documentStatus)}
                        </Badge>
                        <StatusBadge status={certificate.checkStatus} />
                        <span>
                          <CalendarDays size={14} />
                          {formatDate(
                            certificate.policies.map((policy) => policy.expirationDate).sort()[0],
                          )}
                        </span>
                        <span className={failures ? "text-danger" : "text-muted"}>
                          {failures} open {failures === 1 ? "finding" : "findings"}
                        </span>
                      </div>
                      <Link
                        className="button button--secondary button--sm"
                        to={`/certificates/${certificate.id}`}
                      >
                        {certificate.documentStatus === "pending_review" ? "Review" : "View"}
                        <ArrowRight size={14} />
                      </Link>
                    </article>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="panel-card">
            <div className="panel-card__header">
              <div>
                <span className="section-kicker">Collection workflow</span>
                <h3>Certificate requests</h3>
              </div>
              <span className="muted-count">{requests.length} tracked</span>
            </div>
            {requests.length === 0 ? (
              <EmptyState
                icon={<Mail size={25} />}
                title="No tracked requests"
                description="Create a single-use request, share it manually or queue a fixed email, and see when its exact link produces a submission."
                action={
                  user?.role !== "viewer" ? (
                    <Button onClick={openRequest}>
                      <Mail size={16} /> Request certificate
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="request-list">
                {requests.map((requestRecord) => (
                  <article className="request-row" key={requestRecord.id}>
                    <div>
                      <Badge
                        tone={
                          requestRecord.state === "submitted"
                            ? "success"
                            : requestRecord.state === "open"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {titleCase(requestRecord.state)}
                      </Badge>
                      <strong>{titleCase(requestRecord.kind)} certificate</strong>
                      <span>
                        {requestRecord.deliveryMethod === "smtp"
                          ? `${requestRecord.recipientEmail ?? "No recipient"} · ${titleCase(requestRecord.deliveryStatus)}`
                          : "Manual secure link"}
                      </span>
                    </div>
                    <dl>
                      <div>
                        <dt>Created</dt>
                        <dd>{formatDate(requestRecord.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>{formatDate(requestRecord.expiresAt)}</dd>
                      </div>
                      {requestRecord.submittedAt && (
                        <div>
                          <dt>Submitted</dt>
                          <dd>{formatDate(requestRecord.submittedAt)}</dd>
                        </div>
                      )}
                    </dl>
                    {requestRecord.deliveryError && (
                      <small className="text-danger">{requestRecord.deliveryError}</small>
                    )}
                    {requestRecord.state === "open" && user?.role !== "viewer" && (
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => cancelRequest(requestRecord.id)}
                      >
                        <Trash2 size={14} /> Cancel
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </Card>

          {certificates[0] && (
            <Card className="panel-card">
              <div className="panel-card__header">
                <div>
                  <span className="section-kicker">Latest document</span>
                  <h3>Coverage snapshot</h3>
                </div>
                <span className="muted-count">
                  Requirement v{certificates[0].requirementVersion ?? "—"}
                </span>
              </div>
              {certificates[0].policies.length === 0 ? (
                <p className="panel-empty-copy">
                  No policy rows have been confirmed on this document.
                </p>
              ) : (
                <div className="coverage-grid">
                  {certificates[0].policies.map((policy, index) => (
                    <div
                      className="coverage-card"
                      key={policy.id ?? `${policy.coverageType}-${index}`}
                    >
                      <div>
                        <ShieldAlert size={17} />
                        <strong>{titleCase(policy.coverageType)}</strong>
                      </div>
                      <dl>
                        <div>
                          <dt>Insurer</dt>
                          <dd>{policy.insurer || "Not shown"}</dd>
                        </div>
                        <div>
                          <dt>Policy</dt>
                          <dd className="mono">{policy.policyNumber || "Not shown"}</dd>
                        </div>
                        <div>
                          <dt>Each occurrence</dt>
                          <dd>{formatMoney(policy.eachOccurrence, policy.currency)}</dd>
                        </div>
                        <div>
                          <dt>Aggregate</dt>
                          <dd>{formatMoney(policy.aggregate, policy.currency)}</dd>
                        </div>
                        <div>
                          <dt>Expiration</dt>
                          <dd>{formatDate(policy.expirationDate)}</dd>
                        </div>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>

        <aside className="record-sidebar">
          <Card className="detail-card">
            <div className="detail-card__header">
              <h3>Vendor details</h3>
            </div>
            <dl className="detail-list">
              <div>
                <dt>
                  <UserRound size={15} />
                  Contact
                </dt>
                <dd>{vendor.contactName || "Not provided"}</dd>
              </div>
              <div>
                <dt>
                  <Mail size={15} />
                  Email
                </dt>
                <dd>
                  <a href={`mailto:${vendor.contactEmail}`}>{vendor.contactEmail}</a>
                </dd>
              </div>
              <div>
                <dt>
                  <Phone size={15} />
                  Phone
                </dt>
                <dd>
                  {vendor.contactPhone ? (
                    <a href={`tel:${vendor.contactPhone}`}>{vendor.contactPhone}</a>
                  ) : (
                    "Not provided"
                  )}
                </dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>{vendor.externalReference || "Not provided"}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDate(vendor.updatedAt)}</dd>
              </div>
            </dl>
            {vendor.notes && (
              <div className="internal-note">
                <span>Internal notes</span>
                <p>{vendor.notes}</p>
              </div>
            )}
          </Card>

          <Card className="detail-card">
            <div className="detail-card__header">
              <h3>Self-service upload links</h3>
              <Badge tone="neutral">{vendor.activeUploadLinks.length} active</Badge>
            </div>
            {vendor.activeUploadLinks.length === 0 ? (
              <p className="panel-empty-copy">No active links. New links expire after 14 days.</p>
            ) : (
              <div className="upload-link-list">
                {vendor.activeUploadLinks.map((link) => (
                  <div key={link.id}>
                    <span>
                      <Link2 size={15} />
                      <span>
                        <strong>Expires {formatDate(link.expiresAt)}</strong>
                        <small>
                          Used {link.useCount} {link.useCount === 1 ? "time" : "times"}
                        </small>
                      </span>
                    </span>
                    {user?.role !== "viewer" && (
                      <button
                        type="button"
                        onClick={() => revokeLink(link.id)}
                        aria-label={`Revoke link expiring ${formatDate(link.expiresAt)}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {user?.role !== "viewer" && (
              <Button variant="secondary" size="sm" onClick={openRequest}>
                <Plus size={15} />
                New tracked request
              </Button>
            )}
          </Card>
        </aside>
      </div>

      <Modal
        open={requestOpen}
        onClose={() => !creatingRequest && setRequestOpen(false)}
        title="Request a certificate"
        description="Create one tracked, single-use upload request for this vendor."
        footer={
          <>
            <Button
              variant="quiet"
              onClick={() => setRequestOpen(false)}
              disabled={creatingRequest}
            >
              Cancel
            </Button>
            <Button type="submit" form="certificate-request-form" loading={creatingRequest}>
              {deliveryMethod === "smtp" ? "Queue request email" : "Create secure link"}
            </Button>
          </>
        }
      >
        <form id="certificate-request-form" className="modal-form" onSubmit={createRequest}>
          <Field label="Request type">
            <Select
              value={requestKind}
              onChange={(event) => setRequestKind(event.target.value as "initial" | "renewal")}
            >
              <option value="initial">Initial certificate</option>
              <option value="renewal">Renewal certificate</option>
            </Select>
          </Field>
          <Field
            label="Delivery"
            hint="Email status means accepted by SMTP, not delivered to or opened by the recipient."
          >
            <Select
              value={deliveryMethod}
              onChange={(event) => setDeliveryMethod(event.target.value as "manual" | "smtp")}
            >
              <option value="manual">Show a one-time share URL</option>
              <option value="smtp" disabled={!smtpConfigured}>
                {smtpConfigured ? "Queue fixed-text email" : "Email unavailable (configure SMTP)"}
              </option>
            </Select>
          </Field>
          <Field label="Recipient name">
            <TextInput
              value={requestRecipientName}
              onChange={(event) => setRequestRecipientName(event.target.value)}
            />
          </Field>
          <Field label="Recipient email">
            <TextInput
              type="email"
              required={deliveryMethod === "smtp"}
              value={requestRecipientEmail}
              onChange={(event) => setRequestRecipientEmail(event.target.value)}
            />
          </Field>
          <Field label="Link lifetime">
            <Select
              value={requestTtlDays}
              onChange={(event) => setRequestTtlDays(event.target.value)}
            >
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
            </Select>
          </Field>
          {requestError && (
            <div className="form-error" role="alert">
              {requestError}
            </div>
          )}
          <Callout tone="info" title="Document-scoped request">
            Submission through this link enters human review. The request does not establish live
            policy status.
          </Callout>
        </form>
      </Modal>

      <Modal
        open={editOpen}
        onClose={() => !saving && setEditOpen(false)}
        title="Edit vendor"
        description="Keep the requirements profile and renewal contact accurate."
        size="lg"
        footer={
          <>
            <Button variant="quiet" onClick={() => setEditOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="edit-vendor-form" loading={saving}>
              Save changes
            </Button>
          </>
        }
      >
        {editForm && (
          <form id="edit-vendor-form" className="form-grid" onSubmit={saveVendor}>
            {editError && (
              <div className="form-error" role="alert">
                {editError}
              </div>
            )}
            <Field label="Legal name" className="form-grid__wide">
              <TextInput
                required
                value={editForm.legalName}
                onChange={(event) => updateEditForm("legalName", event.target.value)}
              />
            </Field>
            <Field label="Doing business as">
              <TextInput
                value={editForm.dbaName}
                onChange={(event) => updateEditForm("dbaName", event.target.value)}
              />
            </Field>
            <Field label="Vendor type">
              <Select
                required
                value={editForm.vendorTypeId}
                onChange={(event) => updateEditForm("vendorTypeId", event.target.value)}
              >
                {vendorTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} · v{type.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contact name">
              <TextInput
                value={editForm.contactName}
                onChange={(event) => updateEditForm("contactName", event.target.value)}
              />
            </Field>
            <Field label="Contact email">
              <TextInput
                required
                type="email"
                value={editForm.contactEmail}
                onChange={(event) => updateEditForm("contactEmail", event.target.value)}
              />
            </Field>
            <Field label="Contact phone">
              <TextInput
                type="tel"
                value={editForm.contactPhone}
                onChange={(event) => updateEditForm("contactPhone", event.target.value)}
              />
            </Field>
            <Field label="External reference">
              <TextInput
                value={editForm.externalReference}
                onChange={(event) => updateEditForm("externalReference", event.target.value)}
              />
            </Field>
            <Field label="Internal notes" className="form-grid__wide">
              <Textarea
                value={editForm.notes}
                onChange={(event) => updateEditForm("notes", event.target.value)}
                placeholder="Visible only to workspace users"
              />
            </Field>
          </form>
        )}
      </Modal>

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Vendor upload link"
        description="This single-use link accepts one certificate PDF for this vendor."
        size="sm"
        footer={<Button onClick={() => setLinkOpen(false)}>Done</Button>}
      >
        {createdLink && (
          <div className="share-link">
            <Field label="Secure upload URL" hint={`Expires ${formatDate(createdLink.expiresAt)}`}>
              <div className="copy-field">
                <TextInput
                  readOnly
                  value={new URL(createdLink.url, window.location.origin).toString()}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button type="button" variant="secondary" onClick={copyLink}>
                  {copied ? <Check size={16} /> : <Clipboard size={16} />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </Field>
            <Callout tone="info" title="Send it securely">
              Share this link only with the intended vendor contact. Revoke it from the vendor
              record if it is sent to the wrong recipient.
            </Callout>
          </div>
        )}
      </Modal>
    </div>
  );
}
