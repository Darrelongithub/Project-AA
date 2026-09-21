# Hostile Code Audit — Round Report

**Date:** 2026-09-21 · **Scope:** full `src/` tree (66 files, 18,251 LOC) + CLIs + web routing + pipeline + adapters, audited against the mission-brief vectors A–E.
**Baseline established first:** `tsc` clean · vitest 426 passed | 1 skipped (35 files) · simulate 316/316 · stress 1000/1000.

---

## 1. Executive Summary

| Severity | Found | Fixed | Test-pinned |
|---|---|---|---|
| Critical | 0 | — | — |
| High | 2 | 2 | 3 tests |
| Medium | 1 | 1 | 1 test |
| Low | 1 | 1 | 2 tests |
| **Total** | **4** | **4** | **6** |

Every other brief vector (A.1–A.6, B, C.1–C.4, D.1–D.6, E.1–E.2) re-verified against the live
code and found already guarded — see section 3 for the by-vector verdict sheet.

Zero-silent-failure invariant held: the two High findings were the only places an external
stall or a duplicate delivery could pass unrecorded.

---

## 2. Itemized Fix Log

### HIGH-1 — Gemini watcher could silently live-lock the pipeline
- **Location:** `src/watcher/index.ts` `GeminiWatcher.watch()` (was L94)
- **Bug:** `await this.model.generateContent(...)` had **no timeout**. The fail-closed
  `catch` only fires on *rejection*; a hung HTTP socket neither resolves nor rejects, so the
  pipeline awaited forever — the entire ingest loop stalls with no log line, no flag.
- **Invariant violated:** Zero silent failures.
- **Fix:** hard `Promise.race` timeout (45 s default, `timer.unref()` so it never keeps the
  process alive); timeout rejects → existing fail-closed path flags it for human review.
  Constructor accepts an injectable model + timeout for tests; extraction tier kept its own
  pre-existing timeout (verified, not duplicated).
- **Test:** `test/audit-hardening.test.ts` → "a hung model times out and fails closed"
  (never-resolving model resolves in ~50 ms with `flagged: true`, concerns match /timed out/).
  **RED observed:** no timeout semantics existed — result was a generic connection error, never "timed out".

### HIGH-2 — processed-emails claimed at the END → concurrent runs double-processed
- **Location:** `src/pipeline/index.ts` (was: check L63, mark L713)
- **Bug:** `isProcessed()` was checked at the start but `markProcessed()` only ran at the end.
  Two concurrent runs (cron + `--watch`, two processes, or any parallel call sites) both passed
  the gate and processed the same message: **duplicate inbound records, duplicate drafts,
  duplicate replies to the applicant.** Reproduced by RED test: logs showed the same email
  extracted and drafted twice in one `Promise.all`.
- **Invariant violated:** Deterministic single delivery / zero silent failures.
- **Fix:** `repo.claimProcessed(emailId, threadId)` — atomic `INSERT OR IGNORE` inside the PK
  row at the START; claim-loser returns the typed skip result. `processEmail` is now a thin
  claim + `try/catch` wrapper: any exception releases the claim (`unmarkProcessed`) so the
  dead-letter retry machinery still works; body moved to `processEmailInner` unchanged.
- **Tests:** "two concurrent runs … process it EXACTLY ONCE" (was: 2 processed, 2 inbound rows)
  and "a mid-pipeline crash releases the claim" (sabotaged `insertEmail` → claim released).
  **RED observed:** `expected 2 to be 1`, plus duplicate pipeline log lines.

### MEDIUM-3 — `applicantId: -1` skip sentinel
- **Location:** `src/pipeline/index.ts` skip return; consumers `src/simulation/run.ts:143`
  (`getApplicant(...)!`), `src/cli/stress.ts:263`.
- **Bug:** a skipped result carried a fake applicant id. One unchecked use of it was a FK
  constraint or a phantom write away (exactly the defect class the brief calls out).
- **Invariant violated:** clean code / type safety; no wrong-applicant guarantee.
- **Fix:** `ProcessResult` is now a discriminated union —
  `{ skipped?: false; applicantId: number } | { skipped: true; applicantId: null }` —
  so the type system *forbids* reading an applicant id from a skipped run. All consumers
  narrowed honestly (`test/harness.ts → mustProcessed()` for tests; `simulation/run.ts`
  lost its `!` assertion and now records a scored failure instead of crashing).
- **Test:** "a skipped result carries NO applicant handle" (`applicantId` is `null`).
  **RED observed:** value was `-1`.

### LOW-4 — `POST /logout` had no CSRF
- **Location:** `src/web/server.ts` (was L289), nav form in `src/web/views.ts`.
- **Bug:** any cross-site pixel/form could sign staff out (forced-logout CSRF).
- **Invariant violated:** CSRF coverage on all mutating routes.
- **Fix:** nav form carries the session `_csrf`; route runs `csrfCheck`.
- **Tests:** forged POST → 403 and session survives; real POST → 302 then bounced to login;
  nav form contains `name="_csrf"`. **RED observed:** forged POST 302'd and destroyed the session.

---

## 3. By-vector verdict sheet (already guarded — verified, not assumed)

| Vector | Verdict |
|---|---|
| A.1 check-then-insert races | `getOrCreateApplicant` = txn + `INSERT OR IGNORE`; HIGH-2 above closed the last one |
| A.2 WAL / busy_timeout | `journal_mode=WAL`, `busy_timeout=5000` (`db.ts:357–362`) |
| A.3 migrations | rethrows everything except literal "duplicate column name"; PRAGMA-guarded ALTERs |
| A.4 dynamic UPDATE keys | `updateApplicant` hard allow-list, throws on unknown column (`repo.ts:184`) |
| A.5 N+1 | `unansweredCases`/`queueView`/exports/mail counts all aggregate-batched |
| A.6 backups | `db.backup()` via better-sqlite3 API — no file copies mid-WAL |
| B.1 poison pills | per-email try/catch + dead-letter table with attempts, park + notify on third failure |
| B.2 timeouts | Tesseract worker terminated on timeout; Gemini vision tier `withTimeout` + circuit breaker; HIGH-1 closed the watcher gap |
| B.3 provenance | every tier records its real method (`pdf_text`/`ocr`/`pdf_raster`/`gemini_vision`/`none`) |
| B.4 sentinels | MEDIUM-3 |
| B.5 attachment caps | `MAX_EMAIL_BYTES`/`MAX_ATTACHMENT_BYTES` enforced pre-buffer, oversized mail parked dead-letter |
| C.1 matrix compliance / KCPE exemption | frozen matrix tests green (316/316 simulate) |
| C.2 frozen snapshots | `effectiveRequirements()` for every render/draft path |
| C.3 follow-up math | absolute `base + ladder[n]` days (`followups/index.ts`) |
| C.4 synthetic channels | portal machinery deleted in a prior round; identity signals audit-logged |
| D.1 cookie parsing | `sid=%zz` guarded (`auth.ts:34–42`) |
| D.2 rate limit | failure-only limiter, per-call prune + 5000-entry cap; `trust proxy` env-gated |
| D.3 MIME injection | `sanitizeHeaders` strips CR/LF, RFC 2047 encodes non-ASCII subjects |
| D.4 redirects/CSRF | referer-redirect origin-checked; `back` params path-gated; 60 POST routes scanned — all covered except by-design `/login` (own double-submit token), `/setup` (one-time token), `/theme` (cosmetic cookie); `/logout` closed this round |
| D.5 scope probing | `/case/:id*` middleware: identical 403 for missing & out-of-scope; exports/search/lists realm+school filtered |
| D.6 CSV injection | `=+-@\t` prefixed cells get a leading apostrophe |
| E.1 overlapping sweeps | CLIs are one-shot; serve loop uses `onceAtATime`; ingest `--watch` is a sequential await loop |
| E.2 retention | archives written `0o600`; deletion sweeps bounded |

---

## 4. Verification Evidence (two consecutive passes)

- `tsc --noEmit` — clean (strict + noUnusedLocals/Parameters)
- Vitest — **432 passed | 1 skipped (36 files)** = 426 baseline + 6 new audit tests
- `npm run simulate` (OCR on, in-memory DB) — **316/316, 26 scenarios**
- `npm run stress` — **1000/1000 cases clean** (deterministic seed)

## 5. Architectural Recommendations

1. **Keep the claim-first shape for any future async-side-channel the pipeline grows**
   (webhooks, manual re-import): never gate on read — always claim atomically first.
2. **Fold the two ad-hoc `withTimeout` copies** (vision tier, watcher) into one shared
   util when a third external call site appears.
3. Rotating unmark: the dead-letter retry endpoint already uses `unmarkProcessed` — keep
   it the *only* way a claim is released manually, with its existing audit trail.
4. Theme POST is the one intentionally-CSRF-less mutation (cookie-only, no server state);
   revisit if the theme ever gets persisted per-user server-side.
5. The union pattern should be applied to any future "no entity attached" result type
   (`refNumber` already requires no sentinel thanks to `refNumber?: string`).
