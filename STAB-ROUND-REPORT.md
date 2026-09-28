# STAB Round — RED → GREEN Evidence Report

Round: stabilization of the independent audit findings (PPR-AUDIT-2), executed
in strict priority order (CRITICAL → HIGH → MEDIUM → LOW), plus the owner's
separate light-mode report. One row per item below; evidence verbatim.

**Final gate status (this checkout, 2026-09-27):**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` (strict) | clean |
| `npx vitest run` | **77 files · 645 passed + 3 environment-gated skips · 0 failed** |
| `npm run simulate` | **316/316 checks · 26/26 scenarios · ALL GREEN · exit 0** (exit 1 verified while failures were present — real CI gate) |

---

## C-1 — CRITICAL: server crashed on boot when DB_PATH is outside ./data

**Audit reproduction command (run verbatim):**

```bash
DB_PATH=/tmp/aa-boot-red/email-sorter.sqlite PORT=8137 LOG_TO_FILE=0 timeout 25 npx tsx src/cli/serve.ts
```

- **RED (pre-fix, captured output):** boot dies with
  `Error: Unknown attachment set 'application'` — crash chain
  `repo.ts:1785 ← seed.ts:383 ← serve.ts:45`. The bundled data dir was
  resolved against the working tree, so a database anywhere outside `./data`
  started against an unseeded store. (Every existing test used `:memory:`,
  which silently resolved inside the repo — that's how the suite missed it.)
- **Fix:** `src/pack.ts` resolves bundled data from the **module's own
  location** (`__dirname` walk up ≤6 via `package.json`, `BUNDLED_DATA_DIR`
  explicit override first) — never from the CWD or `DB_PATH`.
- **GREEN:** the same command with `DB_PATH=/tmp/aa-boot-green/...` boots
  clean; `/login` serves the setup page.
- **Permanent regression:** `test/boot-outside-repo.test.ts` — spawns the real
  server with a hostile `DB_PATH` in a `mktemp` dir and asserts a clean start
  (2 tests, passing in the full suite).

## H-2 — createStaff hard-coded organization_id = 1; /staff/add never passed a tenant

- **Fix:** `Repo.createStaff(..., organizationId)` takes a real parameter
  threaded through `createStaffAndReturn` and `/staff/add` (which now files
  accounts under `organizationId(req)` — the acting admin's org). Every staff
  surface resolves against the acting user's org: `staffStats(demo, orgId)`
  (dashboard team tile + staff page), accounts/permissions tables, scope
  matrix, case-page assignee picker, board assignee names, workflow-rules
  staff picker, org-1 academic course-owner picker (pinned to org 1).
  No unscoped `repo.listStaff()` render remains in `src/`.
- **Acceptance:** an org-2 admin logging in (`organizationId(req)`) resolves
  org-2 data only.
- **Regression:** `test/h2-staff-org-scope.test.ts` (8 tests): repo-level
  scoping both directions, `/staff` page renders own-tenant accounts only,
  `/staff/add` from an org-2 session creates `organization_id = org2`.

## H-3 — cross-tenant IDOR on /staff/toggle, /staff/password, /staff/reset-code, /staff/permissions, /staff/scopes

- **Fix:** every `/staff/*` write resolves its target through
  `repo.staffInOrganization(staffId, organizationId(req))`; a foreign id is
  treated as unknown and the target row is left untouched.
- **Acceptance/Regression:** `test/h2-staff-org-scope.test.ts`: org-2 admin
  acting on org-1 staff id is refused on toggle (state unchanged), password
  (old password still authenticates), reset-code (200 re-render "Unknown staff
  member — no code issued.", no code in body), scopes (scopes unchanged); and
  same-tenant toggle/password/reset still work end to end.

## M-3 (treated as HIGH) — auto-admit was unreachable dead code; path restored, opt-in only

- **Fix:** `src/admissions/evaluate.ts` gained `autoAdmitPolicy(repo, id)` and
  `evaluateAdmission(..., { autoAdmit })` (default OFF);
  `src/pipeline/index.ts` re-armed the path (eligibility gate, admission
  letter send, `documents_checked` trail step, `auto_admitted` decision +
  `auto_admission_triggered` audit, reversal via the existing not-admitted
  decision form). The `auto_admitted` vocabulary was restored, not deleted.
- **Acceptance (end-to-end, actual test):** `test/m3-auto-admit.test.ts` (5
  tests): a fully qualifying clean-Green migrated Riara profile reaches
  `routing = "auto_admit"`, `routing_reason = "qualified_auto_admit"`,
  `admission_decision = "auto_admitted"`, `admission_route = "auto"`,
  lifecycle `completed`, and the admission letter is sent
  ("[RU-2026-000001] Welcome to Riara University — Your Admission to BSc
  Computer Science"); a registrar reversal flips it to `not_admitted` (route
  human, audited). Simultaneously, a new organization ("Northwind Support") in
  draft mode and an auto-admit-opted-out org ("Rift Valley College") stay
  undecided with no letter — new-org defaults unaffected.
- Suite reconciliation: `e2e`, `v3`, `ppr-workflow-rules`, `ppr-p07`,
  `round19` expectations updated to the restored behavior (no assertion was
  weakened; the status-history trail gained the real `documents_checked` step).

## M-1 — round19 hard-failed without the optional native canvas

- **Fix:** `test/round19.test.ts` probes for canvas with a try/require at the
  top and `(t) => t.skip()` on the two raster tests — mirroring
  `test/responsive.test.ts`. Without canvas: 47 passed, 2 skipped (with a
  one-line warn); with canvas both raster tests run.

## M-2 — username normalization unified

- **Fix:** `src/util/username.ts` — `USERNAME_RE = /^[a-z0-9_.-]{2,32}$/`,
  `normalizeUsername` (trim + lowercase), `isValidUsername`; shared by
  `/setup`, `/staff/add`, `/account/username`. `getStaffByUsername` matches
  `COLLATE NOCASE`; a one-time startup fold lowercases existing mixed-case
  staff usernames (guarded by a settings marker).
- **Migration note:** existing mixed-case usernames are folded to lowercase
  once at first boot after this change. If a legacy database holds both
  `Admin` and `admin`, the fold is skipped loudly rather than violating the
  UNIQUE column — resolve the duplicate manually (the accounts are the same
  person in every observed install).

## M-4 — dashboard counted superseded documents

- **Fix:** `dashboardStats().documents` now adds `AND d.superseded_by IS NULL`,
  matching the case view and CSV (active-only).
- **Regression:** `test/m4-dashboard-superseded.test.ts`.
  RED against the old stats query: `AssertionError: expected 2 to be 1`;
  GREEN with the fix.

## H-1 — `npm run simulate` scorecard stale + exit-code contract

- **Contract verified both ways:** with failures present the command exits **1**
  (observed `NPM EXIT=1` at 309/316); with the key corrected it exits **0**
  (`NPM EXIT=0`). The runner's `process.exit(result.allPassed ? 0 : 1)` was
  already correct — the earlier "exits 0" observation was an artifact of
  piping through `tail`. The CLI is a real CI gate.
- **Answer key updated after M-3 landed** (as required — M-3 changed what
  "correct" means): Green files now complete with the admission letter
  (kevin-duplicate, uma-reopen); education triage holds enquiries
  (henry-inquiry → `rule_enquiry_triage`, category `admission_enquiry`) and
  complaints (mary-complaint → `rule_complaint`, priority high) for a human
  instead of auto-sending document requests; the categoriser's wording rule
  pinned for ib-degree-route / alevel-one-principal (`application` — no
  "find attached … documents" phrasing).
- **Result: 316/316 checks, 26/26 scenarios, ALL GREEN, exit 0.**

## LOW batch

| Item | Fix |
| --- | --- |
| L-1/L-2 README | port 3000 → **8080** (matches `config.ts` + `.env.example`); test count now "632 tests + 3 environment-gated skips across 73 files"; scripts table documents `npm run build`, `npm start`, `npm run stress`, `npm run purge-mock`, `npm run setup:linux`; simulate row states the CI-gate exit contract |
| L-3 lint ambiguity | new README section **"Static analysis policy"**: `tsc --noEmit` (strict) is the only static gate; no ESLint config exists by design, ad-hoc `npx eslint` output reflects no policy |
| L-4 env docs | `.env.example` documents `COOKIE_SECURE` and `TRUST_PROXY` (both `=1` behind a TLS-terminating proxy; commented defaults) |
| L-5 pipeline formatting | verified **absent** in the current file: every `; identifier` hit in `src/pipeline/index.ts` is inside string literals or type annotations; the audit's ~line-588 neighborhood was rewritten by the M-3 restructure. Nothing left to fix |
| L-6 markdown sprawl | new single current-status doc **`STATUS.md`**; `AUDIT.md`, `BUGLOG.md`, `BUGS.md`, `CODE_REVIEW.md`, `MIGRATION.md`, `OWNER_ISSUES.md`, `PPR-REPORT.md`, `REPORT.md` carry a "Historical — superseded by STATUS.md" banner |

---

## Light mode — separate owner report: "some elements stay dark"

Root cause: two clusters were drawn against the dark palette only.

1. **Register-flow band on the admin dashboard** (`.flow-heading`,
   `.flow-index`, `.flow-link`, `.gauge-band`, `.band-label`) — rendered
   *below* the always-dark masthead but directly on the page background:
   - `.band-label b` "At a glance" / "By stage" was bone-white `#eadfe2` —
     **invisible on paper**;
   - `.flow-link` "OPEN REGISTER" was pale pink `#d9b6bf` (hover `#fff`) —
     **invisible on paper**;
   - rules `#40101a` / `#29151b` were near-black lines across the light page.
   Fix: explicit `[data-theme="light"]` overrides — labels `var(--ink)` /
   `var(--muted)`, links `var(--wine-mid)` on `var(--wine-line)`, rules
   `var(--line)`; dark mode keeps the original noir values untouched.

2. **Beveled-slab card shadows** (cards, stat tiles, gauges) baked hard
   `inset 0 -2px 0 rgba(0,0,0,.52)` inner lines and `rgba(0,0,0,.5–.7)` casts
   into light cards — dirty dark lines on paper. Fix: new `--slab-*`
   variables (lip / inner shade / cast / foot) with the original values in
   `:root` for dark and soft warm-ink values (`rgba(49,31,31,.12–.24)`, white
   lip) in `[data-theme="light"]`.

Deliberately left dark (self-consistent, readable in both themes): the
`#090608` masthead band and the `#070507` sidebar rail — both carry their own
hard-coded light text and are designed always-dark brand surfaces.

**Regression:** `test/light-mode.test.ts` (4 tests): no hard near-black inner
shadow lines remain; the light theme redefines the slab variables with paper
values; the flow-band overrides exist; dark mode keeps the original noir
values and the dark mast/rail.

---

## Brand accent — "no pink" (owner follow-up)

- The default organization accent was pink `#e18b9a`, mapped onto
  `--wine-mid`/`--wine-soft` — headings, kickers, links and highlight borders
  rendered pink everywhere, and washed out to near-invisible pale pink on
  light paper.
- New default accent: **antique gold `#c89a4a`** (garnet & gold), applied in
  `organizationTheme()` (the pink pair is now a recognized previous default,
  so existing databases migrate automatically), `createOrganization`,
  `seedDefaults` and the Settings placeholder.
- Theme-aware override: a light accent is deepened (channels × 0.5 →
  `#644d25` bronze) for `[data-theme="light"]` via `accentOnPaper()` in
  `src/web/views.ts`, so paper mode keeps contrast without changing the
  dark-shell look. Deliberately customized themes are never touched.
- Light palette de-pinked: rose bevels/washes (`#b87883`, `#d9b7bf`,
  `#f0dfe3`) → garnet bevel `#7d3542`, warm parchment washes `#f4eee2`,
  `--wine-light` `#b25a62`.
- Regression: `test/brand-accent.test.ts` (3 tests) — pink→gold migration,
  custom themes untouched, page-level override + no pink trace.

## Fresh audit sweep (final pass, 2026-09-28)

| Check | Result |
| --- | --- |
| TODO/FIXME/HACK markers in `src/` | none |
| Stray `console.*` outside CLI/log/simulation | none |
| Committed secrets/credential files | none (`test/ppr-secrets.test.ts` guards this) |
| Unused/duplicate dependencies | none (runtime deps all imported; `@types/*` ambient) |
| Env-var contract | `GMAIL_LABEL` + optional operational knobs (`BACKUP_DIR`, `BUNDLED_DATA_DIR`, `LOG_LEVEL`, `RETAIN_ALL_REALMS`, `GEMINI_TIMEOUT_MS`, `GEMINI_DAILY_BUDGET`, `SIM_DB_PATH`) now documented in `.env.example` |
| Route middleware scan | every POST is auth-guarded + CSRF-checked; pre-auth routes (`/login`, `/reset-password`, `/setup`, `/theme`) are throttled/token-guarded, `/theme` has open-redirect protection; POST `/setup` is one-time (404 after first account) |
| Async-handler rejection risk | the single `async` route (Gmail OAuth callback) wraps its network call in try/catch → user-facing redirect; verified safe |
| C-1 live boot sanity | `DB_PATH=/tmp/aa-boot-audit/...` boots clean, `/login` serves setup — fix holds |
| Unused-import regression | `test/brand-accent.test.ts` had unused `afterAll`/`beforeAll` (TS6133) — removed |

---

## Audit pass 2 (2026-09-28): compiled build, schema, config IDORs

| Finding | Severity | Fix |
| --- | --- | --- |
| `/config/attachment-sets/upload` accepted a foreign org's set id → file injection into another tenant's outgoing mail | HIGH | set must belong to `organizationId(req)`; foreign id ≡ unknown (400) |
| `/config/workflow-rules/toggle` flipped any org's rule id | HIGH | scoped to acting org (delete already was — routes now agree) |
| `/config/workflow-rules/save` hung rules on another tenant's CaseType via form field | HIGH | acting org must match the CaseType's org |
| `outbox` had no `(applicant_id, mode)` index; queue listings full-scanned it per applicant row | MEDIUM (perf) | `idx_outbox_applicant`; EXPLAIN: SCAN → SEARCH |
| Typo'd numeric env vars leaked NaN (PORT → `listen(NaN)` crash; GMAIL_MAX_EMAIL_BYTES → size guard silently off) | MEDIUM | `src/util/envnum.ts` fallbacks at every numeric env parse |
| `npm run build` / `npm start` documented but never verified | LOW | verified: compiled boot clean with hostile `DB_PATH` |
| `ppr-attachment-sets.test.ts` accidentally depended on cross-tenant uploads | test defect | acting-admin flip moved before set management (test's own convention) |

Regression: `test/h3-config-idor.test.ts` (5), `test/env-and-schema.test.ts` (3).

## Audit pass 3 (2026-09-28): CLIs, XSS, cookies, CSV, ref race

| Check | Result |
| --- | --- |
| `retain`/`escalate` NaN settings | FIXED — `envnum` fallbacks (retain crashed on corrupt `retention_days`; escalate's audit window was poisoned) |
| `backup` / `restore` | correct (online backup API; WAL sidecars removed; explicit-arg restore) |
| CSV formula injection | already defended (leading apostrophe + quote doubling) |
| Session cookies | HttpOnly + SameSite=Lax + optional Secure (COOKIE_SECURE) |
| XSS sweep | every user-controlled sink esc()-wrapped (msg, full_name, subject, avatar internals) |
| Portal OTP surface | deliberately removed (portal_otps/portal_sessions dropped in schema) |
| `nextRefNumber` race | transactional counter — safe under concurrency |

## Final fix (2026-09-28): "Sync now" skip honesty

`onceAtATime` conflated "skipped — a pass is in flight" with "success" (both
null), so a manual sync during a background pass claimed "Inbox synced" for a
pass that never ran. The guard now returns `{ ran, result }`; the
`/settings/gmail/sync` and `/settings/gmail/backfill` routes report the skip
explicitly, and the shared-guard wiring (poll = sync = backfill) is mirrored
in the test. Regression: `test/gmail-sync-skip.test.ts` (2),
`test/review-hardening.test.ts` strengthened to pin the new shape.

## Final+1 (2026-09-28): tenancy consistency + last NaN sites

- `/config/attachment-sets/create` ignores form-supplied `organization_id`
  (no UI sends it) and files sets under the acting admin's org — matching the
  pack tab's own-org model and the upload guard. Case-types tab keeps its
  deliberate org picker (documented design).
- Remaining numeric-settings reads hardened: `sla_target_hours` (pipeline —
  corrupt value threw RangeError per email via Invalid Date), the live
  escalation sweep in `serve.ts`, `unanswered_target_hours` (dashboard).
  Regression: corrupt `sla_target_hours` intake test in
  `test/env-and-schema.test.ts`.

## Final+2 (2026-09-28): session hygiene + XSS/render sweep

- **Admin `/staff/password` reset now purges the target's live sessions**
  (matching the self-service reset-code path) — an admin resetting a
  compromised account no longer leaves the attacker's session valid for up
  to 8 hours. Audit records the ended-session count. Regression:
  `test/h2-staff-org-scope.test.ts` ("admin password reset ENDS the member's
  existing sessions").
- Sweep results (no change needed): `esc()` escapes `& < > " '` (text+attr
  safe); mail/compose/previews esc()+pre-wrap; outgoing email is text/plain
  only; both search paths parameterize + escape LIKE wildcards; sessions
  purge on expiry lookup; SQLite runs WAL + 5s busy_timeout + foreign_keys
  (concurrent server/cron safe).

## New/changed files this round (audit-visible)

- New tests: `test/boot-outside-repo.test.ts`, `test/m3-auto-admit.test.ts`,
  `test/h2-staff-org-scope.test.ts`, `test/m4-dashboard-superseded.test.ts`,
  `test/light-mode.test.ts`.
- Changed: `src/pack.ts` (C-1), `src/db/repo.ts` (H-2/H-3/M-4),
  `src/web/server.ts` (H-2/H-3/M-2/M-3), `src/web/pages.ts` (H-2 scoping +
  reversal UI), `src/admissions/evaluate.ts` + `src/pipeline/index.ts` (M-3),
  `src/db/db.ts` + `src/db/seed.ts` (M-2/M-3/marker seeds),
  `src/util/username.ts` (new, M-2), `src/web/views.ts` (light mode),
  `src/simulation/fixtures.ts` (H-1), `README.md`, `.env.example`,
  `STATUS.md` + historical banners (L-6), `test/round19.test.ts` (M-1) and the
  reconciled M-3 suites (`e2e`, `v3`, `ppr-workflow-rules`, `ppr-p07`).
