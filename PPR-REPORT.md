# PPR-REPORT.md — Production Platform Round: Section 3 (RED → GREEN)

Statuses: **RED** = failing / not started · **GREEN** = fixed with evidence · **UNVERIFIED** = could not run, reason given.

Conventions (OWNER_ISSUES.md): one row per numbered prompt item; each row cites the audit
finding IDs it closes, the files changed, and three evidence bullets — (1) the old hardcoded
behaviour is gone (grep/test), (2) the invariants still hold (grep/test), (3) what was
reconciled against the pre-existing Organization/CaseType branch (GR/WLR/CTR rounds), with a
one-line reason for any divergence. Finding IDs named in the round brief (A1 org boundary,
B1 generic folder, D4 generic_enquiry, E1–E4 packs/assets/matrix, F1 academic-engine leak,
F5 never-auto-reject, F6 snapshot immutability) are cited as such; where the brief attached no
letter to an item, the prompt item number is the anchor (the full A1–J8 text lives in the
round's audit context, not in this repository).

**Baseline:** `npx vitest run` = **612 passed / 2 failed (canvas round19 rasterisation —
accepted, `canvas` is unbuildable in this environment) / 1 skipped**; `npx tsc --noEmit` clean.
Delivery: this PR carries the round's full implementation (the C1–C7 work sequence:
P0-1/P1-5 · P0-2/P0-3 · P0-4 · P0-5 · P0-6 · P1-1…P1-9 · P0-7) plus this report and
`MIGRATION.md`. Work sequence labels C1–C7 are used throughout for the build order.

**Reconciliation preamble.** The Organization/CaseType model from the earlier rounds was
EXTENDED, never recreated: `organizations` gained `ref_prefix/from_name/reply_to/locale/
timezone` and the `secrets` store; `case_types` gained `education_module/terminology/stages/
queues/config_version/default_reply_action/qualification_gate/auto_admit`; `applicants` gained
`case_type_id` (the workflow-profile id the prompt's target model asks for — kept the existing
column name per audit §11 naming constraints), `case_config_frozen/config_version_frozen(_at)`,
`queue`, `followup_action`. Real conflicts are called out in the rows below (S1-4, S2-5, S2-6)
rather than silently chosen.

---

## S1-1 — Organization boundary; secrets separated — **GREEN**

**Findings:** A1 (hardcoded institution), A1-family (secrets in the settings bag). ·
**Files:** `src/branding.ts`, `src/db/db.ts`, `src/db/repo.ts`, `src/web/server.ts`,
`src/web/pages.ts`, `data/migrated/organization-1.json`, `test/ppr-secrets.test.ts`.

- **Repro (was RED):** `grep -rn "Riara" src/` returned the institution name in branding, pack
  copy and login text; `gemini_api_key`, `gmail_client_secret`, `gmail_refresh_token` sat in
  `settings`, readable by any generic settings read/export.
- **Tests (GREEN):** `test/ppr-secrets.test.ts` — secrets live in `secrets`, `getSetting` never
  returns them, generic settings export/list cannot leak them, migration moves the values out
  of `settings` exactly once (`test/ppr-p07-migration.test.ts` test 3). P1-5 in the same suite
  proves `from_name`/`reply_to` ride the real MIME headers (wired, not removed).
- **Invariants / grep:** `grep -rn "Riara" src/` → **0 hits**; the name survives only inside the
  labeled legacy migration profile `data/migrated/organization-1.json` and demo assets, as the
  permitted carve-out. New tenants start with `ORG` prefix and empty sender identity.
- **Reconciled:** `organizations` row (GR round) kept; the settings `from_name` is moved onto
  it (divergence from "remove the dead field": the prompt's P1-5 allows wiring instead — wired
  into MIME in C1, so the field is no longer dead). E1–E2 (Riara demo assets) are confined to
  `data/pack/`, `data/branding/`, `src/web/logo.ts` and the labeled snapshot.

## S1-2 — Education module toggle; academic paths unreachable when off — **GREEN**

**Findings:** F1 (academic engine leak), E4 (academic document matrix). ·
**Files:** `src/pipeline/index.ts`, `src/db/repo.ts`, `src/types.ts`, `src/web/pages.ts`,
`test/ppr-education-toggle.test.ts`, `test/ppr-p19-generic-pipeline.test.ts`.

- **Repro (was RED):** `evaluateAdmission`, the academic document matrix and the Admissions
  chrome ran for every case; "Admission eligibility" and grade vocabulary appeared on generic
  cases.
- **Tests (GREEN):** `test/ppr-education-toggle.test.ts` — end-to-end through real admin and
  pipeline routes for a non-academic profile: the mocked evaluator is asserted to **never**
  run, academic fields are absent, Admissions nav disappears for the tenant, `/admissions` still
  redirects (invariant e). `test/ppr-p19-generic-pipeline.test.ts` sweeps every surface of a
  whole generic case life for academic vocabulary (zero matches).
- **Invariants / grep:** `evaluateAdmission` is referenced once in the pipeline
  (`src/pipeline/index.ts:534`) behind `genericRuleResult || !educationCase`; `educationCaseFor`
  = `case_types.education_module === 1` (else org-1 legacy). Education/KCSE suites kept whole
  (prompt: do not delete — `test/admissions.test.ts`, `test/course-config.test.ts`, KCSE tests
  all still run in the baseline).
- **Reconciled:** the toggle is the `education_module` flag on the EXISTING `case_types` model
  (not a parallel profile system). Divergence: none. Invariant (b) (Gemini never decides
  outcomes) untouched — the engine still only extracts/facts/labels.

## S1-3 — Profile/config version frozen on the case — **GREEN**

**Findings:** F6 (frozen snapshots immutable), S1-3 brief. ·
**Files:** `src/db/db.ts`, `src/db/repo.ts`, `src/web/server.ts`,
`test/ppr-education-toggle.test.ts`, `test/ppr-p07-migration.test.ts`.

- **Repro (was RED):** live config edits silently changed open/closed case meaning; no record of
  which rule/config version a case was opened under; re-evaluation could re-apply newer rules.
- **Tests (GREEN):** `test/ppr-education-toggle.test.ts` (freeze section): `requirements_snapshot`
  and `case_config_frozen`/`config_version_frozen` are written once and never rewritten; later
  config saves bump `case_types.config_version` but do not touch frozen cases; re-evaluation
  reports which version it re-applied (`config_version_upgraded` audit). P0-7 test 4 proves the
  migration stamps version 1 and never rewrites history.
- **Invariants / grep:** `freezeCaseConfig` is immutable-once (`repo.ts:300` family);
  `requirements_snapshot` byte-identical across migration re-opens (P0-7 tests 4–5). Invariant
  (c) holds: no migration step re-evaluates or regenerates snapshots.
- **Reconciled:** freeze columns extend `applicants` (no table renames). Divergence: the prompt's
  "version" is an integer (`config_version`) rather than a content hash — one-line reason:
  the hash would rewrite nothing but also record nothing staff can read in the UI; the integer
  is displayed in re-evaluation messages.

## S1-4 — First-email rule as data — **GREEN**

**Findings:** B1 (rule tree drives automation), prompt §1-4 (create/attach/ignore/review…). ·
**Files:** `src/rules/workflow.ts`, `src/db/db.ts`, `src/db/repo.ts`, `src/pipeline/index.ts`,
`src/web/server.ts`, `src/web/pages.ts`, `test/ppr-workflow-rules.test.ts`,
`test/ppr-p1-response-actions.test.ts`, `test/ppr-p1-rule-preview.test.ts`.

- **Repro (was RED):** first-email behaviour was hardcoded `if/else` over categories; the rule
  fields the prompt lists (stage, queue, priority, assignment, reply action, template id,
  attachment-set id, requested info, SLA, follow-up policy, audit code, fallback) were not data.
- **Tests (GREEN):** `test/ppr-workflow-rules.test.ts` — an admin defines intake + response
  rules through the real Workflow-rules routes for a new non-academic profile and a matching
  email fires them end-to-end through the real pipeline; the seeded education rules reproduce
  current behaviour (receipt, complaint → high-priority human review with reply held,
  missing-docs chase, **qualification-gate hold**); a rule gap always routes to human review.
  `test/ppr-p1-response-actions.test.ts` covers the per-path actions (S2-3).
- **Invariants / grep:** invariant (a): unmatched/failed rule trees land in human review
  (`pipeline/index.ts` rule-gap branch; asserted in the P0-4 suite). Invariant (b): rules only
  route/fact/label — no outcome writes. Invariant (f): new profiles default `default_reply_action
  = 'draft'`, `auto_admit = 0`; only the migrated education profile keeps `send`/gated posture.
- **Reconciled:** rules live in a NEW `workflow_rules` table keyed by the existing
  `organization_id`/`case_type_id` (the Organization/CaseType branch's ids). Divergence from the
  prompt's verb list: the reply verb is `none|draft|send|hold` **plus `approve`** (S2-3) and the
  follow-up policy is `none|ladder` **plus a rung action** — one-line reason: the prompt's own
  §2-3 demands per-path send/draft/approve/do-nothing, which the base verb list cannot express.

## S1-5 — Attachment sets replace packs; E3 transfer hole closed — **GREEN**

**Findings:** E3 (transfer-pack send hole), E1–E2 (fixed Riara pack vocabulary). ·
**Files:** `src/db/db.ts`, `src/db/repo.ts`, `src/pack.ts`, `src/web/server.ts`,
`src/web/pages.ts`, `test/ppr-attachment-sets.test.ts`, `test/ppr-p1-document-library.test.ts`,
`test/pack.test.ts`.

- **Repro (was RED):** `applicationPack()`/`admissionPack()` hardcoded ten files; the transfer
  pack could be sent across organizations by name (E3); new organizations could not send
  anything without Riara's files.
- **Tests (GREEN):** `test/ppr-attachment-sets.test.ts` — a NEW organization defines its own set
  from uploaded files (zero Riara files) and sends it; cross-org and unknown-name refs are
  refused (E3 structurally closed). `test/ppr-p1-document-library.test.ts` — the document
  library UI (below) manages sets/files. `test/pack.test.ts` still passes: the ten-slot readers
  remain as labeled migration readers.
- **Invariants / grep:** sends resolve sets via `attachmentSetFiles(org, ref)` (name or
  `set:<id>`) — no privileged pack vocabulary in the send path; incomplete packs are audited,
  never silently dropped (invariant on evidence).
- **Reconciled:** `attachment_sets`/`attachment_set_files` are org-owned rows in the existing
  organization model. Divergence: `PACK_SLOTS`, `applicationPack()`, `admissionPack()` are
  **kept, labeled as migration readers** — one-line reason: `test/pack.test.ts` and the stamped
  legacy profile depend on them, and the prompt only removes them from the send path and UI.

## S1-6 — Templates per profile; D4 `generic_enquiry` wired — **GREEN**

**Findings:** D4 (generic_enquiry claimed automatic but dead), prompt §1-6 (closed 8-key enum). ·
**Files:** `src/db/db.ts`, `src/db/repo.ts`, `src/web/server.ts`, `src/web/pages.ts`,
`test/ppr-templates-profile.test.ts`, `test/templates-section.test.ts`.

- **Repro (was RED):** templates were a closed 8-key enum; Reset restored the global education
  default for everyone; the UI claimed `generic_enquiry` was an automatic fallback but nothing
  ever rendered it.
- **Tests (GREEN):** `test/ppr-templates-profile.test.ts` — template keys are open vocabulary
  (`/templates/create`), profile rows shadow org-wide rows shadow legacy, Reset restores the
  profile's OWN `default_snapshot`, and `generic_enquiry` is a real fallback: a rule gap renders
  it as a QUEUED staff suggestion (never sent). `test/templates-section.test.ts` unchanged.
- **Invariants / grep:** `getTemplate` precedence (profile → org-wide → legacy) in `repo.ts`;
  Reset uses `templateDefaultSnapshot` — never someone else's wording. Invariant (f): the
  fallback is a held draft, not a send.
- **Reconciled:** `organization_templates(organization_id, key, case_type_id, default_snapshot)`
  extends the existing templates store. Divergence: none.

## S1-7 — Migration plan written AND tested on production-shaped copy — **GREEN**

**Findings:** audit §11 (naming constraints), prompt §1-7. ·
**Files:** `MIGRATION.md`, `src/db/db.ts`, `test/ppr-p07-migration.test.ts`.

- **Repro (was RED):** no written plan; no test against real-shaped data; nothing proved the
  one-shot markers cannot re-run.
- **Tests (GREEN):** `test/ppr-p07-migration.test.ts` (6/6) builds a production-shaped copy —
  real ref numbers `RU-2025-000123/124`, frozen KCSE requirement snapshots, `auto_admitted` /
  `not_admitted` decisions with reasoning text, audit + decision logs, education template
  wording, pack defaults, legacy secrets in settings — and runs the real `openDb()` migration
  with before/after evidence per invariant: names kept (test 1), extensions added (test 1),
  rows stamped as migrated education profile **version 1** (test 2: `education_module=1`,
  `qualification_gate=1`, `default_reply_action='send'` preserved, `auto_admit=0`,
  `config_version_frozen=1`, `case_type_id` profile-id stamp), secrets moved once (test 3),
  history byte-identical (test 4), **markers never re-run** (test 5: a deliberate
  `education_module=0` and `attach_pack='none'` survive a re-open), points→grades and
  postgrad→masters convert once (test 6).
- **Invariants / grep:** invariant (d) — reference numbers, audit text and decision reasoning
  asserted byte-identical; invariant (f) — only the stamped Riara profile keeps `send`+gate.
  Plan and rollback: `MIGRATION.md`.
- **Reconciled:** `applicants.case_type_id` (existing column name) is the profile-id structure
  the prompt's target model wants — no rename (audit §11). The profile-id stamp moved from
  `seed` into `migrate()` (divergence: the seed kept its idempotent copy; reason: production
  boots run `migrate()` without the demo seed).

---

## S2-1 — Terminology labels configurable — **GREEN**

**Findings:** prompt §2-1. · **Files:** `src/types.ts`, `src/db/repo.ts`, `src/web/pages.ts`,
`src/web/server.ts`, `test/ppr-p1-settings.test.ts` (P1-1 tests), `test/ppr-p19-generic-pipeline.test.ts`.

- **Repro (was RED):** "Applicant / Contact / Category / Current level / Admission decision"
  were hardcoded strings on every surface.
- **Tests (GREEN):** `test/ppr-p1-settings.test.ts` — the vocabulary form (real route
  `POST /config/case-types/vocabulary`) renames all five words; the case page renders the new
  words (Matter/Requester/Topic/Phase…); education defaults keep the current wording until
  renamed. `test/ppr-p19-generic-pipeline.test.ts` asserts the configured words on real pages.
- **Invariants / grep:** internal keys and DB columns untouched (`terminology` is a JSON column
  on `case_types`); default values = current education wording (prompt), asserted in tests.
- **Reconciled:** terminology extends `case_types` (existing model). Divergence: none.

## S2-2 — Configurable stages and queues — **GREEN**

**Findings:** prompt §2-2. · **Files:** `src/db/repo.ts`, `src/types.ts`, `src/web/pages.ts`,
`src/web/views.ts`, `src/pipeline/index.ts`, `test/ppr-p1-settings.test.ts` (P1-2 tests).

- **Repro (was RED):** six lifecycle stage labels and the queue set were fixed constants; rules
  could not assign custom stages/queues.
- **Tests (GREEN):** `test/ppr-p1-settings.test.ts` — stages/queues edited per profile via the
  rules-tab form; a rule assigns a configured stage + queue and the case page shows the
  configured labels; education preset (six stages; completed/waiting_documents/human_review/
  decision/enquiries queues) preserved as the default vocabulary.
- **Invariants / grep:** lifecycle ids stay stable (labels only override); pipeline stage
  assignment accepts profile stage ids (`pipeline/index.ts` stage-override check).
- **Reconciled:** `case_types.stages/queues` JSON columns on the existing model. Divergence: the
  stage *order* remains the lifecycle order — one-line reason: the lifecycle table is the
  history spine (audit §11: no renames); labels and membership are what the prompt asks to
  configure.

## S2-3 — Explicit response actions on every path — **GREEN**

**Findings:** F5 (never auto-reject), prompt §2-3. · **Files:** `src/rules/workflow.ts`,
`src/db/db.ts`, `src/db/repo.ts`, `src/pipeline/index.ts`, `src/followups/index.ts`,
`src/web/server.ts`, `src/web/pages.ts`, `test/ppr-p1-response-actions.test.ts`.

- **Repro (was RED):** missing-info/status/human-review/approval/follow-up paths had baked-in
  outcomes (the ladder always held; there was no approval verb); two real bugs found and fixed
  while closing this: an intake rule carrying its reply was ignored for non-education profiles
  (`humanTriageOnly` over-trigger), and a `draft`/`approve`/`hold` verb could silently escalate
  to a send when both gates were open.
- **Tests (GREEN):** `test/ppr-p1-response-actions.test.ts` (4/4) — through the real rules
  routes and pipeline: `approve` queues behind the Approve-automation permission (403 without
  it, send with it); ordinary drafts stay releasable (user send paths allowed); the follow-up
  ladder's rung response is rule data (`none` cancels, `draft`/`approve` queue per mode,
  `send` obeys the qualification gate — gate-on education keeps holding, un-gated sends).
- **Invariants / grep:** invariant (a) — hold/review/gap all land in human review; invariant (f)
  — `send` only where the profile opted in; `outbox.needs_approval` extension column.
- **Reconciled:** action vocabulary extended (`reply_action: none|draft|send|hold|approve`,
  `followup_action: send|draft|approve|none`) — divergence from a bare "send/draft/hold" list
  because §2-3's own four-way requirement (incl. do-nothing and approve) needs it.

## S2-4 — Document library UI; per-stage required information — **GREEN**

**Findings:** E1–E2 (fixed pack slots UI), prompt §2-4. · **Files:** `src/web/pages.ts`,
`src/web/server.ts`, `src/db/repo.ts`, `src/types.ts`, `test/ppr-p1-document-library.test.ts`,
`test/pack-management.test.ts` (reconciled).

- **Repro (was RED):** the config tab offered ten fixed pack slots (Riara file names) with
  replace controls; no way to require information per stage.
- **Tests (GREEN):** `test/ppr-p1-document-library.test.ts` — the tab is a document library
  (org files in named sets, upload/remove, `data-pack-slot` gone, the migrated education packs
  remain a labeled read-only snapshot with preview links); stage required-information lists are
  configured via the vocabulary form (`stage|label|items`) and gate `/case/:id/action` advance
  (refused with the missing items named; passes once the items are on file); the education
  matrix remains on the Requirements tab as the profile generator (`Mean grade` builder intact).
- **Invariants / grep:** `grep -rn "data-pack-slot" src/` → 0; `PACK_SLOTS` only in the labeled
  readers (`src/pack.ts`). Empty required list = no enforcement (existing flows unaffected).
- **Reconciled:** `stages` entries gain `requires[]` (same JSON column). `pack-management.test.ts`
  updated (was asserting the ten-slot UI — divergence reason: P1-4 replaces that UI by
  definition; the test now asserts the library + snapshot).

## S2-5 — `from_name`/reply-to wired into MIME — **GREEN**

**Findings:** prompt §2-5. · **Files:** `src/branding.ts`, `src/web/server.ts`,
`src/pipeline/index.ts`, `src/followups/index.ts`, `test/ppr-secrets.test.ts`.

- **Repro (was RED):** `from_name` was a dead settings field; outgoing mail ignored it.
- **Tests (GREEN):** `test/ppr-secrets.test.ts` (P1-5 section) — every send path (pipeline
  auto-send, held-draft release, follow-up rungs, compose) carries the organization's From
  display name and Reply-To via one `organizationSender` wrapper; `sendOrgMail` wraps
  `ctx.adapters.sender` so no route can forget it.
- **Invariants / grep:** the settings key is migrated to `organizations.from_name` and deleted
  from settings only after the value is safe (P0-7 test 3).
- **Reconciled:** prompt allows "wire OR remove" — **wired**; divergence from removing the
  field: the GR-round organization model is the right home for sender identity, and P1-5 lists
  the fields as required behaviour. (Conflict called out: an older reading of the field as
  "dead → remove" loses the P1-5 requirement.)

## S2-6 — SLA targets, escalation, follow-up ladder in Settings — **GREEN**

**Findings:** prompt §2-6. · **Files:** `src/web/pages.ts`, `test/ppr-p1-settings.test.ts`
(P1-6 test), `test/web.test.ts` (reconciled).

- **Repro (was RED):** an earlier QA round removed response targets from Settings
  ("automation is instant"); the SLA clock and ladder days were un-tunable data.
- **Tests (GREEN):** `test/ppr-p1-settings.test.ts` — the "Response targets & SLA" card saves
  `sla_target_hours`, `escalation_hours`, `unanswered_target_hours`, `followup_ladder_days`
  through the real settings route; the ladder honours the configured days (3/7/10 default).
- **Invariants / grep:** settings save route whitelists/validates keys; ladder semantics
  unchanged (rungs anchored at `followup_base_at`).
- **Reconciled — CONFLICT:** `test/web.test.ts` asserted `settings` must NOT contain
  "Response targets" (older round's invariant). The prompt's §2-6 explicitly requires them back.
  Resolution: the PPR requirement supersedes for response targets; the same test's **retention
  ban kept** (P1-6 never asked for retention UI) and no retention input was added. One-line
  reason for the divergence: later explicit requirement beats an earlier removal decision.

## S2-7 — Preview sample email against unpublished rules — **GREEN**

**Findings:** prompt §2-7. · **Files:** `src/web/server.ts`, `src/web/pages.ts`,
`test/ppr-p1-rule-preview.test.ts`.

- **Repro (was RED):** rules could only be tested by publishing and waiting for mail.
- **Tests (GREEN):** `test/ppr-p1-rule-preview.test.ts` — the rule form's preview panel posts
  the CURRENT (unsaved) fields plus a sample email to `POST /config/workflow-rules/preview` and
  reports: MATCH + what would fire; NO MATCH + which published rule would handle the message
  (never silence); MATCH-but-earlier-rule-wins + how to take over; zero DB writes (rule count
  and audit count unchanged; the draft rule is still unpublished).
- **Invariants / grep:** preview route has no write statements; invariant (a) — the no-match
  verdict names the human-review fallback.
- **Reconciled:** none needed (pure addition to the C6 rules model).

## S2-8 — Distinct automation permissions — **GREEN**

**Findings:** prompt §2-8. · **Files:** `src/db/db.ts`, `src/db/repo.ts`, `src/types.ts`,
`src/web/server.ts`, `src/web/pages.ts`, `test/ppr-p1-settings.test.ts` (P1-8 tests),
`test/ppr-p1-response-actions.test.ts`.

- **Repro (was RED):** a two-role split (admin/user) could not express "may publish rules but
  not send" or "may approve automation but not record outcomes".
- **Tests (GREEN):** `test/ppr-p1-settings.test.ts` — the four bits
  (`publish_rules`/`send_automated`/`approve_automation`/`record_outcome`) are granted
  independently through the staff-page form and enforced on six real routes (403 names the
  missing permission); admins hold all four; users with no rows get the safe defaults
  (`send_automated`+`approve_automation`); the refined split is exercised in
  `test/ppr-p1-response-actions.test.ts` (approval drafts vs ordinary drafts).
- **Invariants / grep:** `staff_permissions` table + `hasPermission` (admin ⇒ all, explicit rows
  ⇒ exact, no rows ⇒ defaults); password/role rows untouched.
- **Reconciled — CONFLICT:** the first P1-8 cut gated ALL `/case/:id/draft` actions on
  `approve_automation`; §2-3's "user send paths must stay allowed" requires ordinary drafts to
  be officer work. Resolution: the gate applies only to drafts with `needs_approval=1` (the
  `approve` verb / approval rungs); tests updated accordingly. One-line reason: the stricter
  reading broke the explicitly stated invariant.

## S2-9 — Generic pipeline suite with education fully off — **GREEN**

**Findings:** F1/E4 (proof obligation), prompt §2-9. · **Files:**
`test/ppr-p19-generic-pipeline.test.ts`, `src/web/pages.ts` (education chrome gating),
`src/followups/index.ts` (profile-scoped rung templates).

- **Repro (was RED):** no test ran the core pipeline without academic vocabulary; education
  chrome (programme catalogue, "Admissions / Decision" tab, admission-decision column, academic
  template options, legacy pack buttons) leaked onto non-education surfaces.
- **Tests (GREEN):** `test/ppr-p19-generic-pipeline.test.ts` — a whole case life (intake →
  documents → checklist → held replies → ladder rungs → stage movement) inside a brand-new
  non-academic organization, with an academic-word sweep (`KCSE/KCPE/IGCSE/GPA/grade(s)/
  programme(s)/admission(s)/eligibility/…`) over the case page, the applicants list, every
  audit line and every draft body: zero matches. Chrome leaks found by the sweep were fixed:
  queue tab/programme filter/admission column/academic template options/legacy pack panel are
  now gated on `hasEducationModule`.
- **Invariants / grep:** all education/KCSE suites remain a separate, untouched suite (baseline
  includes `admissions.test.ts`, `course-config.test.ts`, KCSE matrix tests). Workspace chrome
  scope note: the sweep strips nav/styles (invariant (e) keeps `/admissions` reachable in
  education workspaces) — the case CONTENT is what must be vocabulary-clean.
- **Reconciled:** the applicants page (admissions-era `QUEUES` model) keeps its education
  taxonomy for education workspaces; non-education workspaces filter it. Divergence: none —
  additive gating.

---

## Evidence index

- Full suite: `npx vitest run` → 612 passed / 2 failed (`test/round19.test.ts` rasterisation,
  `canvas` unbuildable — accepted across all rounds) / 1 skipped. `npx tsc --noEmit` clean.
- New suites: `ppr-secrets`, `ppr-education-toggle`, `ppr-workflow-rules`,
  `ppr-attachment-sets`, `ppr-templates-profile`, `ppr-p1-settings`, `ppr-p1-response-actions`,
  `ppr-p1-document-library`, `ppr-p1-rule-preview`, `ppr-p19-generic-pipeline`,
  `ppr-p07-migration` (all green).
- Reconciled suites (updated with in-file RECONCILED notes): `test/web.test.ts` (S2-6),
  `test/pack-management.test.ts` (S2-4), `test/ppr-p1-settings.test.ts` (S2-8).
- Migration plan + rollback: `MIGRATION.md`.
