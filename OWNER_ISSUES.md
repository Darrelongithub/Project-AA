# OWNER_ISSUES.md — acceptance gates

Statuses: **RED** = failing / not started · **GREEN** = fixed with evidence · **UNVERIFIED** = could not run, reason given.

Baseline before this round: tsc clean · 305/305 vitest · 316/316 simulate.

---

## OR-1 — No mock data in the app — **GREEN**

**Repro (before fix):** `npm run demo` deleted the exact DB file `npm run serve` reads and rebuilt it with the simulation corpus; login worked with `admin/admin123`; the console showed a "Demo dataset loaded" banner and staff rows badged `demo`; serve/ingest printed "run npm run demo".

**Fixes (commit "Round 23 OR-1"):**
- `seedDefaults` seeds NO staff accounts — the product ships with zero credentials.
- First-run setup screen (`/setup`): on a fresh install every request redirects to `/setup`; the owner creates their own admin account (name, username, ≥8-char password with confirmation, one-time expiring token). After the first account exists `/setup` returns 404 forever.
- `npm run demo` removed (script + CLI deleted). Simulation defaults to an in-memory DB and now **hard-refuses** to run against the server's configured database.
- Demo banner, demo badges, `KNOWN_DEFAULTS` (hard-coded admin123/demo123 strings in source) and all "run npm run demo" messages removed.
- `npm run purge-mock` added: backs the DB up, deletes only `demo=1` applicants (+ child rows), demo staff and the `demo_dataset` marker; prints exactly what went; idempotent; writes nothing when clean.
- Fresh-install empty state: "No applications yet. Connect Gmail in Settings…"

**Tests (test/owner-acceptance.test.ts, group OR-1):** 6 tests.
- RED evidence (before fix): `6 failed (6)` — including "no tests" collection failure because `src/db/purge.ts` did not exist.
- GREEN evidence (after fix): `Tests 6 passed (6)`; full suite `Tests 311 passed (311)`.

**Live-run evidence (fresh DB + real server, HTTP):**
- `GET /login → 302 loc=/setup`; `GET /setup` renders "Welcome… Create administrator account".
- `POST /setup → 302 loc=/` with session cookie; all 6 console pages returned 200 with **0 demo-wording lines**.
- `GET /setup` after first run → **404**.
- Purge on contaminated file DB: `removed 2 mock applicant(s) and 2 demo account(s)`, backup written; second run: `clean — nothing to remove`. Real applicant + real staff row survived.

**Interpretations:** internal `demo` DB columns and realm filters were KEPT (invisible to users, harmless once purged, and they make any future contamination self-isolating); only user-visible demo concepts were removed. Purge identifies mock rows by the `demo=1` flag the old tool itself set.

---

## OR-2 — Status/queue model follows the pipeline — **GREEN** (model core)

**Repro (before fix):** `queueOf()` fell through to *Enquiries → New enquiry* for any
applicant with documents in hand but no routing yet — exactly the owner's "documents
submitted and awaiting review shows as waiting/new" confusion. 5 OR-2 tests written first;
2 failed RED proving the fall-through (`documents_received` and `awaiting_review` cases
landed in enquiries).

**Fixes:**
- `queueOf` now routes "documents in, no routing" to **Human Review → "Documents in —
  needs a manual decision"** before any enquiries fallback.
- Vague labels replaced with plain language: "Requirement not satisfied" → "Entry
  requirements not met — decide manually"; "Manual decision required" → "Documents in —
  needs a manual decision"; "Escalated" → "Escalated — overdue, needs attention now".
  The queue page already prints the evaluation reason beside each row, so no label appears
  without its explanation.
- `docs/STATUS_MODEL.md` written: every state, what enters/leaves it, who acts next, and
  the invariants pinned by tests.

**Evidence:** OR-2 group `5 passed` (RED first: `2 failed | 9 passed`); full suite
`316 passed`; simulate `316/316 ALL GREEN`.

**Remaining OR-2 scope (tracked):** "What needs my attention" panel ordering/scoping is
implemented with OR-8 (role scoping); escalation *who/when* display on the case page is
verified in the route scan.
## OR-3 — Responsive UI — **GREEN**

**Repro (real Chromium, throwaway DB):** resize audit visited 8 staff pages ×
5 widths (1280/1024/768/480/360) plus a continuous 1280→320 sweep. Before fix:
**10 overflowing page/width combinations** — every page at 360px (unwrapped wide
tables: 465–639px), `/applicants` at 1024px (1145px queue table), `/case` at
480/360 (529–607px fixed grids). 0 JS errors, so the break was layout, not scripting.

**Root causes:** wide `<table>`s were only given scroll containment inside
`.card` below 900px; selects and case-page grids had no min-width caps; page
padding was fixed at desktop values.

**Fixes (views.ts):** universal containment — `section, .card, .loginbox
{ max-width:100%; overflow-x:auto }` (wide tables scroll inside their own
container, per the owner's rule), `table/select/input/textarea { max-width:100% }`,
`.case-grid > * { min-width:0 }`, and a 480px tier for paddings/header chips.

**Evidence:** after fix the same audit reports `0 overflowing page/width
combinations; 0 JS errors`; permanent regression test `test/responsive.test.ts`
(real Chromium; skips with a reason if no browser binary) passes. Screenshots in
`docs/screenshots/*_360.png`. Audit tooling: `scripts/ui-resize-audit.mts`.

**Known low nit:** brand wordmark contrast at tiny widths (polish, not overflow).
## OR-4 — Gmail/Gemini connections in Settings, guided, live status — **GREEN**

**Repro:** the Gmail/Gemini connection cards rendered in **Configuration →
Replies** (`/config?tab=replies`) instead of Settings; after saving credentials,
connecting, syncing or saving a Gemini key the console redirected back to
`/config?tab=replies#gmail|gemini`; the dashboard "manage" links pointed at the
same wrong home; the Gmail card offered **Sync now** but no explicit *Test
connection*; and the setup guide gave only a free key/API-key line — no
step-by-step Google Cloud OAuth walk-through (scope, redirect URI, OAuth
Playground fallback) as the owner dictated.

**Root cause:** the cards were built into `configPage()` back when connections
were considered "reply plumbing"; the OAuth backend (server.ts) was written
against that home, so every `Location:` header and dashboard link hardcoded
`/config?tab=replies…`.

**Fixes:**
- `src/web/pages.ts` — new `connectionsSection(c)` rendered at the top of
  **Settings** (`<div id="connections">` with `#gmail` and `#gemini` cards),
  removed from `configPage` entirely. Gmail card now carries a numbered
  step-by-step guide (Google Cloud project → enable Gmail API → OAuth consent →
  OAuth client ID type Web application → add `<console>/settings/gmail/callback`
  redirect URI → copy ID/secret), states the **exact scope** requested
  (`https://www.googleapis.com/auth/gmail.modify`), documents the **OAuth
  Playground fallback** (advanced refresh-token field wired to
  `gmail_refresh_token_manual`), and shows live status: connected badge, signed-in
  address, last successful sync, last error with plain-language remedies.
- `src/web/server.ts` — new **`POST /settings/gmail/test`** (admin + CSRF): makes
  one real lightweight Gmail call (`listRecentMessageIds(1, { perPage: 1, maxPages: 1 })`);
  on success clears `gmail_last_error` + audit `gmail_tested`; on failure stores the
  exact error in `gmail_last_error`, audits `gmail_test_failed`, and redirects with
  the message — never silent. All connection redirects (`settingsBack`, Gemini
  save/remove) now land on `/settings?msg=…#connections`; audit wording fixed
  ("manual sync from Settings").
- Dashboard manage links (`/config#gmail`, `/config#gemini`) → `/settings#connections`.
- Contract updates (moves, not weakenings): `test/web.test.ts` production-readiness
  + secret-echo tests now assert the card lives in Settings and is *absent* from
  Configuration; `test/v5.test.ts` gemini-slot test fetches `/settings`.

**Evidence (RED → GREEN):** five new acceptance tests in
`test/owner-acceptance.test.ts` failed first (RED, pasted in session log):
connections section + guide strings (incl. "OAuth Playground", "gmail.modify"),
Configuration no longer hosting the cards, credential-save persisting + redirect
to `/settings#connections`, Gmail test-connection with fake credentials reporting
a helpful stored error, Gemini bad key stored + visible + surviving a restart on a
file-backed DB. After the fix: **16/16** in the file; full suite **322/322 tests
(25 files)**; `tsc --noEmit` clean; `npm run simulate` **316/316 checks across 26
scenarios — ALL GREEN**; responsive audit still 0 overflows. No restarts needed:
saved credentials/token/key go live immediately (hot-swap in serve.ts unchanged).
## OR-5 — Deterministic document-requirement generator — **RED**
## OR-6 — Course config: every subject × every system, extendable — **RED**
## OR-7 — Templates section — **RED**
## OR-8 — Assignment & visibility scoping — **RED**

(Functionality scan, route inventory and 1,000-case stress run pending — tracked in REPORT.md.)
