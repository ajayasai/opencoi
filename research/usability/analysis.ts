import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STUDY_SCHEMA_VERSION = "1.1";

const COLUMNS = [
  "schema_version",
  "dataset_kind",
  "product_commit",
  "session_id",
  "role",
  "accessibility_mode",
  "task_code",
  "outcome",
  "duration_seconds",
  "error_count",
  "critical_incident_count",
  "session_scope_comprehension_correct",
  "confidence_rating",
  "issue_code",
] as const;

const ROLES = ["coi_reviewer", "procurement_manager", "vendor_uploader"] as const;
const ACCESSIBILITY_MODES = [
  "standard",
  "keyboard_only",
  "screen_reader",
  "magnification",
  "voice_control",
] as const;
const TASK_CODES = [
  "T01_CREATE_REQUIREMENTS",
  "T02_CREATE_VENDOR_LINK",
  "T03_VENDOR_UPLOAD",
  "T04_REVIEW_CORRECT",
  "T05_EXPLAIN_FINDING",
  "T06_DECIDE_EXCEPTION",
  "T07_EXPORT_STATUS",
  "T08_RENEWAL_REMINDER",
] as const;
const ALLOCATED_TASKS = {
  coi_reviewer: ["T04_REVIEW_CORRECT", "T05_EXPLAIN_FINDING", "T06_DECIDE_EXCEPTION"],
  procurement_manager: [
    "T01_CREATE_REQUIREMENTS",
    "T02_CREATE_VENDOR_LINK",
    "T06_DECIDE_EXCEPTION",
    "T07_EXPORT_STATUS",
    "T08_RENEWAL_REMINDER",
  ],
  vendor_uploader: ["T03_VENDOR_UPLOAD"],
} as const satisfies Record<(typeof ROLES)[number], readonly (typeof TASK_CODES)[number][]>;
const OUTCOMES = ["unassisted", "assisted", "not_completed"] as const;
const ISSUE_CODES = [
  "none",
  "navigation",
  "labeling",
  "document_review",
  "rule_comprehension",
  "status_comprehension",
  "exception_workflow",
  "reminder_workflow",
  "export_workflow",
  "assistive_technology",
  "performance",
  "other",
] as const;

type Role = (typeof ROLES)[number];
type AccessibilityMode = (typeof ACCESSIBILITY_MODES)[number];
type TaskCode = (typeof TASK_CODES)[number];
type Outcome = (typeof OUTCOMES)[number];
type IssueCode = (typeof ISSUE_CODES)[number];
type DatasetKind = "synthetic" | "participant";

export interface StudyObservation {
  schemaVersion: typeof STUDY_SCHEMA_VERSION;
  datasetKind: DatasetKind;
  productCommit: string;
  sessionId: string;
  role: Role;
  accessibilityMode: AccessibilityMode;
  taskCode: TaskCode;
  outcome: Outcome;
  durationSeconds: number;
  errorCount: number;
  criticalIncidentCount: number;
  scopeComprehensionCorrect: boolean;
  confidenceRating: number;
  issueCode: IssueCode;
}

export interface RateSummary {
  numerator: number;
  denominator: number;
  rate: number;
  lower95: number;
  upper95: number;
}

export interface VisibleCohortSummary {
  suppressed: false;
  participantCount: number;
  observationCount: number;
  outcomes: Record<Outcome, number>;
  unassistedCompletion: RateSummary;
  anyCompletion: RateSummary;
  scopeComprehension: RateSummary;
  medianCompletedSeconds: number | null;
  medianConfidence: number | null;
  meanConfidence: number;
  errorCount: number;
  criticalIncidentCount: number;
  issues: Partial<Record<IssueCode, number>>;
}

export interface SuppressedCohortSummary {
  suppressed: true;
  participantCount: `<${number}`;
}

export type CohortSummary = VisibleCohortSummary | SuppressedCohortSummary;

export interface StudyAnalysis {
  schemaVersion: typeof STUDY_SCHEMA_VERSION;
  evidenceStatus: "synthetic_only" | "participant_aggregate";
  productCommit: string;
  minimumPublishedCellSize: number;
  overall: CohortSummary;
  byRole: Record<Role, CohortSummary>;
  byTask: Partial<Record<TaskCode, CohortSummary>>;
  byRoleTask: Record<Role, Partial<Record<TaskCode, CohortSummary>>>;
  byAccessibilityMode: Record<AccessibilityMode, CohortSummary>;
  limitations: string[];
}

export class StudyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyDataError";
  }
}

const parseCsvRows = (source: string): string[][] => {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quoted) {
      if (character === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) throw new StudyDataError("A quoted CSV cell must start with a quote");
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new StudyDataError("CSV contains an unterminated quoted cell");
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
};

const oneOf = <T extends string>(
  value: string,
  allowed: readonly T[],
  column: string,
  rowNumber: number,
): T => {
  if (!allowed.includes(value as T)) {
    throw new StudyDataError(`Row ${rowNumber}: ${column} has an unsupported value`);
  }
  return value as T;
};

const integer = (
  value: string,
  column: string,
  rowNumber: number,
  minimum: number,
  maximum: number,
): number => {
  if (!/^\d+$/.test(value)) {
    throw new StudyDataError(`Row ${rowNumber}: ${column} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new StudyDataError(`Row ${rowNumber}: ${column} is outside the accepted range`);
  }
  return parsed;
};

const boolean = (value: string, column: string, rowNumber: number): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new StudyDataError(`Row ${rowNumber}: ${column} must be true or false`);
};

const rejectSensitiveValue = (value: string, rowNumber: number): void => {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) {
    throw new StudyDataError(`Row ${rowNumber}: email-like values are forbidden`);
  }
  if (/https?:\/\//i.test(value)) {
    throw new StudyDataError(`Row ${rowNumber}: URLs are forbidden`);
  }
};

export const parseStudyCsv = (source: string): StudyObservation[] => {
  const rows = parseCsvRows(source);
  if (rows.length < 2) throw new StudyDataError("Study CSV must contain a header and observations");
  const header = rows[0] ?? [];
  if (header.length !== COLUMNS.length || header.some((value, index) => value !== COLUMNS[index])) {
    throw new StudyDataError(
      `Study CSV header must exactly match the privacy-reviewed schema: ${COLUMNS.join(",")}`,
    );
  }

  const observations = rows.slice(1).map((values, index): StudyObservation => {
    const rowNumber = index + 2;
    if (values.length !== COLUMNS.length) {
      throw new StudyDataError(`Row ${rowNumber}: expected ${COLUMNS.length} columns`);
    }
    values.forEach((value) => {
      rejectSensitiveValue(value, rowNumber);
    });
    const row = Object.fromEntries(
      COLUMNS.map((column, columnIndex) => [column, values[columnIndex]]),
    );
    if (row.schema_version !== STUDY_SCHEMA_VERSION) {
      throw new StudyDataError(`Row ${rowNumber}: unsupported schema_version`);
    }
    const datasetKind = oneOf(
      row.dataset_kind ?? "",
      ["synthetic", "participant"],
      "dataset_kind",
      rowNumber,
    );
    const sessionId = row.session_id ?? "";
    const validSessionId =
      datasetKind === "synthetic"
        ? /^SYN-[A-Z0-9]{3,12}$/.test(sessionId)
        : /^P-[A-F0-9]{12}$/.test(sessionId);
    if (!validSessionId) {
      throw new StudyDataError(`Row ${rowNumber}: session_id is not a valid pseudonymous ID`);
    }
    const productCommit = row.product_commit ?? "";
    if (!/^[a-f0-9]{40}$/.test(productCommit)) {
      throw new StudyDataError(`Row ${rowNumber}: product_commit must be a full lowercase Git SHA`);
    }
    const criticalIncidentCount = integer(
      row.critical_incident_count ?? "",
      "critical_incident_count",
      rowNumber,
      0,
      20,
    );
    const issueCode = oneOf(row.issue_code ?? "", ISSUE_CODES, "issue_code", rowNumber);
    if (criticalIncidentCount > 0 && issueCode === "none") {
      throw new StudyDataError(`Row ${rowNumber}: a critical incident requires an issue_code`);
    }
    const role = oneOf(row.role ?? "", ROLES, "role", rowNumber);
    const taskCode = oneOf(row.task_code ?? "", TASK_CODES, "task_code", rowNumber);
    if (!(ALLOCATED_TASKS[role] as readonly TaskCode[]).includes(taskCode)) {
      throw new StudyDataError(`Row ${rowNumber}: task_code is not allocated to this role`);
    }
    return {
      schemaVersion: STUDY_SCHEMA_VERSION,
      datasetKind,
      productCommit,
      sessionId,
      role,
      accessibilityMode: oneOf(
        row.accessibility_mode ?? "",
        ACCESSIBILITY_MODES,
        "accessibility_mode",
        rowNumber,
      ),
      taskCode,
      outcome: oneOf(row.outcome ?? "", OUTCOMES, "outcome", rowNumber),
      durationSeconds: integer(row.duration_seconds ?? "", "duration_seconds", rowNumber, 1, 7_200),
      errorCount: integer(row.error_count ?? "", "error_count", rowNumber, 0, 99),
      criticalIncidentCount,
      scopeComprehensionCorrect: boolean(
        row.session_scope_comprehension_correct ?? "",
        "session_scope_comprehension_correct",
        rowNumber,
      ),
      confidenceRating: integer(row.confidence_rating ?? "", "confidence_rating", rowNumber, 1, 5),
      issueCode,
    };
  });

  const kinds = new Set(observations.map((row) => row.datasetKind));
  const commits = new Set(observations.map((row) => row.productCommit));
  if (kinds.size !== 1) throw new StudyDataError("Synthetic and participant rows cannot be mixed");
  if (commits.size !== 1) throw new StudyDataError("One analysis cannot mix product commits");

  const sessionProfiles = new Map<string, string>();
  const sessionScopeAnswers = new Map<string, boolean>();
  const observationKeys = new Set<string>();
  for (const observation of observations) {
    const profile = `${observation.role}:${observation.accessibilityMode}`;
    const previousProfile = sessionProfiles.get(observation.sessionId);
    if (previousProfile && previousProfile !== profile) {
      throw new StudyDataError(
        `Session ${observation.sessionId} changes role or accessibility mode`,
      );
    }
    sessionProfiles.set(observation.sessionId, profile);
    const priorScopeAnswer = sessionScopeAnswers.get(observation.sessionId);
    if (
      priorScopeAnswer !== undefined &&
      priorScopeAnswer !== observation.scopeComprehensionCorrect
    ) {
      throw new StudyDataError(
        `Session ${observation.sessionId} changes its session scope-comprehension answer`,
      );
    }
    sessionScopeAnswers.set(observation.sessionId, observation.scopeComprehensionCorrect);
    const key = `${observation.sessionId}:${observation.taskCode}`;
    if (observationKeys.has(key)) throw new StudyDataError(`Duplicate observation ${key}`);
    observationKeys.add(key);
  }
  return observations;
};

const rounded = (value: number, digits = 3): number => Number(value.toFixed(digits));

const rateSummary = (numerator: number, denominator: number): RateSummary => {
  if (denominator <= 0) {
    return { numerator: 0, denominator: 0, rate: 0, lower95: 0, upper95: 0 };
  }
  const z = 1.959963984540054;
  const rate = numerator / denominator;
  const denominatorAdjustment = 1 + z ** 2 / denominator;
  const centre = (rate + z ** 2 / (2 * denominator)) / denominatorAdjustment;
  const margin =
    (z * Math.sqrt((rate * (1 - rate) + z ** 2 / (4 * denominator)) / denominator)) /
    denominatorAdjustment;
  return {
    numerator,
    denominator,
    rate: rounded(rate),
    lower95: rounded(Math.max(0, centre - margin)),
    upper95: rounded(Math.min(1, centre + margin)),
  };
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? rounded(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2, 1)
    : (sorted[middle] ?? null);
};

const summarize = (rows: StudyObservation[], minimumCellSize: number): CohortSummary => {
  const participantCount = new Set(rows.map((row) => row.sessionId)).size;
  if (participantCount < minimumCellSize) {
    return { suppressed: true, participantCount: `<${minimumCellSize}` };
  }
  const outcomes: Record<Outcome, number> = {
    unassisted: 0,
    assisted: 0,
    not_completed: 0,
  };
  const issues: Partial<Record<IssueCode, number>> = {};
  let errors = 0;
  let criticalIncidents = 0;
  const scopeAnswers = new Map<string, boolean>();
  let confidenceTotal = 0;
  const confidenceRatings: number[] = [];
  const completedDurations: number[] = [];
  for (const row of rows) {
    outcomes[row.outcome] += 1;
    errors += row.errorCount;
    criticalIncidents += row.criticalIncidentCount;
    const priorScopeAnswer = scopeAnswers.get(row.sessionId);
    if (priorScopeAnswer !== undefined && priorScopeAnswer !== row.scopeComprehensionCorrect) {
      throw new StudyDataError(
        `Session ${row.sessionId} changes its session scope-comprehension answer`,
      );
    }
    scopeAnswers.set(row.sessionId, row.scopeComprehensionCorrect);
    confidenceTotal += row.confidenceRating;
    confidenceRatings.push(row.confidenceRating);
    if (row.outcome !== "not_completed") completedDurations.push(row.durationSeconds);
    if (row.issueCode !== "none") issues[row.issueCode] = (issues[row.issueCode] ?? 0) + 1;
  }
  return {
    suppressed: false,
    participantCount,
    observationCount: rows.length,
    outcomes,
    unassistedCompletion: rateSummary(outcomes.unassisted, rows.length),
    anyCompletion: rateSummary(outcomes.unassisted + outcomes.assisted, rows.length),
    scopeComprehension: rateSummary(
      Array.from(scopeAnswers.values()).filter(Boolean).length,
      participantCount,
    ),
    medianCompletedSeconds: median(completedDurations),
    medianConfidence: median(confidenceRatings),
    meanConfidence: rounded(confidenceTotal / rows.length, 2),
    errorCount: errors,
    criticalIncidentCount: criticalIncidents,
    issues,
  };
};

export const analyzeStudy = (
  observations: StudyObservation[],
  options: { minimumCellSize?: number } = {},
): StudyAnalysis => {
  if (observations.length === 0) throw new StudyDataError("At least one observation is required");
  const minimumCellSize = options.minimumCellSize ?? 5;
  if (!Number.isInteger(minimumCellSize) || minimumCellSize < 5) {
    throw new StudyDataError("minimumCellSize must be an integer of at least 5");
  }
  const datasetKinds = new Set(observations.map((row) => row.datasetKind));
  const commits = new Set(observations.map((row) => row.productCommit));
  if (datasetKinds.size !== 1 || commits.size !== 1) {
    throw new StudyDataError("Observations must use one dataset kind and one product commit");
  }

  return {
    schemaVersion: STUDY_SCHEMA_VERSION,
    evidenceStatus:
      observations[0]?.datasetKind === "participant" ? "participant_aggregate" : "synthetic_only",
    productCommit: observations[0]?.productCommit ?? "",
    minimumPublishedCellSize: minimumCellSize,
    overall: summarize(observations, minimumCellSize),
    byRole: Object.fromEntries(
      ROLES.map((role) => [
        role,
        summarize(
          observations.filter((row) => row.role === role),
          minimumCellSize,
        ),
      ]),
    ) as Record<Role, CohortSummary>,
    byTask: Object.fromEntries(
      TASK_CODES.flatMap((taskCode) => {
        const rows = observations.filter((row) => row.taskCode === taskCode);
        return rows.length > 0 ? [[taskCode, summarize(rows, minimumCellSize)]] : [];
      }),
    ),
    byRoleTask: Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.fromEntries(
          ALLOCATED_TASKS[role].map((taskCode) => [
            taskCode,
            summarize(
              observations.filter((row) => row.role === role && row.taskCode === taskCode),
              minimumCellSize,
            ),
          ]),
        ),
      ]),
    ) as Record<Role, Partial<Record<TaskCode, CohortSummary>>>,
    byAccessibilityMode: Object.fromEntries(
      ACCESSIBILITY_MODES.map((accessibilityMode) => [
        accessibilityMode,
        summarize(
          observations.filter((row) => row.accessibilityMode === accessibilityMode),
          minimumCellSize,
        ),
      ]),
    ) as Record<AccessibilityMode, CohortSummary>,
    limitations: [
      "Task rows are observations, not independent participants; confidence intervals are descriptive.",
      "The final scope-comprehension answer is counted once per unique session, even though the denormalized CSV repeats it on each task row.",
      "Cells with fewer than the configured participant threshold are suppressed.",
      "The analyzer does not establish comparative superiority or production outcomes.",
    ],
  };
};

const percent = (value: number): string => `${rounded(value * 100, 1)}%`;

const rateWithInterval = (summary: RateSummary): string =>
  `${percent(summary.rate)} (${summary.numerator}/${summary.denominator}; Wilson 95% CI ${percent(summary.lower95)}–${percent(summary.upper95)})`;

const taskGate = (summary: CohortSummary): string => {
  if (summary.suppressed) return "insufficient cohort";
  return summary.unassistedCompletion.rate >= 0.8 ? "met" : "not met";
};

export const renderStudyMarkdown = (analysis: StudyAnalysis): string => {
  const lines = [
    "# OpenCOI usability analysis",
    "",
    `- Evidence status: \`${analysis.evidenceStatus}\``,
    `- Product commit: \`${analysis.productCommit}\``,
    `- Minimum published cell size: ${analysis.minimumPublishedCellSize}`,
    "",
  ];
  if (analysis.evidenceStatus === "synthetic_only") {
    lines.push(
      "> Synthetic validation only. These numbers are not participant findings and must not be used as usability claims.",
      "",
    );
  }
  lines.push(
    "## Cohorts",
    "",
    "| Cohort | Participants | Attempts | Unassisted completion | Any completion | Scope comprehension | Median completed seconds | Median confidence | Mean confidence | Errors | Critical incidents |",
    "| --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  const cohorts: Array<[string, CohortSummary]> = [
    ["Overall", analysis.overall],
    ...ROLES.map((role): [string, CohortSummary] => [role, analysis.byRole[role]]),
  ];
  for (const [label, summary] of cohorts) {
    lines.push(
      summary.suppressed
        ? `| ${label} | ${summary.participantCount} | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed |`
        : `| ${label} | ${summary.participantCount} | ${summary.observationCount} | ${rateWithInterval(summary.unassistedCompletion)} | ${rateWithInterval(summary.anyCompletion)} | ${rateWithInterval(summary.scopeComprehension)} | ${summary.medianCompletedSeconds ?? "—"} | ${summary.medianConfidence ?? "—"} | ${summary.meanConfidence} | ${summary.errorCount} | ${summary.criticalIncidentCount} |`,
    );
  }
  lines.push(
    "",
    "## Overall release gates",
    "",
    "| Gate | Observed | Status |",
    "| --- | --- | --- |",
  );
  if (analysis.overall.suppressed) {
    lines.push(
      `| Scope comprehension ≥95% | suppressed | insufficient cohort |`,
      `| Zero critical incidents | suppressed | insufficient cohort |`,
      `| Median confidence ≥4 | suppressed | insufficient cohort |`,
    );
  } else {
    lines.push(
      `| Scope comprehension ≥95% | ${rateWithInterval(analysis.overall.scopeComprehension)} | ${analysis.overall.scopeComprehension.rate >= 0.95 ? "met" : "not met"} |`,
      `| Zero critical incidents | ${analysis.overall.criticalIncidentCount} | ${analysis.overall.criticalIncidentCount === 0 ? "met" : "not met"} |`,
      `| Median confidence ≥4 | ${analysis.overall.medianConfidence ?? "—"} | ${(analysis.overall.medianConfidence ?? 0) >= 4 ? "met" : "not met"} |`,
    );
  }
  lines.push(
    "| No unresolved keyboard or screen-reader blocker | Requires private-note disposition and synthetic reproduction issue review | manual gate |",
  );
  lines.push(
    "",
    "## Allocated role-by-task release gates",
    "",
    "Every allocated cell requires at least five unique participants and at least 80% unassisted completion.",
    "",
    "| Role | Task | Participants | Attempts | Unassisted completion | Any completion | Median seconds | Median confidence | Errors | Critical incidents | Gate |",
    "| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const role of ROLES) {
    for (const taskCode of ALLOCATED_TASKS[role]) {
      const summary = analysis.byRoleTask[role][taskCode];
      if (!summary || summary.suppressed) {
        lines.push(
          `| ${role} | ${taskCode} | ${summary?.participantCount ?? `<${analysis.minimumPublishedCellSize}`} | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed | suppressed | insufficient cohort |`,
        );
        continue;
      }
      lines.push(
        `| ${role} | ${taskCode} | ${summary.participantCount} | ${summary.observationCount} | ${rateWithInterval(summary.unassistedCompletion)} | ${rateWithInterval(summary.anyCompletion)} | ${summary.medianCompletedSeconds ?? "—"} | ${summary.medianConfidence ?? "—"} | ${summary.errorCount} | ${summary.criticalIncidentCount} | ${taskGate(summary)} |`,
      );
    }
  }
  lines.push(
    "",
    "## Accessibility-mode cohorts",
    "",
    "| Mode | Participants | Attempts | Unassisted completion | Any completion | Critical incidents |",
    "| --- | ---: | ---: | --- | --- | ---: |",
  );
  for (const accessibilityMode of ACCESSIBILITY_MODES) {
    const summary = analysis.byAccessibilityMode[accessibilityMode];
    lines.push(
      summary.suppressed
        ? `| ${accessibilityMode} | ${summary.participantCount} | suppressed | suppressed | suppressed | suppressed |`
        : `| ${accessibilityMode} | ${summary.participantCount} | ${summary.observationCount} | ${rateWithInterval(summary.unassistedCompletion)} | ${rateWithInterval(summary.anyCompletion)} | ${summary.criticalIncidentCount} |`,
    );
  }
  lines.push("", "## Coded issues", "");
  if (!analysis.overall.suppressed && Object.keys(analysis.overall.issues).length > 0) {
    lines.push("| Issue code | Observations |", "| --- | ---: |");
    for (const issueCode of ISSUE_CODES) {
      const count = analysis.overall.issues[issueCode];
      if (issueCode !== "none" && count) lines.push(`| ${issueCode} | ${count} |`);
    }
  } else {
    lines.push("No publishable coded-issue counts are available.");
  }
  lines.push(
    "",
    "## Publication administration required",
    "",
    "Before publishing participant results, add the study dates, recruitment-source categories, valid/excluded/stopped/withdrawn counts, device and browser categories, assistive-technology categories at publishable cell sizes, protocol deviations, and unresolved-finding dispositions. These administrative aggregates are intentionally not accepted in the row-level CSV.",
    "",
    "## Limitations",
    "",
    ...analysis.limitations.map((item) => `- ${item}`),
    "",
  );
  return lines.join("\n");
};

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write(
      "Usage: npx tsx research/usability/analysis.ts <observations.csv> [--markdown]\n",
    );
    process.exitCode = 1;
  } else {
    try {
      const observations = parseStudyCsv(await readFile(resolve(input), "utf8"));
      const analysis = analyzeStudy(observations);
      process.stdout.write(
        process.argv.includes("--markdown")
          ? renderStudyMarkdown(analysis)
          : `${JSON.stringify(analysis, null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
