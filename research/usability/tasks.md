# Synthetic study tasks

All names, organizations, contacts, policy values, and PDFs used here must be synthetic. The
moderator supplies a seeded workspace and synthetic document pack. A task is successful only when
the observable criteria are met; arriving at a similar-looking page is not enough.

## Frozen within-role order rotation

Every participant attempts every task allocated to their role. Assign the next rotation in sequence
within each role; do not choose an order in response to participant performance.

| Role | Rotation 1 | Rotation 2 | Rotation 3 | Rotation 4 | Rotation 5 |
| --- | --- | --- | --- | --- | --- |
| COI reviewer | `T04, T05, T06` | `T05, T06, T04` | `T06, T04, T05` | `T04, T06, T05` | `T05, T04, T06` |
| Procurement manager | `T01, T02, T06, T07, T08` | `T02, T06, T07, T08, T01` | `T06, T07, T08, T01, T02` | `T07, T08, T01, T02, T06` | `T08, T01, T02, T06, T07` |
| Vendor uploader | `T03` | `T03` | `T03` | `T03` | `T03` |

For recruitment beyond five people in one role, repeat the rotations from Rotation 1. The final
scope-comprehension check is administered once after the last task in the assigned rotation.

## T01_CREATE_REQUIREMENTS — procurement manager

Scenario: Northstar Demo Builders is adding a “Field contractors” vendor type. It requires
commercial general liability with a $1,000,000 each-occurrence limit, $2,000,000 aggregate, and
additional-insured evidence. The document warning window is 30 days.

Ask: Configure and publish that requirement profile.

Success:

- the correct vendor type is selected or created;
- all stated requirements and exact limits are present;
- the profile is published as a new version; and
- the participant can identify that prior decisions were not silently rewritten.

Time box: 8 minutes.

## T02_CREATE_VENDOR_LINK — procurement manager

Scenario: Synthetic vendor Redwood Electrical Demo needs a single-use upload link that expires in
14 days.

Ask: Find the vendor, create the scoped link, and explain how you would deliver it safely.

Success:

- the link is created for the correct vendor and expiry;
- the participant identifies it as a bearer secret; and
- no real recipient or external service is used during the session.

Time box: 5 minutes.

## T03_VENDOR_UPLOAD — vendor uploader

Scenario: You received a secure link from Northstar Demo Builders and the synthetic file
`redwood-renewal-synthetic.pdf`.

Ask: Review the stated requirements and submit the PDF.

Success:

- the correct synthetic PDF is selected;
- local extraction reaches a reviewable state;
- the submission receipt is shown; and
- the participant understands that staff review is still required.

Time box: 8 minutes.

## T04_REVIEW_CORRECT — COI reviewer

Scenario: The review queue contains a synthetic Redwood Electrical Demo submission. OCR proposed
the policy number `GL-10008`, but page 1 shows `GL-10006`; the general-liability expiration date and
each-occurrence limit are correct.

Ask: Compare the proposal with the PDF, correct only what is wrong, and confirm the extraction.

Success:

- the participant consults the displayed source;
- the policy number is corrected to `GL-10006`;
- correct values are not changed; and
- confirmation is submitted with the human-review attestation.

Time box: 10 minutes.

## T05_EXPLAIN_FINDING — COI reviewer

Scenario: A confirmed synthetic document is marked deficient because additional-insured evidence is
insufficient.

Ask: Explain the finding to a risk owner using the rule, expected value, observed evidence, and
document scope shown in OpenCOI.

Success:

- the participant identifies the applicable requirement and stable reason;
- distinguishes missing or insufficient evidence from a zero limit;
- finds the observed source/evidence context; and
- does not claim that OpenCOI checked insurer records.

Time box: 6 minutes.

## T06_DECIDE_EXCEPTION — reviewer requests; procurement manager decides

Scenario: Operations requests temporary acceptance of the synthetic additional-insured deficiency
through 2026-09-30, with site access limited to supervised work.

Ask for reviewer: Create a finding-scoped exception request with the stated rationale, control, and
expiry.

Ask for manager: Review and approve the pending request with an audit-ready decision reason.

Success:

- the correct vendor and failed finding are selected;
- rationale, control, and expiry are preserved;
- the authorized manager makes the decision; and
- the participant explains that the underlying failed finding remains visible.

Time box: 8 minutes per assigned role.

## T07_EXPORT_STATUS — procurement manager

Scenario: A project lead wants records for expiring field contractors.

Ask: Filter the vendor directory appropriately and export the resulting compliance-status CSV.

Success:

- filters represent the requested vendor type and document lifecycle;
- the result count is checked before export; and
- the participant describes the export as document-scoped rather than live coverage data.

Time box: 5 minutes.

## T08_RENEWAL_REMINDER — procurement manager

Scenario: A synthetic vendor's latest confirmed certificate shows an expiration date within its
configured warning window.

Ask: Inspect the renewal queue and history, then explain what a reminder means and what it does not
mean.

Success:

- the correct vendor and printed expiration date are located;
- previous delivery state or errors are found;
- the participant recognizes that delivery configuration is operator-controlled; and
- the reminder is not described as insurer cancellation or live-policy evidence.

Time box: 5 minutes.
