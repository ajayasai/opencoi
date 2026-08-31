# Contributing to OpenCOI

Thank you for helping build an explainable, self-hostable certificate of
insurance tracking system. Contributions are welcome from engineers,
compliance practitioners, security reviewers, designers, technical writers,
and people who submit careful bug reports.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Start with the product boundary

OpenCOI assesses a document against requirements configured by the operator.
It does not verify live insurer records, determine that a policy remains
active, interpret an insurance contract or law, or guarantee coverage. Product
copy, tests, exports, and documentation must preserve that distinction.

Prefer these status terms:

- `Meets configured document checks`
- `Deficient against configured document checks`
- `Needs review`
- `Approved exception`
- `Not submitted`

Avoid unqualified claims such as `insured`, `coverage verified`, `policy
active`, or `compliant`.

## Before opening a pull request

For bugs and small improvements, open an issue or a focused pull request. For a
new workflow, rule type, data-model change, public API, dependency with a large
security footprint, or backward-incompatible change, start with an issue that
describes:

- the user and problem;
- the proposed behavior and alternatives considered;
- security, privacy, migration, and accessibility effects; and
- how the behavior can be verified without real customer data.

Security vulnerabilities must be reported privately under
[SECURITY.md](SECURITY.md), never in a public issue.

## Local workflow

The repository requires the Node.js and npm versions declared in
`package.json`. Copy `.env.example` to `.env`, review the local-only defaults,
and then run:

```text
npm ci
npm run dev
```

Before submitting a change, run:

```text
npm run check
npm run build
```

If a command is not available on your platform, include the equivalent command
you used and its result in the pull request.

## Pull request expectations

- Keep the change focused and explain its user-visible effect.
- Add or update tests for behavior, security boundaries, and important edge
  cases.
- Update documentation and screenshots when the workflow changes.
- Include migration and rollback notes for stored-data changes.
- Preserve compatibility unless the breaking change was discussed first.
- Do not weaken authentication, authorization, auditability, upload isolation,
  human confirmation, or safe export handling for convenience.
- Confirm that generated files, credentials, local databases, uploads, and
  environment files are not included.

Reviewers may ask for a smaller change, additional tests, threat-model updates,
or domain review. Approval is based on correctness and project fit, not on
whether a contributor is already a maintainer.

## Domain and rule-engine standards

Rules must be deterministic, typed, explainable, and safe to run as data. Do
not introduce arbitrary JavaScript, SQL, shell commands, or other executable
expressions as a rule format. A result should identify the requirement version,
evaluation date, confirmed certificate revision, expected value, actual value,
evidence, and reason code.

Missing, contradictory, incomparable, or unconfirmed data should produce
`Needs review` or an `UNKNOWN` finding, not an invented zero or a pass.
Exceptions must be scoped, time-bounded, and recorded separately from the base
finding; an approval must not rewrite a deficiency into a successful check.

Changes involving insurance semantics should include representative boundary
tests, including dates, currencies, coverage bases, limits, endorsement evidence,
and the default prohibition on silently stacking policies.

## Fixtures, privacy, and intellectual property

Use synthetic vendors, people, policy numbers, certificates, and endorsements
in tests, screenshots, examples, and bug reports. Do not commit a real COI, even
if names have been blurred: PDFs can retain text, metadata, attachments, and
revision history.

Do not copy proprietary application screens or bundle third-party forms,
logos, boilerplate, or coordinate maps without confirmed redistribution rights.
Create independently designed fixtures and interfaces. A user-supplied document
may be processed without making that document part of the project.

## Security-sensitive code

Treat filenames, PDFs, OCR output, free text, links, and export cells as
attacker-controlled. Changes to file handling, public upload links, identity,
authorization, storage, notifications, exports, parsing, or logging should
reference the relevant abuse case in [the threat model](docs/THREAT_MODEL.md)
and add a regression test where practical.

## Commit and review hygiene

Write concise commit messages in the imperative mood and avoid mixing unrelated
formatting changes with functional work. The project may squash a pull request
at merge time. By contributing, you represent that you have the right to submit
the work under the repository's license.
