# STATUS — current project status

**This is the single current-status document.** Every other root-level markdown
(`AUDIT.md`, `BUGLOG.md`, `BUGS.md`, `CODE_REVIEW.md`, `OWNER_ISSUES.md`,
`PPR-REPORT.md`, `REPORT.md`, `STAB-ROUND-REPORT.md`) is historical: kept for the
audit trail, figures may be stale. `MIGRATION.md` and the `docs/` references describe
the **current** system. When the state of the project changes, update THIS file —
not the historical ones.

## State of the build (verified 2026-10-01)

| Gate | Command | Status |
| --- | --- | --- |
| Types (strict) | `npm run typecheck` | clean — 0 errors across `src/` **and** `test/` |
| Test suite | `npm test` (vitest) | **544 passed + 1 environment-gated skip** (545 tests, 71 files), **0 failed**, ~85 s |
| Simulation scorecard | `npm run simulate` | **409/409 checks, 26/26 scenarios — ALL GREEN**, exits 0 (CI gate: non-zero on any failure) |
| Stress + determinism | `npm run stress` | **1000/1000 cases clean** (seed 7331), **11/11** sampled cases re-ran byte-identically |
| Compiled build | `npm run build` && `npm start` | builds; boots clean with a hostile `DB_PATH` (`/healthz` 200, `/` → `/setup`) |
| Fresh boot is empty | `DB_PATH=/tmp/x.sqlite npm start` | 0 organizations, 0 staff, 0 cases, 0 case types, 0 emails, 0 templates, 0 attachment sets — only 9 operational settings; `user_version = 2`; no `schools`/`staff_scopes` tables |
| Domain grep | `rg -i 'riara\|kcse\|kcpe\|igcse\|admission' src` | **0 matches** (see "Retired vocabulary" below for what remains elsewhere, and why) |

The single skip is `test/responsive.test.ts`, which needs a Chromium binary and says
so when there is none; nothing else is skipped, todo-ed or silently disabled.

## Phase 13 — a general-purpose intake platform (this round)

The product is no longer an admissions console. It is a document-intake console whose
domain is **tenant data**: case types, document checklists, `AND`/`OR`/`NOT` rule trees
over facts read from mail and documents, per-organization vocabulary (its own words for
case/contact/category/stage/outcome, its own stages and queues), workflow rules,
attachment sets, templates and submission windows.

**Deleted, not gated:** the bundled admissions preset and the migrated Organization #1
snapshot (`data/migrated/organization-1.json`), the ten bundled pack PDFs
(`data/pack/*.pdf`) and the email banner (`data/branding/email-banner.jpg`) — the whole
`data/` tree is gone; the five `src/admissions/*` modules (academic evaluation, entry
requirements, points ladders, the education document matrix generator); the
`APP_PROFILE=education` option and every education seed; the education-era routes
(`/admissions`, `/case/:id/admission-decision`, `/config/course-owner`, the
requirement-node builder and the pack-slot routes all 404 now; `/team` and
`/config?tab=courses` keep redirecting to their new homes); the `schools` and
`staff_scopes` tables and `staff_users.scope_mode`; five `src/admissions/*` modules;
twelve bundled data files; and eleven education-only test files.

**Ordering was enforced** — the generic fixtures, the 26-scenario simulation and the
stress harness were converted and run green *before* any production asset was deleted,
and every gate was re-run after each deletion step. The numbers in the table above are
the post-deletion re-runs on the current tree; the suite, simulation and stress harness
were each re-run again after the final source edits in this round.

**Replaced by:** visibility scope is the **case type** (`staff_case_type_scopes` +
`case_type_scope_mode`, edited on the Team page; administrators are never scoped);
outcomes are recorded only by a person through `POST /case/:id/outcome`
(`record_outcome` permission + written reason); attachment sets are the organization's
own uploaded files, referenced by name from a template or a rule; starter templates are
neutral copy seeded per organization on request (`seedStarterTemplates`), never by boot.

### Defects this conversion exposed (all fixed, all regression-tested)

- **`outbox.claimed_at` did not exist** — approving a held draft threw inside an async
  route. Express 4 never forwards a rejected promise to the error middleware, so the
  officer's browser hung for three minutes with nothing logged. Column added, and every
  registered async route/middleware is now wrapped so a throw always becomes a logged
  response (`test/async-route-guard.test.ts`).
- **The migration ran indexes before columns** — `idx_documents_hash` references
  `documents.sha256`, a column `ADDITIONS` adds on an upgraded database, so opening a
  legacy copy died inside the migration transaction. Schema is now split: tables →
  missing columns → indexes.
- **Columns the code reads were missing from `ADDITIONS`** (`staff_users.active`,
  `case_types.active`, `emails.read/labels`, `documents.sha256/is_duplicate`,
  `status_history.reason`, `applicants.triage/phone`) — an upgraded database opened fine
  and then failed on the first query.
- **`evidence_gate = 0` had no effect on a case type with no rule tree** — an empty tree
  evaluated as "undetermined", which filed a blocking flag and downgraded every Green
  verdict, so the documented "this case type's rules own the send decision" switch could
  never be exercised. An empty tree now means "no rule constraints".
- **Submission-window deadlines were silently discarded** — `/settings/intake-deadline`
  called an UPDATE-only setter, so on any install without pre-seeded windows (every fresh
  one) the save did nothing while the audit said it worked. It upserts now, and the
  windows have a real home (Configuration → Requirements & repairs).
- **Tenant guards on configuration writes** — `/config/case-types/{create,document,
  document-delete,rules,axes}` and the vocabulary route now refuse another
  organization's ids instead of writing through them (`test/bughunt3.test.ts`,
  `test/h3-config-idor.test.ts`, `test/config-ux.test.ts`).

### Retired vocabulary — what still matches a domain grep, and why

`src/` is clean. The remaining matches are deliberate:

- `migrations/legacy-storage.json` — the historical **storage-name** map that lets a
  database written by an older release be opened and upgraded. Renames only; no preset,
  catalogue, identity or decision data.
- `test/ppr-p07-migration.test.ts` — builds a production-shaped legacy database, so it
  must spell the old column names to prove they are renamed and that history survives.
- Absence assertions and leak detectors: `test/white-label.test.ts`,
  `test/demo-org.test.ts`, `test/ppr-p19-generic-pipeline.test.ts`, `test/e2e.test.ts`,
  `test/web.test.ts`, `test/ppr-p1-document-library.test.ts`.
- Historical round reports (`REPORT.md`, `PPR-REPORT.md`, `OWNER_ISSUES.md`, `BUGLOG.md`,
  `AUDIT.md`, `BUGS.md`, `CODE_REVIEW.md`, `STAB-ROUND-REPORT.md`) and the "removed
  routes" note in `docs/ROUTE_SCAN.md`.

## Phase 14 — the real email flow (Part B)

Part A traced the live path and found the send machinery intact but unreachable
in practice. Fixed, each with a regression test:

- **A real installation had zero reply templates.** `seedStarterTemplates` had
  exactly one caller in the repository — `test/helpers.ts`. Phase 13b deleted the
  boot-time seeding of the admissions templates and never wired the neutral
  replacement to organization creation, so the pipeline had no wording to render:
  no draft, no reply, an `INTERNAL — DO NOT AUTO-SEND` note instead. `/setup` and
  `/config/organizations/create` now seed the seven neutral starter templates
  inside the same transaction as the organization; `POST
  /templates/seed-starters` is the idempotent recovery path for organizations
  created before the fix; the Templates section explains the empty state; and a
  workflow rule naming a template the organization does not have is **refused at
  the route** instead of silently never replying. A template chosen but missing
  at run time is loud: `template_missing` audit, a `review_needed` notification,
  and a queued draft that says what to do.
- **Senders now declare whether they deliver.** `MockSender` does not,
  `GmailSender` does. Boot logs a warning, every page carries a banner, and an
  auto-send through a non-delivering sender is audited as
  `email_not_delivered` — the trail no longer claims a delivery that did not
  happen.
- **Gemini classification was unreachable.** The pipeline called it only when
  `process.env.GEMINI_API_KEY` was set *and* `organization_categories` had rows,
  and `addEmailCategory` had **zero callers** — no route, no UI, no seed. Now:
  Configuration → Requirements & repairs has a Message categories card
  (`POST /config/categories/{create,remove}`, tenant-guarded), credentials
  resolve from the stored secret first and the environment second, and the label
  audit is written on the case with its confidence, source and routed category.
- **`createApp` downgraded an env-configured Gemini to mocks on every boot** —
  `rebuildAdapters` read only the secret store, so `MODE=live` + `GEMINI_API_KEY`
  lost its real vision adapter and watcher moments after `buildAdapters` wired
  them. Credential resolution is now identical in both places.
- **The Gmail wire path had no test at all.** `test/gmail-sandbox.test.ts` drives
  the real `GmailClient`/`GmailSender`/googleapis stack against a local sandbox
  speaking the Gmail HTTP shape, and it immediately found a production bug: the
  stale-thread retry never fired because Gmail reports `errors[0].reason =
  "notFound"` (no space) while the guard matched only the human message. Fixed.
  Covered now: RFC 2822 construction, org From/Reply-To, multipart attachments
  and banner with byte-identical payloads, CRLF header-injection defence, RFC
  2047 subjects, the thread retry, hard-failure propagation, inbound list/full
  fetch and attachment bytes, the oversized-message refusal, and the pipeline
  delivering end to end.
- **Inbound mail was never attributed to a tenant.** Ingestion left
  `organizationId` unset and the pipeline hard-coded organization 1, so every
  tenant's mail was processed against the head office's configuration. Each
  organization now declares its inbound address (additive
  `organizations.inbound_address`, editable in Settings), `GmailClient` returns
  the Delivered-To/To/Cc it already parsed, and both ingestion and the pipeline
  resolve the tenant from it; an unmatched message falls back and writes
  `tenant_attribution_fallback`.
- **Real mail never carries a case type**, so every inbound case was
  "unconfigured" (empty checklist, human review). A tenant with exactly one case
  type now gets it by default and records `case_type_inferred`; with several,
  nothing is guessed.
- **The deterministic categorizer lost its enrolment vocabulary** (`hesb`,
  `helb`, `tuition`) and gained domain-free context words, so ordinary business
  mail is an enquiry instead of `other`.

Verified on a fresh install walked end to end over HTTP (setup → configure →
inbound mail): 7 starter templates present, rule pointing at a missing template
refused with a reason, case opened in the right tenant with the inferred case
type, reply rendered from the tenant's own template and handed to the sender,
audit trail `case_created → rule_quote_open → case_type_inferred →
email_received → case_type_gate → requirements_checked → rule_quote_ack →
email_sent_auto → email_not_delivered` (the last because no Gmail was
connected), and the banner on both the overview and the case page.

## Residual issues (known, not hidden)

- **A tenant with several case types cannot route inbound mail between them** —
  only the portal and the test-intake page declare a case type, so with more than
  one configured the case stays `unconfigured_case` and a person picks the
  checklist. The fix is a case-type selector on intake rules (an org-wide rule
  declaring which type it opens), which is a product decision, not a patch.
- **`intakes` is not tenant-scoped** — submission windows are global (`name` PRIMARY
  KEY). Two organizations using the same window name share a deadline. The fix is a
  primary-key rebuild plus `UNIQUE(organization_id, name)` across
  `repo.listIntakes/addIntakeWithDeadline/intakeDeadline`, the pipeline's window
  inference and the settings route; it needs its own migration step and test.
- **Legacy catalogue surface remains in storage** — the `programmes` table and its repo
  methods, and the `applicants.programme` / `intake` / `nationality` / `transfer` /
  `requirements_structured` columns (the case-type **code** lives in
  `applicants.programme`). Renaming them is a data migration with no user-visible
  benefit; the console no longer exposes any of it except the case-list filter, whose
  public parameter is `case_type`.
- **The migration narrows access by design** — staff who were school-scoped come out with
  *no* case types until an administrator assigns them. There is no faithful translation
  from schools to case types; widening silently was the worse failure.
- **`src/enrich` keeps legacy API names** (`inferIntake`, `courseNames`,
  `knownApplicant`) and internal identifiers such as `fullyQualified` /
  `heldForQualification` were left alone deliberately: they are not user-visible and
  renaming them churns the pipeline's safest code.
- **Dependencies** — `npm audit` still reports **13 vulnerabilities** (2 critical,
  4 high, 7 moderate), mostly transitive through `pdfjs-dist`/`canvas`/`sharp` toolchains;
  the PDF.js legacy CommonJS import remains. Upgrades were attempted and reverted where
  they broke the native builds in this environment.
- **`canvas` cannot be installed here** — raster-only PDFs therefore exercise OCR or the
  safe fallback in tests; the two raster probes skip cleanly rather than fake a result.
- **Not yet proven**: an upgrade against a *real* customer database (the migration is
  proven on a production-shaped copy, not on a live file), and multi-process concurrency
  beyond the two-sweeper and double-approval races that are tested.

## Superseded claims from earlier rounds

- **M-3 (auto-admission) is gone** — there is no auto-approve/auto-reject path of any
  kind. `test/m3-auto-admit.test.ts` was deleted with the feature; the pipeline's only
  automated mail is receipts, factual status answers and information chases, all
  draft-first by default.
- **C-1 (bundled data resolution) is moot** — there is no bundled data any more, so
  `BUNDLED_DATA_DIR` was removed from `.env.example`. `test/boot-outside-repo.test.ts`
  still pins that a boot outside `./data` is clean.
- **M-2's startup username fold** lived in the deleted education migration block; the
  surviving part is the single username rule (`src/util/username.ts`) used by setup,
  staff-add and account-rename.
- **Round 19 / light-mode probes**: `test/round19.test.ts` was removed with the education
  matrix; `test/light-mode.test.ts` remains.

## Running the project

See `README.md` (first-run setup, configuration surfaces, scripts, upgrade path,
static-analysis policy, Linux notes) and `docs/` for the status model, the document
matrix, the demo tenant and the route scan.
