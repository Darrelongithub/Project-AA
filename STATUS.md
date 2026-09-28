# STATUS — current project status

**This is the single current-status document.** Every other root-level markdown
(`AUDIT.md`, `BUGLOG.md`, `BUGS.md`, `CODE_REVIEW.md`, `MIGRATION.md`,
`OWNER_ISSUES.md`, `PPR-REPORT.md`, `REPORT.md`) is historical: kept for the
audit trail, figures may be stale. When the state of the project changes,
update THIS file — not the historical ones.

## State of the build (as of 2026-09-28)

| Gate | Command | Status |
| --- | --- | --- |
| Types (strict) | `npm run typecheck` | clean |
| Test suite | `npm test` (vitest) | **635 passed + 3 environment-gated skips** (74 files), 0 failed |
| Simulation scorecard | `npm run simulate` | **316/316 checks, 26/26 scenarios — ALL GREEN, exits 0**; exits non-zero on any failure (CI gate) |
| Boot outside `./data` | `DB_PATH=/tmp/x.sqlite npm run serve` | clean boot (bundled data resolved from the install, not the CWD) |

## What recently changed (STAB round)

- **C-1** — the server crashed on boot when `DB_PATH` pointed outside the
  repo's `./data` (`Unknown attachment set 'application'`). Bundled data is now
  resolved from the compiled module's own location (or `BUNDLED_DATA_DIR`),
  never from the CWD or `DB_PATH`. Permanent regression: `test/boot-outside-repo.test.ts`.
- **H-2** — staff management is tenant-scoped end to end: `createStaff` takes a
  real `organizationId`, `/staff/add` files new accounts under the acting
  admin's organization, and every staff surface (stats, accounts, permissions,
  scope matrix, assignee pickers) resolves against the acting user's org.
  Regression: `test/h2-staff-org-scope.test.ts`.
- **H-3** — cross-tenant IDOR on `/staff/toggle`, `/staff/password`,
  `/staff/reset-code`, `/staff/permissions`, `/staff/scopes` is closed: targets
  must belong to the acting admin's organization (`repo.staffInOrganization`).
- **M-3** — the auto-admission path is live again and strictly opt-in: a fully
  qualifying, watcher-clean, non-draft education case auto-admits and sends the
  admission letter (reversible via the ordinary not-admitted path), while new
  organizations default to draft/no-auto-admit. Regression:
  `test/m3-auto-admit.test.ts`.
- **M-1** — canvas-free environments skip the two raster probes cleanly
  (`test/round19.test.ts` mirrors `test/responsive.test.ts`).
- **M-2** — one username rule everywhere (`src/util/username.ts`: trim +
  lowercase, `/^[a-z0-9_.-]{2,32}$/`), `getStaffByUsername` matches
  case-insensitively; existing mixed-case usernames are folded once at startup
  (`education_auto_admit_restored_v1` migration block in `src/db/db.ts`).
- **M-4** — the dashboard "documents" tile counts active documents only
  (`superseded_by IS NULL`), matching the case view and CSV export.
  Regression: `test/m4-dashboard-superseded.test.ts`.
- **H-1** — `npm run simulate` is a real CI gate (non-zero exit on failure) and
  the fixture answer key matches actual verified behavior (26/26 green).
- **Light mode** — the register-flow band (bone-white labels, pale-pink links,
  near-black rules) and the beveled-slab card shadows no longer stay dark on
  paper: slab shadows are theme variables with paper values, and the flow band
  gets explicit `[data-theme="light"]` overrides. Regression:
  `test/light-mode.test.ts`.
- **LOW** — README port/test-count/script fixes, static-analysis policy
  documented (typecheck is the only lint gate), `COOKIE_SECURE`/`TRUST_PROXY`
  in `.env.example`, historical markdowns marked superseded (this file).

## Hardening round (2026-09-28, audit pass 2)

- **Config-surface IDORs closed (H-3 follow-up)** — `/config/attachment-sets/upload`
  accepted ANY set id (files could be injected into another tenant's outgoing
  mail); `/config/workflow-rules/toggle` flipped ANY rule id; `/config/workflow-rules/save`
  could hang a rule on another tenant's CaseType. All three now constrain to the
  acting admin's organization. Regression: `test/h3-config-idor.test.ts`.
- **Outbox index** — queue listings probe outbox per applicant row; without
  `idx_outbox_applicant` each probe was a full table scan (EXPLAIN verified
  SCAN → SEARCH).
- **Numeric env hardening** — `PORT=abc` etc. leaked NaN into listen(),
  timeouts, budgets and the Gmail byte guard (`x > NaN` is always false).
  All numeric env parses now fall back to documented defaults
  (`src/util/envnum.ts`, `test/env-and-schema.test.ts`).
- **Compiled build verified** — `npm run build` + `npm start` boot clean with a
  hostile `DB_PATH` (C-1 holds in the `dist/` layout).

## CLI hardening round (2026-09-28, audit pass 3)

- **Operational CLIs audited** — `backup` (online SQLite backup API, correct),
  `restore` (explicit-arg + WAL sidecar cleanup, correct), `retain`
  (0700/0600 archive, completed-only, realm guard, never deletes on
  unparseable dates), `escalate`, `followups`, `nextRefNumber`
  (transactional, race-safe).
- **NaN fallbacks added to `retain` and `escalate`** — a corrupt
  `retention_days`/`escalation_hours` setting previously crashed retain with
  an opaque RangeError (Invalid Date) and poisoned the escalation audit
  trail; both now fall back to documented defaults via `src/util/envnum.ts`.
- **Verified-safe**: CSV formula-injection guard (leading apostrophe + quote
  doubling), session cookies (HttpOnly/SameSite/optional Secure), XSS
  escaping (every `full_name`/`subject`/`msg` sink esc()-wrapped; avatar()
  escapes internally), portal OTP machinery deliberately dropped (tables
  removed in schema), branded 404/500 boundaries, realm-scoped exports.

## Sync-skip honesty fix (2026-09-28, final)

- `onceAtATime` now returns `{ ran, result }` — a manual "Sync now" or
  backfill clicked while a background pass is in flight reports
  "A sync is already running" instead of a false "Inbox synced".
  Regression: `test/gmail-sync-skip.test.ts`; guard semantics pinned in
  `test/review-hardening.test.ts`.

## Consistency fixes (2026-09-28, final+1)

- **Attachment-set creation is own-org only** — the Document-library tab has
  no org picker and uploads are org-checked, so `/config/attachment-sets/create`
  now ignores form-supplied `organization_id` and always files the set under
  the acting admin's organization (removes the footgun of creating a set in
  an org whose uploads are then refused). The case-types tab keeps its
  deliberate org picker.
- **Every numeric SETTINGS read is NaN-safe** — `sla_target_hours`
  (pipeline: a corrupt value made `sla_due_at` an Invalid Date and threw
  RangeError per email, bricking intake), `escalation_hours` (live sweep in
  serve.ts), `unanswered_target_hours` (dashboard alert math). All now fall
  back to documented defaults; regression pins the intake crash path
  (`test/env-and-schema.test.ts`).

## Session-hygiene fix (2026-09-28, final+2)

- **Admin password reset now ends the member's live sessions** — the
  self-service reset-code path already purged sessions; the admin
  `/staff/password` path did not, leaving a (stolen-laptop /
  suspected-compromise) session valid until natural 8-hour expiry. Both paths
  now purge and the audit records how many sessions ended. Account-disable
  was already instant (`getSession` rejects inactive staff).
- **Verified-safe this pass**: `esc()` covers text+attribute contexts, both
  search paths escape LIKE wildcards with ESCAPE clauses, mail/compose bodies
  render via esc()+pre-wrap, all outgoing email is text/plain (no HTML
  injection surface), `renderTemplate` substitution is single-pass plain
  text, sessions self-purge on expiry, openDb sets WAL + busy_timeout +
  foreign_keys for concurrent server/CLI access.

## Running the project

See `README.md` (setup, scripts, static-analysis policy, Linux notes).
