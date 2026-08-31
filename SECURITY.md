# Security policy

OpenCOI handles insurance documents, contact details, policy identifiers, and
decisions that can affect vendor access. Treat every deployment as a
security-sensitive document system.

## Report a vulnerability privately

Use GitHub's **Security** tab and select **Report a vulnerability**. GitHub
Private Vulnerability Reporting is the project's security contact; there is
intentionally no public security email in this repository.

Do not disclose a suspected vulnerability in an issue, discussion, pull
request, or other public channel. If the private reporting option is not
visible, ask the repository owner to enable it without including any sensitive
details. Project maintainers should enable Private Vulnerability Reporting
before operating a public deployment.

Please include:

- the affected release, commit, deployment mode, and configuration;
- a clear description of the impact and the boundary crossed;
- minimal, non-destructive reproduction steps or a proof of concept;
- any prerequisites and suggested mitigations; and
- a GitHub account through which the maintainers can follow up privately.

Never attach a real certificate of insurance, production database, access
token, credential, or other person's data. Use a synthetic document and redact
secrets from screenshots and logs.

## What to expect

This is a community project and does not promise a commercial response-time
SLA. Maintainers will make a good-faith effort to acknowledge a complete
report, assess severity, coordinate a fix, and publish an advisory when
appropriate. Please allow a reasonable remediation period before public
disclosure. A report may be closed as out of scope when it describes a product
limitation rather than a security boundary failure.

## Supported versions

Until the project reaches a stable release, security fixes are provided on the
latest published release and the default branch only. Older pre-1.0 releases
should be considered unsupported and upgraded rather than patched in place.

## Security-relevant scope

Examples of in-scope reports include:

- authentication or authorization bypass;
- cross-organization or cross-vendor data access;
- public upload-link disclosure, guessing, replay, or privilege escalation;
- arbitrary code execution, server-side request forgery, path traversal, or
  sandbox escape through PDF parsing or OCR;
- stored or reflected cross-site scripting from filenames or extracted text;
- spreadsheet-formula injection in exports;
- leakage of documents, OCR text, session data, secrets, or upload tokens;
- material audit-history tampering; and
- a practical denial of service that bypasses documented resource limits.

The following are normally not security vulnerabilities:

- OCR mistakes that remain visible for human confirmation;
- a finding caused by an organization's incorrectly configured requirement;
- disagreement about the legal or insurance meaning of a document;
- absence of a production hardening control that the deployment guide clearly
  assigns to the operator; or
- failure to detect a policy change that happened after a document was issued.

The last item is an important product boundary: OpenCOI compares confirmed
information in uploaded documents with configured rules. It does not contact
an insurer, prove that a policy is active, interpret the underlying policy, or
guarantee coverage or payment of a claim.

## Deployment responsibility

Self-hosting transfers meaningful responsibility to the operator. Production
operators must use supported dependencies, TLS, secure secret management,
private document storage, least-privilege access, backups, retention controls,
upload isolation, rate limits, monitoring, and a tested incident-response
process. Review [the threat model](docs/THREAT_MODEL.md) before exposing an
instance to untrusted users or files.

## Coordinated disclosure and safe harbor

We welcome good-faith research that avoids privacy violations, service
disruption, social engineering, persistence, and access beyond what is needed
to demonstrate the issue. Stop testing and report immediately if you encounter
another person's data. We will not pursue action against good-faith research
that follows this policy, but this policy cannot authorize testing of third
parties, hosted instances not operated by this project, or systems outside the
repository owner's control.
