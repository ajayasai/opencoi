import type { CoverageType, EvidenceField, LimitType } from "@shared/domain";
import { parseCoiText } from "@shared/ocr";
import {
  Check,
  FileCheck2,
  FileText,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { PdfPreview } from "../components/PdfPreview";
import { Button, Callout, Field, IconButton, Select, TextInput } from "../components/ui";
import {
  type BrowserExtractionResult,
  type ExtractionProgress,
  extractPdfInBrowser,
} from "../lib/documentExtraction";
import { useToast } from "../state/ToastContext";

const coverageOptions: Array<{ value: CoverageType; label: string }> = [
  { value: "COMMERCIAL_GENERAL_LIABILITY", label: "Commercial general liability" },
  { value: "AUTOMOBILE_LIABILITY", label: "Automobile liability" },
  { value: "WORKERS_COMPENSATION", label: "Workers’ compensation" },
  { value: "EMPLOYERS_LIABILITY", label: "Employers’ liability" },
  { value: "UMBRELLA_EXCESS_LIABILITY", label: "Umbrella / excess liability" },
  { value: "PROFESSIONAL_LIABILITY", label: "Professional liability / E&O" },
  { value: "CYBER_LIABILITY", label: "Cyber liability" },
  { value: "POLLUTION_LIABILITY", label: "Pollution liability" },
  { value: "PROPERTY", label: "Property" },
  { value: "OTHER", label: "Other" },
];

const evidenceOptions: Array<{ value: EndorsementEvidenceDraft; label: string }> = [
  { value: "NONE", label: "Not shown" },
  { value: "MENTIONED", label: "Indicated on certificate" },
  { value: "ATTACHED", label: "Endorsement included in PDF package" },
  { value: "HUMAN_VERIFIED", label: "Attached endorsement reviewed" },
];

interface IntakeRequirement {
  coverageType: string;
  label: string;
  summary: string;
}

interface PolicyDraft {
  id: string;
  coverageType: CoverageType;
  insurer: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string;
  occurrenceLimitType: LimitType;
  eachOccurrence: string;
  aggregateLimitType: LimitType;
  aggregate: string;
  additionalInsured: EndorsementEvidenceDraft;
  waiverOfSubrogation: EndorsementEvidenceDraft;
  primaryNoncontributory: EndorsementEvidenceDraft;
}

type EndorsementEvidenceDraft = "NONE" | "MENTIONED" | "ATTACHED" | "HUMAN_VERIFIED";

interface EndorsementDraft {
  id: string;
  name: string;
  formCode: string;
  evidenceLevel: EndorsementEvidenceDraft;
}

interface CertificateDraft {
  namedInsured: string;
  issueDate: string;
  producer: string;
  certificateHolder: string;
  policies: PolicyDraft[];
  endorsements: EndorsementDraft[];
  provenance: ExtractionProvenance[];
}

export interface ExtractionProvenance {
  field:
    | "NAMED_INSURED"
    | "CERTIFICATE_HOLDER"
    | "COVERAGE_TYPE"
    | "INSURER_NAME"
    | "POLICY_NUMBER"
    | "EFFECTIVE_DATE"
    | "EXPIRATION_DATE"
    | "LIMIT"
    | "ENDORSEMENT_NAME"
    | "ENDORSEMENT_FORM_CODE"
    | "ENDORSEMENT_EVIDENCE_LEVEL";
  extractedValue: string | number;
  policyIndex?: number;
  endorsementIndex?: number;
  limitType?: LimitType;
  source: "OCR";
  confidenceBps?: number;
  rawText: string;
  page: number;
}

export interface IntakeSubmission {
  extractionVersion: string;
  extractionMethod: string;
  rawText: string;
  pages: BrowserExtractionResult["pages"];
  reviewStatus: "CONFIRMED" | "UNCONFIRMED";
  namedInsured: string;
  issueDate: string | null;
  producer: string | null;
  certificateHolder: string | null;
  provenance: ExtractionProvenance[];
  policies: Array<{
    coverageType: CoverageType;
    insurer: string | null;
    policyNumber: string | null;
    effectiveDate: string | null;
    expirationDate: string | null;
    limits: Partial<Record<LimitType, number>>;
    endorsements: Array<{
      name: string;
      evidenceLevel: Exclude<EndorsementEvidenceDraft, "NONE">;
      formCode?: string;
    }>;
  }>;
}

interface DocumentIntakeProps {
  vendorName: string;
  requirements?: IntakeRequirement[];
  confirmationMode: "staff" | "vendor";
  submitLabel: string;
  onSubmit: (file: File, submission: IntakeSubmission) => Promise<void>;
  success?: { title: string; description: string; receiptId?: string } | null;
}

function firstMatch(text: string, pattern: RegExp) {
  return pattern.exec(text)?.[1]?.trim().slice(0, 240) ?? "";
}

function majorUnits(minorUnits?: number) {
  return minorUnits === undefined ? "" : String(minorUnits / 100);
}

function defaultOccurrenceLimitType(coverageType: CoverageType): LimitType {
  if (coverageType === "AUTOMOBILE_LIABILITY") return "COMBINED_SINGLE_LIMIT";
  if (coverageType === "EMPLOYERS_LIABILITY") return "EACH_ACCIDENT";
  if (["PROFESSIONAL_LIABILITY", "CYBER_LIABILITY", "POLLUTION_LIABILITY"].includes(coverageType)) {
    return "EACH_CLAIM";
  }
  return "EACH_OCCURRENCE";
}

function defaultAggregateLimitType(coverageType: CoverageType): LimitType {
  return [
    "PROFESSIONAL_LIABILITY",
    "CYBER_LIABILITY",
    "POLLUTION_LIABILITY",
    "UMBRELLA_EXCESS_LIABILITY",
  ].includes(coverageType)
    ? "AGGREGATE"
    : "GENERAL_AGGREGATE";
}

function firstLimit(
  limits: Partial<Record<LimitType, EvidenceField<number>>>,
  types: LimitType[],
  fallbackType: LimitType,
) {
  const type = types.find((candidate) => limits[candidate]?.value !== undefined) ?? fallbackType;
  return { type, value: limits[type]?.value, evidence: limits[type] };
}

function draftFromExtraction(result: BrowserExtractionResult): CertificateDraft {
  const parsed = parseCoiText(result.rawText, { documentId: crypto.randomUUID() });
  const normalized = parsed.normalizedText;
  const insurerFallbackField = parsed.candidates.insurerNames[0];
  const insurerFallback = insurerFallbackField?.value ?? "";
  const provenance: ExtractionProvenance[] = [];
  const record = (
    field: ExtractionProvenance["field"],
    evidence: EvidenceField<unknown> | undefined,
    qualifiers: Pick<ExtractionProvenance, "policyIndex" | "endorsementIndex" | "limitType"> = {},
  ) => {
    if (evidence?.source !== "OCR" || !evidence.rawText || !evidence.page) return;
    if (typeof evidence.value !== "string" && typeof evidence.value !== "number") return;
    provenance.push({
      field,
      extractedValue: evidence.value,
      source: "OCR",
      ...(evidence.confidenceBps === undefined ? {} : { confidenceBps: evidence.confidenceBps }),
      rawText: evidence.rawText,
      page: evidence.page,
      ...qualifiers,
    });
  };
  record("NAMED_INSURED", parsed.document.namedInsured);
  record("CERTIFICATE_HOLDER", parsed.document.certificateHolder);
  const policies: PolicyDraft[] = parsed.document.policies.map((policy, policyIndex) => {
    const occurrence = firstLimit(
      policy.limits,
      ["EACH_OCCURRENCE", "COMBINED_SINGLE_LIMIT", "EACH_ACCIDENT", "EACH_CLAIM"],
      defaultOccurrenceLimitType(policy.coverageType.value),
    );
    const aggregate = firstLimit(
      policy.limits,
      ["GENERAL_AGGREGATE", "AGGREGATE", "PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE"],
      defaultAggregateLimitType(policy.coverageType.value),
    );
    record("COVERAGE_TYPE", policy.coverageType, { policyIndex });
    record("INSURER_NAME", policy.insurerName ?? insurerFallbackField, { policyIndex });
    record("POLICY_NUMBER", policy.policyNumber, { policyIndex });
    record("EFFECTIVE_DATE", policy.effectiveDate, { policyIndex });
    record("EXPIRATION_DATE", policy.expirationDate, { policyIndex });
    record("LIMIT", occurrence.evidence, { policyIndex, limitType: occurrence.type });
    if (aggregate.type !== occurrence.type) {
      record("LIMIT", aggregate.evidence, { policyIndex, limitType: aggregate.type });
    }
    return {
      id: policy.id,
      coverageType: policy.coverageType.value,
      insurer: policy.insurerName?.value ?? insurerFallback,
      policyNumber: policy.policyNumber?.value ?? "",
      effectiveDate: policy.effectiveDate?.value ?? "",
      expirationDate: policy.expirationDate?.value ?? "",
      occurrenceLimitType: occurrence.type,
      eachOccurrence: majorUnits(occurrence.value),
      aggregateLimitType: aggregate.type,
      aggregate: majorUnits(aggregate.value),
      additionalInsured: /\b(?:ADDL|ADDITIONAL)\s+INSURED\b/i.test(normalized)
        ? "MENTIONED"
        : "NONE",
      waiverOfSubrogation: /\b(?:SUBR\s+WVD|WAIVER\s+OF\s+SUBROGATION)\b/i.test(normalized)
        ? "MENTIONED"
        : "NONE",
      primaryNoncontributory: /\bPRIMARY\s+(?:AND|&)?\s*NON-?CONTRIBUTORY\b/i.test(normalized)
        ? "MENTIONED"
        : "NONE",
    };
  });

  const endorsements = parsed.document.endorsements.map((endorsement, endorsementIndex) => {
    record("ENDORSEMENT_NAME", endorsement.name, { endorsementIndex });
    record("ENDORSEMENT_FORM_CODE", endorsement.formCode, { endorsementIndex });
    record("ENDORSEMENT_EVIDENCE_LEVEL", endorsement.evidenceLevel, { endorsementIndex });
    return {
      id: endorsement.id,
      name: endorsement.name?.value ?? "",
      formCode: endorsement.formCode?.value ?? "",
      evidenceLevel:
        endorsement.evidenceLevel.value === "HUMAN_VERIFIED"
          ? ("HUMAN_VERIFIED" as const)
          : endorsement.evidenceLevel.value === "ATTACHED" ||
              endorsement.evidenceLevel.value === "SCHEDULED"
            ? ("ATTACHED" as const)
            : endorsement.evidenceLevel.value === "NONE"
              ? ("NONE" as const)
              : ("MENTIONED" as const),
    };
  });

  return {
    namedInsured:
      parsed.document.namedInsured?.value ??
      firstMatch(normalized, /^(?:NAMED\s+INSURED|INSURED)(?!\s*\(S\))\s*[:#-]\s*(.+)$/im),
    issueDate: firstMatch(
      normalized,
      /^(?:DATE\s+(?:ISSUED|OF\s+ISSUE)|ISSUE\s+DATE)\s*[:#-]?\s*(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})/im,
    ),
    producer: firstMatch(normalized, /^(?:PRODUCER|BROKER)\s*[:#-]\s*(.+)$/im),
    certificateHolder:
      parsed.document.certificateHolder?.value ??
      firstMatch(normalized, /^CERTIFICATE\s+HOLDER\s*[:#-]\s*(.+)$/im),
    policies:
      policies.length > 0
        ? policies
        : [
            {
              id: crypto.randomUUID(),
              coverageType: "COMMERCIAL_GENERAL_LIABILITY",
              insurer: insurerFallback,
              policyNumber: "",
              effectiveDate: "",
              expirationDate: "",
              occurrenceLimitType: "EACH_OCCURRENCE",
              eachOccurrence: "",
              aggregateLimitType: "GENERAL_AGGREGATE",
              aggregate: "",
              additionalInsured: "NONE",
              waiverOfSubrogation: "NONE",
              primaryNoncontributory: "NONE",
            },
          ],
    endorsements,
    provenance,
  };
}

function toMinorUnits(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : undefined;
}

export function DocumentIntake({
  vendorName,
  requirements = [],
  confirmationMode,
  submitLabel,
  onSubmit,
  success,
}: DocumentIntakeProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [extraction, setExtraction] = useState<BrowserExtractionResult | null>(null);
  const [draft, setDraft] = useState<CertificateDraft | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const processFile = async (selected: File) => {
    setError("");
    if (selected.size > 15 * 1024 * 1024) {
      setError("PDFs must be 15 MB or smaller.");
      return;
    }
    if (!selected.name.toLowerCase().endsWith(".pdf") && selected.type !== "application/pdf") {
      setError("Select a PDF certificate or certificate package.");
      return;
    }
    setFile(selected);
    setExtraction(null);
    setDraft(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await extractPdfInBrowser(selected, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setExtraction(result);
      setDraft(draftFromExtraction(result));
      if (result.warnings.length > 0) {
        toast("Extraction needs attention", {
          tone: "info",
          message: result.warnings[0],
        });
      }
    } catch (cause) {
      if ((cause as Error).name !== "ExtractionCancelledError") {
        setError(cause instanceof Error ? cause.message : "The PDF could not be read.");
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (selected) void processFile(selected);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const selected = event.dataTransfer.files[0];
    if (selected) void processFile(selected);
  };

  const updateDraft = (
    field: keyof Omit<CertificateDraft, "policies" | "endorsements" | "provenance">,
    value: string,
  ) => {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  };

  const updatePolicy = <K extends keyof PolicyDraft>(
    index: number,
    field: K,
    value: PolicyDraft[K],
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const policies = current.policies.map((policy, policyIndex) =>
        policyIndex === index ? { ...policy, [field]: value } : policy,
      );
      return { ...current, policies };
    });
  };

  const updatePolicyCoverage = (index: number, coverageType: CoverageType) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        policies: current.policies.map((policy, policyIndex) =>
          policyIndex === index
            ? {
                ...policy,
                coverageType,
                occurrenceLimitType: defaultOccurrenceLimitType(coverageType),
                aggregateLimitType: defaultAggregateLimitType(coverageType),
              }
            : policy,
        ),
      };
    });
  };

  const addPolicy = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            policies: [
              ...current.policies,
              {
                id: crypto.randomUUID(),
                coverageType: "OTHER",
                insurer: "",
                policyNumber: "",
                effectiveDate: "",
                expirationDate: "",
                occurrenceLimitType: "EACH_OCCURRENCE",
                eachOccurrence: "",
                aggregateLimitType: "GENERAL_AGGREGATE",
                aggregate: "",
                additionalInsured: "NONE",
                waiverOfSubrogation: "NONE",
                primaryNoncontributory: "NONE",
              },
            ],
          }
        : current,
    );
  };

  const removePolicy = (index: number) => {
    setDraft((current) =>
      current
        ? { ...current, policies: current.policies.filter((_, item) => item !== index) }
        : current,
    );
  };

  const addEndorsement = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            endorsements: [
              ...current.endorsements,
              {
                id: crypto.randomUUID(),
                name: "",
                formCode: "",
                evidenceLevel: confirmationMode === "staff" ? "HUMAN_VERIFIED" : "ATTACHED",
              },
            ],
          }
        : current,
    );
  };

  const updateEndorsement = <K extends keyof EndorsementDraft>(
    index: number,
    field: K,
    value: EndorsementDraft[K],
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            endorsements: current.endorsements.map((endorsement, endorsementIndex) =>
              endorsementIndex === index ? { ...endorsement, [field]: value } : endorsement,
            ),
          }
        : current,
    );
  };

  const removeEndorsement = (index: number) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            endorsements: current.endorsements.filter(
              (_, endorsementIndex) => endorsementIndex !== index,
            ),
          }
        : current,
    );
  };

  const submit = async () => {
    if (!file || !draft || !extraction) return;
    if (!draft.namedInsured.trim()) {
      setError("Confirm the named insured before submitting.");
      return;
    }
    if (confirmationMode === "staff" && !reviewConfirmed) {
      setError("Confirm that you reviewed the source document.");
      return;
    }

    const submission: IntakeSubmission = {
      extractionVersion: "pdfjs-tesseract-local-v1",
      extractionMethod: extraction.method,
      rawText: extraction.rawText,
      pages: extraction.pages,
      reviewStatus: confirmationMode === "staff" ? "CONFIRMED" : "UNCONFIRMED",
      namedInsured: draft.namedInsured.trim(),
      issueDate: draft.issueDate || null,
      producer: draft.producer.trim() || null,
      certificateHolder: draft.certificateHolder.trim() || null,
      provenance: draft.provenance,
      policies: draft.policies.map((policy, policyIndex) => {
        const limits: Partial<Record<LimitType, number>> = {};
        const occurrence = toMinorUnits(policy.eachOccurrence);
        const aggregate = toMinorUnits(policy.aggregate);
        if (occurrence !== undefined) limits[policy.occurrenceLimitType] = occurrence;
        if (aggregate !== undefined) limits[policy.aggregateLimitType] = aggregate;
        const endorsements: Array<{
          name: string;
          evidenceLevel: Exclude<EndorsementEvidenceDraft, "NONE">;
          formCode?: string;
        }> = [];
        if (policy.additionalInsured !== "NONE") {
          endorsements.push({
            name: "Additional insured",
            evidenceLevel: policy.additionalInsured,
          });
        }
        if (policy.waiverOfSubrogation !== "NONE") {
          endorsements.push({
            name: "Waiver of subrogation",
            evidenceLevel: policy.waiverOfSubrogation,
          });
        }
        if (policy.primaryNoncontributory !== "NONE") {
          endorsements.push({
            name: "Primary and non-contributory",
            evidenceLevel: policy.primaryNoncontributory,
          });
        }
        if (policyIndex === 0) {
          endorsements.push(
            ...draft.endorsements
              .filter(
                (endorsement) => endorsement.evidenceLevel !== "NONE" && endorsement.name.trim(),
              )
              .map((endorsement) => ({
                name: endorsement.name.trim(),
                evidenceLevel: endorsement.evidenceLevel as Exclude<
                  EndorsementEvidenceDraft,
                  "NONE"
                >,
                ...(endorsement.formCode.trim() ? { formCode: endorsement.formCode.trim() } : {}),
              })),
          );
        }
        return {
          coverageType: policy.coverageType,
          insurer: policy.insurer.trim() || null,
          policyNumber: policy.policyNumber.trim() || null,
          effectiveDate: policy.effectiveDate || null,
          expirationDate: policy.expirationDate || null,
          limits,
          endorsements,
        };
      }),
    };

    setSubmitting(true);
    setError("");
    try {
      await onSubmit(file, submission);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The certificate could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="intake-success">
        <div className="intake-success__mark">
          <Check size={34} />
        </div>
        <span>Submission received</span>
        <h2>{success.title}</h2>
        <p>{success.description}</p>
        {success.receiptId && (
          <div className="receipt-id">
            Receipt <code>{success.receiptId}</code>
          </div>
        )}
      </div>
    );
  }

  if (!file || (!draft && !progress)) {
    return (
      <div className="intake-start">
        {requirements.length > 0 && (
          <section className="intake-requirements">
            <div className="intake-section-heading">
              <div>
                <span>Before you upload</span>
                <h2>Requirements for {vendorName}</h2>
              </div>
              <ShieldCheck size={23} />
            </div>
            <div className="requirement-chips">
              {requirements.map((requirement) => (
                <div key={`${requirement.coverageType}-${requirement.label}`}>
                  <Check size={15} />
                  <span>
                    <strong>{requirement.label}</strong>
                    <small>{requirement.summary}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        <section
          className={`drop-zone ${dragging ? "drop-zone--dragging" : ""}`}
          aria-label="Certificate PDF upload area"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={dropFile}
        >
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            aria-label="Certificate PDF file"
            tabIndex={-1}
            onChange={chooseFile}
          />
          <div className="drop-zone__icon">
            <UploadCloud size={29} />
          </div>
          <h2>Drop a certificate PDF here</h2>
          <p>
            Text extraction and OCR run locally in this browser. Nothing is submitted until you
            review it.
          </p>
          <Button type="button" onClick={() => inputRef.current?.click()}>
            Choose PDF
          </Button>
          <small>PDF only · 15 MB maximum</small>
        </section>
        {error && (
          <Callout tone="danger" title="Upload not ready">
            {error}
          </Callout>
        )}
      </div>
    );
  }

  if (progress || !draft || !extraction) {
    return (
      <div className="extraction-progress">
        <div className="extraction-progress__art">
          <FileText size={42} />
          <Sparkles className="extraction-progress__spark" size={23} />
        </div>
        <span>Local document intelligence</span>
        <h2>{progress?.message ?? "Preparing review"}</h2>
        <div className="progress-track">
          <div style={{ width: `${Math.max(8, (progress?.progress ?? 0.08) * 100)}%` }} />
        </div>
        <p>
          The PDF stays in your browser while PDF.js reads text and Tesseract handles scanned pages.
        </p>
        <Button variant="quiet" onClick={() => abortRef.current?.abort()}>
          <X size={16} /> Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="intake-review">
      <div className="review-banner">
        <div>
          <FileCheck2 size={20} />
          <span>
            <strong>{file.name}</strong>
            <small>
              {extraction.pageCount} {extraction.pageCount === 1 ? "page" : "pages"} ·{" "}
              {extraction.method.replace("_", " ")} extraction
            </small>
          </span>
        </div>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            setFile(null);
            setDraft(null);
            setExtraction(null);
            setReviewConfirmed(false);
          }}
        >
          <RotateCcw size={15} /> Replace
        </Button>
      </div>

      {extraction.warnings.map((warning) => (
        <Callout key={warning} tone="warning" title="Manual confirmation required">
          {warning}
        </Callout>
      ))}

      <div className="review-workspace">
        <section className="review-document-pane">
          <div className="pane-heading">
            <div>
              <span>Source evidence</span>
              <h2>Uploaded PDF</h2>
            </div>
          </div>
          <PdfPreview file={file} />
        </section>

        <section className="review-fields-pane">
          <div className="pane-heading">
            <div>
              <span>Human confirmation</span>
              <h2>Extracted fields</h2>
            </div>
            <div className="local-badge">
              <Sparkles size={13} /> Local OCR
            </div>
          </div>
          <div className="certificate-fields">
            <div className="form-section">
              <div className="form-section__title">
                <span>01</span>
                <div>
                  <h3>Certificate parties</h3>
                  <p>Confirm names exactly as shown in the uploaded document.</p>
                </div>
              </div>
              <div className="form-grid form-grid--two">
                <Field label="Named insured" className="form-grid__wide">
                  <TextInput
                    value={draft.namedInsured}
                    onChange={(event) => updateDraft("namedInsured", event.target.value)}
                    placeholder="Legal entity on certificate"
                  />
                </Field>
                <Field label="Producer / broker">
                  <TextInput
                    value={draft.producer}
                    onChange={(event) => updateDraft("producer", event.target.value)}
                    placeholder="Not shown"
                  />
                </Field>
                <Field label="Certificate holder">
                  <TextInput
                    value={draft.certificateHolder}
                    onChange={(event) => updateDraft("certificateHolder", event.target.value)}
                    placeholder="Not shown"
                  />
                </Field>
                <Field label="Issue date">
                  <TextInput
                    type="date"
                    value={draft.issueDate}
                    onChange={(event) => updateDraft("issueDate", event.target.value)}
                  />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section__title form-section__title--action">
                <span>02</span>
                <div>
                  <h3>Policies and limits</h3>
                  <p>Blank values remain unknown and can never silently pass a rule.</p>
                </div>
                <Button variant="secondary" size="sm" onClick={addPolicy}>
                  <Plus size={15} /> Add policy
                </Button>
              </div>
              <div className="policy-list">
                {draft.policies.map((policy, index) => (
                  <article className="policy-editor" key={policy.id}>
                    <header>
                      <div>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>
                          {
                            coverageOptions.find((option) => option.value === policy.coverageType)
                              ?.label
                          }
                        </strong>
                      </div>
                      {draft.policies.length > 1 && (
                        <IconButton label="Remove policy" onClick={() => removePolicy(index)}>
                          <Trash2 size={16} />
                        </IconButton>
                      )}
                    </header>
                    <div className="form-grid form-grid--two">
                      <Field label="Coverage type" className="form-grid__wide">
                        <Select
                          value={policy.coverageType}
                          onChange={(event) =>
                            updatePolicyCoverage(index, event.target.value as CoverageType)
                          }
                        >
                          {coverageOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Insurer">
                        <TextInput
                          value={policy.insurer}
                          onChange={(event) => updatePolicy(index, "insurer", event.target.value)}
                          placeholder="Not shown"
                        />
                      </Field>
                      <Field label="Policy number">
                        <TextInput
                          value={policy.policyNumber}
                          onChange={(event) =>
                            updatePolicy(index, "policyNumber", event.target.value)
                          }
                          placeholder="Not shown"
                        />
                      </Field>
                      <Field label="Effective date">
                        <TextInput
                          type="date"
                          value={policy.effectiveDate}
                          onChange={(event) =>
                            updatePolicy(index, "effectiveDate", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Expiration date">
                        <TextInput
                          type="date"
                          value={policy.expirationDate}
                          onChange={(event) =>
                            updatePolicy(index, "expirationDate", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Primary limit" hint="Choose the document's exact limit label">
                        <Select
                          value={policy.occurrenceLimitType}
                          onChange={(event) =>
                            updatePolicy(
                              index,
                              "occurrenceLimitType",
                              event.target.value as LimitType,
                            )
                          }
                        >
                          <option value="EACH_OCCURRENCE">Each occurrence</option>
                          <option value="COMBINED_SINGLE_LIMIT">Combined single limit</option>
                          <option value="EACH_ACCIDENT">Each accident</option>
                          <option value="EACH_CLAIM">Each claim</option>
                        </Select>
                        <TextInput
                          inputMode="decimal"
                          value={policy.eachOccurrence}
                          onChange={(event) =>
                            updatePolicy(index, "eachOccurrence", event.target.value)
                          }
                          placeholder="1,000,000"
                        />
                      </Field>
                      <Field label="Aggregate limit" hint="Choose the document's exact limit label">
                        <Select
                          value={policy.aggregateLimitType}
                          onChange={(event) =>
                            updatePolicy(
                              index,
                              "aggregateLimitType",
                              event.target.value as LimitType,
                            )
                          }
                        >
                          <option value="GENERAL_AGGREGATE">General aggregate</option>
                          <option value="AGGREGATE">Aggregate</option>
                          <option value="PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE">
                            Products/completed operations aggregate
                          </option>
                        </Select>
                        <TextInput
                          inputMode="decimal"
                          value={policy.aggregate}
                          onChange={(event) => updatePolicy(index, "aggregate", event.target.value)}
                          placeholder="2,000,000"
                        />
                      </Field>
                    </div>
                    <div className="endorsement-evidence-grid">
                      <span>Common endorsement evidence</span>
                      {[
                        ["additionalInsured", "Additional insured"],
                        ["waiverOfSubrogation", "Waiver of subrogation"],
                        ["primaryNoncontributory", "Primary & non-contributory"],
                      ].map(([field, label]) => (
                        <Field key={field} label={label}>
                          <Select
                            value={policy[field as keyof PolicyDraft] as EndorsementEvidenceDraft}
                            onChange={(event) =>
                              updatePolicy(
                                index,
                                field as keyof PolicyDraft,
                                event.target.value as never,
                              )
                            }
                          >
                            {evidenceOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ))}
                    </div>
                    <Callout tone="info" title="Evidence strength is explicit">
                      A certificate indication, an attached form, and a human-reviewed endorsement
                      are separate evidence levels.
                    </Callout>
                  </article>
                ))}
              </div>
            </div>

            <div className="form-section">
              <div className="form-section__title form-section__title--action">
                <span>03</span>
                <div>
                  <h3>Other endorsement evidence</h3>
                  <p>
                    Record form numbers or contractual endorsements included in the PDF package.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={addEndorsement}>
                  <Plus size={15} /> Add endorsement
                </Button>
              </div>
              {draft.endorsements.length === 0 ? (
                <div className="endorsement-empty">
                  No other endorsement evidence was detected. Add one when the PDF package includes
                  it.
                </div>
              ) : (
                <div className="custom-endorsement-list">
                  {draft.endorsements.map((endorsement, endorsementIndex) => (
                    <div className="custom-endorsement" key={endorsement.id}>
                      <Field label="Endorsement name">
                        <TextInput
                          value={endorsement.name}
                          onChange={(event) =>
                            updateEndorsement(endorsementIndex, "name", event.target.value)
                          }
                          placeholder="Completed operations additional insured"
                        />
                      </Field>
                      <Field label="Form number">
                        <TextInput
                          value={endorsement.formCode}
                          onChange={(event) =>
                            updateEndorsement(endorsementIndex, "formCode", event.target.value)
                          }
                          placeholder="Optional"
                        />
                      </Field>
                      <Field label="Evidence level">
                        <Select
                          value={endorsement.evidenceLevel}
                          onChange={(event) =>
                            updateEndorsement(
                              endorsementIndex,
                              "evidenceLevel",
                              event.target.value as EndorsementEvidenceDraft,
                            )
                          }
                        >
                          {evidenceOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <IconButton
                        label="Remove endorsement"
                        onClick={() => removeEndorsement(endorsementIndex)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className="review-submit-bar">
        <div>
          {confirmationMode === "staff" ? (
            <label className="confirmation-check">
              <input
                type="checkbox"
                checked={reviewConfirmed}
                onChange={(event) => setReviewConfirmed(event.target.checked)}
              />
              <span>
                <Check size={14} />
              </span>
              I reviewed these fields against the source PDF.
            </label>
          ) : (
            <p>A compliance reviewer will confirm this extraction after submission.</p>
          )}
          <small>
            OpenCOI compares this document to configured rules; it does not contact the insurer.
          </small>
        </div>
        <Button size="lg" loading={submitting} onClick={submit}>
          <ShieldCheck size={18} /> {submitLabel}
        </Button>
      </div>
      {error && (
        <Callout tone="danger" title="Submission not ready">
          {error}
        </Callout>
      )}
    </div>
  );
}
