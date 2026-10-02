# Demo organization — Aperture People Ops

A real, persistent second organization that proves the CaseType engine is
general. It is **optional and off by default**: nothing seeds it on a normal
boot. When seeded it is created **alongside** the other tenants and never reads,
copies or edits their rows (case types, document definitions, rule trees,
templates, settings or branding).

## Seeding

```bash
npm run seed:demo-org                 # one-off, idempotent (uses DB_PATH)
SEED_DEMO_ORG=1 npm run serve         # or seed on boot, then serve
```

Re-running is safe: the org is found by its prefix (`APO`) and only missing
pieces are added — staff edits are never overwritten. Source:
`src/db/demoOrg.ts`.

| Field | Value |
| --- | --- |
| Name | Aperture People Ops |
| Reference prefix | `APO` (cases are `APO-YYYY-NNNNNN`) |
| Theme | primary `#1f4e79` (navy), accent `#5fb3a1` (teal) |
| Logo | inline SVG placeholder (teal aperture ring on navy) |
| Sender name | Aperture People Ops Team |
| Automation | every CaseType is draft-first with the evidence gate on |

## CaseTypes

### New Hire Onboarding — `NEW_HIRE_ONBOARDING` (category: people)

| Key | Label | Required | Blocking |
| --- | --- | --- | --- |
| `offer_acceptance` | Countersigned offer acceptance | yes | yes |
| `photo_id` | Government photo ID (passport or national ID) | yes | yes |
| `tax_withholding` | Tax withholding declaration | yes | yes |
| `payroll_banking` | Payroll banking instructions | yes | no |
| `emergency_contact` | Emergency contact sheet | no | no |

Rule tree: `(employment_type = full-time OR employment_type = part-time) AND right_to_work = yes AND NOT (background_check = failed)`

Template: `new_hire_welcome` — "Welcome aboard — your onboarding file {ref}" (first-day logistics).

### Contractor Intake — `CONTRACTOR_INTAKE` (category: vendors)

| Key | Label | Required | Blocking |
| --- | --- | --- | --- |
| `services_agreement` | Master services agreement | yes | yes |
| `insurance_certificate` | Certificate of liability insurance | yes | yes |
| `nondisclosure` | Non-disclosure agreement (NDA) | yes | yes |
| `vendor_tax_registration` | Vendor tax registration | yes | no |
| `statement_of_work` | Statement of work and rate card | no | no |

Rule tree: `insurance_coverage >= 1000000 AND (engagement_months <= 12 OR legal_approved = yes) AND NOT (sanctions_match = yes)`

Template: `contractor_intake_confirmation` — "Contractor paperwork received — {ref}".

### Equipment Request — `EQUIPMENT_REQUEST` (category: it)

| Key | Label | Required | Blocking |
| --- | --- | --- | --- |
| `equipment_requisition` | Equipment requisition | yes | yes |
| `manager_signoff` | Line manager sign-off | yes | yes |
| `vendor_quote` | Vendor quote | yes | no |
| `asset_return_receipt` | Previous asset return receipt | no | no |

Rule tree: `(estimated_cost <= 1500 OR (estimated_cost <= 5000 AND manager_approved = yes)) AND NOT (asset_outstanding = yes)`

Template: `equipment_request_update` — "Your equipment request {ref}".

### Organization-wide replies

`ack_received`, `missing_documents`, `docs_request`, `status_answer`,
`generic_enquiry` — People Ops wording, so the intake pipeline's auto-drafts
never fall back to Organization #1's copy.

## Demo walkthrough

1. Log in as an installation admin. The sidebar (above the account chip) has
   an **Organization** dropdown — pick *Aperture People Ops*.
2. **Configuration → CaseTypes**: three CaseTypes, each with its document
   matrix and a plain-English reading of its rule tree above the JSON editor.
3. **Queues → Test intake** (or the empty-state button): choose a CaseType,
   keep the prefilled `Field: value` facts, tick documents, submit. The
   message runs through the real pipeline and opens an `APO-…` case.
   Untick a blocking document or change a fact (e.g. `Right to work: no`) to
   see the matrix/rule tree report it — the outcome always stays *undecided*
   and routes to a human.
4. Switch back to Organization #1 — the demo case is not in its queues, and
   its direct URL is refused.

## Isolation guarantees (tested in `test/demo-org.test.ts`)

- Queues, dashboards, mail, search and case pages are scoped to the admin's
  **active** organization; parked (caseless) mail belongs to Organization #1.
- Mail explicitly addressed to an organization only continues cases in that
  organization (a shared contact email never joins another tenant's case).
- The other tenants' rows are byte-for-byte identical before and after seeding.
- A grep over every seeded demo row, its outbox drafts and sent mail finds no
  domain vocabulary the tenant did not choose. The leak detector in
  `test/demo-org.test.ts` spells the banned words out (including the retired
  product's own name) precisely so that they can never reappear.
- Screens on the walkthrough path are free of those words too; every other
  page is free of `riara|kcse|programme|school|university`. The only
  exception is the organization pickers, which list every organization by
  name on purpose.
- Administrators whose home organization is not the head office never see the
  switcher and get 403 from `/org/switch`.
