# Authorization-aware head-to-head harness

The head-to-head harness turns one frozen corpus, a declared system roster, and
zero or more vendor-neutral prediction artifacts into deterministic JSON and
Markdown reports. It uses the same scorer for every supplied artifact and
renders missing products as `NOT_TESTED`, never as zero.

The harness is evidence infrastructure, not permission to access a product.
Only submit outputs you were authorized to produce and allowed to publish. A
manifest records that declaration and its basis, but OpenCOI cannot independently
verify contractual or legal rights. The resulting report says so explicitly.

## Run the public synthetic example

From the repository root:

```text
npm run benchmark:head-to-head -- benchmark/corpus/synthetic-text-v1.json benchmark/examples/head-to-head-synthetic-v1.manifest.json data/head-to-head-synthetic-v1
```

This writes `data/head-to-head-synthetic-v1.json` and
`data/head-to-head-synthetic-v1.md`. The example supplies only the committed
OpenCOI prediction artifact. Certificial, myCOI/illumend, SmartCompliance,
TrustLayer, and CertFocus remain explicitly `NOT_TESTED`; no competitor output
or result is invented.

## Input contracts

The strict, versioned contracts are:

- [`schemas/prediction-v1.schema.json`](schemas/prediction-v1.schema.json) for
  normalized facts, warning codes, system identity, mode, and corpus hash;
- [`schemas/head-to-head-manifest-v1.schema.json`](schemas/head-to-head-manifest-v1.schema.json)
  for the roster, artifact paths, run provenance, and authorization/publication
  declarations; and
- [`schemas/head-to-head-report-v1.schema.json`](schemas/head-to-head-report-v1.schema.json)
  for the deterministic machine report.

For a tested row, set `status` to `PROVIDED`, point `predictionPath` to a
prediction-v1 artifact relative to the manifest, and provide:

- who ran it, when, how, under which settings, and whether truth was visible;
- the source artifact label and optional source SHA-256, plus the required exact
  normalized-prediction file SHA-256 that the CLI verifies before scoring;
- an access-authorization declaration and its basis; and
- a publication-permission declaration and its basis.

The CLI rejects undeclared access or publication permission, unknown fields,
identity mismatches, duplicate system ids, invalid prediction shapes, and corpus
id/hash mismatches. These are technical safeguards around publisher
self-attestation; they are not independent legal verification.

## Fair-run protocol

For an actual comparator run:

1. Freeze and publish the corpus SHA-256, run mode, settings, normalization map,
   scorer version, and system roster before scoring.
2. Use lawfully obtained inputs that every tested system is allowed to process.
3. Generate outputs before revealing truth. Keep raw exports privately if their
   terms prohibit publication, and publish only when permission covers the
   normalized artifact and derived metrics.
4. Normalize every output to prediction v1 without adding facts that the source
   system did not produce. Record the exact normalization method.
5. Retain all cases and failures. Do not remove difficult cases per product.
6. Run this harness once against the identical corpus. Publish both generated
   reports, the manifest, normalized predictions, hashes, and any allowed source
   artifacts.

Rows are ordered by system id rather than score. Deltas are descriptive
differences from the declared reference; the harness does not rank products or
calculate statistical significance.

## What this does not prove

The bundled corpus contains six synthetic page-text cases. It does not measure
PDF rendering, OCR, human review, workflow quality, endorsement attachment
validation, live policy status, integrations, support, security, usability, or
enterprise scale. A credible real-world comparison still requires a licensed,
de-identified, blinded holdout, independent annotation and adjudication, and
paired document-level uncertainty estimates. No output of this harness alone
supports a universal “better overall” claim.
