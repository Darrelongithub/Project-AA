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


---

# Round 2 — fresh hostile pass (2026-09-21)

Round 2 re-hunted under the same rules: only NEW defects, no re-audit of guards pinned in round 1 (see the A.1–E.2 verdict sheet). Recon confirmed the already-guarded vectors: `runEscalationSweep` is fully synchronous on better-sqlite3 (single event-loop turn — no interleave possible), ref-numbering uses a transaction + `INSERT OR IGNORE` per (prefix, year) with correct rollover, `/templates/save` enforces non-empty name/subject/body plus unknown-placeholder warnings, `/staff/scopes` allow-lists against `listSchools()`. Two new defects survived the hunt.

## R2-1 — HIGH: held-draft approval race sends the same applicant reply twice

- **Vector** — web draft route `POST /case/:id/draft` (decision `send`, `src/web/server.ts`). The handler read the queued draft, then **awaited** `sender.send(...)` — a genuine event-loop yield — and only *afterward* recorded the sent email and deleted the draft row. Two staff approving the same held draft inside that window both read the still-queued row → **the applicant received the same reply twice** (plus duplicate `human_override` audits and duplicate `emails` rows). Held drafts are exactly the high-stakes replies, and a slow SMTP transport widens the window to tens/hundreds of ms.
- **Why round 1 missed it**: an instant MockSender keeps the handler's synchronous segment atomic; the interleave only appears when the send actually yields to the I/O phase.
- **RED evidence** — `test/audit2-hardening.test.ts` T1: SlowSender (80 ms defer), two concurrent approvals of one held draft → `expected 2 to be 1` (both sent).
- **Fix** — optimistic send claim. New migration `outbox.claimed_at TEXT`; `repo.claimOutboxDraft(id, nowIso)` = one `UPDATE … WHERE id=? AND (claimed_at IS NULL OR claimed_at < now-10min)` → `changes>0`. The handler must win the claim *before* the awaited send; the loser is redirected with an explicit "already being sent" message. A failed send releases the claim so the officer may retry; the 10-minute staleness horizon salvages drafts stranded by a process crash mid-send; successful sends delete the row anyway. Discard keeps its existing semantics (deterministic; a discard racing an in-flight send still cannot resurrect a sent draft).
- **GREEN evidence** — T1 now: exactly 1 send, exactly 1 recorded `out` email, exactly 1 `human_override` audit across the two concurrent approvals.
- **Circularity check** — the claim is a state transition on the very row the test races; no method-patching can satisfy it. Simulation determinism unchanged.

## R2-2 — MEDIUM: follow-up ladder TOCTOU across sweep processes

- **Vector** — `runFollowUpSweep` (`src/followups/index.ts`) reads `dueFollowUps()` and then, per case, drafts the reminder and advances the rung. The daemon runs the sweep every 2 min **unguarded** (`src/cli/serve.ts`, unlike the `guardedSync` inbox job) and `npm run followups` can additionally run from cron as a second Process. Two sweepers reading the same due-list both drafted → **duplicate reminder held + rung jumping two rungs per pass** (which later means an applicant misses a scheduled reminder). Same-process double-invocation is provably safe — the sweep body has no awaits, so one invocation never interleaves with itself — the real hazard is cross-process overlap.
- **RED evidence** — T2a: `claimFollowupRung is not a function`; T2b: two Repo connections on one file-backed SQLite, the second holding a monkey-patched stale due-list snapshot → `expected 1 to be +0` (duplicate reminder drafted; rung double-advanced).
- **Fix** — optimistic rung claim. `repo.claimFollowupRung(id, expectedRung, nextRung, nextAt)` = `UPDATE applicants SET followup_rung=?, followup_next_at=? WHERE id=? AND followup_rung=? AND lifecycle IN ('application_received','documents_received')` → `changes>0`. The sweep claims the rung **before any visible side effect** (draft, notification, audit); the loser logs `warn` and skips. The ladder-exhausted → human-escalation branch uses the same claim, so only one sweeper can escalate. Accepted trade-off (documented): a crash between claim and draft advances the rung without a reminder — loud, deterministic, never duplicated.
- **GREEN evidence** — T2a: a stale rung cannot be claimed twice. T2b: the stale sweep drafts nothing, the rung advances exactly once, exactly one `followup_held_qualification` audit. The `followup_stopped` (file became complete) branch is intentionally untouched — it is idempotent.

### Round-2 gates — run twice, all clean

| Gate | Run 1 | Run 2 |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| `vitest run` (`DISABLE_OCR=1`) | 435 passed / 1 skipped (37 files) | 435 passed / 1 skipped (37 files) |
| `npm run simulate` | 316/316 checks, 26 scenarios, determinism 13/13 | 316/316, determinism 13/13 |
| `npm run stress` | 1000/1000 | 1000/1000 |

### Invariant review (round 2)

All 7 non-negotiables hold: deterministic evaluation untouched (claims are ordering gates, not evaluation inputs); Green = complete blocking matrix + rule tree + 0 blocking flags unchanged; never auto-reject preserved (reminders are still held drafts; exhaustion escalates to humans, never rejects); frozen snapshots untouched; strict scoping untouched; no silent failures added (lost claims log `warn`; the losing officer sees an explicit message); zero mock contamination (RED used two real connections over a file-backed DB; all fixes live in repo/route/sweep code, none in fixtures).
