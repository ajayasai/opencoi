# Preregistered formative workflow study v1.1

Registered on 2026-08-31 against protocol baseline
`5f97a4945498e79246c647dcfe4b8ea73fe683fe`. This file freezes the study questions and analysis
before participant data is collected. Record amendments at the end before running affected
sessions; never edit a hypothesis or outcome in response to observed data without labeling it
exploratory.

## Purpose and boundary

The study evaluates whether representative people can use OpenCOI to assess uploaded documents
against configured rules and understand the resulting evidence. It does not evaluate whether a
policy is active, legally sufficient, enforceable, or likely to pay a claim.

Primary questions:

1. Can each role finish its core workflow without moderator assistance?
2. Can reviewers find and correct extracted facts while consulting the source PDF?
3. Can users explain why a document check passed, failed, or needs review?
4. Do users retain the distinction between document assessment and live insurer verification?
5. Do keyboard and assistive-technology users encounter role-specific blockers?

## Fixed success thresholds

These thresholds are release gates, not predictions:

- at least 80% unassisted completion for every allocated role-by-task cell;
- at least 95% correct answers to the document-scope comprehension check overall;
- zero unresolved critical incidents that can cause an unintended approval, exception decision,
  disclosure, or destructive action;
- no unresolved keyboard trap or screen-reader blocker in a tested core workflow; and
- median confidence of at least 4 on the fixed five-point post-task scale.

Failure to meet a threshold is reported as a finding. It is not grounds to exclude a session or
change the threshold.

## Participants and stopping rule

Recruit adults who currently perform or closely supervise the represented work:

- at least five COI/compliance reviewers;
- at least five procurement or vendor-risk managers; and
- at least five people who submit insurance documents for vendors.

Across these cohorts, include at least five sessions using keyboard-only navigation and at least
five using a screen reader, magnification, or voice control. One person may satisfy a role and an
accessibility quota. Record only the categorical accessibility mode needed for analysis; do not
collect diagnoses.

Stop the formative round only after all three conditions are met: 15 valid completed sessions, the
accessibility quotas, and at least five unique participants with an observed outcome in every
allocated role-by-task cell below. If a participant stops an assigned task, keep the
`not_completed` observation; recruit additional participants only when a withdrawal, exclusion, or
missing assigned observation leaves a cell below five. Additional sessions beyond what is needed to
fill a deficient cell require a dated amendment before recruitment. Pause immediately for a
security, privacy, data-loss, or misleading-approval incident; resume only after documenting
disposition.

This sample is intended to find workflow problems. It is not powered for population estimates or
comparative superiority.

## Inclusion, exclusion, and withdrawals

Include a session when the participant meets a role definition, gives informed consent, uses the
assigned synthetic scenario, and attempts at least one task.

Exclude only when:

- the participant withdraws consent;
- the wrong product build or scenario was used;
- an outage prevents the product from loading for most of the allotted session; or
- moderator error reveals a task solution before the attempt.

Preserve the exclusion count and reason outside the public dataset. Do not exclude slow,
unsuccessful, assisted, accessibility-blocked, or critical-incident sessions. A participant may
stop any task; record it as `not_completed` unless the whole session is withdrawn.

## Design and materials

This is a moderated, within-product formative study. Use the same tagged build, seeded synthetic
organization, synthetic PDFs, and task wording for a study round. Record the full product commit in
every observation. Do not use a real certificate, contact, company, policy number, or contract.

Assign tasks from [tasks.md](tasks.md) based on role. Counterbalance the order of independent tasks
using a predetermined rotation. Always administer the final scope-comprehension check after the
last product task and before debriefing.

### Frozen participant-by-task allocation

Every valid participant attempts every task allocated to their role. `T06` has distinct reviewer
request and manager decision variants and is analyzed as two role-by-task cells.

| Role | Required tasks per participant | Minimum unique participants per cell |
| --- | --- | ---: |
| COI/compliance reviewer | `T04`, `T05`, reviewer variant of `T06` | 5 |
| Procurement or vendor-risk manager | `T01`, `T02`, manager variant of `T06`, `T07`, `T08` | 5 |
| Vendor uploader | `T03` | 5 |

Use the order rotations registered in [tasks.md](tasks.md). Do not substitute tasks between roles or
count a manager's `T06` decision as a reviewer's `T06` request.

## Outcome definitions

- `unassisted`: success criteria met without a hint, intervention, or takeover.
- `assisted`: success criteria met after one or more moderator hints or interventions.
- `not_completed`: success criteria not met before the time box or the participant stops.
- `duration_seconds`: from completion of task reading until success, stop, or time-box expiry.
- `error_count`: observable actions that move away from the goal, repeat without progress, or
  produce a validation error; one continuous recovery episode counts once.
- `critical_incident_count`: an action or misunderstanding that could cause unintended approval,
  exception disposition, disclosure, destructive action, or belief that OpenCOI verified live
  insurer status.
- `session_scope_comprehension_correct`: the one final session answer is correct only when the
  participant states that the result is based on the uploaded document and configured rules, not
  current insurer records. Copy that one answer identically to each task row for the participant;
  the analyzer validates consistency and counts it once per unique session.
- `confidence_rating`: the fixed response to “How confident are you that you completed this task
  correctly?” from 1 (not at all) to 5 (completely).
- `issue_code`: the first applicable fixed taxonomy value in the data dictionary; details remain in
  private notes.

## Moderator assistance rule

Allow silent observation first. If the participant is blocked for 90 seconds, asks for help, or
would create a critical incident, give the next neutral hint from the moderator guide and mark the
outcome assisted if the task later succeeds. Never complete an approval, rejection, upload, or
exception action on the participant's behalf.

## Fixed analysis

The checked-in analyzer is authoritative for quantitative summaries:

1. Validate the exact schema and reject mixed commits or synthetic/participant rows.
2. Reject duplicate session/task rows and inconsistent role/accessibility assignments.
3. Report unassisted completion and any completion with Wilson 95% intervals.
4. Report median duration among completed attempts, median and mean confidence, total errors, total critical
   incidents, scope comprehension, and fixed issue-code counts.
5. Analyze overall, by role, by allocated role-by-task cell, and by accessibility mode.
6. Suppress every cell with fewer than five unique participants.
7. Do not impute missing tasks, convert assisted success to unassisted success, discard outliers, or
   combine product commits.

Task rows from one person are correlated, so intervals are explicitly descriptive. Qualitative
themes may be published separately only with denominators and a statement that they are exploratory.

## Privacy and retention

The public analysis schema contains categorical or numeric observations only. Random participant
pseudonyms link tasks within a private working dataset and are removed from aggregate output. Never
put consent records, names, emails, employer names, diagnoses, IP addresses, recordings, free text,
screenshots, filenames, or document content in the repository.

Store consent and private notes separately with access controls. Define retention and deletion
before recruitment according to local law and organizational policy. Honor withdrawal requests to
the extent promised in the reviewed consent form.

## Reporting

Publish the tested commit, dates, recruitment source categories, valid/excluded/stopped/withdrawn
counts, device, browser, and assistive-technology categories, every role-by-task threshold result,
confidence intervals, deviations, limitations, and unresolved findings. Report noncompletion and
critical incidents prominently. The analyzer-generated Markdown must be supplemented with the
administrative aggregates it lists before the publication checklist can pass.

Do not claim time savings, accuracy, accessibility conformance, production outcomes, or superiority
over another product from this formative study.

## Amendments

- 2026-08-31, pre-data v1.1 clarification: froze the participant-by-task allocation and task-level
  stopping rule, made scope comprehension explicitly session-level, added median confidence and
  role-by-task/accessibility reporting, and expanded the required Markdown report. No participant
  session had occurred; no observed result informed the change.

Add future entries here with date, author, change, rationale, and whether any participant session
had already occurred.
