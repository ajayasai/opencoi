# OCR and human review

OpenCOI treats extraction as a proposal, not a decision. PDF.js and Tesseract.js help a person transcribe the document; only confirmed structured facts can satisfy a configured rule.

No OCR step establishes that an insurer issued the document, that the underlying policy remains active, that an endorsement is legally effective, or that coverage will respond to a claim.

## What runs where

Before submission, extraction runs in the browser:

- PDF.js opens the selected bytes, renders the preview, and reads embedded text layers.
- Tesseract.js processes page canvases when a page lacks enough usable embedded text.
- OpenCOI's shared heuristic parser proposes structured fields from the resulting text.
- The user can compare the PDF and proposals without first uploading the file.

OpenCOI does not send PDF pages, page images, or extracted text to a third-party OCR API. The build vendors the Tesseract worker, every required WebAssembly core variant, and the English `best_int` language data from locked npm packages. OpenCOI serves those assets from same-origin `/tesseract/` paths, so OCR has no runtime CDN dependency. The assets execute and cache in the browser.

When the user submits, the browser sends the original PDF, extracted page text, extraction method metadata, and edited structured facts to the self-hosted OpenCOI server. The server stores the original PDF and the extraction/review record. "Browser-side OCR" therefore does not mean that submitted documents stay only on the user's device.

## Extraction pipeline

### 1. File selection

The browser checks the filename or declared MIME type, size, and the `%PDF-` signature before starting extraction. The server repeats authoritative signature and size checks and does not trust client metadata.

### 2. Digital text first

For each page, PDF.js reconstructs lines from text items. A page with at least 80 usable characters is kept as `text_layer` extraction with full extraction confidence. This is usually faster and more accurate than OCR for digitally generated COIs.

### 3. OCR fallback

A page below the usable-text threshold is rendered at 1.65× scale and passed to an English Tesseract worker. Progress is shown per page. OCR confidence is retained as a proposal hint only.

To bound browser resource use, v0.1 OCR-processes at most the first 20 scanned pages. Additional pages remain available in the document but require manual transcription and confirmation.

### 4. Heuristic field proposals

The shared parser normalizes whitespace and OCR punctuation, then looks for conservative COI patterns. It can propose:

- common coverage sections;
- insurer names on labeled insurer lines;
- labeled or plausible policy numbers;
- US-style numeric and unambiguous ISO or named-month dates;
- common occurrence, aggregate, auto, employers-liability, and similar limit labels;
- amounts with common separators, currency marks, and `K`, `M`, or `B` suffixes; and
- common endorsement names and form-code-like text.

The parser returns warnings when no standard coverage section is recognized, multiple insurers cannot be assigned safely, policy numbers are missing, or a complete date pair is unavailable.

It does not use a large language model, infer policy wording, resolve ambiguous insurer-to-policy relationships, or read handwriting reliably.

## Review workflows

### Staff upload

An authenticated staff member selects a vendor, uploads a PDF, edits the proposed parties and policy rows, and compares them with the rendered source. Submission is blocked until the reviewer checks the attestation that the fields were reviewed against the PDF.

The server then marks the submitted facts confirmed, resolves the current published requirement version, evaluates the document, and persists the facts and findings.

### Vendor self-service upload

An administrator or reviewer creates an expiring vendor-specific bearer link. The vendor can upload and edit extraction proposals without an account, but cannot make them trusted evidence.

The server forces every public-link submission to `UNCONFIRMED`, even if a modified client claims otherwise. It consumes the allowed link use, stores the submission, and places it in the review queue. An authenticated reviewer opens the original and extracted facts, gives an explicit attestation, and confirms the revision. The server evaluates it against the requirement profile current at confirmation time and records that version and evaluation date.

Treat the URL as a secret. Anyone with an active unused link can submit a document for that vendor.

## Fields in the v0.1 review form

The review workspace supports:

- named insured, producer/broker, certificate holder, and issue date;
- add, remove, and reclassify policy rows;
- insurer, policy number, effective date, and expiration date;
- each-occurrence/claim and aggregate amounts in major currency units; and
- explicit evidence levels for additional insured, waiver of subrogation, and primary/non-contributory; and
- arbitrary named or form-coded endorsements included in the PDF package.

Blank values remain absent. They are not converted to zero. The reviewer chooses among no evidence, a certificate mention, an endorsement included in the PDF package, and an attached endorsement personally reviewed. A certificate indication is never automatically promoted to attached or human-verified evidence.

The underlying metadata and rule model represent more coverage and limit types than the v0.1 form exposes. Unusual documents still require careful manual mapping and should remain `UNKNOWN` or `FAIL` when the reviewer cannot establish the required evidence level.

## Extraction and server limits

| Boundary | v0.1 behavior |
| --- | --- |
| Upload size | 15 MiB by default; server-configurable from 1 through 100 MiB. The browser form currently enforces 15 MiB. |
| Stored PDF page safety limit | 75 pages, based on conservative byte-level page-marker inspection. |
| OCR page limit | First 20 pages that need OCR. Digital text-layer pages are still read across the PDF. |
| OCR language | English (`eng`). |
| Digital-text threshold | 80 usable characters per page before OCR fallback. |
| OCR render scale | 1.65×. |
| Structured policy rows | At most 50 per submission. |
| Submitted extraction text | At most 2,000,000 characters. |
| Submitted page metadata | At most 100 entries. |

These are safety and usability bounds, not supported-document guarantees. A malformed or visually complex file can still fail below every limit.

## Server-side PDF triage

Before storing a PDF, the server:

- requires the `%PDF-` signature at byte zero;
- computes SHA-256 and stores the byte size;
- rejects encrypted PDFs;
- rejects markers for JavaScript, JavaScript actions, launch actions, embedded files, rich media, and XFA forms;
- rejects the page estimate above 75; and
- writes through a server-generated UUID path with owner-only permissions.

The original filename is sanitized only for download presentation and never used as a storage path.

This inspection is deliberately conservative and byte-oriented. It is not antivirus, a full PDF validator, a rendering sandbox, or content disarm/reconstruction. A deployment accepting untrusted public uploads should use layered isolation and, where required, an upstream malware-scanning or CDR service. Review [THREAT_MODEL.md](THREAT_MODEL.md) before public exposure.

## Data retained after submission

The standard deployment retains:

- the original PDF;
- its generated storage key, size, and SHA-256;
- raw extracted text and per-page extraction metadata;
- the edited structured facts;
- review and upload actors and timestamps;
- requirement version and evaluation date;
- persisted findings and exception links; and
- related audit events.

These records can contain personal and commercially sensitive information. Operators must define retention, access, backup, deletion, and incident-response practices. The v0.1 UI does not provide a complete retention-policy engine.

## Review checklist

Before confirming a document, a reviewer should verify at least:

1. the vendor context and named insured;
2. each coverage classification and its insurer and policy number;
3. effective and expiration dates, including transposed month/day values;
4. every monetary amount and its basis, not just the largest number on the page;
5. whether an item is merely indicated on the certificate or supported by an attached endorsement;
6. the certificate holder and any relevant form number; and
7. parser warnings, blank fields, duplicate policy rows, and unexpected pages.

Qualified insurance or legal review may still be needed. A certificate is informational and can conflict with the policy or endorsements.

## Common problems

| Symptom | Response |
| --- | --- |
| Very little text detected | Confirm that the PDF is readable, enter required fields manually, or request a clearer unlocked copy. |
| OCR is slow | Prefer a text-searchable PDF, reduce unnecessary scanned pages, and keep the browser tab active. |
| Multiple insurers proposed | Assign each policy manually; OpenCOI will not guess an ambiguous relationship. |
| Dates appear reversed | Compare every date with the source; the parser favors US-style numeric dates and unambiguous ISO dates. |
| Limit missing or wrong | Verify the limit label and basis, then enter the amount in major units. Do not substitute an aggregate for an occurrence limit. |
| Endorsement fails despite a checked box | The rule may require attached or human-verified evidence; a COI indication is only `MENTIONED`. |
| Encrypted or active PDF rejected | Ask for an unlocked, inert PDF. Do not weaken the server check for one document. |
| Vendor submission remains Needs review | This is expected until an authenticated reviewer confirms and re-evaluates it. |

## Testing

Parser tests cover normalization, dates, amounts, coverage markers, policy-number and insurer proposals, limit mapping, warnings, and endorsement indications. Storage and HTTP tests cover PDF signatures, active content, encryption, generated paths, public-link state, forced unconfirmed intake, confirmation, and organization authorization.

Run `npm run test:run` for the suite and `npm run test:coverage` for a local coverage report.
