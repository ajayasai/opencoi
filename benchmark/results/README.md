# Published benchmark results

This directory contains machine-readable outputs generated from committed,
public benchmark inputs and scripts.

- `synthetic-text-v1-opencoi-v0.4.0.predictions.json` is the current release's
  zero-touch shared-text-parser output.
- `synthetic-text-v1-opencoi-v0.4.0.score.json` is its deterministic score.
- The corresponding v0.2.0 files are retained as historical evidence.
- `head-to-head-synthetic-v1.json` and `.md` are the generated public status
  report: OpenCOI is tested on this synthetic parser corpus; every unavailable
  commercial comparator remains `NOT_TESTED`.
- `scale-windows-2026-08-31.json` is a hardware-labelled internal vendor-list
  workload. It is not a production capacity guarantee.

There are no Certificial, myCOI/illumend, SmartCompliance, TrustLayer, or
CertFocus scores here. None of those systems was lawfully run on this corpus,
so publishing a number for them would be fabricated. The vendor-neutral
prediction schema and comparison tool are ready for an authorized evaluation.
All published extraction artifacts embed the canonical corpus SHA-256 from
`../corpus/synthetic-text-v1.sha256`; the scorer and comparison tool reject a
checksum mismatch.
