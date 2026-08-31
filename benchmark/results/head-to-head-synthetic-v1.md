# Synthetic text benchmark: public evidence status

- **Report date:** 2026-09-01
- **Corpus:** OpenCOI original synthetic page-text benchmark v1 (`opencoi-synthetic-text-v1`, 6 cases)
- **Corpus SHA-256:** `af737d1acaa50b4c827b78dfeecba30219dc484e0022f869d111381073020012`
- **Reference system:** `opencoi-shared-parser`

> `TESTED` means a normalized artifact was supplied with self-attested access and publication declarations. The harness does not independently verify those rights. `NOT_TESTED` is not a zero score.

## Results

Rows are ordered by stable system id, never by score.

| System | Version | Status | Facts F1 | Macro F1 | Citation recall | Warning F1 | Exact documents | Facts F1 delta |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CertFocus | — | NOT_TESTED: No authorized, publishable normalized prediction artifact was supplied. | — | — | — | — | — | — |
| Certificial | — | NOT_TESTED: No authorized, publishable normalized prediction artifact was supplied. | — | — | — | — | — | — |
| myCOI / illumend | — | NOT_TESTED: No authorized, publishable normalized prediction artifact was supplied. | — | — | — | — | — | — |
| OpenCOI shared text parser | v0.4.0 | TESTED | 98.4% | 99.2% | 96.9% | 100.0% | 5/6 (83.3%) | +0.0 pp |
| SmartCompliance | — | NOT_TESTED: No authorized, publishable normalized prediction artifact was supplied. | — | — | — | — | — | — |
| TrustLayer | — | NOT_TESTED: No authorized, publishable normalized prediction artifact was supplied. | — | — | — | — | — | — |

## Methodology

- Mode: `ZERO_TOUCH_TEXT_PARSE`.
- Scorer: OpenCOI deterministic benchmark scorer 1.0.
- Protocol: Supply vendor-neutral prediction-v1 artifacts generated from the identical frozen page-text corpus, validate them strictly, then score every supplied artifact with the same deterministic scorer. Do not inspect truth while producing new comparator predictions.
- Missing data: `NOT_TESTED_IS_NOT_ZERO`.
- Authorization evidence: `SELF_ATTESTATION_RECORDED_NOT_VERIFIED`.
- Deltas are descriptive differences from the declared reference, not ranks or statistical significance tests.

## Tested-artifact provenance

### OpenCOI shared text parser v0.4.0

- System id: `opencoi-shared-parser`
- Source: `FIRST_PARTY_RUN`; benchmark/results/synthetic-text-v1-opencoi-v0.4.0.predictions.json
- Source artifact SHA-256: `d63d21e3ab223ee98d71fce0cd474866307f2c4116617590822c4758270f8963`
- Prediction artifact SHA-256: `d63d21e3ab223ee98d71fce0cd474866307f2c4116617590822c4758270f8963`
- Output produced: 2026-09-01T00:00:00Z; run by OpenCOI maintainers
- Truth access: `NOT_BLINDED`
- Normalization: Direct output from the committed OpenCOI shared-parser adapter; no third-party format translation.
- Settings: mode=ZERO_TOUCH_TEXT_PARSE; timing=disabled for deterministic output
- Normalized prediction SHA-256: `509f1566a5b34c28008b7840eebc2bbea0c3bbc4c9fd432ae9e770d2e2fabbe7`
- Deterministic score SHA-256: `4bff2f4105b5a5e541df962af4fc98b03ba715f37572be3a4554fb49ac8e8a8e`
- Authorization: self-attested by OpenCOI maintainers at 2026-09-01T00:00:00Z; First-party execution of the AGPL-3.0-only OpenCOI parser against the CC0-1.0 synthetic corpus.

## Limitations

- TESTED records a supplied normalized artifact and publisher declarations; it does not independently verify legal authorization or publication rights.
- NOT_TESTED means no authorized publishable artifact was supplied; it is not a zero score and has no delta.
- Synthetic zero-touch text parsing does not measure browser OCR, policy status, workflow quality, integrations, usability, or overall product superiority.
- The six-case corpus is original synthetic regression data and is too small for a general accuracy claim.
- The published OpenCOI baseline was not blinded; it is included only to demonstrate the public protocol and evidence status.
