import { describe, expect, it } from "vitest";
import {
  type CoiDocumentFacts,
  type CoiEndorsementEvidence,
  type CoiPolicyFacts,
  type ComplianceException,
  DOCUMENT_SCOPE_DISCLAIMER,
  type EvidenceField,
  evidenceField,
  isoDate,
  moneyMinor,
} from "./domain.js";
import {
  type CoverageRequirement,
  evaluateCompliance,
  parseRuleset,
  RULES_SCHEMA_VERSION,
  type RulesetV1,
  rulesetV1Schema,
  safeParseRuleset,
} from "./rules.js";

function confirmed<T>(value: T): EvidenceField<T> {
  return evidenceField(value, { confirmation: "CONFIRMED", source: "MANUAL" });
}

function unconfirmed<T>(value: T): EvidenceField<T> {
  return evidenceField(value, {
    confirmation: "UNCONFIRMED",
    source: "OCR",
    confidenceBps: 9_000,
  });
}

function makeRules(requirement: Partial<CoverageRequirement> = {}): RulesetV1 {
  return rulesetV1Schema.parse({
    schemaVersion: RULES_SCHEMA_VERSION,
    id: "rules-1",
    name: "Contractor requirements",
    currency: "USD",
    vendorTypes: [
      {
        vendorTypeId: "contractor",
        name: "Contractor",
        requirements: [
          {
            id: "cgl",
            coverageType: "COMMERCIAL_GENERAL_LIABILITY",
            minimumDaysRemaining: 0,
            minimumLimits: [
              {
                limitType: "EACH_OCCURRENCE",
                minimumMinor: 100_000_000,
              },
            ],
            ...requirement,
          },
        ],
      },
    ],
  });
}

function cglPolicy(overrides: Partial<CoiPolicyFacts> = {}): CoiPolicyFacts {
  return {
    id: "policy-cgl",
    coverageType: confirmed("COMMERCIAL_GENERAL_LIABILITY"),
    insurerName: confirmed("Example Insurance Co."),
    policyNumber: confirmed("CGL-12345"),
    effectiveDate: confirmed(isoDate("2026-01-01")),
    expirationDate: confirmed(isoDate("2027-01-01")),
    limits: { EACH_OCCURRENCE: confirmed(moneyMinor(100_000_000)) },
    ...overrides,
  };
}

function documentFacts(
  policyOverrides: Partial<CoiPolicyFacts> = {},
  documentOverrides: Partial<CoiDocumentFacts> = {},
): CoiDocumentFacts {
  return {
    id: "doc-1",
    reviewStatus: "CONFIRMED",
    policies: [cglPolicy(policyOverrides)],
    endorsements: [],
    ...documentOverrides,
  };
}

const evaluationContext = {
  vendorTypeId: "contractor",
  evaluationDate: isoDate("2026-06-01"),
};

function findingByCode(result: ReturnType<typeof evaluateCompliance>, code: string) {
  const resultFinding = result.findings.find((finding) => finding.code === code);
  expect(resultFinding, `Expected finding code ${code}`).toBeDefined();
  return resultFinding;
}

describe("versioned rule schema", () => {
  it("applies safe defaults, including disabled umbrella stacking", () => {
    const parsed = makeRules();
    const requirement = parsed.vendorTypes[0]?.requirements[0];
    expect(parsed.schemaVersion).toBe("1.0");
    expect(requirement?.applicability).toBe("REQUIRED");
    expect(requirement?.requiredPolicyFields).toEqual([]);
    expect(requirement?.minimumLimits[0]?.allowUmbrellaStacking).toBe(false);
  });

  it("rejects unsupported versions, fractional money, and unknown keys", () => {
    const valid = makeRules();
    expect(safeParseRuleset({ ...valid, schemaVersion: "2.0" }).success).toBe(false);
    expect(
      safeParseRuleset({
        ...valid,
        vendorTypes: [
          {
            ...valid.vendorTypes[0],
            requirements: [
              {
                ...valid.vendorTypes[0]?.requirements[0],
                minimumLimits: [{ limitType: "EACH_OCCURRENCE", minimumMinor: 1.5 }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(() => parseRuleset({ ...valid, undocumentedOption: true })).toThrow();
  });

  it("rejects duplicate stable ids and unsafe umbrella configuration", () => {
    const valid = makeRules();
    const profile = valid.vendorTypes[0];
    expect(
      safeParseRuleset({
        ...valid,
        vendorTypes: [profile, profile],
      }).success,
    ).toBe(false);
    expect(
      safeParseRuleset({
        ...valid,
        vendorTypes: [
          {
            ...profile,
            requirements: [
              {
                ...profile?.requirements[0],
                minimumLimits: [
                  {
                    limitType: "EACH_OCCURRENCE",
                    minimumMinor: 1,
                    umbrellaLimitType: "EACH_OCCURRENCE",
                    allowUmbrellaStacking: false,
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("explainable compliance evaluation", () => {
  it("produces a document-scoped compliant result at exact boundaries", () => {
    const result = evaluateCompliance(makeRules(), documentFacts(), evaluationContext);
    expect(result.label).toBe("DOCUMENT_COMPLIANT");
    expect(result.scope).toBe("UPLOADED_DOCUMENT");
    expect(result.disclaimer).toBe(DOCUMENT_SCOPE_DISCLAIMER);
    expect(result.disclaimer).toMatch(/does not verify.*currently active/i);
    expect(result.findings.every((finding) => finding.status === "PASS")).toBe(true);
    expect(findingByCode(result, "LIMIT_SATISFIES")?.observed).toMatchObject({
      creditedValueMinor: 100_000_000,
    });
  });

  it("never lets a wholly unconfirmed extraction pass", () => {
    const result = evaluateCompliance(
      makeRules(),
      documentFacts(
        {
          coverageType: unconfirmed("COMMERCIAL_GENERAL_LIABILITY"),
          effectiveDate: unconfirmed(isoDate("2026-01-01")),
          expirationDate: unconfirmed(isoDate("2027-01-01")),
          limits: { EACH_OCCURRENCE: unconfirmed(moneyMinor(100_000_000)) },
        },
        { reviewStatus: "UNCONFIRMED" },
      ),
      evaluationContext,
    );
    expect(result.label).toBe("DOCUMENT_REVIEW_REQUIRED");
    expect(result.findings.some((finding) => finding.status === "PASS")).toBe(false);
    expect(result.findings.every((finding) => finding.status === "UNKNOWN")).toBe(true);
  });

  it("treats an unconfirmed amount at or above the threshold as UNKNOWN", () => {
    const result = evaluateCompliance(
      makeRules(),
      documentFacts({
        limits: { EACH_OCCURRENCE: unconfirmed(moneyMinor(200_000_000)) },
      }),
      evaluationContext,
    );
    expect(findingByCode(result, "LIMIT_UNCONFIRMED")?.status).toBe("UNKNOWN");
    expect(result.label).toBe("DOCUMENT_REVIEW_REQUIRED");
  });

  it("uses an inclusive monetary boundary and fails one minor unit below", () => {
    const exact = evaluateCompliance(
      makeRules(),
      documentFacts({ limits: { EACH_OCCURRENCE: confirmed(moneyMinor(100_000_000)) } }),
      evaluationContext,
    );
    expect(findingByCode(exact, "LIMIT_SATISFIES")?.status).toBe("PASS");

    const below = evaluateCompliance(
      makeRules(),
      documentFacts({ limits: { EACH_OCCURRENCE: confirmed(moneyMinor(99_999_999)) } }),
      evaluationContext,
    );
    expect(findingByCode(below, "LIMIT_INADEQUATE")?.status).toBe("FAIL");
    expect(below.label).toBe("DOCUMENT_NON_COMPLIANT");
  });

  it("uses inclusive effective and required-through date boundaries", () => {
    const rules = makeRules({ minimumDaysRemaining: 30, minimumLimits: [] });
    const context = { vendorTypeId: "contractor", evaluationDate: isoDate("2026-01-01") };
    const exact = evaluateCompliance(
      rules,
      documentFacts({
        effectiveDate: confirmed(isoDate("2026-01-01")),
        expirationDate: confirmed(isoDate("2026-01-31")),
      }),
      context,
    );
    expect(findingByCode(exact, "POLICY_PERIOD_SATISFIES")?.status).toBe("PASS");

    const expiresOneDayEarly = evaluateCompliance(
      rules,
      documentFacts({ expirationDate: confirmed(isoDate("2026-01-30")) }),
      context,
    );
    expect(findingByCode(expiresOneDayEarly, "POLICY_PERIOD_DEFICIENT")?.status).toBe("FAIL");

    const startsOneDayLate = evaluateCompliance(
      rules,
      documentFacts({ effectiveDate: confirmed(isoDate("2026-01-02")) }),
      context,
    );
    expect(findingByCode(startsOneDayLate, "POLICY_PERIOD_DEFICIENT")?.explanation).toMatch(
      /does not become effective/i,
    );
  });

  it("does not credit an umbrella unless the limit rule explicitly enables stacking", () => {
    const umbrella: CoiPolicyFacts = {
      id: "policy-umbrella",
      coverageType: confirmed("UMBRELLA_EXCESS_LIABILITY"),
      effectiveDate: confirmed(isoDate("2026-01-01")),
      expirationDate: confirmed(isoDate("2027-01-01")),
      limits: { EACH_OCCURRENCE: confirmed(moneyMinor(60_000_000)) },
    };
    const document = documentFacts(
      { limits: { EACH_OCCURRENCE: confirmed(moneyMinor(50_000_000)) } },
      {
        policies: [
          cglPolicy({ limits: { EACH_OCCURRENCE: confirmed(moneyMinor(50_000_000)) } }),
          umbrella,
        ],
      },
    );

    const defaultResult = evaluateCompliance(makeRules(), document, evaluationContext);
    const defaultLimit = findingByCode(defaultResult, "LIMIT_INADEQUATE");
    expect(defaultLimit?.status).toBe("FAIL");
    expect(defaultLimit?.explanation).toMatch(/stacking is disabled/i);
    expect(defaultLimit?.observed).not.toHaveProperty("umbrellaValueMinor");

    const explicitRules = makeRules({
      minimumLimits: [
        {
          limitType: "EACH_OCCURRENCE",
          minimumMinor: moneyMinor(100_000_000),
          allowUmbrellaStacking: true,
          umbrellaLimitType: "EACH_OCCURRENCE",
        },
      ],
    });
    const explicitResult = evaluateCompliance(explicitRules, document, evaluationContext);
    expect(findingByCode(explicitResult, "STACKED_LIMIT_SATISFIES")?.observed).toMatchObject({
      baseValueMinor: 50_000_000,
      umbrellaValueMinor: 60_000_000,
      creditedValueMinor: 110_000_000,
    });
    expect(explicitResult.label).toBe("DOCUMENT_COMPLIANT");
  });

  it("fails rather than defers when confirmed umbrella evidence is expired", () => {
    const umbrella = cglPolicy({
      id: "expired-umbrella",
      coverageType: confirmed("UMBRELLA_EXCESS_LIABILITY"),
      expirationDate: confirmed(isoDate("2026-05-31")),
      limits: { EACH_OCCURRENCE: confirmed(moneyMinor(100_000_000)) },
    });
    const rules = makeRules({
      minimumLimits: [
        {
          limitType: "EACH_OCCURRENCE",
          minimumMinor: moneyMinor(100_000_000),
          allowUmbrellaStacking: true,
        },
      ],
    });
    const result = evaluateCompliance(
      rules,
      documentFacts(
        {},
        {
          policies: [
            cglPolicy({ limits: { EACH_OCCURRENCE: confirmed(moneyMinor(50_000_000)) } }),
            umbrella,
          ],
        },
      ),
      evaluationContext,
    );
    expect(findingByCode(result, "STACKED_LIMIT_INADEQUATE")?.status).toBe("FAIL");
  });

  it("compares explicit endorsement evidence levels", () => {
    const rules = makeRules({
      minimumLimits: [],
      endorsements: [
        {
          id: "additional-insured",
          formCode: "CG 20 10",
          applicability: "REQUIRED",
          minimumEvidenceLevel: "ATTACHED",
        },
      ],
    });
    const mentioned: CoiEndorsementEvidence = {
      id: "end-1",
      formCode: confirmed("CG2010"),
      evidenceLevel: confirmed("MENTIONED"),
    };
    const inadequate = evaluateCompliance(
      rules,
      documentFacts({}, { endorsements: [mentioned] }),
      evaluationContext,
    );
    expect(findingByCode(inadequate, "ENDORSEMENT_EVIDENCE_INADEQUATE")?.status).toBe("FAIL");

    const attached = evaluateCompliance(
      rules,
      documentFacts({}, { endorsements: [{ ...mentioned, evidenceLevel: confirmed("ATTACHED") }] }),
      evaluationContext,
    );
    expect(findingByCode(attached, "ENDORSEMENT_EVIDENCE_SATISFIES")?.status).toBe("PASS");

    const pendingReview = evaluateCompliance(
      rules,
      documentFacts(
        {},
        { endorsements: [{ ...mentioned, evidenceLevel: unconfirmed("ATTACHED") }] },
      ),
      evaluationContext,
    );
    expect(findingByCode(pendingReview, "ENDORSEMENT_EVIDENCE_UNCONFIRMED")?.status).toBe(
      "UNKNOWN",
    );
  });

  it("does not let generic names or mismatched form codes satisfy specific endorsements", () => {
    const namedRules = makeRules({
      minimumLimits: [],
      endorsements: [
        {
          id: "ongoing-completed-operations",
          name: "Additional insured ongoing and completed operations",
          applicability: "REQUIRED",
          minimumEvidenceLevel: "HUMAN_VERIFIED",
        },
      ],
    });
    const genericName = evaluateCompliance(
      namedRules,
      documentFacts(
        {},
        {
          endorsements: [
            {
              id: "generic-ai",
              name: confirmed("Additional insured"),
              evidenceLevel: confirmed("HUMAN_VERIFIED"),
            },
          ],
        },
      ),
      evaluationContext,
    );
    expect(findingByCode(genericName, "ENDORSEMENT_EVIDENCE_MISSING")?.status).toBe("FAIL");

    const formRules = makeRules({
      minimumLimits: [],
      endorsements: [
        {
          id: "specific-form",
          formCode: "CG 20 10",
          name: "Additional insured",
          applicability: "REQUIRED",
          minimumEvidenceLevel: "ATTACHED",
        },
      ],
    });
    const wrongForm = evaluateCompliance(
      formRules,
      documentFacts(
        {},
        {
          endorsements: [
            {
              id: "different-form",
              formCode: confirmed("CG 20 37"),
              name: confirmed("Additional insured"),
              evidenceLevel: confirmed("ATTACHED"),
            },
          ],
        },
      ),
      evaluationContext,
    );
    expect(findingByCode(wrongForm, "ENDORSEMENT_EVIDENCE_MISSING")?.status).toBe("FAIL");
  });

  it("keeps approved exceptions separate from the base decision", () => {
    const exception: ComplianceException = {
      id: "exception-1",
      findingIds: ["cgl:limit:EACH_OCCURRENCE:policy-cgl"],
      status: "APPROVED",
      reason: "Time-limited business approval",
      requestedBy: "user-1",
      requestedOn: isoDate("2026-05-01"),
      decidedBy: "user-2",
      decidedOn: isoDate("2026-05-02"),
    };
    const result = evaluateCompliance(
      makeRules(),
      documentFacts({ limits: { EACH_OCCURRENCE: confirmed(moneyMinor(1)) } }),
      evaluationContext,
      [exception],
    );
    expect(result.label).toBe("DOCUMENT_NON_COMPLIANT");
    expect(result.findings.some((finding) => finding.status === "FAIL")).toBe(true);
    expect(result.exceptions).toEqual([exception]);
  });

  it("emits NOT_APPLICABLE findings and label when the profile says so", () => {
    const result = evaluateCompliance(
      makeRules({ applicability: "NOT_APPLICABLE", minimumLimits: [] }),
      documentFacts({}, { policies: [] }),
      evaluationContext,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.status).toBe("NOT_APPLICABLE");
    expect(result.label).toBe("DOCUMENT_NOT_APPLICABLE");
  });

  it("distinguishes reviewed missing coverage from an unreviewed extraction", () => {
    const reviewed = evaluateCompliance(
      makeRules(),
      documentFacts({}, { policies: [] }),
      evaluationContext,
    );
    expect(findingByCode(reviewed, "REQUIRED_COVERAGE_MISSING")?.status).toBe("FAIL");

    const unreviewed = evaluateCompliance(
      makeRules(),
      documentFacts({}, { policies: [], reviewStatus: "UNCONFIRMED" }),
      evaluationContext,
    );
    expect(findingByCode(unreviewed, "COVERAGE_REVIEW_REQUIRED")?.status).toBe("UNKNOWN");
  });

  it("returns a review-required result when no vendor profile is configured", () => {
    const result = evaluateCompliance(makeRules(), documentFacts(), {
      vendorTypeId: "unknown-type",
      evaluationDate: evaluationContext.evaluationDate,
    });
    expect(result.label).toBe("DOCUMENT_REVIEW_REQUIRED");
    expect(findingByCode(result, "VENDOR_TYPE_RULES_NOT_FOUND")?.status).toBe("UNKNOWN");
  });

  it("requires configured policy identifiers and explains missing fields", () => {
    const result = evaluateCompliance(
      makeRules({ requiredPolicyFields: ["INSURER_NAME", "POLICY_NUMBER"] }),
      documentFacts({ policyNumber: undefined }),
      evaluationContext,
    );
    const missing = findingByCode(result, "REQUIRED_POLICY_FIELD_MISSING");
    expect(missing?.status).toBe("FAIL");
    expect(missing?.observed).toEqual({ value: null });
  });

  it("deterministically selects a complete passing policy among duplicate coverage records", () => {
    const failed = cglPolicy({
      id: "a-failed",
      limits: { EACH_OCCURRENCE: confirmed(moneyMinor(1)) },
    });
    const passing = cglPolicy({ id: "b-passing" });
    const result = evaluateCompliance(
      makeRules(),
      documentFacts({}, { policies: [failed, passing] }),
      evaluationContext,
    );
    expect(result.label).toBe("DOCUMENT_COMPLIANT");
    expect(result.findings.every((finding) => finding.evidenceIds.includes("b-passing"))).toBe(
      true,
    );
  });
});
