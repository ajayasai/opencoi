# Rule and status semantics

OpenCOI's evaluator answers a narrow question:

> Do the human-confirmed facts in this uploaded document satisfy the configured requirements for this vendor type on this evaluation date?

It does not answer whether a policy is still active in an insurer's system, whether the underlying contract wording creates coverage, whether an endorsement is legally sufficient, or whether a claim will be paid.

## Inputs and output

The pure evaluator receives four explicit inputs:

1. a versioned rule set;
2. structured document facts and their evidence confirmation state;
3. a vendor-type identifier and ISO evaluation date; and
4. exception records for display, kept separate from the base calculation.

It returns:

- scope `UPLOADED_DOCUMENT` and a mandatory disclaimer;
- document, rule-set, vendor-type, and evaluation identifiers;
- one document label;
- requirement-level findings with stable codes, explanations, expected and observed values, and evidence identifiers; and
- unchanged exception records for a separate disposition layer.

The evaluator does not read the current clock. Calendar comparisons use validated `YYYY-MM-DD` values in UTC day arithmetic. Money uses non-negative safe integers in currency minor units—for example, USD 1,000,000.00 is `100000000`.

## Evidence and confirmation

Every proposed fact can carry a source (`OCR`, `MANUAL`, or `IMPORT`), confirmation state, confidence, raw text, and page number. The present application persists a reviewed document as a whole and marks submitted reviewed facts accordingly.

The central invariant is:

```text
unconfirmed or incomparable evidence != PASS
```

- Before human confirmation, a matching coverage, date, limit, policy field, or endorsement proposal produces `UNKNOWN` when that proposal would otherwise be used.
- After a reviewer confirms the document, an absent required field is a `FAIL`, not an invented zero or empty pass.
- An OCR confidence score never overrides confirmation.
- Vendor-link submissions are server-forced to unconfirmed state until an authenticated reviewer attests to them.

## Finding statuses

| Finding | Meaning |
| --- | --- |
| `PASS` | Confirmed document evidence satisfies this exact configured check. |
| `FAIL` | Confirmed review establishes that the configured check is not satisfied, or that required evidence is absent. |
| `UNKNOWN` | The check cannot be decided from confirmed comparable evidence. It never counts as a pass. |
| `NOT_APPLICABLE` | The published rule explicitly marks the coverage or endorsement requirement as not applicable. It is not inferred from missing data. |

The document label follows strict precedence:

1. any `FAIL` → `DOCUMENT_NON_COMPLIANT`;
2. otherwise, any `UNKNOWN` → `DOCUMENT_REVIEW_REQUIRED`;
3. otherwise, any `PASS` → `DOCUMENT_COMPLIANT`;
4. otherwise → `DOCUMENT_NOT_APPLICABLE`.

The UI deliberately uses bounded copy such as **Meets configured document checks**, **Deficient against configured document checks**, and **Needs review** rather than an unqualified claim that a vendor is insured or a policy is active.

## Coverage checks

Each vendor-type profile contains one or more coverage requirements. A requirement can be `REQUIRED` or explicitly `NOT_APPLICABLE`.

For a required coverage, the engine finds policy rows whose normalized coverage type matches exactly. If none exist:

- an unconfirmed extraction produces `COVERAGE_REVIEW_REQUIRED` / `UNKNOWN`;
- a confirmed document produces `REQUIRED_COVERAGE_MISSING` / `FAIL`.

When more than one matching policy row exists, the engine deterministically selects the best complete candidate. It prefers:

1. a candidate with no failures or unknowns;
2. then a candidate with unknowns but no failures;
3. then fewer failures;
4. then fewer unknowns; and
5. finally lexical policy ID order.

It does not combine arbitrary duplicate policy rows to manufacture a successful result.

## Required policy fields

The v0.2 application requires insurer name and policy number for configured coverage rows. A present value must be human-confirmed to pass.

- Missing from unconfirmed extraction → `UNKNOWN`.
- Present but unconfirmed → `UNKNOWN`.
- Missing after confirmation → `FAIL`.
- Present and confirmed → `PASS`.

These checks establish only that the reviewed document shows a value. OpenCOI does not validate the insurer identity, NAIC record, or policy number against an external source.

## Policy-period checks

A coverage requirement has `minimumDaysRemaining`. The engine calculates:

```text
requiredThrough = evaluationDate + minimumDaysRemaining
```

Both boundaries are inclusive. A policy-period check passes only when confirmed document dates show:

```text
effectiveDate <= evaluationDate
expirationDate >= requiredThrough
```

A future effective date or an expiration before the required-through date fails. Missing dates after confirmation fail; missing or unconfirmed dates before confirmation remain unknown.

The result still speaks only about dates printed on the uploaded document. A later cancellation, reinstatement, or insurer-side change is outside the evidence available to this rule.

## Limit checks

Configured limit checks use exact `greater than or equal` comparisons in minor units. An exact-boundary value passes.

- Missing after confirmation → `REQUIRED_LIMIT_MISSING` / `FAIL`.
- Missing before confirmation → `LIMIT_REVIEW_REQUIRED` / `UNKNOWN`.
- Present but unconfirmed → `LIMIT_UNCONFIRMED` / `UNKNOWN`.
- Confirmed below the minimum → `LIMIT_INADEQUATE` / `FAIL`.
- Confirmed at or above the minimum → `LIMIT_SATISFIES` / `PASS`.

The underlying rule engine supports explicitly configured umbrella stacking with a confirmed active-through umbrella row. It is disabled by default, and the v0.2 requirements UI and server-generated profiles do not enable it. OpenCOI therefore does not silently add primary and umbrella limits.

The engine also refuses an arithmetic result outside JavaScript's safe integer range and returns `UNKNOWN` rather than rounding or overflowing.

## Endorsement evidence

Endorsement evidence has an ordered level:

```text
NONE < MENTIONED < SCHEDULED < ATTACHED < HUMAN_VERIFIED
```

A rule identifies an endorsement by a normalized form code, a normalized name, or both, and sets a minimum evidence level. The best matching piece of confirmed evidence passes only if its level meets or exceeds the configured minimum.

This distinction matters: a checked COI box or description is generally `MENTIONED`; it is not silently promoted to an attached or human-verified endorsement. A missing match after confirmed review fails. A proposed but unconfirmed match stays unknown.

The v0.2 intake UI exposes evidence levels for three common items—additional insured, waiver of subrogation, and primary/non-contributory—and lets a reviewer add arbitrary named or form-coded endorsements from the PDF package. `ATTACHED` and `HUMAN_VERIFIED` are explicit reviewer choices; they are never inferred merely because a phrase appears on the certificate. Detailed policy-language interpretation and legal sufficiency review remain outside the evaluator.

## Requirement publishing

The requirements editor publishes a numbered profile per vendor type. Publication stores an immutable JSON snapshot with its actor and timestamp and updates the active requirement projection used for subsequent intake.

Each certificate evaluation records the selected version and evaluation date in its extraction context. Its persisted findings retain the decision output. Publishing a later profile does not silently rewrite older findings.

v0.2 does not expose a bulk historical replay or retroactive migration UI. If reproducibility or migration behavior changes, the release notes must describe it.

The versioned shared schema is constrained data, not executable customization. Rules cannot contain JavaScript, SQL, shell commands, or arbitrary user-provided regular expressions.

## Exceptions are a separate disposition

An exception request points to a stored failed finding and includes a requester, rationale, optional compensating controls, and expiration. A decision records its actor, note, timestamp, and outcome.

An approved exception:

- does not turn the finding from `FAIL` into `PASS`;
- does not change the base document label produced by the pure evaluator;
- appears separately in the UI and audit history;
- can expire, be rejected, or be revoked; and
- affects workflow status only while active and correctly scoped.

The UI may show **Approved exception** when active approvals dispose of the current failed findings for workflow purposes. That label is not document compliance, proof of coverage, or live policy verification. Unknown findings, lifecycle state, and the original failures remain independently visible.

## Document checks versus lifecycle

OpenCOI maintains two status axes:

| Axis | Values | Source |
| --- | --- | --- |
| Document check | Meets, Deficient, Needs review, Approved exception, Not submitted | Findings from the selected uploaded document plus separate active exception disposition. |
| Document lifecycle | Current, Expiring, Expired, Future, Unknown | Earliest relevant effective and expiration dates printed on the selected document. |

A document can meet its configured checks today and be labeled expiring because the printed expiration approaches. Conversely, an unexpired document can be deficient because a required limit or endorsement is missing.

Renewal reminders use printed dates from the latest confirmed document. They never infer an insurer-side cancellation or continuation.

## Representative reason codes

| Category | Examples |
| --- | --- |
| Rule profile | `VENDOR_TYPE_RULES_NOT_FOUND` |
| Coverage | `REQUIRED_COVERAGE_FOUND`, `COVERAGE_TYPE_UNCONFIRMED`, `REQUIRED_COVERAGE_MISSING` |
| Policy field | `REQUIRED_POLICY_FIELD_FOUND`, `POLICY_FIELD_UNCONFIRMED`, `REQUIRED_POLICY_FIELD_MISSING` |
| Policy period | `POLICY_PERIOD_SATISFIES`, `POLICY_PERIOD_UNCONFIRMED`, `POLICY_PERIOD_DEFICIENT` |
| Limit | `LIMIT_SATISFIES`, `LIMIT_UNCONFIRMED`, `LIMIT_INADEQUATE`, `REQUIRED_LIMIT_MISSING` |
| Endorsement | `ENDORSEMENT_EVIDENCE_SATISFIES`, `ENDORSEMENT_EVIDENCE_UNCONFIRMED`, `ENDORSEMENT_EVIDENCE_INADEQUATE`, `ENDORSEMENT_EVIDENCE_MISSING` |

Reason codes are intended for explanation and tests. The pre-1.0 API and export schema can still evolve; incompatible changes belong in the changelog.

## v0.2 configuration boundaries

- The v0.2 application UI and configuration API accept only USD profiles and store money in cents, although the reusable shared schema validates general three-letter currency codes. Other currencies require explicit document normalization and mismatch handling before the application can expose them safely.
- The UI exposes common coverage types, each-occurrence/claim and aggregate minimums, expiration horizons, and named endorsement requirements; the shared engine models additional limit types.
- Umbrella stacking is modeled but disabled in application-generated rules.
- Contract-, project-, or location-specific requirement assignment is not included.
- The evaluator does not interpret free-form contracts, certificates, endorsements, or policy wording.
- No rule can establish current insurer-system status.

## Verification

Pure tests cover schema rejection, calendar boundaries, exact limit equality, missing and unconfirmed evidence, duplicate coverage candidates, explicit stacking behavior, endorsement evidence ranks, exception separation, and document-label precedence.

Run:

```text
npm run test:run
npm run typecheck
```

Contributors changing a rule must add boundary tests and preserve the document-assessment language described in [CONTRIBUTING.md](../CONTRIBUTING.md).
