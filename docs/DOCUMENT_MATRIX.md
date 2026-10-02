# Document Requirement Matrix (OR-5, generalized)

**A case's checklist is its case type's own data — configured in the console, never
generated from a bundled catalogue.** The pure functions live in
`src/documents/matrix.ts`; the rows live in `document_definitions`.

## Where a checklist comes from

1. **CaseType → Document matrix** (Configuration) — an administrator adds rows:
   `key` (machine name), `label` (contact-facing wording), `required`,
   `blocking`, `position`, and optionally an `axis` + `values`.
2. **Organization axes** (`POST /config/case-types/axes`) — an organization may
   define its own axes (for example `residency: in-country | overseas`) and bind
   individual definitions to specific axis values. `documentRequirementsFromAxes`
   validates a selection against the axis and refuses an unknown value; a
   definition with no axis applies to every selection.
3. **Nothing else.** There is no bundled matrix, no default slots, no
   level × curriculum × nationality grid, and no fixed ten-slot pack. A brand-new
   organization has an empty checklist until it writes one, and an unconfigured
   case is flagged `unconfigured_case` and held for a human rather than judged
   against somebody else's list.

## Slot semantics (`fillSlots`)

- One uploaded document fills **one exact slot** (`document_type` must equal the
  definition's `key`); nothing is inferred from a similar name.
- `missing` = a slot that is `required` **and** `blocking` and was not filled.
  Optional or non-blocking items are requested but never hold a file.
- `leftover` = files that fill no slot. They are kept, shown on the case page and
  raise a `wrong_document` flag for a human — never silently discarded, and never
  treated as satisfying a slot.
- Missing data is never treated as failure: an unread or absent rule value leaves
  the rule tree **undetermined**, which routes to a person.

## Wording

`docLabel` (`src/rules/index.ts`) supplies neutral wording for the four generic
document hints the classifier knows (`request_form` → "Request form", `id` →
"Identity document", `birth_cert` → "Birth certificate", `passport_photo` →
"Photograph") and humanizes any other key (`services_agreement` → "Services
agreement"). A case type's own `label` always wins wherever the console has it, so
contacts see the tenant's words, not the machine's.

## Freezing and upgrades

A case stores the checklist and rule tree it was evaluated against
(`case_config_frozen`, `config_version_frozen`). Editing a case type bumps its
`config_version` and applies to **newly processed mail**; existing cases keep their
frozen configuration until an administrator runs an explicit re-evaluation
(Configuration → Requirements & repairs → "Re-evaluate all open cases"), which
records what changed and never rewrites a human outcome.

## Evidence, not decisions

The matrix feeds a verdict, not a decision: `Green` (complete, high-confidence,
clean), `Orange` (a flag a person must read) or `Red` (something required is
missing). Outcomes (`approved_after_review`, `not_approved`) are recorded only by a
person holding `record_outcome`, with a written reason. Tests:
`test/document-matrix.test.ts`, `test/fix-round3-features.test.ts`,
`test/config-ux.test.ts`, `test/ppr-p1-document-library.test.ts`.
