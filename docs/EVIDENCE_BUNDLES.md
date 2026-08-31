# Signed evidence bundles

OpenCOI can export one certificate decision as a portable JSON record signed
with an organization-specific Ed25519 key. The export is intended to let an
auditor, customer, or another tool inspect exactly which document facts,
configured rules, evidence citations, human review, findings, and exceptions
produced the displayed document status.

The bundle does **not** assert that a policy is active in an insurer's system.
It preserves and authenticates an OpenCOI document assessment at an export
time.

Verification confirms the bundle's integrity under its included signing key
and can optionally confirm the source PDF hash. It does not rerun the evaluator,
prove that the recorded outcome is correct, or identify the organization unless
the public-key fingerprint is matched through an independently trusted channel.

## Contents

Version 1 bundles include:

- the source PDF filename, byte size, upload time, and SHA-256 digest;
- the immutable extraction proposal received for an unreviewed submission,
  including submitted page text and page-linked citations when present;
- the human-confirmed facts and reviewer attestation only after confirmation;
- the exact normalized ruleset used for evaluation, its vendor type and
  version, plus matching publication metadata when available;
- immutable base findings, expected and observed values, and evidence IDs;
- separately recorded exception requests and decisions;
- the document-check and document-lifecycle status at export time;
- an audit-chain checkpoint and certificate-specific audit events; and
- a SHA-256 digest and Ed25519 signature over the canonical unsigned record.

The JSON envelope is described by
[`docs/schemas/evidence-bundle-v1.schema.json`](schemas/evidence-bundle-v1.schema.json).
`confirmedFacts` is `null` for draft and rejected records. `machineProposal` is
`null` when the record was confirmed directly at staff intake or predates
server-side proposal preservation; the exporter never relabels corrected facts
as the original proposal.

## Export and offline verification

Open a certificate record and choose **Evidence bundle**. The browser downloads
`opencoi-evidence-<certificate-id>.json` without sending the PDF or extracted
text to a third party.

Verify the JSON signature and digest:

```text
npm run evidence:verify -- path/to/opencoi-evidence.json
```

Also bind the export to a copy of the original PDF:

```text
npm run evidence:verify -- path/to/opencoi-evidence.json --pdf path/to/certificate.pdf
```

For signer identity—not only integrity—compare the bundle's public-key
fingerprint with a fingerprint obtained through a separately trusted channel:

```text
npm run evidence:verify -- path/to/opencoi-evidence.json --trusted-key-fingerprint <sha256>
```

An embedded public key can prove that the signed payload has not changed since
it was signed. By itself, it cannot prove who controls that key. The separately
trusted fingerprint is therefore required when organization identity matters.
The verifier prints this identity boundary explicitly and does not label a
self-contained signature as trusted organization identity.

## Key protection and operations

`TOKEN_PEPPER` must contain at least 32 UTF-8 bytes before signed export is
available. On the first export OpenCOI generates one Ed25519 key for the
organization, stores the public SPKI and fingerprint, and encrypts the PKCS#8
private key with AES-256-GCM using record-bound associated data.

Preserve `TOKEN_PEPPER` and back up the database with the rest of the OpenCOI
data. Losing either makes existing private signing material unusable. Changing
the pepper without a planned key migration also makes the stored private key
unreadable. Version 1 does not yet expose key rotation in the UI; publish the
fingerprint through a controlled channel and record any emergency replacement
as an operational event.

Assessments created before v0.3 did not persist both the evaluated vendor type
and normalized ruleset. Their exports leave `requirementSnapshot` null rather
than attaching the vendor's current rules and misrepresenting them as historic
inputs. Reconfirming a still-pending document under v0.3 records the new exact
evaluation context; OpenCOI does not silently reevaluate an old confirmed
decision.

## Privacy and retention

Evidence bundles can contain full extracted page text, vendor details, reviewer
names, policy numbers, and business exception rationales. Treat them like the
source certificate: restrict access, transfer them over protected channels,
apply a retention schedule, and do not attach real bundles to public issues.
