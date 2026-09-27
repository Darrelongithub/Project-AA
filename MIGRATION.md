# MIGRATION.md — Production migration plan (PPR P0-7)

**Scope:** take a live, pre-PPR Riara University database (education-only,
round-18 shape) to the production-platform schema WITHOUT rewriting a single
historical row. The migration is the code in `src/db/db.ts` (`openDb` →
`SCHEMA` + `migrate()`), is idempotent, and is **tested on a production-shaped
copy** in `test/ppr-p07-migration.test.ts` (real reference numbers, frozen
requirement snapshots, admission decisions, audit/decision logs, education
template wording, pack defaults, legacy secrets in the settings bag).

## Principles (non-negotiable)

1. **Names stay.** No table or column is renamed or dropped. Everything new is
   an *extension*: new columns (nullable or defaulted) and new tables.
2. **History is immutable.** `requirements_snapshot`, `audit_log`,
   `decision_logs`, `ref_number`, `admission_decision` and every rendered text
   survive byte-identical. No migration step re-evaluates a case, regenerates a
   frozen snapshot, or renumbers anything.
3. **Everything is one-shot or only-NULL.** Marker-guarded steps run once ever
   (`settings` markers); backfills only touch rows where the new column is
   still NULL. A re-open (every production restart) is a no-op for anything a
   human has since changed.
4. **New tenants are safe.** A brand-new organization starts with draft
   automation, auto-admit OFF, and the neutral `ORG` prefix. Only the migrated
   Riara tenant keeps its preserved legacy posture — explicitly.

## Steps (in run order, inside `migrate()`)

| # | Step | Guard | Evidence |
|---|------|-------|----------|
| 1 | `ALTER TABLE … ADD COLUMN` extension columns (`applicants.case_config_frozen`, `config_version_frozen(_at)`, `queue`, `followup_action`, `case_type_id`, `organization_id`, `category`, …; `case_types.education_module/terminology/stages/queues/config_version/default_reply_action/qualification_gate/auto_admit`; `outbox.needs_approval`; `templates.default_snapshot`; `organizations.ref_prefix/from_name/reply_to/locale/timezone`; …) | `duplicate column name` no-op | test 1 |
| 2 | New tables: `secrets`, `workflow_rules`, `attachment_sets`, `attachment_set_files`, `organization_templates`, `staff_permissions`, `staff_scopes`, `schools` | `CREATE TABLE IF NOT EXISTS` | test 1 |
| 3 | **Education profile stamp**: `case_types` rows of Organization #1 whose code is `GENERAL` or matches a programme become `education_module=1, qualification_gate=1, default_reply_action='send'` (preserved legacy automation), `auto_admit=0`, `config_version=1` | `education_profiles_stampled` → **`education_profiles_stamped`** marker, once ever | test 2 |
| 4 | **Profile-id stamp on cases**: legacy `applicants` rows get `case_type_id` (programme-derived type, else `GENERAL`), `organization_id=1`, `category=programme` | only-NULL / only-NULL-org | test 2 |
| 5 | **Config freeze**: every case is stamped `config_version_frozen=1` (opened under the configuration that shipped with this database) | only-NULL | test 2 |
| 6 | **Secrets extraction**: `gemini_api_key`, `gmail_client_secret`, `gmail_refresh_token` move from `settings` to `secrets`, then the settings rows are deleted | value exists in `secrets` before delete; re-run finds nothing | test 3 |
| 7 | **`from_name` → `organizations.from_name`**, settings key dropped only after the org row carries the value | `UPDATE … WHERE from_name IS NULL` | test 3 |
| 8 | **Ref prefixes**: `organizations.ref_prefix` takes the legacy `settings.ref_prefix` (`RU`) once; `ref_counters` untouched — reference numbers continue their sequence | `WHERE ref_prefix IS NULL OR ref_prefix = 'ORG'` | test 3 |
| 9 | **Pack defaults**: `templates.docs_request → attach_pack='application'`, `admission_letter → 'admission'` | `pack_defaults_migrated` marker, once ever — a later `'none'` (a deliberate staff choice) is never resurrected | test 5 |
| 10 | Best-effort conversions: `min_grade_points → mean_grade` (KCSE ladder), `postgrad → masters` | only rows with `min_grade_points IS NOT NULL AND mean_grade IS NULL` / `WHERE level='postgrad'` | test 6 |

## What the migration NEVER does

- never re-runs `pack_defaults_migrated` or `education_profiles_stamped`
  (proven by re-opening the copy after a deliberate post-migration change —
  test 5);
- never re-evaluates an application or regenerates `requirements_snapshot`;
- never edits audit text, decision-log reasoning, or reference numbers;
- never applies the education matrix to a non-education profile.

## Rollback

The migration is additive; a rollback is a code rollback plus the previous
binary reading the same columns (old code ignores extension columns and the
new tables). The only destructive steps are the two settings-key deletions
(secrets + `from_name`), whose values are safely copied first; rolling back the
code without restoring those keys leaves secrets unread — restore from backup
in that case. Take the usual file-level SQLite backup before booting the new
binary.

## Verification

`npx vitest test/ppr-p07-migration.test.ts` — 6 tests, each named after the
invariant it evidences, running against the production-shaped copy described
above. The Section 3 report (`PPR-REPORT.md`) cites this evidence per finding.
