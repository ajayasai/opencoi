import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BenchmarkCorpusV1,
  BenchmarkPredictionFileV1,
  BenchmarkScoreV1,
  BenchmarkSystemV1,
} from "../shared/benchmark.js";
import {
  BENCHMARK_SCHEMA_VERSION,
  scoreBenchmark,
  validateBenchmarkCorpus,
} from "../shared/benchmark.js";
import { canonicalBenchmarkJson, corpusSha256 } from "./serialization.js";

export const HEAD_TO_HEAD_SCHEMA_VERSION = "1.0" as const;

const nonEmpty = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Value must contain a non-whitespace character",
  });
const boundedId = nonEmpty.max(200);
const boundedName = nonEmpty.max(500);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const reportDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
    message: "Report date must be a real calendar date",
  });
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Timestamp must be a valid RFC 3339 date-time",
  });
const uniquePositivePages = z
  .array(z.number().int().positive())
  .refine((pages) => new Set(pages).size === pages.length, {
    message: "Evidence pages must be unique",
  });

const stringFieldSchema = z
  .object({
    value: nonEmpty,
    evidencePages: uniquePositivePages.optional(),
  })
  .strict();

const numberFieldSchema = z
  .object({
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidencePages: uniquePositivePages.optional(),
  })
  .strict();

const policySchema = z
  .object({
    coverageType: stringFieldSchema,
    insurerName: stringFieldSchema.optional(),
    policyNumber: stringFieldSchema.optional(),
    effectiveDate: stringFieldSchema.optional(),
    expirationDate: stringFieldSchema.optional(),
    limits: z.record(nonEmpty, numberFieldSchema).optional(),
  })
  .strict();

const endorsementSchema = z
  .object({
    name: stringFieldSchema.optional(),
    formCode: stringFieldSchema.optional(),
    evidenceLevel: stringFieldSchema,
  })
  .strict()
  .refine((endorsement) => Boolean(endorsement.name || endorsement.formCode), {
    message: "An endorsement needs a name or form code",
  });

/** Runtime counterpart to prediction-v1.schema.json. Unknown fields are rejected. */
export const normalizedPredictionV1Schema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
    corpusId: boundedId,
    corpusSha256: sha256,
    mode: z.literal("ZERO_TOUCH_TEXT_PARSE"),
    system: z.object({ id: boundedId, name: boundedName, version: boundedId }).strict(),
    cases: z.array(
      z
        .object({
          caseId: boundedId,
          facts: z
            .object({
              namedInsured: stringFieldSchema.optional(),
              certificateHolder: stringFieldSchema.optional(),
              policies: z.array(policySchema),
              endorsements: z.array(endorsementSchema),
            })
            .strict(),
          warningCodes: z.array(boundedId).refine((codes) => new Set(codes).size === codes.length, {
            message: "Warning codes must be unique",
          }),
          durationMs: z.number().finite().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const rosterSystemSchema = z.object({ id: boundedId, name: boundedName }).strict();

const authorizationSchema = z
  .object({
    accessAuthorized: z.literal(true),
    publicationPermission: z.literal(true),
    attestedBy: boundedName,
    attestedAt: timestamp,
    basis: nonEmpty.max(2_000),
  })
  .strict();

const provenanceSchema = z
  .object({
    sourceType: z.enum([
      "FIRST_PARTY_RUN",
      "VENDOR_EXPORT",
      "AUTHORIZED_MANUAL_RUN",
      "AUTHORIZED_API_RUN",
    ]),
    sourceArtifact: nonEmpty.max(2_000),
    sourceArtifactSha256: sha256.optional(),
    predictionArtifactSha256: sha256,
    outputProducedAt: timestamp,
    runBy: boundedName,
    truthAccess: z.enum(["BLINDED", "NOT_BLINDED", "UNKNOWN"]),
    normalizationMethod: nonEmpty.max(2_000),
    settings: z.record(nonEmpty.max(200), z.string().max(2_000)),
  })
  .strict();

const providedSystemSchema = z
  .object({
    system: rosterSystemSchema,
    status: z.literal("PROVIDED"),
    predictionPath: nonEmpty.max(2_000),
    authorization: authorizationSchema,
    provenance: provenanceSchema,
  })
  .strict();

const notTestedSystemSchema = z
  .object({
    system: rosterSystemSchema,
    status: z.literal("NOT_TESTED"),
    reason: nonEmpty.max(2_000),
  })
  .strict();

export const headToHeadManifestV1Schema = z
  .object({
    schemaVersion: z.literal(HEAD_TO_HEAD_SCHEMA_VERSION),
    comparisonId: boundedId,
    title: boundedName,
    reportDate,
    referenceSystemId: boundedId,
    methodology: z
      .object({
        protocol: nonEmpty.max(5_000),
        limitations: z.array(nonEmpty.max(2_000)),
      })
      .strict(),
    systems: z
      .array(z.discriminatedUnion("status", [providedSystemSchema, notTestedSystemSchema]))
      .min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.systems.map((entry) => entry.system.id);
    for (const [index, id] of ids.entries()) {
      if (ids.indexOf(id) !== index) {
        context.addIssue({
          code: "custom",
          path: ["systems", index, "system", "id"],
          message: `Duplicate system id: ${id}`,
        });
      }
    }
    const reference = manifest.systems.find(
      (entry) => entry.system.id === manifest.referenceSystemId,
    );
    if (!reference) {
      context.addIssue({
        code: "custom",
        path: ["referenceSystemId"],
        message: "Reference system is not in the roster",
      });
    } else if (reference.status !== "PROVIDED") {
      context.addIssue({
        code: "custom",
        path: ["referenceSystemId"],
        message: "Reference system must have a provided prediction artifact",
      });
    }
  });

export type HeadToHeadManifestV1 = z.infer<typeof headToHeadManifestV1Schema>;
export type HeadToHeadProvidedSystemV1 = z.infer<typeof providedSystemSchema>;

interface ScoreSummaryV1 {
  readonly facts: { readonly precision: number; readonly recall: number; readonly f1: number };
  readonly macroF1: number;
  readonly citations: { readonly precision: number; readonly recall: number };
  readonly warnings: { readonly precision: number; readonly recall: number; readonly f1: number };
  readonly exactDocuments: number;
  readonly documentCount: number;
  readonly exactDocumentRate: number;
  readonly durationMs: {
    readonly reportedCases: number;
    readonly median: number;
    readonly p95: number;
  };
}

interface ScoreDeltasV1 {
  readonly macroF1: number;
  readonly factsF1: number;
  readonly citationRecall: number;
  readonly warningF1: number;
  readonly exactDocumentRate: number;
}

export interface HeadToHeadTestedRowV1 {
  readonly system: BenchmarkSystemV1;
  readonly status: "TESTED";
  readonly authorizationEvidence: "SELF_ATTESTED_NOT_INDEPENDENTLY_VERIFIED";
  readonly authorization: HeadToHeadProvidedSystemV1["authorization"];
  readonly provenance: HeadToHeadProvidedSystemV1["provenance"] & {
    readonly normalizedPredictionSha256: string;
    readonly deterministicScoreSha256: string;
  };
  readonly score: ScoreSummaryV1;
  readonly deltaFromReference: ScoreDeltasV1;
}

export interface HeadToHeadNotTestedRowV1 {
  readonly system: { readonly id: string; readonly name: string };
  readonly status: "NOT_TESTED";
  readonly reason: string;
}

export interface HeadToHeadReportV1 {
  readonly schemaVersion: typeof HEAD_TO_HEAD_SCHEMA_VERSION;
  readonly comparisonId: string;
  readonly title: string;
  readonly reportDate: string;
  readonly corpus: {
    readonly id: string;
    readonly title: string;
    readonly sha256: string;
    readonly caseCount: number;
    readonly license: string;
  };
  readonly referenceSystemId: string;
  readonly methodology: {
    readonly mode: "ZERO_TOUCH_TEXT_PARSE";
    readonly scorer: "OpenCOI deterministic benchmark scorer 1.0";
    readonly protocol: string;
    readonly rowOrder: "SYSTEM_ID_ASCENDING_NOT_SCORE";
    readonly missingDataPolicy: "NOT_TESTED_IS_NOT_ZERO";
    readonly authorizationPolicy: "SELF_ATTESTATION_RECORDED_NOT_VERIFIED";
    readonly limitations: readonly string[];
  };
  readonly rows: readonly (HeadToHeadTestedRowV1 | HeadToHeadNotTestedRowV1)[];
}

export interface LoadedPredictionV1 {
  readonly value: unknown;
  /** SHA-256 of the exact bytes loaded by the adapter, when available. */
  readonly artifactSha256?: string;
}

export type PredictionLoader = (entry: HeadToHeadProvidedSystemV1) => Promise<LoadedPredictionV1>;

const semanticSha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalBenchmarkJson(value), "utf8").digest("hex");

const rounded = (value: number): number =>
  Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000 : 0;

const summaryFor = (score: BenchmarkScoreV1): ScoreSummaryV1 => ({
  facts: {
    precision: score.facts.precision,
    recall: score.facts.recall,
    f1: score.facts.f1,
  },
  macroF1: score.macroF1,
  citations: {
    precision: score.citations.precision,
    recall: score.citations.recall,
  },
  warnings: {
    precision: score.warnings.precision,
    recall: score.warnings.recall,
    f1: score.warnings.f1,
  },
  exactDocuments: score.exactDocuments,
  documentCount: score.documentCount,
  exactDocumentRate: score.exactDocumentRate,
  durationMs: score.durationMs,
});

const deltasFrom = (score: ScoreSummaryV1, reference: ScoreSummaryV1): ScoreDeltasV1 => ({
  macroF1: rounded(score.macroF1 - reference.macroF1),
  factsF1: rounded(score.facts.f1 - reference.facts.f1),
  citationRecall: rounded(score.citations.recall - reference.citations.recall),
  warningF1: rounded(score.warnings.f1 - reference.warnings.f1),
  exactDocumentRate: rounded(score.exactDocumentRate - reference.exactDocumentRate),
});

const parsedPrediction = (value: unknown, systemId: string): BenchmarkPredictionFileV1 => {
  const result = normalizedPredictionV1Schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ");
    throw new TypeError(`Prediction for ${systemId} violates prediction schema v1: ${detail}`);
  }
  return result.data as BenchmarkPredictionFileV1;
};

/**
 * Scores all supplied normalized artifacts against one corpus. Authorization
 * is a publisher declaration recorded for audit; this function cannot verify
 * contractual or legal rights independently.
 */
export async function buildHeadToHeadReport(
  corpusValue: unknown,
  manifestValue: unknown,
  loadPrediction: PredictionLoader,
): Promise<HeadToHeadReportV1> {
  const manifestResult = headToHeadManifestV1Schema.safeParse(manifestValue);
  if (!manifestResult.success) {
    const detail = manifestResult.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ");
    throw new TypeError(`Comparison manifest violates manifest schema v1: ${detail}`);
  }
  const manifest = manifestResult.data;
  const corpus = corpusValue as BenchmarkCorpusV1;
  validateBenchmarkCorpus(corpus);
  const checksum = corpusSha256(corpus);
  const tested = new Map<
    string,
    {
      entry: HeadToHeadProvidedSystemV1;
      prediction: BenchmarkPredictionFileV1;
      score: BenchmarkScoreV1;
    }
  >();

  for (const entry of manifest.systems) {
    if (entry.status !== "PROVIDED") continue;
    const loaded = await loadPrediction(entry);
    if (loaded.artifactSha256 !== entry.provenance.predictionArtifactSha256) {
      throw new TypeError(`Prediction artifact SHA-256 mismatch for ${entry.system.id}`);
    }
    const prediction = parsedPrediction(loaded.value, entry.system.id);
    if (prediction.system.id !== entry.system.id || prediction.system.name !== entry.system.name) {
      throw new TypeError(
        `Prediction identity for ${entry.system.id} does not match its manifest roster entry`,
      );
    }
    const score = scoreBenchmark(corpus, prediction, checksum);
    tested.set(entry.system.id, { entry, prediction, score });
  }

  const referenceResult = tested.get(manifest.referenceSystemId);
  if (!referenceResult) throw new TypeError("Reference system did not produce a tested result");
  const referenceSummary = summaryFor(referenceResult.score);

  const rows = [...manifest.systems]
    .sort((left, right) => left.system.id.localeCompare(right.system.id))
    .map<HeadToHeadTestedRowV1 | HeadToHeadNotTestedRowV1>((entry) => {
      if (entry.status === "NOT_TESTED") {
        return { system: entry.system, status: "NOT_TESTED", reason: entry.reason };
      }
      const result = tested.get(entry.system.id);
      if (!result) throw new TypeError(`No score was produced for ${entry.system.id}`);
      const summary = summaryFor(result.score);
      return {
        system: result.prediction.system,
        status: "TESTED",
        authorizationEvidence: "SELF_ATTESTED_NOT_INDEPENDENTLY_VERIFIED",
        authorization: entry.authorization,
        provenance: {
          ...entry.provenance,
          settings: Object.fromEntries(
            Object.entries(entry.provenance.settings).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
          normalizedPredictionSha256: semanticSha256(result.prediction),
          deterministicScoreSha256: semanticSha256(result.score),
        },
        score: summary,
        deltaFromReference: deltasFrom(summary, referenceSummary),
      };
    });

  return {
    schemaVersion: HEAD_TO_HEAD_SCHEMA_VERSION,
    comparisonId: manifest.comparisonId,
    title: manifest.title,
    reportDate: manifest.reportDate,
    corpus: {
      id: corpus.corpusId,
      title: corpus.title,
      sha256: checksum,
      caseCount: corpus.cases.length,
      license: corpus.license,
    },
    referenceSystemId: manifest.referenceSystemId,
    methodology: {
      mode: "ZERO_TOUCH_TEXT_PARSE",
      scorer: "OpenCOI deterministic benchmark scorer 1.0",
      protocol: manifest.methodology.protocol,
      rowOrder: "SYSTEM_ID_ASCENDING_NOT_SCORE",
      missingDataPolicy: "NOT_TESTED_IS_NOT_ZERO",
      authorizationPolicy: "SELF_ATTESTATION_RECORDED_NOT_VERIFIED",
      limitations: [
        "TESTED records a supplied normalized artifact and publisher declarations; it does not independently verify legal authorization or publication rights.",
        "NOT_TESTED means no authorized publishable artifact was supplied; it is not a zero score and has no delta.",
        "Synthetic zero-touch text parsing does not measure browser OCR, policy status, workflow quality, integrations, usability, or overall product superiority.",
        ...manifest.methodology.limitations,
      ],
    },
    rows,
  };
}

const escapeTable = (value: string): string =>
  value
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const delta = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;

/** Deterministic human-readable rendering of the machine report. */
export function renderHeadToHeadMarkdown(report: HeadToHeadReportV1): string {
  const lines = [
    `# ${report.title}`,
    "",
    `- **Report date:** ${report.reportDate}`,
    `- **Corpus:** ${report.corpus.title} (\`${report.corpus.id}\`, ${report.corpus.caseCount} cases)`,
    `- **Corpus SHA-256:** \`${report.corpus.sha256}\``,
    `- **Reference system:** \`${report.referenceSystemId}\``,
    "",
    "> `TESTED` means a normalized artifact was supplied with self-attested access and publication declarations. The harness does not independently verify those rights. `NOT_TESTED` is not a zero score.",
    "",
    "## Results",
    "",
    "Rows are ordered by stable system id, never by score.",
    "",
    "| System | Version | Status | Facts F1 | Macro F1 | Citation recall | Warning F1 | Exact documents | Facts F1 delta |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const row of report.rows) {
    if (row.status === "NOT_TESTED") {
      lines.push(
        `| ${escapeTable(row.system.name)} | — | NOT_TESTED: ${escapeTable(row.reason)} | — | — | — | — | — | — |`,
      );
      continue;
    }
    lines.push(
      `| ${escapeTable(row.system.name)} | ${escapeTable(row.system.version)} | TESTED | ${percent(row.score.facts.f1)} | ${percent(row.score.macroF1)} | ${percent(row.score.citations.recall)} | ${percent(row.score.warnings.f1)} | ${row.score.exactDocuments}/${row.score.documentCount} (${percent(row.score.exactDocumentRate)}) | ${delta(row.deltaFromReference.factsF1)} |`,
    );
  }

  lines.push("", "## Methodology", "");
  lines.push(
    `- Mode: \`${report.methodology.mode}\`.`,
    `- Scorer: ${report.methodology.scorer}.`,
    `- Protocol: ${report.methodology.protocol}`,
    `- Missing data: \`${report.methodology.missingDataPolicy}\`.`,
    `- Authorization evidence: \`${report.methodology.authorizationPolicy}\`.`,
    "- Deltas are descriptive differences from the declared reference, not ranks or statistical significance tests.",
  );

  const testedRows = report.rows.filter(
    (row): row is HeadToHeadTestedRowV1 => row.status === "TESTED",
  );
  lines.push("", "## Tested-artifact provenance", "");
  for (const row of testedRows) {
    lines.push(
      `### ${row.system.name} ${row.system.version}`,
      "",
      `- System id: \`${row.system.id}\``,
      `- Source: \`${row.provenance.sourceType}\`; ${row.provenance.sourceArtifact}`,
      ...(row.provenance.sourceArtifactSha256
        ? [`- Source artifact SHA-256: \`${row.provenance.sourceArtifactSha256}\``]
        : []),
      `- Prediction artifact SHA-256: \`${row.provenance.predictionArtifactSha256}\``,
      `- Output produced: ${row.provenance.outputProducedAt}; run by ${row.provenance.runBy}`,
      `- Truth access: \`${row.provenance.truthAccess}\``,
      `- Normalization: ${row.provenance.normalizationMethod}`,
      `- Settings: ${
        Object.entries(row.provenance.settings)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ") || "none recorded"
      }`,
      `- Normalized prediction SHA-256: \`${row.provenance.normalizedPredictionSha256}\``,
      `- Deterministic score SHA-256: \`${row.provenance.deterministicScoreSha256}\``,
      `- Authorization: self-attested by ${row.authorization.attestedBy} at ${row.authorization.attestedAt}; ${row.authorization.basis}`,
      "",
    );
  }

  lines.push("## Limitations", "");
  for (const limitation of report.methodology.limitations) lines.push(`- ${limitation}`);
  return `${lines.join("\n").trimEnd()}\n`;
}
