import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeStudy, parseStudyCsv, renderStudyMarkdown, StudyDataError } from "./analysis";

const fixture = readFileSync(
  new URL("./fixtures/synthetic-observations.csv", import.meta.url),
  "utf8",
);

describe("usability study analysis", () => {
  it("deterministically summarizes the privacy-reviewed synthetic fixture", () => {
    const observations = parseStudyCsv(fixture);
    const first = analyzeStudy(observations);
    const second = analyzeStudy(parseStudyCsv(fixture));

    expect(observations).toHaveLength(45);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.evidenceStatus).toBe("synthetic_only");
    expect(first.overall).toMatchObject({
      suppressed: false,
      participantCount: 15,
      observationCount: 45,
      outcomes: { assisted: 7, not_completed: 4, unassisted: 34 },
      criticalIncidentCount: 3,
    });
    if (first.overall.suppressed) throw new Error("Synthetic overall cohort was suppressed");
    expect(first.overall.unassistedCompletion).toMatchObject({ numerator: 34, denominator: 45 });
    expect(first.overall.anyCompletion).toMatchObject({ numerator: 41, denominator: 45 });
    expect(first.overall.scopeComprehension).toMatchObject({ numerator: 13, denominator: 15 });
    expect(first.overall.medianConfidence).toBe(4);
    expect(first.byRole.coi_reviewer.suppressed).toBe(false);
    expect(first.byTask.T03_VENDOR_UPLOAD?.suppressed).toBe(false);
    expect(first.byRoleTask.coi_reviewer.T04_REVIEW_CORRECT).toMatchObject({
      suppressed: false,
      participantCount: 5,
    });
    expect(first.byRoleTask.procurement_manager.T06_DECIDE_EXCEPTION).toMatchObject({
      suppressed: false,
      participantCount: 5,
    });
  });

  it("renders an unmistakable synthetic-only warning", () => {
    const report = renderStudyMarkdown(analyzeStudy(parseStudyCsv(fixture)));
    expect(report).toContain("Evidence status: `synthetic_only`");
    expect(report).toContain("Synthetic validation only");
    expect(report).toContain("must not be used as usability claims");
    expect(report).toContain("Wilson 95% CI");
    expect(report).toContain("Scope comprehension");
    expect(report).toContain("Median confidence");
    expect(report).toContain("Overall release gates");
    expect(report).toContain("No unresolved keyboard or screen-reader blocker");
    expect(report).toContain("Allocated role-by-task release gates");
    expect(report).toContain("T04_REVIEW_CORRECT");
    expect(report).toContain("Accessibility-mode cohorts");
    expect(report).toContain("Coded issues");
    expect(report).toContain("Publication administration required");
  });

  it("rejects columns capable of carrying unreviewed personal data", () => {
    const unsafeHeader = fixture.replace("issue_code", "participant_name");
    expect(() => parseStudyCsv(unsafeHeader)).toThrow(/privacy-reviewed schema/);
  });

  it("rejects sensitive-looking cell values before analysis", () => {
    const unsafeValue = fixture.replace("SYN-R01", "person@example.com");
    expect(() => parseStudyCsv(unsafeValue)).toThrow(/email-like values are forbidden/);
  });

  it("requires randomized participant identifiers", () => {
    const participantRows = fixture
      .replaceAll(",synthetic,", ",participant,")
      .replaceAll(/SYN-[RMU]\d{2}/g, "P-001");
    expect(() => parseStudyCsv(participantRows)).toThrow(/valid pseudonymous ID/);
  });

  it("removes valid participant pseudonyms from aggregate output", () => {
    let sequence = 0;
    const pseudonyms = new Map<string, string>();
    const participantRows = fixture
      .replaceAll(",synthetic,", ",participant,")
      .replaceAll(/SYN-[RMU]\d{2}/g, (sessionId) => {
        const existing = pseudonyms.get(sessionId);
        if (existing) return existing;
        sequence += 1;
        const pseudonym = `P-${sequence.toString(16).toUpperCase().padStart(12, "0")}`;
        pseudonyms.set(sessionId, pseudonym);
        return pseudonym;
      });
    const analysis = analyzeStudy(parseStudyCsv(participantRows));
    expect(analysis.evidenceStatus).toBe("participant_aggregate");
    expect(JSON.stringify(analysis)).not.toContain("P-");
  });

  it("rejects duplicate session-task observations", () => {
    const firstObservation = fixture.trim().split("\n")[1];
    expect(firstObservation).toBeDefined();
    expect(() => parseStudyCsv(`${fixture.trim()}\n${firstObservation}\n`)).toThrow(
      /Duplicate observation/,
    );
  });

  it("rejects a task that is not allocated to the participant role", () => {
    const unallocated = fixture.replace(
      "SYN-R01,coi_reviewer,standard,T04_REVIEW_CORRECT",
      "SYN-R01,coi_reviewer,standard,T01_CREATE_REQUIREMENTS",
    );
    expect(() => parseStudyCsv(unallocated)).toThrow(/task_code is not allocated to this role/);
  });

  it("rejects inconsistent session-level scope answers", () => {
    const rows = fixture
      .trim()
      .split("\n")
      .map((row) => row.split(","));
    const header = rows[0] ?? [];
    const scopeIndex = header.indexOf("session_scope_comprehension_correct");
    const target = rows.find(
      (row) => row.includes("SYN-R01") && row.includes("T05_EXPLAIN_FINDING"),
    );
    if (!target || scopeIndex < 0) throw new Error("Synthetic scope fixture is incomplete");
    target[scopeIndex] = "false";
    expect(() => parseStudyCsv(rows.map((row) => row.join(",")).join("\n"))).toThrow(
      /changes its session scope-comprehension answer/,
    );
  });

  it("suppresses cohorts smaller than five participants", () => {
    const small = analyzeStudy(parseStudyCsv(fixture).slice(0, 4));
    expect(small.overall).toEqual({ suppressed: true, participantCount: "<5" });
  });

  it("refuses to weaken the publication threshold", () => {
    expect(() => analyzeStudy(parseStudyCsv(fixture), { minimumCellSize: 4 })).toThrow(
      StudyDataError,
    );
  });
});
