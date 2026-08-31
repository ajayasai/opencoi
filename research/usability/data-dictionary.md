# Privacy-reviewed study data dictionary

The analyzer accepts exactly these columns in this order. Unknown columns are rejected. This is a
deliberately narrow quantitative schema: detailed notes, consent, recordings, recruitment records,
and identity mappings never enter it.

| Column | Allowed value | Meaning |
| --- | --- | --- |
| `schema_version` | `1.1` | Analyzer schema, not product version. |
| `dataset_kind` | `synthetic`, `participant` | Synthetic fixtures and participant observations cannot be mixed. |
| `product_commit` | 40 lowercase hexadecimal characters | Exact product build tested. One analysis uses one commit. |
| `session_id` | synthetic `SYN-...`; participant `P-` plus 12 random uppercase hexadecimal characters | Private working pseudonym. It is removed from aggregate output. Never derive it from a name, email, time, or recruitment order. |
| `role` | `coi_reviewer`, `procurement_manager`, `vendor_uploader` | Fixed workflow cohort. |
| `accessibility_mode` | `standard`, `keyboard_only`, `screen_reader`, `magnification`, `voice_control` | Input/access category needed for the protocol. Do not record diagnoses, brands, or personal detail here. |
| `task_code` | `T01_CREATE_REQUIREMENTS` through `T08_RENEWAL_REMINDER` | Fixed task in `tasks.md`. |
| `outcome` | `unassisted`, `assisted`, `not_completed` | Outcome under the registered definitions. |
| `duration_seconds` | integer 1–7200 | Start to success, stop, or time box. |
| `error_count` | integer 0–99 | Errors under the registered counting rule. |
| `critical_incident_count` | integer 0–20 | Safety/privacy/destructive or blocking incidents. A nonzero value requires an issue code. |
| `session_scope_comprehension_correct` | `true`, `false` | The one final document-versus-live-status answer, repeated identically on every task row for this session and counted once per unique session. |
| `confidence_rating` | integer 1–5 | Fixed post-task response. |
| `issue_code` | fixed taxonomy below | Primary issue class; details stay in private notes. |

## Issue taxonomy

- `none`
- `navigation`
- `labeling`
- `document_review`
- `rule_comprehension`
- `status_comprehension`
- `exception_workflow`
- `reminder_workflow`
- `export_workflow`
- `assistive_technology`
- `performance`
- `other`

Choose the first applicable category in this order for a critical incident:

1. `status_comprehension`
2. `exception_workflow`
3. `document_review`
4. `assistive_technology`
5. the remaining closest workflow category
6. `other`

The public analyzer output contains counts only. Do not add a free-text “detail” column. Track
remediation in a normal GitHub issue using synthetic reproduction steps rather than participant
quotes or data.

## Privacy checks

The parser rejects schema changes, email-like values, URLs, malformed pseudonyms, duplicate
session/task rows, role, accessibility-mode, or session-scope-answer changes within a session, mixed
dataset types, and mixed product commits.
Every reported cohort with fewer than five unique sessions is returned only as `<5` and
`suppressed`; no metric for that cell is emitted.
