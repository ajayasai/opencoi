# Head-to-head benchmark status

**Status date:** 2026-09-01

The public corpus, prediction schema, scorer, basic comparison tool, and
[authorization-aware head-to-head harness](HEAD_TO_HEAD.md) are ready.
Only OpenCOI has been executed because the maintainers do not have authorized,
publishable access to the commercial systems. “Not tested” is evidence status,
not a zero score.

| System | Zero-touch text parser | Browser/PDF OCR | Human-assisted review | Publication status |
| --- | --- | --- | --- | --- |
| OpenCOI v0.4.0 | [Published result](results/synthetic-text-v1-opencoi-v0.4.0.score.json) | Not tested | Not tested | Reproducible synthetic baseline |
| Certificial | Not tested | Not tested | Not tested | Awaiting authorized run |
| myCOI / illumend | Not tested | Not tested | Not tested | Awaiting authorized run |
| SmartCompliance | Not tested | Not tested | Not tested | Awaiting authorized run |
| TrustLayer | Not tested | Not tested | Not tested | Awaiting authorized run |
| CertFocus | Not tested | Not tested | Not tested | Awaiting authorized run |

An authorized comparator run must freeze the corpus hash and settings, declare
zero-touch versus human-assisted mode, generate predictions before truth is
opened, retain failure cases, and use the same scorer. A real-world accuracy
claim additionally requires a licensed, de-identified, blinded holdout,
independent annotation and adjudication, and paired document-level confidence
intervals. The current six-case corpus is a transparent regression set, not
enough evidence for a universal product ranking.

The frozen synthetic corpus checksum is published in
[`corpus/synthetic-text-v1.sha256`](corpus/synthetic-text-v1.sha256) and embedded
in every prediction, score, and comparison artifact.

The committed [synthetic example manifest](examples/head-to-head-synthetic-v1.manifest.json)
turns this table into a committed deterministic [JSON report](results/head-to-head-synthetic-v1.json)
and [Markdown report](results/head-to-head-synthetic-v1.md) without manufacturing competitor
numbers. `TESTED` in those reports records a publisher's self-attestation; the
harness does not independently verify legal permission.
