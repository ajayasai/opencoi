# Competitive positioning

**Research reviewed:** 2026-08-31

This document helps contributors describe OpenCOI accurately. It is not a
procurement recommendation or a complete feature audit. Commercial products
change frequently, and the descriptions below are vendor-reported positioning
from the linked official pages, not independently verified performance claims.

## The commercial baseline is already beyond OCR

PDF upload, OCR, configurable requirements, expiration alerts, vendor requests,
and dashboards are established category capabilities. OpenCOI should not call
itself differentiated merely because it implements that checklist.

| Reference | Vendor-reported position as reviewed | Implication for OpenCOI |
| --- | --- | --- |
| [Certificial](https://www.certificial.com/requestor) | Promotes continuous policy information from connected agent systems, automated updates, requirements comparison, and alerts, plus an [insurance-tracking API](https://www.certificial.com/insurance-tracking-api) and [software partners](https://www.certificial.com/software-partners). | Live agency-management-system feeds are a genuine capability difference and remain outside OpenCOI. Never imply that document expiration tracking provides equivalent current-policy knowledge. |
| [illumend, from myCOI](https://www.illumend.ai/products) | Positions its workflow as extracting contract requirements, reviewing COIs and endorsements against them, resolving edge cases with people, and connecting to systems including Procore through its [integration catalog](https://www.illumend.ai/integrations). | OCR plus a pass/fail result is not enough. OpenCOI's defensible contribution is inspectable rules, evidence, human confirmation, and verifiable decision snapshots—not an unsupported claim of better AI judgment. |
| [TrustLayer](https://www.trustlayer.io/pages/coi-tracking-software-ga) | Advertises requests, expiration and deficiency workflows, [page-attributed endorsement evidence](https://www.trustlayer.io/pages/enhanced-endorsements), carrier validation in some workflows, and a documented [API](https://developers.trustlayer.io/) and [webhooks](https://developers.trustlayer.io/webhooks/). | OpenCOI must compare itself with evidence-aware and integration-capable products, not a straw-man OCR tool. Its signed portable decision record is a different advantage; carrier validation and catalog breadth are not matched. |
| [SmartCompliance](https://smartcompliance.co/) | Advertises upload links, OCR, customized requirement comparison, notices, and automated collection of missing or expiring documents. Its [FAQ](https://smartcompliance.co/faq) and [integrations page](https://smartcompliance.co/integrations) describe additional workflow and connectivity. | Collection and reminder automation are category baseline rather than a moat. OpenCOI's tracked request workflow closes that baseline without turning an SMTP outcome into a false delivery claim. |
| [CertFocus, from Vertikal](https://www.vertikalrms.com/solutions/certfocus-coi-compliance-tracking/) | Offers self-service and full-service approaches and emphasizes insurance-professional review, configurable workflows, integrations, and account support in its [feature description](https://www.vertikalrms.com/solutions/certfocus-coi-compliance-tracking/certfocus-features/). | Open source software alone does not replace managed review or domain expertise. OpenCOI should make professional review easier to audit, not claim it is unnecessary. |

These references are useful comparators, not design templates. Contributors
must not copy proprietary interfaces, content, forms, or branding.

## Where OpenCOI can earn preference

OpenCOI's strategy is explainability and operator control:

1. **Inspectable decisions.** A finding can show the typed rule, requirement
   version, evaluation date, confirmed document revision, expected and actual
   values, evidence location, and stable reason code.
2. **Human-visible provenance.** OCR proposals, confidence, corrections, and
   reviewers remain distinguishable instead of collapsing into one unexplained
   field.
3. **Verifiable decision snapshots.** v0.3 persists the evaluated vendor type
   and normalized ruleset and signs a portable evidence snapshot. The verifier
   detects alteration; evaluator replay remains separate future work.
4. **Honest exceptions.** A risk owner can approve a scoped, expiring exception
   without rewriting the underlying deficiency into a pass.
5. **Deployment and data control.** Operators can self-host, choose retention,
   keep OCR local, and decide whether any external processor receives document
   data.
6. **Portability.** Document metadata, confirmed facts, requirement versions,
   findings, exceptions, and audit history can use documented export formats
   rather than being trapped in an opaque workflow.
7. **Open extension.** A constrained rule specification, test fixtures, and
   adapter boundaries can be reviewed and extended without executing arbitrary
   tenant code.

These are goals that must be proven in releases, tests, documentation, and
real deployments. Being open source does not automatically make the software
more secure, accurate, usable, or economical.

## Public artifacts and evidence status

OpenCOI v0.3 publishes artifacts and evidence for several narrower claims:

| Question | Public artifact | Result or status |
| --- | --- | --- |
| Can its shared text parser be scored reproducibly? | [Corpus, schemas, scorer, and method](../benchmark/README.md) plus [machine-readable output](../benchmark/results/synthetic-text-v1-opencoi-v0.2.0.score.json) | Six original synthetic page-text cases: micro F1 `0.984375`, citation recall `0.969231`, exact documents `5/6`; browser OCR and real documents are not measured. |
| Are parser failures visible? | Per-case score and [head-to-head status](../benchmark/HEAD_TO_HEAD_STATUS.md) | Two deliberately exposed insurer-assignment false negatives; every commercial comparator is “not tested,” not assigned a fabricated score. |
| Does endorsement evidence overclaim attachment? | Frozen benchmark and OCR regression tests | Machine text is capped at `MENTIONED`; attachment/human-verification requires a person. |
| Can a decision snapshot be checked outside the app? | [Evidence-bundle schema and offline verifier](EVIDENCE_BUNDLES.md) plus cryptographic and HTTP integration tests | Canonical payload digest, Ed25519 signature, source-PDF hash, evaluated ruleset, citations, findings, and exceptions are portable. This verifies integrity, not evaluator correctness or organization identity without an independently trusted fingerprint. |
| Does the vendor list grow one query per vendor? | [Scale method and output](../benchmark/scale/README.md) plus query-count regression | One aggregate query; the published Windows run reports 10,000 rows at 96.13 ms median / 117.801 ms p95 on the labelled host. It is not a capacity or horizontal-scale claim. |
| Are standards-based integration interfaces available? | [API/webhook contract](API.md), served OpenAPI 3.1, and integration tests | Scoped service accounts, OIDC, cursor API, idempotency, ETags, ordered events, signatures, retries, dead letters, and SSRF controls are implemented. Breadth against each commercial integration catalog is not established. |
| Is real-world usability proven? | [Preregistered protocol and analyzer](../research/usability/README.md) | No participant sessions yet. Synthetic analyzer tests are not usability results. |

These artifacts make OpenCOI's stated claims inspectable and independently testable. This
is not enough to say it is universally better overall. A lawful, identical
commercial-product run and real participant/production evidence are still
required for that broader conclusion.

## Where OpenCOI should not claim an advantage

Do not claim parity or superiority in:

- insurer, carrier, broker, or agency-management-system connectivity;
- live policy monitoring or cancellation data;
- managed certificate review and credentialed account services;
- proprietary integration breadth, implementation services, support SLAs, or
  enterprise certifications;
- AI interpretation of contracts, policies, or endorsements;
- scale, accuracy, time savings, response rates, or compliance outcomes without
  reproducible evidence; or
- legal sufficiency, policy validity, claim payment, or universal fitness.

An organization that requires live source-system data or an outsourced expert
team may reasonably choose a commercial service. OpenCOI is for teams that
value a reviewable document-assessment workflow and control of their deployment
and data.

## A measurable public bar

“Better” should mean demonstrably better for a defined use case, not a universal
marketing claim. Public releases should make it possible to evaluate:

- whether every status links to evidence and an explanation;
- whether exported snapshots preserve the exact evaluated inputs and findings;
- whether unknown or unconfirmed values can ever produce a successful result;
- whether exports are documented and usable without the application;
- whether tenant boundaries, upload links, hostile PDFs, and spreadsheet
  injection have regression tests;
- whether self-hosting, backup, restore, retention, and upgrades are documented;
- whether security reports and dependencies are handled transparently; and
- whether accessibility and workflow usability are tested with representative
  users.

Publish benchmark methods, synthetic fixtures, known limitations, and failure
cases. Do not publish precision or time-saved numbers without the dataset,
method, comparator, and confidence limits needed to interpret them.

## Recommended description

> OpenCOI is an open-source certificate-of-insurance tracking application. It
> compares human-confirmed information from uploaded documents with your
> configured requirements and shows why each check passed, failed, or needs
> review. It does not contact insurers or claim that a policy remains active.

This message is narrower than many commercial claims by design. It tells users
what the software can establish and makes room for future evidence sources
without mislabeling a document check as insurance verification.
