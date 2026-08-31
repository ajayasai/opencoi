import type {
  BenchmarkDocumentFactsV1,
  BenchmarkField,
  BenchmarkPredictionCaseV1,
  BenchmarkTextPageV1,
} from "../shared/benchmark.js";
import type { EvidenceField } from "../shared/domain.js";
import { parseCoiText } from "../shared/ocr.js";

const benchmarkField = <T extends string | number>(field: EvidenceField<T>): BenchmarkField<T> => ({
  value: field.value,
  evidencePages: field.page ? [field.page] : [],
});

export function openCoiPredictionForPages(
  caseId: string,
  pages: readonly BenchmarkTextPageV1[],
): BenchmarkPredictionCaseV1 {
  const text = pages.map((page) => `--- Page ${page.page} ---\n${page.text}`).join("\n\n");
  const extraction = parseCoiText(text);
  const facts: BenchmarkDocumentFactsV1 = {
    ...(extraction.document.namedInsured
      ? { namedInsured: benchmarkField(extraction.document.namedInsured) }
      : {}),
    ...(extraction.document.certificateHolder
      ? { certificateHolder: benchmarkField(extraction.document.certificateHolder) }
      : {}),
    policies: extraction.document.policies.map((policy) => ({
      coverageType: benchmarkField(policy.coverageType),
      ...(policy.insurerName ? { insurerName: benchmarkField(policy.insurerName) } : {}),
      ...(policy.policyNumber ? { policyNumber: benchmarkField(policy.policyNumber) } : {}),
      ...(policy.effectiveDate ? { effectiveDate: benchmarkField(policy.effectiveDate) } : {}),
      ...(policy.expirationDate ? { expirationDate: benchmarkField(policy.expirationDate) } : {}),
      limits: Object.fromEntries(
        Object.entries(policy.limits).flatMap(([limitType, field]) =>
          field ? ([[limitType, benchmarkField(field)]] as const) : [],
        ),
      ),
    })),
    endorsements: extraction.document.endorsements.map((endorsement) => ({
      ...(endorsement.name ? { name: benchmarkField(endorsement.name) } : {}),
      ...(endorsement.formCode ? { formCode: benchmarkField(endorsement.formCode) } : {}),
      evidenceLevel: benchmarkField(endorsement.evidenceLevel),
    })),
  };
  return {
    caseId,
    facts,
    warningCodes: [...new Set(extraction.warnings.map((warning) => warning.code))].sort(),
  };
}
