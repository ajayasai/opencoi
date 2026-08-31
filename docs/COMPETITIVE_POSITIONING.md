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
| [Certificial](https://www.certificial.com/requestor) | Promotes continuous policy information from connected agent systems, automated updates, requirements comparison, and alerts. Its [FAQ](https://www.certificial.com/faqs) distinguishes network-connected monitoring from PDF processing when an agent is not connected. | Live agency-management-system feeds are a genuine capability difference and are outside OpenCOI's first release. Never imply that document expiration tracking provides equivalent current-policy knowledge. |
| [illumend, from myCOI](https://www.illumend.ai/) | Positions its AI workflow as reviewing COIs and endorsements against an organization's contract or lease requirements, guiding partners, and automating renewals. | OCR plus a pass/fail result is not enough. OpenCOI's defensible contribution is inspectable rule behavior, evidence, human confirmation, and reproducible decision history—not an unsupported claim of better AI judgment. |
| [TrustLayer Starter](https://www.trustlayer.io/pages/trustlayer-starter-free-vendor-compliance-tracking-ga) | Advertises a free tier for up to 50 vendors with requests, expiration tracking, notifications, and a centralized dashboard. | Zero license cost for a small account is not unique. OpenCOI should lead with source availability, deployment control, and portability. |
| [SmartCompliance](https://smartcompliance.co/certificate-of-insurance-tracking-software-features) | Advertises upload links, OCR, customized risk-template comparison, non-compliance notices, and automated collection of missing or expiring documents. Its [FAQ](https://smartcompliance.co/faq) describes expiration-based reminders and uploads from insureds or producers. | First-release workflow coverage matters, but basic collection and reminder automation should be treated as baseline rather than a moat. |
| [CertFocus](https://www.certfocus.com/) | Offers self-service and full-service approaches and emphasizes credentialed insurance professionals and dedicated account management. | Open source software alone does not replace managed review or domain expertise. OpenCOI should make professional review easier to audit, not claim it is unnecessary. |

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
3. **Reproducibility.** Immutable inputs and a versioned deterministic engine
   can reproduce a past decision and explain why a later decision changed.
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
- whether the same versioned inputs reproduce the same findings;
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
