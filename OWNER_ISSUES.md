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

## OR-2 — Status/queue model follows the pipeline — **RED** (next)
## OR-3 — Responsive UI — **RED**
## OR-4 — Gmail/Gemini connections in Settings, guided, live status — **RED**
## OR-5 — Deterministic document-requirement generator — **RED**
## OR-6 — Course config: every subject × every system, extendable — **RED**
## OR-7 — Templates section — **RED**
## OR-8 — Assignment & visibility scoping — **RED**

(Functionality scan, route inventory and 1,000-case stress run pending — tracked in REPORT.md.)
