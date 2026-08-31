import {
  COVERAGE_TYPES,
  ENDORSEMENT_EVIDENCE_LEVELS,
  type EndorsementEvidenceLevel,
  LIMIT_TYPES,
  type LimitType,
} from "@shared/domain";
import { Plus, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Select, TextInput } from "../components/ui";
import type { CertificateCorrectionInput, CertificateRecord, PolicyRecord } from "../types";
import { titleCase } from "../utils";

interface LimitDraft {
  id: string;
  type: LimitType;
  amount: string;
}

interface EndorsementDraft {
  id: string;
  name: string;
  formCode: string;
  evidenceLevel: Exclude<EndorsementEvidenceLevel, "NONE">;
}

interface PolicyCorrectionDraft {
  id: string;
  coverageType: string;
  insurer: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string;
  limits: LimitDraft[];
  endorsements: EndorsementDraft[];
}

export interface CertificateCorrectionDraft {
  namedInsured: string;
  issueDate: string;
  producer: string;
  certificateHolder: string;
  policies: PolicyCorrectionDraft[];
}

const id = () => crypto.randomUUID();

const occurrenceTypeFor = (coverageType: string): LimitType => {
  if (coverageType === "AUTOMOBILE_LIABILITY") return "COMBINED_SINGLE_LIMIT";
  if (coverageType === "EMPLOYERS_LIABILITY") return "EACH_ACCIDENT";
  if (["PROFESSIONAL_LIABILITY", "CYBER_LIABILITY", "POLLUTION_LIABILITY"].includes(coverageType)) {
    return "EACH_CLAIM";
  }
  return "EACH_OCCURRENCE";
};

const aggregateTypeFor = (coverageType: string): LimitType =>
  [
    "PROFESSIONAL_LIABILITY",
    "CYBER_LIABILITY",
    "POLLUTION_LIABILITY",
    "UMBRELLA_EXCESS_LIABILITY",
  ].includes(coverageType)
    ? "AGGREGATE"
    : "GENERAL_AGGREGATE";

const limitDraftsFor = (policy: PolicyRecord, policyIndex: number): LimitDraft[] => {
  const exact = Object.entries(policy.limits ?? {}).filter(
    (entry): entry is [LimitType, number] =>
      (LIMIT_TYPES as readonly string[]).includes(entry[0]) && Number.isInteger(entry[1]),
  );
  if (exact.length > 0) {
    return exact.map(([type, amount]) => ({
      id: `${policy.id ?? policyIndex}:${type}`,
      type,
      amount: String(amount / 100),
    }));
  }
  const fallback: LimitDraft[] = [];
  if (policy.eachOccurrence !== null && policy.eachOccurrence !== undefined) {
    const type = occurrenceTypeFor(policy.coverageType);
    fallback.push({
      id: `${policy.id ?? policyIndex}:${type}`,
      type,
      amount: String(policy.eachOccurrence / 100),
    });
  }
  if (policy.aggregate !== null && policy.aggregate !== undefined) {
    const type = aggregateTypeFor(policy.coverageType);
    fallback.push({
      id: `${policy.id ?? policyIndex}:${type}`,
      type,
      amount: String(policy.aggregate / 100),
    });
  }
  return fallback;
};

const endorsementDraftsFor = (policy: PolicyRecord, policyIndex: number): EndorsementDraft[] => {
  if (policy.endorsements.length > 0) {
    return policy.endorsements
      .filter((endorsement) => endorsement.evidenceLevel !== "NONE")
      .map((endorsement, index) => ({
        id: `${policy.id ?? policyIndex}:endorsement:${index}`,
        name: endorsement.name,
        formCode: endorsement.formCode ?? "",
        evidenceLevel: endorsement.evidenceLevel as Exclude<EndorsementEvidenceLevel, "NONE">,
      }));
  }
  return [
    policy.additionalInsured ? "Additional insured" : null,
    policy.waiverOfSubrogation ? "Waiver of subrogation" : null,
    policy.primaryNoncontributory ? "Primary and non-contributory" : null,
  ]
    .filter((name): name is string => Boolean(name))
    .map((name, index) => ({
      id: `${policy.id ?? policyIndex}:legacy-endorsement:${index}`,
      name,
      formCode: "",
      evidenceLevel: "MENTIONED",
    }));
};

export const correctionDraftFromCertificate = (
  certificate: CertificateRecord,
): CertificateCorrectionDraft => ({
  namedInsured: certificate.namedInsured,
  issueDate: certificate.issueDate ?? "",
  producer: certificate.producer ?? "",
  certificateHolder: certificate.certificateHolder ?? "",
  policies: certificate.policies.map((policy, policyIndex) => ({
    id: policy.id ?? `policy:${policyIndex}`,
    coverageType: policy.coverageType,
    insurer: policy.insurer,
    policyNumber: policy.policyNumber,
    effectiveDate: policy.effectiveDate,
    expirationDate: policy.expirationDate,
    limits: limitDraftsFor(policy, policyIndex),
    endorsements: endorsementDraftsFor(policy, policyIndex),
  })),
});

const minorUnits = (value: string): number => {
  if (!value.trim()) throw new Error("Every limit needs an amount.");
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Every limit must be zero or greater.");
  return Math.round(parsed * 100);
};

export const correctionInputFromDraft = (
  draft: CertificateCorrectionDraft,
): CertificateCorrectionInput => {
  const namedInsured = draft.namedInsured.trim();
  if (!namedInsured) throw new Error("Named insured is required before confirmation.");
  return {
    namedInsured,
    issueDate: draft.issueDate || null,
    producer: draft.producer.trim() || null,
    certificateHolder: draft.certificateHolder.trim() || null,
    policies: draft.policies.map((policy) => {
      if (!policy.coverageType.trim()) throw new Error("Every policy needs a coverage type.");
      const limits: Partial<Record<LimitType, number>> = {};
      for (const limit of policy.limits) {
        if (limits[limit.type] !== undefined) {
          throw new Error(`A policy cannot contain two ${titleCase(limit.type)} limits.`);
        }
        limits[limit.type] = minorUnits(limit.amount);
      }
      return {
        coverageType: policy.coverageType,
        insurer: policy.insurer.trim() || null,
        policyNumber: policy.policyNumber.trim() || null,
        effectiveDate: policy.effectiveDate || null,
        expirationDate: policy.expirationDate || null,
        limits,
        endorsements: policy.endorsements
          .filter((endorsement) => endorsement.name.trim())
          .map((endorsement) => ({
            name: endorsement.name.trim(),
            ...(endorsement.formCode.trim() ? { formCode: endorsement.formCode.trim() } : {}),
            evidenceLevel: endorsement.evidenceLevel,
          })),
      };
    }),
  };
};

export function CertificateCorrectionEditor({
  value,
  onChange,
}: {
  value: CertificateCorrectionDraft;
  onChange: (next: CertificateCorrectionDraft) => void;
}) {
  const updatePolicy = (index: number, update: Partial<PolicyCorrectionDraft>) => {
    onChange({
      ...value,
      policies: value.policies.map((policy, item) =>
        item === index ? { ...policy, ...update } : policy,
      ),
    });
  };

  return (
    <div className="correction-editor">
      <div className="form-section">
        <div className="form-section__title">
          <span>01</span>
          <div>
            <h3>Certificate parties</h3>
            <p>Correct any OCR suggestions so they match the original PDF exactly.</p>
          </div>
        </div>
        <div className="form-grid form-grid--two">
          <Field label="Named insured" className="form-grid__wide">
            <TextInput
              required
              value={value.namedInsured}
              onChange={(event) => onChange({ ...value, namedInsured: event.target.value })}
            />
          </Field>
          <Field label="Producer / broker">
            <TextInput
              value={value.producer}
              onChange={(event) => onChange({ ...value, producer: event.target.value })}
            />
          </Field>
          <Field label="Certificate holder">
            <TextInput
              value={value.certificateHolder}
              onChange={(event) => onChange({ ...value, certificateHolder: event.target.value })}
            />
          </Field>
          <Field label="Issue date">
            <TextInput
              type="date"
              value={value.issueDate}
              onChange={(event) => onChange({ ...value, issueDate: event.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section__title form-section__title--action">
          <span>02</span>
          <div>
            <h3>Policies, exact limits, and endorsements</h3>
            <p>Limit labels remain distinct and are evaluated without silent remapping.</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                policies: [
                  ...value.policies,
                  {
                    id: id(),
                    coverageType: "OTHER",
                    insurer: "",
                    policyNumber: "",
                    effectiveDate: "",
                    expirationDate: "",
                    limits: [],
                    endorsements: [],
                  },
                ],
              })
            }
          >
            <Plus size={15} /> Add policy
          </Button>
        </div>

        <div className="policy-list">
          {value.policies.map((policy, policyIndex) => (
            <article className="policy-editor" key={policy.id}>
              <header>
                <div>
                  <span>{String(policyIndex + 1).padStart(2, "0")}</span>
                  <strong>{titleCase(policy.coverageType)}</strong>
                </div>
                <IconButton
                  label={`Remove policy ${policyIndex + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      policies: value.policies.filter((_, index) => index !== policyIndex),
                    })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </header>
              <div className="form-grid form-grid--two">
                <Field label="Coverage type" className="form-grid__wide">
                  <Select
                    value={policy.coverageType}
                    onChange={(event) =>
                      updatePolicy(policyIndex, { coverageType: event.target.value })
                    }
                  >
                    {COVERAGE_TYPES.map((coverageType) => (
                      <option key={coverageType} value={coverageType}>
                        {titleCase(coverageType)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Insurer">
                  <TextInput
                    value={policy.insurer}
                    onChange={(event) => updatePolicy(policyIndex, { insurer: event.target.value })}
                  />
                </Field>
                <Field label="Policy number">
                  <TextInput
                    value={policy.policyNumber}
                    onChange={(event) =>
                      updatePolicy(policyIndex, { policyNumber: event.target.value })
                    }
                  />
                </Field>
                <Field label="Effective date">
                  <TextInput
                    type="date"
                    value={policy.effectiveDate}
                    onChange={(event) =>
                      updatePolicy(policyIndex, { effectiveDate: event.target.value })
                    }
                  />
                </Field>
                <Field label="Expiration date">
                  <TextInput
                    type="date"
                    value={policy.expirationDate}
                    onChange={(event) =>
                      updatePolicy(policyIndex, { expirationDate: event.target.value })
                    }
                  />
                </Field>
              </div>

              <div className="correction-subsection">
                <div className="correction-subsection__heading">
                  <div>
                    <strong>Limits</strong>
                    <small>Amounts are entered in major USD units.</small>
                  </div>
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    onClick={() =>
                      updatePolicy(policyIndex, {
                        limits: [
                          ...policy.limits,
                          { id: id(), type: "EACH_OCCURRENCE", amount: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} /> Add limit
                  </Button>
                </div>
                {policy.limits.map((limit, limitIndex) => (
                  <div className="correction-row" key={limit.id}>
                    <Field label={`Limit ${limitIndex + 1} type`}>
                      <Select
                        value={limit.type}
                        onChange={(event) =>
                          updatePolicy(policyIndex, {
                            limits: policy.limits.map((item, index) =>
                              index === limitIndex
                                ? { ...item, type: event.target.value as LimitType }
                                : item,
                            ),
                          })
                        }
                      >
                        {LIMIT_TYPES.map((limitType) => (
                          <option key={limitType} value={limitType}>
                            {titleCase(limitType)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={`Limit ${limitIndex + 1} amount`}>
                      <TextInput
                        inputMode="decimal"
                        value={limit.amount}
                        onChange={(event) =>
                          updatePolicy(policyIndex, {
                            limits: policy.limits.map((item, index) =>
                              index === limitIndex ? { ...item, amount: event.target.value } : item,
                            ),
                          })
                        }
                        placeholder="1,000,000"
                      />
                    </Field>
                    <IconButton
                      label={`Remove limit ${limitIndex + 1}`}
                      onClick={() =>
                        updatePolicy(policyIndex, {
                          limits: policy.limits.filter((_, index) => index !== limitIndex),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                ))}
              </div>

              <div className="correction-subsection">
                <div className="correction-subsection__heading">
                  <div>
                    <strong>Endorsement evidence</strong>
                    <small>Record the exact evidence strength shown in the package.</small>
                  </div>
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    onClick={() =>
                      updatePolicy(policyIndex, {
                        endorsements: [
                          ...policy.endorsements,
                          { id: id(), name: "", formCode: "", evidenceLevel: "MENTIONED" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} /> Add endorsement
                  </Button>
                </div>
                {policy.endorsements.map((endorsement, endorsementIndex) => (
                  <div className="correction-row correction-row--endorsement" key={endorsement.id}>
                    <Field label={`Endorsement ${endorsementIndex + 1}`}>
                      <TextInput
                        value={endorsement.name}
                        onChange={(event) =>
                          updatePolicy(policyIndex, {
                            endorsements: policy.endorsements.map((item, index) =>
                              index === endorsementIndex
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="Form number">
                      <TextInput
                        value={endorsement.formCode}
                        onChange={(event) =>
                          updatePolicy(policyIndex, {
                            endorsements: policy.endorsements.map((item, index) =>
                              index === endorsementIndex
                                ? { ...item, formCode: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="Evidence level">
                      <Select
                        value={endorsement.evidenceLevel}
                        onChange={(event) =>
                          updatePolicy(policyIndex, {
                            endorsements: policy.endorsements.map((item, index) =>
                              index === endorsementIndex
                                ? {
                                    ...item,
                                    evidenceLevel: event.target.value as Exclude<
                                      EndorsementEvidenceLevel,
                                      "NONE"
                                    >,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        {ENDORSEMENT_EVIDENCE_LEVELS.filter((level) => level !== "NONE").map(
                          (level) => (
                            <option key={level} value={level}>
                              {titleCase(level)}
                            </option>
                          ),
                        )}
                      </Select>
                    </Field>
                    <IconButton
                      label={`Remove endorsement ${endorsementIndex + 1}`}
                      onClick={() =>
                        updatePolicy(policyIndex, {
                          endorsements: policy.endorsements.filter(
                            (_, index) => index !== endorsementIndex,
                          ),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
