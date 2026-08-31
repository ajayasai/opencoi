# OpenCOI governance

OpenCOI uses maintainer-led governance while the contributor community is
small. The goal is fast, accountable decision-making with a clear path toward
broader stewardship as sustained contributors emerge.

## Project scope

The project builds open infrastructure for collecting insurance certificates,
confirming extracted data, comparing that data with configured requirements,
tracking document expirations, recording exceptions, and exporting evidence.

The project does not represent that an uploaded document proves current
coverage. Live carrier or broker monitoring, insurance or legal advice, claim
prediction, and decisions that should be made by a qualified professional are
outside the initial scope.

## Principles

Decisions should advance these principles:

1. **Truthful outcomes.** Distinguish document checks, unknowns, deficiencies,
   and approved risk exceptions. Do not turn product status into a coverage
   guarantee.
2. **Explainability.** A reviewer should be able to reproduce a finding from a
   confirmed certificate revision, versioned requirements, an evaluation date,
   and evidence.
3. **Human authority.** OCR assists review; it does not silently approve
   consequential fields or endorsement evidence.
4. **Security and privacy.** Minimize sensitive data, isolate untrusted files,
   enforce least privilege, and make retention an operator-controlled policy.
5. **Operator control and portability.** Keep self-hosting practical and make
   data and decision history exportable in documented formats.
6. **Open collaboration.** Prefer public rationale, tests, and specifications
   over decisions that exist only in a maintainer's memory.

## Roles

### Contributors

Anyone may report issues, propose designs, improve documentation, review pull
requests, or submit code. Contributors are expected to follow
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

### Maintainers

Maintainers triage issues, review and merge changes, publish releases, moderate
community spaces, and steward the product boundary. The repository owner is the
initial maintainer. Additional maintainers are appointed based on a sustained
record of sound contributions, respectful review, security judgment, and
availability—not employer, sales relationship, or contribution count alone.

A maintainer may step down at any time. Inactive maintainers may be moved to an
emeritus role after a public check-in and a reasonable response period.

### Security responders

Security responders are maintainers explicitly trusted to access private
vulnerability reports. They coordinate confidential triage and disclosure
under [SECURITY.md](SECURITY.md). This access is limited to the smallest
practical group and does not automatically accompany every maintainer role.

### Domain reviewers

Maintainers may invite insurance, compliance, privacy, accessibility, or
security specialists to review a change. Domain reviewers advise; merge
authority remains with maintainers unless they are separately appointed.

## Decision process

Routine changes are decided through issue and pull-request review. Maintainers
seek rough consensus and are responsible for recording the rationale when
reasonable objections remain. If consensus cannot be reached, the repository
owner makes the final decision and documents it publicly.

Material changes should begin as a public design issue. These include:

- changing the product's verification claims or status vocabulary;
- altering the rule model, audit history, public API, or export contract;
- introducing an external OCR, AI, insurer, broker, or identity service;
- weakening a control described in the threat model;
- making a backward-incompatible data migration; and
- changing the license or governance model.

A proposal should identify affected users, alternatives, compatibility,
security and privacy effects, migration, and tests. Maintainers may use a
time-boxed comment period for consequential decisions.

Urgent security fixes may be developed privately and merged with limited detail
until users have had a reasonable opportunity to patch. The rationale and
advisory should become public when disclosure is safe.

## Releases and compatibility

Maintainers publish releases and release notes. Before 1.0, incompatible
changes may occur but should include migration guidance. After 1.0, public APIs
and stored-data formats should follow semantic versioning, with deprecation
before removal unless a security issue makes that unsafe.

A release is not a certification of legal compliance, policy validity, or
fitness for a particular organization's risk program. Operators remain
responsible for configuration, deployment, document review, and professional
advice.

## Conflicts of interest

Reviewers must disclose material personal or commercial interests in a
decision. A maintainer should recuse themselves when they cannot review fairly,
including from conduct or security reports involving them. Commercial support
or sponsorship may fund work but does not buy roadmap priority, private product
control, or a favorable technical decision.

## Changing governance

Governance changes require a public pull request, an explanation of the need,
and a reasonable community comment period. The project should revisit this
model when it has at least three active, independent maintainers and consider a
documented voting or steering model at that point.
