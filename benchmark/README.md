# OpenCOI text-extraction benchmark

This directory contains a small, original, reproducible benchmark for the
**shared page-text parser**. It provides a vendor-neutral prediction format,
deterministic scoring, page-citation metrics, and descriptive comparisons.

It is intentionally not presented as a browser OCR or real-world accuracy
benchmark. The corpus supplies idealized text that might have come from a PDF
text layer or OCR engine. It does not open PDFs, render pages, run PDF.js, run
Tesseract, measure human review, establish live policy status, or exercise the
server application.

## Safe scope

Every case is an original synthetic example. It uses fictional `Example`
organizations and is marked `SYNTHETIC TEST FIXTURE - VOID - NOT EVIDENCE OF
INSURANCE`. The corpus does not reproduce an ACORD form, commercial-product UI,
real certificate, logo, policy, endorsement wording, or personal information.
Corpus data is dedicated under CC0-1.0; application and benchmark code remains
AGPL-3.0-only.

The corpus is deliberately small and transparent. It is useful for regression
testing and for making parser limitations measurable. It is not representative
of production documents, and scores from it cannot support a claim that one COI
product is generally better than another.

## Run the exact shared parser

From the repository root, with development dependencies installed:

```text
npx tsx benchmark/run-shared.ts benchmark/corpus/synthetic-text-v1.json data/text-predictions.json working-tree
npx tsx benchmark/score.ts benchmark/corpus/synthetic-text-v1.json data/text-predictions.json
npx tsx benchmark/hash-corpus.ts benchmark/corpus/synthetic-text-v1.json
```

`run-shared.ts` joins each supplied page using the same `--- Page N ---`
envelope produced by browser intake, then calls `parseCoiText`. It intentionally
does not record wall-clock time so repeated prediction files are byte-for-byte
stable for the same source and version label. Prediction and score files carry
`corpusSha256`, the SHA-256 of canonical semantic corpus JSON. The canonicalizer
sorts object keys recursively, retains array order, and uses JSON scalar
encoding, so indentation and checkout line endings do not change the identity.
The published checksum is in `corpus/synthetic-text-v1.sha256`.

To score another system, map its zero-touch text-parser output to
[`prediction-v1.schema.json`](schemas/prediction-v1.schema.json). Do not inspect
truth while producing predictions. Missing citations are permitted and receive
no page-evidence credit. The schemas are strict and self-contained: every
reference is internal, so a Draft 2020-12 validator can load each schema without
a custom URL registry. The scorer rejects a prediction whose corpus checksum
does not match the corpus supplied for scoring.

## Compare score files

The comparison command requires a declared reference system and at least two
score files:

```text
npx tsx benchmark/compare.ts opencoi-shared-parser score-open.json score-other.json
```

Rows are sorted by system id, not by score. The output contains descriptive
deltas from the selected reference. It does not calculate statistical
significance, rank products, or assert superiority. A commercial-product result
must not be published without authorized access, an identical run mode,
documented settings, a frozen corpus hash, and permission to publish the result.
The comparison command validates each score's structure and arithmetic and
refuses score files with different corpus ids or checksums.

## Metrics

The scorer flattens each document into atomic facts:

- named insured and certificate holder;
- coverage type, insurer, policy number, effective date, and expiration date;
- each exact limit type and integer minor-unit value; and
- endorsement name, form code, and conservative evidence level.

A correct value is a true positive. A wrong value is one false positive and one
false negative. Missing and extra values are counted independently. Metrics are
rounded to six decimal places.

Reported measures are:

- micro precision, recall, and F1 across atomic facts;
- macro F1 across field types;
- per-field precision, recall, and F1;
- exact-document rate;
- warning-code precision, recall, and F1;
- citation coverage for correct predictions;
- citation precision: correct value and overlapping truth page divided by all
  predictions that attempted a page citation; and
- citation recall: correct value and overlapping truth page divided by truth
  facts that have page evidence.

Names are compared after Unicode NFKC normalization, whitespace collapse, and
case folding. Policy and form identifiers additionally ignore punctuation and
whitespace. Dates, coverage labels, evidence levels, limit types, and numeric
values otherwise compare exactly. Corpus v1 allows at most one policy for each
normalized coverage type; a future corpus must introduce a preregistered
one-to-one policy-matching algorithm before adding duplicates.

## Files

- `corpus/synthetic-text-v1.json` — six original synthetic page-text cases and
  page-linked truth.
- `corpus/synthetic-text-v1.sha256` — canonical semantic corpus checksum.
- `schemas/corpus-v1.schema.json` — corpus and truth contract.
- `schemas/prediction-v1.schema.json` — vendor-neutral prediction contract.
- `schemas/score-v1.schema.json` — score output contract.
- `schemas/comparison-v1.schema.json` — descriptive comparison output contract.
- `run-shared.ts` — OpenCOI shared-parser adapter.
- `hash-corpus.ts` and `serialization.ts` — checksum and deterministic artifact
  serialization implementation.
- `score.ts` — deterministic scorer CLI.
- `compare.ts` — descriptive comparison CLI.
- `../shared/benchmark.ts` — dependency-free contracts, validation, scoring,
  and comparison implementation.

## What a credible accuracy claim still requires

Before calling this a real-world or head-to-head benchmark, add a legally
licensed, de-identified, blinded holdout with a public annotation guide, two
independent annotators and adjudication, predictions committed before labels
are revealed, identical zero-touch or human-assisted modes, and paired
document-level confidence intervals. Browser OCR must be measured separately
by running the production PDF.js/Tesseract path on pinned PDF fixtures. Neither
work is simulated by this corpus.
