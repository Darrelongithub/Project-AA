# MIGRATION.md — the generic storage migration (v2)

**Scope:** open a database written by an older release of this product and bring its
*storage* up to the generic, tenant-scoped model — in one transaction, without
rewriting history and without loading any domain data. Everything below is pinned by
`test/ppr-p07-migration.test.ts`, which builds a production-shaped legacy copy
(old table and column names, school-scoped staff, frozen snapshots, audit and decision
logs, secrets in the settings bag) and opens it exactly like a boot would.

`openDb()` refuses a database whose `user_version` is **higher** than the code knows
("created by a newer version") rather than downgrading it, and aborts the whole
migration if it would introduce a single new foreign-key violation.

## Order of operations (`migrate()` in `src/db/db.ts`)

| # | Step | Detail |
|---|---|---|
| 1 | **Declared renames** | `migrations/legacy-storage.json` maps historical table and column names onto generic ones (`admission_rules → legacy_rule_sets`, `admission_rule_nodes → legacy_rule_nodes`, `admission_decision → legacy_outcome`, `admission_route → outcome_route`, `admission_rules_frozen(_at) → legacy_rule_snapshot/_frozen_at`, `education_module → legacy_module`, `auto_admit → legacy_auto_decision`, `qualification_gate → evidence_gate`). A rename is applied only when the old name exists and the new one does not — never twice. **Storage names only:** no preset, catalogue, identity, grade or decision data is loaded from anywhere. |
| 2 | **Tables** | `SCHEMA_TABLES` — `CREATE TABLE IF NOT EXISTS` for every table, so existing tables keep their rows and their own shapes. |
| 3 | **Columns** | `ADDITIONS` — `ALTER TABLE … ADD COLUMN` for each column the running code reads that this database lacks (tenant ids, frozen-configuration columns, follow-up ladder, outbox `needs_approval` **and `claimed_at`**, template snapshots, `case_type_scope_mode`, `active` flags, `emails.read/labels`, `documents.sha256/is_duplicate`, `status_history.reason`, …). An older release's database otherwise opens fine and then fails on the first query, which is how a missing column shipped once already. |
| 4 | **Indexes** | `SCHEMA_INDEXES` — created **after** the columns, because an index may reference a column step 3 only just added (`idx_documents_hash` on `documents.sha256`). Running the whole schema string in one go used to kill the migration transaction on an upgraded database. |
| 5 | **Tenant backfill** | `emails.organization_id` is filled from the case each message belongs to. |
| 6 | **Drop the school dimension** | `staff_users.scope_mode` is dropped, and `staff_scopes` + `schools` tables are removed. Visibility scope is the **case type** now, so anyone who was school-scoped (`scope_mode` `scoped` or `none`) is set to `case_type_scope_mode='none'` — deliberately **narrowed to no access**, never widened. An administrator re-assigns case types on the Team page; `staff_case_type_scopes` starts empty. Accounts that were never scoped keep `unscoped` (full visibility). |
| 7 | **Rebuild legacy uniqueness** | `applicants UNIQUE(email_address, thread_id)` → `UNIQUE(organization_id, email_address, thread_id)` and `processed_emails PRIMARY KEY(email_id)` → `PRIMARY KEY(organization_id, email_id)`, preserving custom columns, indexes, triggers, row ids and the AUTOINCREMENT high-water mark. Two organizations may now hold the same contact email; a duplicate inside one organization is still refused. |
| 8 | **One-shot stamps** (marker `generic_storage_v2`) | Historical decision vocabulary is mapped **once** into the generic `outcome` column (`auto_admitted → auto_approved`, `admitted_after_review → approved_after_review`, `not_admitted → not_approved`) and only where `outcome` was still `undecided`; the original text stays readable in `legacy_outcome`. Case types carrying `legacy_module` are set draft-first. If data exists but no organization row does, organization 1 is created from the stored `institution_name` (an installation with no data still boots **empty**). Rows with no tenant are stamped into organization 1. |
| 9 | **Identity and secrets** | `from_name` moves from the settings bag onto the organization row; `gemini_api_key`, `gmail_client_secret` and `gmail_refresh_token` move into `secrets` (organization-scoped, never rendered or exported) — each exactly once, never overwriting a value already stored. |
| 10 | **Finish** | Operational indexes, the `cases` view, `user_version = 2`. |

## What is never touched

Reference numbers, frozen requirement/configuration snapshots, audit and decision logs,
status history, held drafts, processed-mail claims and recorded outcomes survive
byte-identical (the outcome *mapping* in step 8 is the single declared exception, and it
keeps the original wording beside it). Re-opening a migrated database changes nothing:
the marker makes steps 8–9 one-shot, so a deliberate setting — an automation mode, a
renamed tenant, a case type opted into sending, an outcome cleared by hand — is never
re-stamped.

## Historical note

Earlier releases of this product were an admissions console, and their migration also
stamped an education profile, converted grade-point ladders and seeded bundled document
packs. That domain migration is **gone**: no preset, catalogue, points ladder, bundled
PDF or education profile option remains in the codebase, and a fresh installation boots
empty. What survives is the storage-name mapping in step 1, so a database written by
those releases can still be opened and upgraded — its historical rows keep their meaning
under generic names, and its staff must be re-assigned case types.
