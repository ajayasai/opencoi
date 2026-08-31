import { z } from "zod";
import {
  addIsoDateDays,
  COVERAGE_TYPES,
  type CoiDocumentFacts,
  type CoiEndorsementEvidence,
  type CoiPolicyFacts,
  type ComplianceException,
  type ComplianceFinding,
  DOCUMENT_SCOPE,
  DOCUMENT_SCOPE_DISCLAIMER,
  type DocumentComplianceEvaluation,
  deriveDocumentComplianceLabel,
  ENDORSEMENT_EVIDENCE_LEVELS,
  ENDORSEMENT_EVIDENCE_RANK,
  type EvidenceField,
  type IsoDate,
  isIsoDate,
  isoDate,
  isoDateToEpochDay,
  LIMIT_TYPES,
  type LimitType,
  type MoneyMinor,
  moneyMinor,
} from "./domain.js";

export const RULES_SCHEMA_VERSION = "1.0" as const;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Use a stable, URL-safe identifier.");

export const isoDateSchema = z
  .string()
  .refine(isIsoDate, "Expected a real calendar date in YYYY-MM-DD format.")
  .transform(isoDate);

export const moneyMinorSchema = z
  .number()
  .int("Money must use integer minor units.")
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .transform(moneyMinor);

export const limitRequirementSchema = z
  .object({
    limitType: z.enum(LIMIT_TYPES),
    minimumMinor: moneyMinorSchema,
    /** Off by default. Enabling this is an explicit contractual rule decision. */
    allowUmbrellaStacking: z.boolean().default(false),
    /** The umbrella limit to add when explicit stacking is enabled. */
    umbrellaLimitType: z.enum(LIMIT_TYPES).optional(),
  })
  .strict()
  .superRefine((requirement, context) => {
    if (requirement.umbrellaLimitType && !requirement.allowUmbrellaStacking) {
      context.addIssue({
        code: "custom",
        path: ["umbrellaLimitType"],
        message: "umbrellaLimitType requires allowUmbrellaStacking: true.",
      });
    }
  });

export const endorsementRequirementSchema = z
  .object({
    id: identifierSchema,
    formCode: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(300).optional(),
    applicability: z.enum(["REQUIRED", "NOT_APPLICABLE"]).default("REQUIRED"),
    minimumEvidenceLevel: z.enum(ENDORSEMENT_EVIDENCE_LEVELS).default("MENTIONED"),
  })
  .strict()
  .superRefine((requirement, context) => {
    if (!requirement.formCode && !requirement.name) {
      context.addIssue({
        code: "custom",
        path: ["formCode"],
        message: "An endorsement requirement needs a formCode, a name, or both.",
      });
    }
    if (requirement.minimumEvidenceLevel === "NONE") {
      context.addIssue({
        code: "custom",
        path: ["minimumEvidenceLevel"],
        message: "A required endorsement must require at least MENTIONED evidence.",
      });
    }
  });

export const REQUIRED_POLICY_FIELDS = ["INSURER_NAME", "POLICY_NUMBER"] as const;
export type RequiredPolicyField = (typeof REQUIRED_POLICY_FIELDS)[number];

export const coverageRequirementSchema = z
  .object({
    id: identifierSchema,
    coverageType: z.enum(COVERAGE_TYPES),
    applicability: z.enum(["REQUIRED", "NOT_APPLICABLE"]).default("REQUIRED"),
    requiredPolicyFields: z.array(z.enum(REQUIRED_POLICY_FIELDS)).default([]),
    /** Zero means the policy expiration date is inclusive of evaluationDate. */
    minimumDaysRemaining: z.number().int().min(0).max(36_500).default(0),
    minimumLimits: z.array(limitRequirementSchema).default([]),
    endorsements: z.array(endorsementRequirementSchema).default([]),
  })
  .strict()
  .superRefine((requirement, context) => {
    addDuplicateIssues(
      requirement.minimumLimits.map((limit) => limit.limitType),
      ["minimumLimits"],
      "limit type",
      context,
    );
    addDuplicateIssues(
      requirement.endorsements.map((endorsement) => endorsement.id),
      ["endorsements"],
      "endorsement id",
      context,
    );
  });

export const vendorTypeRuleProfileSchema = z
  .object({
    vendorTypeId: identifierSchema,
    name: z.string().trim().min(1).max(200),
    requirements: z.array(coverageRequirementSchema).min(1),
  })
  .strict()
  .superRefine((profile, context) => {
    addDuplicateIssues(
      profile.requirements.map((requirement) => requirement.id),
      ["requirements"],
      "requirement id",
      context,
    );
  });

export const rulesetV1Schema = z
  .object({
    schemaVersion: z.literal(RULES_SCHEMA_VERSION),
    id: identifierSchema,
    name: z.string().trim().min(1).max(200),
    /** ISO 4217-style code; amounts are still always represented in minor units. */
    currency: z.string().regex(/^[A-Z]{3}$/, "Expected a three-letter uppercase currency code."),
    vendorTypes: z.array(vendorTypeRuleProfileSchema).min(1),
  })
  .strict()
  .superRefine((ruleset, context) => {
    addDuplicateIssues(
      ruleset.vendorTypes.map((profile) => profile.vendorTypeId),
      ["vendorTypes"],
      "vendor type id",
      context,
    );
  });

/** Extend this union when a new schema version is introduced. */
export const versionedRulesetSchema = z.union([rulesetV1Schema]);

export type LimitRequirement = z.output<typeof limitRequirementSchema>;
export type EndorsementRequirement = z.output<typeof endorsementRequirementSchema>;
export type CoverageRequirement = z.output<typeof coverageRequirementSchema>;
export type VendorTypeRuleProfile = z.output<typeof vendorTypeRuleProfileSchema>;
export type RulesetV1 = z.output<typeof rulesetV1Schema>;
export type RulesetV1Input = z.input<typeof rulesetV1Schema>;
export type VersionedRuleset = z.output<typeof versionedRulesetSchema>;

function addDuplicateIssues(
  values: readonly string[],
  path: readonly (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `Duplicate ${label}: ${value}`,
      });
    }
    seen.add(value);
  });
}

export function parseRuleset(input: unknown): VersionedRuleset {
  return versionedRulesetSchema.parse(input);
}

export function safeParseRuleset(input: unknown): z.ZodSafeParseResult<VersionedRuleset> {
  return versionedRulesetSchema.safeParse(input);
}

export interface ComplianceEvaluationContext {
  readonly vendorTypeId: string;
  /** Required for deterministic date evaluation; the engine never reads the system clock. */
  readonly evaluationDate: IsoDate;
}

interface CandidateEvaluation {
  readonly policyId: string;
  readonly findings: readonly ComplianceFinding[];
}

export function evaluateCompliance(
  rulesetInput: RulesetV1 | RulesetV1Input,
  document: CoiDocumentFacts,
  context: ComplianceEvaluationContext,
  exceptions: readonly ComplianceException[] = [],
): DocumentComplianceEvaluation {
  const ruleset = rulesetV1Schema.parse(rulesetInput);
  const evaluationDate = isoDate(context.evaluationDate);
  const profile = ruleset.vendorTypes.find(
    (candidate) => candidate.vendorTypeId === context.vendorTypeId,
  );

  const findings: ComplianceFinding[] = [];
  if (!profile) {
    findings.push({
      id: `profile:${context.vendorTypeId}`,
      requirementId: context.vendorTypeId,
      category: "RULE_PROFILE",
      status: "UNKNOWN",
      code: "VENDOR_TYPE_RULES_NOT_FOUND",
      title: "Vendor rules are not configured",
      explanation: `No rule profile exists for vendor type ${context.vendorTypeId}.`,
      expected: { vendorTypeId: context.vendorTypeId },
      evidenceIds: [],
    });
  } else {
    for (const requirement of profile.requirements) {
      findings.push(...evaluateCoverageRequirement(requirement, document, evaluationDate));
    }
  }

  return {
    scope: DOCUMENT_SCOPE,
    disclaimer: DOCUMENT_SCOPE_DISCLAIMER,
    documentId: document.id,
    rulesetId: ruleset.id,
    vendorTypeId: context.vendorTypeId,
    evaluationDate,
    label: deriveDocumentComplianceLabel(findings),
    findings,
    exceptions: [...exceptions],
  };
}

function evaluateCoverageRequirement(
  requirement: CoverageRequirement,
  document: CoiDocumentFacts,
  evaluationDate: IsoDate,
): readonly ComplianceFinding[] {
  if (requirement.applicability === "NOT_APPLICABLE") {
    return [
      finding(requirement.id, "coverage", {
        category: "COVERAGE",
        status: "NOT_APPLICABLE",
        code: "COVERAGE_NOT_APPLICABLE",
        title: `${coverageLabel(requirement.coverageType)} is not applicable`,
        explanation: "The selected vendor rule explicitly marks this coverage as not applicable.",
        expected: { coverageType: requirement.coverageType },
      }),
    ];
  }

  const candidates = document.policies
    .filter((policy) => policy.coverageType.value === requirement.coverageType)
    .sort((left, right) => left.id.localeCompare(right.id));

  if (candidates.length === 0) {
    const status = document.reviewStatus === "CONFIRMED" ? "FAIL" : "UNKNOWN";
    return [
      finding(requirement.id, "coverage", {
        category: "COVERAGE",
        status,
        code: status === "FAIL" ? "REQUIRED_COVERAGE_MISSING" : "COVERAGE_REVIEW_REQUIRED",
        title: `${coverageLabel(requirement.coverageType)} evidence is missing`,
        explanation:
          status === "FAIL"
            ? "A reviewer confirmed the extraction and no matching policy appears on the document."
            : "No matching policy was extracted, but the document extraction has not been confirmed.",
        expected: { coverageType: requirement.coverageType },
      }),
    ];
  }

  const candidateEvaluations = candidates.map((policy) => ({
    policyId: policy.id,
    findings: evaluatePolicy(requirement, policy, document, evaluationDate),
  }));
  candidateEvaluations.sort(compareCandidateEvaluations);
  const selected = candidateEvaluations[0];
  if (!selected) return [];

  return [...selected.findings, ...evaluateEndorsements(requirement, document)];
}

function evaluatePolicy(
  requirement: CoverageRequirement,
  policy: CoiPolicyFacts,
  document: CoiDocumentFacts,
  evaluationDate: IsoDate,
): readonly ComplianceFinding[] {
  const results: ComplianceFinding[] = [];
  const coverageConfirmed = isConfirmed(document, policy.coverageType);
  results.push(
    finding(requirement.id, `coverage:${policy.id}`, {
      category: "COVERAGE",
      status: coverageConfirmed ? "PASS" : "UNKNOWN",
      code: coverageConfirmed ? "REQUIRED_COVERAGE_FOUND" : "COVERAGE_TYPE_UNCONFIRMED",
      title: `${coverageLabel(requirement.coverageType)} policy evidence`,
      explanation: coverageConfirmed
        ? "The reviewed document contains a matching coverage section."
        : "A matching coverage section was extracted but has not been confirmed by a reviewer.",
      expected: { coverageType: requirement.coverageType },
      observed: {
        coverageType: policy.coverageType.value,
        confirmation: policy.coverageType.confirmation,
      },
      evidenceIds: [policy.id],
    }),
  );

  for (const requiredField of requirement.requiredPolicyFields) {
    const field = requiredField === "INSURER_NAME" ? policy.insurerName : policy.policyNumber;
    const fieldName = requiredField === "INSURER_NAME" ? "insurer name" : "policy number";
    let status: ComplianceFinding["status"];
    let code: string;
    let explanation: string;
    if (!field) {
      status = document.reviewStatus === "CONFIRMED" ? "FAIL" : "UNKNOWN";
      code = status === "FAIL" ? "REQUIRED_POLICY_FIELD_MISSING" : "POLICY_FIELD_REVIEW_REQUIRED";
      explanation =
        status === "FAIL"
          ? `The reviewed document does not provide a ${fieldName} for this policy.`
          : `The extraction has not confirmed whether the document provides a ${fieldName}.`;
    } else if (!isConfirmed(document, field)) {
      status = "UNKNOWN";
      code = "POLICY_FIELD_UNCONFIRMED";
      explanation = `The extracted ${fieldName} must be confirmed by a reviewer.`;
    } else {
      status = "PASS";
      code = "REQUIRED_POLICY_FIELD_FOUND";
      explanation = `The reviewed document provides a ${fieldName}.`;
    }
    results.push(
      finding(requirement.id, `field:${requiredField}:${policy.id}`, {
        category: "POLICY_FIELD",
        status,
        code,
        title: `Required ${fieldName}`,
        explanation,
        expected: { field: requiredField },
        observed: field
          ? { value: field.value, confirmation: field.confirmation }
          : { value: null },
        evidenceIds: [policy.id],
      }),
    );
  }

  results.push(evaluatePolicyPeriod(requirement, policy, document, evaluationDate));
  for (const limitRequirement of requirement.minimumLimits) {
    results.push(evaluateLimit(requirement, limitRequirement, policy, document, evaluationDate));
  }
  return results;
}

function evaluatePolicyPeriod(
  requirement: CoverageRequirement,
  policy: CoiPolicyFacts,
  document: CoiDocumentFacts,
  evaluationDate: IsoDate,
): ComplianceFinding {
  const requiredThrough = addIsoDateDays(evaluationDate, requirement.minimumDaysRemaining);
  const expected = {
    effectiveOnOrBefore: evaluationDate,
    expirationOnOrAfter: requiredThrough,
    boundary: "inclusive",
    minimumDaysRemaining: requirement.minimumDaysRemaining,
  };

  if (!policy.effectiveDate || !policy.expirationDate) {
    const status = document.reviewStatus === "CONFIRMED" ? "FAIL" : "UNKNOWN";
    return finding(requirement.id, `period:${policy.id}`, {
      category: "POLICY_PERIOD",
      status,
      code: status === "FAIL" ? "POLICY_PERIOD_MISSING" : "POLICY_PERIOD_REVIEW_REQUIRED",
      title: "Policy period",
      explanation:
        status === "FAIL"
          ? "The reviewed document is missing an effective or expiration date."
          : "The policy period cannot be decided until the extracted dates are reviewed.",
      expected,
      observed: {
        effectiveDate: policy.effectiveDate?.value ?? null,
        expirationDate: policy.expirationDate?.value ?? null,
      },
      evidenceIds: [policy.id],
    });
  }

  if (
    !isConfirmed(document, policy.effectiveDate) ||
    !isConfirmed(document, policy.expirationDate)
  ) {
    return finding(requirement.id, `period:${policy.id}`, {
      category: "POLICY_PERIOD",
      status: "UNKNOWN",
      code: "POLICY_PERIOD_UNCONFIRMED",
      title: "Policy period",
      explanation: "The extracted effective and expiration dates must be confirmed by a reviewer.",
      expected,
      observed: {
        effectiveDate: policy.effectiveDate.value,
        expirationDate: policy.expirationDate.value,
      },
      evidenceIds: [policy.id],
    });
  }

  const startsInTime =
    isoDateToEpochDay(policy.effectiveDate.value) <= isoDateToEpochDay(evaluationDate);
  const endsInTime =
    isoDateToEpochDay(policy.expirationDate.value) >= isoDateToEpochDay(requiredThrough);
  const passes = startsInTime && endsInTime;
  return finding(requirement.id, `period:${policy.id}`, {
    category: "POLICY_PERIOD",
    status: passes ? "PASS" : "FAIL",
    code: passes ? "POLICY_PERIOD_SATISFIES" : "POLICY_PERIOD_DEFICIENT",
    title: "Policy period",
    explanation: passes
      ? `The documented policy period includes ${evaluationDate} and expires on or after ${requiredThrough}.`
      : policy.effectiveDate.value > evaluationDate
        ? `The documented policy does not become effective until ${policy.effectiveDate.value}.`
        : `The documented policy expires before the required through-date of ${requiredThrough}.`,
    expected,
    observed: {
      effectiveDate: policy.effectiveDate.value,
      expirationDate: policy.expirationDate.value,
    },
    evidenceIds: [policy.id],
  });
}

function evaluateLimit(
  coverageRequirement: CoverageRequirement,
  limitRequirement: LimitRequirement,
  policy: CoiPolicyFacts,
  document: CoiDocumentFacts,
  evaluationDate: IsoDate,
): ComplianceFinding {
  const field = policy.limits[limitRequirement.limitType];
  const expected = {
    limitType: limitRequirement.limitType,
    minimumMinor: limitRequirement.minimumMinor,
    comparison: "greater_than_or_equal",
    umbrellaStacking: limitRequirement.allowUmbrellaStacking ? "EXPLICITLY_ENABLED" : "DISABLED",
  };
  if (!field) {
    const status = document.reviewStatus === "CONFIRMED" ? "FAIL" : "UNKNOWN";
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status,
      code: status === "FAIL" ? "REQUIRED_LIMIT_MISSING" : "LIMIT_REVIEW_REQUIRED",
      title: `${limitLabel(limitRequirement.limitType)} limit`,
      explanation:
        status === "FAIL"
          ? "The reviewed document does not show this required limit."
          : "The limit cannot be decided until the extraction is reviewed.",
      expected,
      observed: { valueMinor: null },
      evidenceIds: [policy.id],
    });
  }

  if (!isConfirmed(document, field)) {
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status: "UNKNOWN",
      code: "LIMIT_UNCONFIRMED",
      title: `${limitLabel(limitRequirement.limitType)} limit`,
      explanation: "The extracted limit must be confirmed before it can satisfy a requirement.",
      expected,
      observed: { valueMinor: field.value, confirmation: field.confirmation },
      evidenceIds: [policy.id],
    });
  }

  if (field.value >= limitRequirement.minimumMinor) {
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status: "PASS",
      code: "LIMIT_SATISFIES",
      title: `${limitLabel(limitRequirement.limitType)} limit`,
      explanation: `${field.value} minor units is greater than or equal to the required ${limitRequirement.minimumMinor}.`,
      expected,
      observed: { baseValueMinor: field.value, creditedValueMinor: field.value },
      evidenceIds: [policy.id],
    });
  }

  if (!limitRequirement.allowUmbrellaStacking) {
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status: "FAIL",
      code: "LIMIT_INADEQUATE",
      title: `${limitLabel(limitRequirement.limitType)} limit`,
      explanation: `${field.value} minor units is below the required ${limitRequirement.minimumMinor}; umbrella limits were not credited because stacking is disabled.`,
      expected,
      observed: { baseValueMinor: field.value, creditedValueMinor: field.value },
      evidenceIds: [policy.id],
    });
  }

  const umbrellaLimitType =
    limitRequirement.umbrellaLimitType ?? defaultUmbrellaLimitType(limitRequirement.limitType);
  const requiredThrough = addIsoDateDays(evaluationDate, coverageRequirement.minimumDaysRemaining);
  const umbrellaCandidates = document.policies
    .filter((candidate) => candidate.coverageType.value === "UMBRELLA_EXCESS_LIABILITY")
    .map((candidate) => ({
      policy: candidate,
      limit: candidate.limits[umbrellaLimitType],
      indeterminate:
        document.reviewStatus !== "CONFIRMED" ||
        candidate.coverageType.confirmation !== "CONFIRMED" ||
        candidate.limits[umbrellaLimitType]?.confirmation === "UNCONFIRMED" ||
        candidate.effectiveDate?.confirmation === "UNCONFIRMED" ||
        candidate.expirationDate?.confirmation === "UNCONFIRMED",
      usable:
        isConfirmed(document, candidate.coverageType) &&
        isConfirmed(document, candidate.limits[umbrellaLimitType]) &&
        isPolicyActiveThrough(candidate, document, evaluationDate, requiredThrough),
    }))
    .filter((candidate) => candidate.limit)
    .sort((left, right) => {
      const amountDifference = (right.limit?.value ?? 0) - (left.limit?.value ?? 0);
      return amountDifference || left.policy.id.localeCompare(right.policy.id);
    });

  const usableUmbrella = umbrellaCandidates.find((candidate) => candidate.usable);
  if (!usableUmbrella?.limit) {
    if (umbrellaCandidates.some((candidate) => candidate.indeterminate)) {
      return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
        category: "LIMIT",
        status: "UNKNOWN",
        code: "UMBRELLA_EVIDENCE_UNCONFIRMED",
        title: `${limitLabel(limitRequirement.limitType)} stacked limit`,
        explanation:
          "Umbrella stacking is enabled, but the umbrella amount or policy period is unconfirmed.",
        expected,
        observed: { baseValueMinor: field.value },
        evidenceIds: [policy.id, ...umbrellaCandidates.map((candidate) => candidate.policy.id)],
      });
    }
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status: "FAIL",
      code: "STACKED_LIMIT_INADEQUATE",
      title: `${limitLabel(limitRequirement.limitType)} stacked limit`,
      explanation:
        "Umbrella stacking is enabled, but no usable umbrella evidence appears on the document.",
      expected,
      observed: { baseValueMinor: field.value, creditedValueMinor: field.value },
      evidenceIds: [policy.id],
    });
  }

  const total = safeMoneyAdd(field.value, usableUmbrella.limit.value);
  if (total === null) {
    return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
      category: "LIMIT",
      status: "UNKNOWN",
      code: "STACKED_LIMIT_OVERFLOW",
      title: `${limitLabel(limitRequirement.limitType)} stacked limit`,
      explanation: "The stacked value exceeds the engine's safe integer range and needs review.",
      expected,
      observed: {
        baseValueMinor: field.value,
        umbrellaValueMinor: usableUmbrella.limit.value,
      },
      evidenceIds: [policy.id, usableUmbrella.policy.id],
    });
  }

  const passes = total >= limitRequirement.minimumMinor;
  return finding(coverageRequirement.id, `limit:${limitRequirement.limitType}:${policy.id}`, {
    category: "LIMIT",
    status: passes ? "PASS" : "FAIL",
    code: passes ? "STACKED_LIMIT_SATISFIES" : "STACKED_LIMIT_INADEQUATE",
    title: `${limitLabel(limitRequirement.limitType)} stacked limit`,
    explanation: `${field.value} base minor units plus ${usableUmbrella.limit.value} umbrella minor units equals ${total}, ${passes ? "meeting" : "below"} the required ${limitRequirement.minimumMinor}.`,
    expected,
    observed: {
      baseValueMinor: field.value,
      umbrellaValueMinor: usableUmbrella.limit.value,
      creditedValueMinor: total,
    },
    evidenceIds: [policy.id, usableUmbrella.policy.id],
  });
}

function evaluateEndorsements(
  coverageRequirement: CoverageRequirement,
  document: CoiDocumentFacts,
): readonly ComplianceFinding[] {
  return coverageRequirement.endorsements.map((requirement) => {
    if (requirement.applicability === "NOT_APPLICABLE") {
      return finding(coverageRequirement.id, `endorsement:${requirement.id}`, {
        category: "ENDORSEMENT",
        status: "NOT_APPLICABLE",
        code: "ENDORSEMENT_NOT_APPLICABLE",
        title: endorsementTitle(requirement.formCode, requirement.name),
        explanation:
          "The selected vendor rule explicitly marks this endorsement as not applicable.",
        expected: endorsementExpected(requirement),
      });
    }

    const matches = document.endorsements
      .filter((evidence) => endorsementMatches(requirement, evidence))
      .sort((left, right) => {
        const rank =
          ENDORSEMENT_EVIDENCE_RANK[right.evidenceLevel.value] -
          ENDORSEMENT_EVIDENCE_RANK[left.evidenceLevel.value];
        return rank || left.id.localeCompare(right.id);
      });
    const best = matches[0];
    if (!best) {
      const status = document.reviewStatus === "CONFIRMED" ? "FAIL" : "UNKNOWN";
      return finding(coverageRequirement.id, `endorsement:${requirement.id}`, {
        category: "ENDORSEMENT",
        status,
        code: status === "FAIL" ? "ENDORSEMENT_EVIDENCE_MISSING" : "ENDORSEMENT_REVIEW_REQUIRED",
        title: endorsementTitle(requirement.formCode, requirement.name),
        explanation:
          status === "FAIL"
            ? "The reviewed document contains no matching endorsement evidence."
            : "No matching evidence was extracted, but the document has not been confirmed.",
        expected: endorsementExpected(requirement),
      });
    }

    const identityConfirmed =
      (!best.formCode || isConfirmed(document, best.formCode)) &&
      (!best.name || isConfirmed(document, best.name));
    if (!identityConfirmed || !isConfirmed(document, best.evidenceLevel)) {
      return finding(coverageRequirement.id, `endorsement:${requirement.id}`, {
        category: "ENDORSEMENT",
        status: "UNKNOWN",
        code: "ENDORSEMENT_EVIDENCE_UNCONFIRMED",
        title: endorsementTitle(requirement.formCode, requirement.name),
        explanation: "Matching endorsement evidence was extracted but has not been confirmed.",
        expected: endorsementExpected(requirement),
        observed: endorsementObserved(best),
        evidenceIds: [best.id],
      });
    }

    const passes =
      ENDORSEMENT_EVIDENCE_RANK[best.evidenceLevel.value] >=
      ENDORSEMENT_EVIDENCE_RANK[requirement.minimumEvidenceLevel];
    return finding(coverageRequirement.id, `endorsement:${requirement.id}`, {
      category: "ENDORSEMENT",
      status: passes ? "PASS" : "FAIL",
      code: passes ? "ENDORSEMENT_EVIDENCE_SATISFIES" : "ENDORSEMENT_EVIDENCE_INADEQUATE",
      title: endorsementTitle(requirement.formCode, requirement.name),
      explanation: passes
        ? `${best.evidenceLevel.value} evidence meets the required ${requirement.minimumEvidenceLevel} level.`
        : `${best.evidenceLevel.value} evidence is below the required ${requirement.minimumEvidenceLevel} level.`,
      expected: endorsementExpected(requirement),
      observed: endorsementObserved(best),
      evidenceIds: [best.id],
    });
  });
}

function compareCandidateEvaluations(
  left: CandidateEvaluation,
  right: CandidateEvaluation,
): number {
  const leftCounts = statusCounts(left.findings);
  const rightCounts = statusCounts(right.findings);
  const leftAllPass = leftCounts.fail === 0 && leftCounts.unknown === 0;
  const rightAllPass = rightCounts.fail === 0 && rightCounts.unknown === 0;
  if (leftAllPass !== rightAllPass) return leftAllPass ? -1 : 1;
  const leftUnknownOnly = leftCounts.fail === 0 && leftCounts.unknown > 0;
  const rightUnknownOnly = rightCounts.fail === 0 && rightCounts.unknown > 0;
  if (leftUnknownOnly !== rightUnknownOnly) return leftUnknownOnly ? -1 : 1;
  return (
    leftCounts.fail - rightCounts.fail ||
    leftCounts.unknown - rightCounts.unknown ||
    left.policyId.localeCompare(right.policyId)
  );
}

function statusCounts(findings: readonly ComplianceFinding[]): {
  readonly fail: number;
  readonly unknown: number;
} {
  return findings.reduce(
    (counts, item) => ({
      fail: counts.fail + (item.status === "FAIL" ? 1 : 0),
      unknown: counts.unknown + (item.status === "UNKNOWN" ? 1 : 0),
    }),
    { fail: 0, unknown: 0 },
  );
}

function isConfirmed<T>(document: CoiDocumentFacts, field: EvidenceField<T> | undefined): boolean {
  return document.reviewStatus === "CONFIRMED" && field?.confirmation === "CONFIRMED";
}

function isPolicyActiveThrough(
  policy: CoiPolicyFacts,
  document: CoiDocumentFacts,
  evaluationDate: IsoDate,
  requiredThrough: IsoDate,
): boolean {
  const effectiveDate = policy.effectiveDate;
  const expirationDate = policy.expirationDate;
  if (!effectiveDate || !expirationDate) return false;
  return Boolean(
    isConfirmed(document, effectiveDate) &&
      isConfirmed(document, expirationDate) &&
      isoDateToEpochDay(effectiveDate.value) <= isoDateToEpochDay(evaluationDate) &&
      isoDateToEpochDay(expirationDate.value) >= isoDateToEpochDay(requiredThrough),
  );
}

function safeMoneyAdd(left: MoneyMinor, right: MoneyMinor): MoneyMinor | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? moneyMinor(result) : null;
}

function defaultUmbrellaLimitType(limitType: LimitType): LimitType {
  switch (limitType) {
    case "GENERAL_AGGREGATE":
    case "PRODUCTS_COMPLETED_OPERATIONS_AGGREGATE":
    case "AGGREGATE":
      return "AGGREGATE";
    default:
      return "EACH_OCCURRENCE";
  }
}

function normalizedIdentity(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function endorsementMatches(
  requirement: EndorsementRequirement,
  evidence: CoiEndorsementEvidence,
): boolean {
  if (requirement.formCode) {
    return Boolean(
      evidence.formCode &&
        normalizedIdentity(requirement.formCode) === normalizedIdentity(evidence.formCode.value),
    );
  }
  if (requirement.name && evidence.name) {
    const expected = normalizedIdentity(requirement.name);
    const actual = normalizedIdentity(evidence.name.value);
    return expected.length > 0 && actual === expected;
  }
  return false;
}

function endorsementExpected(
  requirement: EndorsementRequirement,
): Readonly<Record<string, unknown>> {
  return {
    formCode: requirement.formCode ?? null,
    name: requirement.name ?? null,
    minimumEvidenceLevel: requirement.minimumEvidenceLevel,
  };
}

function endorsementObserved(evidence: CoiEndorsementEvidence): Readonly<Record<string, unknown>> {
  return {
    formCode: evidence.formCode?.value ?? null,
    name: evidence.name?.value ?? null,
    evidenceLevel: evidence.evidenceLevel.value,
  };
}

function endorsementTitle(formCode?: string, name?: string): string {
  return [formCode, name].filter(Boolean).join(" — ") || "Required endorsement";
}

function coverageLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function limitLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

function finding(
  requirementId: string,
  suffix: string,
  value: Omit<ComplianceFinding, "id" | "requirementId" | "evidenceIds"> & {
    readonly evidenceIds?: readonly string[];
  },
): ComplianceFinding {
  return {
    id: `${requirementId}:${suffix}`,
    requirementId,
    evidenceIds: [],
    ...value,
  };
}
