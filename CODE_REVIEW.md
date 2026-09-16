# Code Review — email-sorter (hostile pass)

> **UPDATE:** a subsequent bug hunt confirmed 42 defects and fixed all of them —
> see `BUGS.md` for the itemized list and `test/bughunt.test.ts` for the
> regression tests. Findings below that overlap with BUGS.md are resolved;
> architectural notes (pipeline god-function split, retain encryption posture,
> proxy deployment hardening) remain as open guidance.

Scope: all 44 src files (~8.2k lines), CLI scripts, simulation harness, spot-check of tests.
Verdicts: **Keep as-is** · **Needs fixes** · **Rewrite** · **Delete**.
Nothing below is hedged. If a file is fine, it gets one line.

Seven issues are marked **CRITICAL** — they break stated product guarantees or are exploitable, and should be fixed before this touches real applicant data.

---

## src/config.ts — NEEDS FIXES

1. **L82, L86 — wrong institution name.** `institution_name: "Rafiki University"` and `from_name: "Rafiki University Admissions"`. Every UI surface was rebranded to Riara University; every seeded email template signs off with `{institution}`, so **every auto-reply goes out under the wrong university's name**. This is not cosmetic — it's a misrepresentation on official correspondence. Fix: `"Riara University"`. (Existing DBs keep the old value after seeding; also needs a one-time `UPDATE settings` for the demo DB.)

## src/db/db.ts — NEEDS FIXES

1. **L264–277 — `migrate()` swallows all migration errors.** The `catch {}` around `ALTER TABLE` is meant to ignore "column already exists", but it equally swallows lock errors, permission errors, and schema corruption. A failed migration produces a DB missing columns that then explodes later as `no such column: followup_rung` in some unrelated query. Fix: catch, test the message for `duplicate column name`, rethrow everything else.
2. **L255–261 — no `busy_timeout`.** WAL mode is set, but any concurrent access — the web server plus `npm run retain`, `escalate`, `followups`, or `backup` from cron — throws `SQLITE_BUSY` instantly instead of retrying. Fix: `db.pragma("busy_timeout = 5000")`. This is the reason several later findings (retain, backup) are races rather than theoreticals.

## src/db/repo.ts — NEEDS FIXES

The core is competent: parameterized SQL throughout, sensible indexes, clean transaction use in `syncFlags`. The problems:

1. **L58–80 — `getOrCreateApplicant` is a check-then-insert race.** SELECT, then INSERT, no transaction, no `ON CONFLICT`. Two parallel first emails from the same sender (portal upload racing an ingest poll; two emails in one poll interleaving across extraction awaits) both miss the row, both insert, one throws on `UNIQUE(email_address, thread_id)` and the whole email fails unprocessed. Fix: `INSERT ... ON CONFLICT DO NOTHING` then SELECT, inside a transaction.
2. **L197–201 — `updateApplicant` interpolates column names into SQL.** `keys.map(k => `${k} = ?`)` — safe today only because TypeScript constrains callers. It's one careless future caller (e.g. forwarding a settings payload) away from identifier injection. Fix: validate keys against an explicit allow-list array before building the statement.
3. **L215–222 — orphaned doc comment.** A full `/** Resolve the effective requirement set… */` block for `resolveRequirements` sits stranded above the `effectiveRequirements` comment, which has its own block. Dead documentation that now describes nothing. Delete the first block.
4. **L677–683 — `todayStats()` uses `date('now')`, which is UTC.** In Africa/Nairobi (UTC+3) the dashboard's "Today" counters reset at **03:00 local**, and midnight–3am activity counts as yesterday. Fix: compute local day boundaries in JS and pass as bind params.
5. **L690–705 — `queueView()` is N+1.** It calls `activeFlags(r.id)` per row (L702). The queue page and `/export/queue.csv` each fire a few hundred queries for a busy intake. Fix: one grouped `SELECT applicant_id, group_concat(...)` and a map. `unansweredCases()` (L923) has the same shape with per-applicant COUNTs.
6. **L770–800 — `dashboardStats()` comment/code mismatch.** Comment: "Avg time from email receipt → automated decision (minutes), **last 7 days**". SQL: no date filter — it's an **all-time** average, so the metric drifts toward historical noise and lies about current responsiveness. Either add `WHERE d.timestamp > datetime('now','-7 days')` or fix the comment. (`documents` stat also counts superseded docs; decide if that's intended.)
7. **L729–734 — `searchApplicants` doesn't escape LIKE wildcards.** User `%` and `_` are passed straight into `%${q}%`; typing `%` matches the whole table, `_` becomes a one-char wildcard. Not injectable (parameterized) but wrong search semantics, and this is the query behind the command palette. Fix: escape `%_\` with `ESCAPE '\'`.
8. **L467–499 — sessions are never purged on read.** Only `seedDefaults()` at startup purges. Long-running servers accumulate expired session rows forever. Purge opportunistically in `getSession` or on a timer.
9. **L228–234 — corrupt `requirements_snapshot` silently falls back to live rules.** That means an applicant can be re-judged by rules that changed after they applied — violating the explicit "old applicants never judged by new rules" guarantee — with no log entry. At minimum audit when the fallback fires.

## src/db/seed.ts — NEEDS FIXES

1. **L140–150 — weak default credentials on every fresh DB, live mode included.** `admin/admin123` etc. are seeded unconditionally, and `serve.ts` prints them. In mock/demo that's the point; with `MODE=live` against a real inbox it's a wide-open door if the operator doesn't rotate immediately. Fix: in live mode generate a random admin password and print it once, or refuse first boot until staff exists.

## src/pipeline/index.ts — NEEDS FIXES

Correct against its 232-check simulation, but structurally strained:

1. **L59–65 — sentinel `applicantId: -1` on the skip path.** Any caller that forgets to check `skipped` does `repo.getApplicant(-1)!` and crashes. `simulation/run.ts` L119 is exactly such a caller (`repo.getApplicant(last!.applicantId)!`) — a fixture whose last email is a duplicate dies with a useless crash instead of a scored failure. Fix: a discriminated union (`{ skipped: true } | { skipped?: false, … }`) so the compiler enforces the check.
2. **Concurrency: nothing serializes per applicant.** `processEmail` awaits extraction/vision/watcher between identity checks and inserts; better-sqlite3's per-statement sync doesn't help across awaits. Two parallel emails for a new sender both pass `findByEmailAny` and hit the repo.ts #1 race. Fix: an in-process per-sender mutex, or make the repo layer idempotent (see repo #1).
3. **L300–332 — status answers auto-send while the case is simultaneously queued for human** (`queueForHuman = true` at L314, auto-send proceeds). The applicant gets an automatic reply and staff see the same case on the queue. That interplay is never audited as a decision. Decide explicitly: if `queueForHuman`, either suppress the auto-send or log why both are correct.
4. **Architecture: one 480-line function doing 11 jobs** (identity, reopen, freeze, extraction, rules, watcher, gate, drafting, follow-ups, SLA, lifecycle). It passes simulation only because the simulation black-boxes the whole thing; no stage is individually testable outside fixtures. Split into named steps over an explicit context object. This is the one file I'd schedule a rewrite of — not because it's wrong, because nothing in it can be fixed locally without retesting everything.
5. **L136/187/229/231/471/486/516 — seven `getApplicant(id)!` re-fetches.** Every `!` asserts "cannot be gone"; a concurrent retention sweep deleting the row mid-pipeline makes all seven crash sites. Minor, but it's the same fix as the mutex.
6. **L534–536 — `lifecycleIndex` is exported and used nowhere.** Dead code. The tail `export type { ApplicantRow }`/`DocType` re-exports are likewise unused by any importer. Delete.

## src/pipeline/adapters.ts — KEEP, one fix

1. **L44 — the Gemini watcher is constructed per call** (`(input) => new GeminiWatcher(...).watch(input)`): re-`require`s the SDK and re-instantiates the model on every single email. Construct once alongside `vision`.

## src/rules/index.ts — KEEP AS-IS

Pure, deterministic, zero dependencies as required. One observation, not a defect: with `examYear` absent the anomaly check skips silently; "suspiciously incomplete" is only partially covered via `low_confidence`. Given the hard rule that anything borderline goes to a human anyway, acceptable.

## src/gate/index.ts — KEEP AS-IS

Precedence is explicit and matches spec. Fine.

## src/matching/index.ts — PARTIAL DELETE

1. **`resolveApplicant` is dead in production.** The pipeline imports `resolveIdentity` from `matching/identity`; `resolveApplicant` survives only inside `test/matching.test.ts`. Two identity resolvers is a trap — a fix lands in one and behavior diverges. Delete it and port those tests to `resolveIdentity`, which is the code that actually runs.

## src/matching/identity.ts — NEEDS FIXES

1. **L26/L36–44 — the quoted-ref signal outranks everything, including on synthetic channels.** `resolveIdentity` trusts a ref found in subject/body unconditionally (flagging a concern when the sender differs, but still attaching). Combine with `server.ts` `/portal/upload`, which builds a synthetic email with `subject: "Portal upload: <filename>"`: **an applicant who uploads a file named `RU-2026-000099.pdf` (someone else's ref) moves their document into that person's case.** That directly violates the "never silently attach documents to the wrong applicant" guarantee — a concern flag is raised, but the attachment and thread link already happened. Fix: skip ref-matching when `email.channel === "portal"` (the session already proves who owns the case).
2. `REF_RE` matches any 2-letter prefix regardless of the configured `ref_prefix`. Harmless today (lookup is in-DB) but it means a misconfigured prefix never fails loudly.

## src/categorize/index.ts — KEEP AS-IS

Ordered regexes, deterministic, tested. Fine.

## src/enrich/index.ts — NEEDS FIXES

1. **L7+ — `extractPhone` has no digit boundaries.** After stripping separators, `(?:\+?254|0)(7\d{8}|1\d{8})` matches *inside* longer digit runs — a 12-digit ID number containing a valid 9-digit subsequence silently becomes the applicant's phone, which then feeds identity search. Fix: assert no adjacent digits around the match.

## src/extraction/extract.ts — NEEDS FIXES

1. **Header comment still says "pdf-parse"** — stale; the chain is pdfjs-dist. Two-line fix, but provenance comments are what the next maintainer trusts.
2. **The total-failure fallback labels documents `method: "gemini_vision"` even when vision returned null** (mock mode). The decision log — which exists specifically so behavior can be scored — records a method that never ran. Fix: `method: "none"`.
3. **No attachment size cap on the email path.** The portal caps uploads at 10 MB; Gmail ingest caps nothing. A mail with several 25 MB attachments is base64-buffered, then handed to pdfjs/sharp/Tesseract in-process. That's a memory spike and an availability problem on any busy inbox. Fix: cap per-attachment and per-email in `extractAttachment`.

## src/extraction/gemini.ts — NEEDS FIXES

1. **No timeout on `generateContent`.** A hung Gemini request stalls the pipeline indefinitely — one slow call and inbox polling stops processing. Fix: race with a timeout and fail closed (return null → OCR/lower tier handles it).
2. **Constructor `require("@google/generative-ai")` throws synchronously** if the SDK isn't installed. That only fires in live mode, but a missing optional dependency should fail closed to mock-with-flag, not crash the process at boot.
3. **`MockVisionAdapter` returns an `{unknown…}` object instead of `null`** for attachments without sidecar data — the comment says "treated as unreadable", the code says readable, and downstream labels it `gemini_vision` (see extract.ts #2).

## src/extraction/ocr.ts — NEEDS FIXES

1. **The `Promise.race` timeout doesn't cancel `worker.recognize`.** After a timeout the OCR keeps grinding inside the worker, the next OCR call queues behind it, and under sustained load every subsequent timeout is also late. Fix: terminate the worker on timeout (or track the pending job and discard its result).

## src/extraction/quality.ts — KEEP AS-IS

## src/extraction/pdfText.ts — KEEP AS-IS (catch→null, 25-page cap; fine)

## src/extraction/classify.ts — KEEP AS-IS

## src/extraction/fields.ts — KEEP AS-IS

## src/extraction/png.ts — KEEP AS-IS

Test-harness codec + unfilter for scanned-PDF images. Correct for 8-bit, which is what it's used for (see next file).

## src/extraction/pdfImages.ts — NEEDS FIXES

1. **`/BitsPerComponent 16` is unhandled.** `unfilterPNG` assumes 8-bit; a 16-bit scan inflates to garbage pixels, which OCR turns into garbage text that then flows through classification and field extraction as if it were real. Best-effort module, failures fall through to Gemini — but check `BitsPerComponent` and skip anything but 8.
2. The stream-boundary heuristics (`indexOf("stream")`, `lastIndexOf(" obj")`) can bind to the wrong object on pathological PDFs; the `dictStart/endobj` sanity guard makes the blast radius "skip the image", which is acceptable. Noted, not blocked on.

## src/watcher/index.ts — KEEP AS-IS, two notes

1. Fail-closed on Gemini error is exactly right.
2. The heuristic duplicate-content check compares a 400-char normalized prefix — two different documents with shared letterhead boilerplate can trigger it. Fails toward human review, so safe; expect false positives in production.

## src/drafting/index.ts — KEEP AS-IS

Template rendering, ref-prefixing, INTERNAL marking all clean.

## src/followups/index.ts — NEEDS FIXES

1. **The ladder intervals stack; the docs say they're absolute.** Header comment (and `cli/followups.ts`, and the settings description) promises Day 3 / Day 7 / Day 10 from the initial notice. The code computes `nextAt = now + ladder[rung] days` **from the previous reminder**, so the real ladder is Day 0, 3, **10, 20**. Staff configuring `"3,7,10"` get behavior they didn't ask for, silently. Fix: schedule each rung relative to the original missing-docs timestamp, or rewrite every doc string to say "intervals".

## src/logs/index.ts — KEEP AS-IS

## src/ingestion/index.ts — NEEDS FIXES

1. **No try/catch around `processEmail` in the loop.** One poison email (UNIQUE race from repo.ts #1, an OOM-inducing PDF) rejects the whole function; the remainder of the batch waits for the next poll. In `npm run ingest --watch` the process exits (`main().catch`) and polling stops entirely. Fix: per-email try/catch, log, continue.

## src/ingestion/gmailClient.ts — NEEDS FIXES

1. **`sendReply` builds raw MIME by string concatenation — CRLF header injection.** `Subject: ${subject}` where the subject is staff-editable (templates in Settings, held-draft subjects on the case page). A subject containing `\r\nBcc: …` injects arbitrary headers. Also no RFC 2047 encoding, so any non-ASCII subject (which templates can contain) produces invalid headers. Fix: strip/reject CR and LF from `to` and `subject`; encode the subject.
2. **`listRecentMessageIds` caps at 50, newest-first.** A burst >50 messages starves the oldest mail across many passes. Paginate or process oldest-first.
3. No size guard on fetched attachments — feeds extract.ts #3.

## src/web/auth.ts — NEEDS FIXES

1. **`parseCookies` calls `decodeURIComponent` unguarded.** A malformed cookie (`sid=%zz`) throws `URIError` inside `authMiddleware` — which runs on **every request** — so that client gets 500 on every page, and any anonymous client can manufacture the cookie. Fix: try/catch per value, treat failures as absent.
2. **Staff login has no rate limiting or lockout**, while the portal and the public status page both have per-IP limiters. Unlimited brute force against scrypt at `/login`. Fix: the same hits-map pattern already used elsewhere in server.ts.

## src/web/server.ts — NEEDS FIXES

The largest concentration of real problems:

1. **CRITICAL — `/portal/upload` allows cross-case document injection via filename.** Covered under matching/identity.ts #1; the fix can live in either place, but this route is the exploit surface.
2. **CRITICAL — `/theme` is an open redirect.** `res.redirect(back)` where `back` is the raw Referer; the only guard is `back.includes("/theme")`. Referer: `https://evil.com/x` → staff gets bounced to evil.com. Fix: only redirect to paths starting with `/` on this host.
3. **L~187 — draft handoff: any unknown `decision` value sends the email.** Only `discard` and `edit` are matched; everything else falls into the send branch. Validate `decision === "send"` explicitly.
4. **`/case/:id/action` ("request info") and `/case/:id/send` use live `resolveRequirements` instead of `effectiveRequirements(a)`.** Staff-initiated requests are computed against rules that may have changed after the case's snapshot was frozen — contradicting the versioning guarantee enforced everywhere else (portal home, follow-ups, pipeline). Also both call `sender.send` with no try/catch → 500 on SMTP failure.
5. **L388/L406 — inline `require("../util/password")` inside route handlers.** Same latent failure mode as the `/api/search` bug already hit under vitest (ESM transform → 500), just untested because the staff routes have thinner test coverage. Move to top-level imports.
6. **`/export/audit.csv` runs raw SQL in server.ts** — violates the stated "all SQL lives in repo.ts" convention. Move to a repo method.
7. **CSV exports have no formula-injection guard.** `full_name`, notes, flag details can start with `=`/`+`/`@` and execute as formulas when staff open the export in Excel. Prefix such cells with `'`.
8. **Rate limiters assume direct connections.** No `trust proxy` is set, so behind any reverse proxy (including this preview environment) every client shares one IP and the portal/status limits become global caps — 6/min for *all* users. Without a proxy they're trivially bypassable. Configure deliberately and document.
9. **`portalHits`/`statusHits` maps are never pruned** — entries only filter on access by the same IP. Slow unbounded memory growth per distinct IP over process lifetime.

## src/cli/serve.ts — NEEDS FIXES

1. **`escalationHours` is read once at startup** — changing `escalation_hours` in Settings does nothing until restart. Read it inside the interval.
2. **`GmailSender` is defined here, in `cli/ingest.ts`, and again (as an object literal) in `cli/followups.ts`.** Three copies of the same adapter. Move to `pipeline/adapters.ts`.
3. Prints `admin/admin123` at boot — fine for demo, wrong for live (see seed.ts #1).
4. Follow-up/escalation sweeps and ingest polling are wired with bare `setInterval` and overlapping runs aren't guarded — a slow ingest (>60s) overlaps the next poll. Add an in-flight flag.

## src/cli/ingest.ts — NEEDS FIXES

`--watch` mode dies on the first thrown error (`main().catch` → exit). With no per-email isolation (ingestion/index.ts #1), one bad email kills the watcher silently. Fix both.

## src/cli/backup.ts — NEEDS FIXES

1. **Checkpoint-then-`copyFileSync` is not atomic against a live writer.** Writes landing between the checkpoint and the copy are absent from the backup while the file is otherwise consistent-ish; worse, copying while WAL is active can capture a torn state if the checkpoint itself is interrupted. Use `db.backup()` (or `VACUUM INTO`).
2. Backup files are full PII in plaintext — noted, not blocking, but retention policy should apply to `./backups` too.

## src/cli/restore.ts — KEEP, one warning

Restoring over a database a live server has open can corrupt both files. The command prints "restart the server", but should actively check/refuse (e.g. fail if the WAL sidecar is being written).

## src/cli/retain.ts — NEEDS FIXES

1. **The "archive" moves PII, it doesn't reduce it.** The JSON dump contains full email bodies, extracted ID numbers, decision logs — written **unencrypted** to `./data/archive/`. If retention exists because of student personal information, plaintext JSON archives on disk are arguably worse than the DB (no auth, no retention-of-retention, no encryption). Encrypt, or at minimum document the security posture explicitly.
2. Runs against the DB with no `busy_timeout` (db.ts #2) while the server may be live → `SQLITE_BUSY` mid-archive.
3. `deleteApplicantFull` per applicant, outside a transaction — a crash between archive-write and delete is recoverable (re-run), but wrap the loop body in a transaction anyway.

## src/cli/{queue,escalate,simulate,demo,followups}.ts — KEEP AS-IS

Demo hardcodes a January 2027 deadline — fine, it's demo.

## src/simulation/run.ts — NEEDS FIXES

1. **L119 — `repo.getApplicant(last!.applicantId)!`** crashes on the pipeline's `-1` skip sentinel instead of producing a scored failure. Guard or restructure alongside the pipeline fix.

`fixtures.ts` / `pdfFactory.ts` — test infrastructure, fine.

## src/web/{views,pages,portal}.ts — KEEP AS-IS

String-template SSR with consistent `esc()` on all interpolated values (verified), self-contained CSS/JS per the zero-external-assets decision, splash/palette/toast logic sound. `portal.ts` showing the OTP on screen is gated by the `portal_otp_delivery` setting and is the demo default by design. No defects found; no changes warranted.

## src/types.ts — KEEP AS-IS

Pure type definitions + lifecycle constants.

## test/ — note, no verdict

130 tests, meaningful assertions. One structural problem already named: `matching.test.ts` exercises `resolveApplicant`, which production never calls (matching/index.ts #1). The rest is solid.

---

## Priority order

**Fix before real data (CRITICAL):**
1. Portal-upload filename → cross-case document attachment (`identity.ts` #1 / `server.ts` #1) — violates a core product guarantee.
2. CRLF header injection in `gmailClient.sendReply`.
3. `parseCookies` URIError → 500-on-every-request.
4. `getOrCreateApplicant` race + ingestion poison-email-kills-batch (repo #1 + ingestion #1 + ingest.ts).
5. `/theme` open redirect.
6. `admin/admin123` seeded unconditionally in live mode.
7. `migrate()` swallowing all errors.

**High:** follow-up ladder stacked vs documented days; `todayStats()` UTC reset at 03:00 local; live-rules bypass of frozen snapshots in `/case/:id/action` + `/case/:id/send`; no timeout on Gemini calls; OCR timeout that doesn't cancel; `-1` sentinel crash path; no email-attachment size cap; no login rate limiting; "Rafiki University" in outgoing mail.

**Medium:** N+1 in `queueView`/`unansweredCases`; sessions never purged; dashboardStats 7-day comment vs all-time SQL; LIKE wildcard escaping; retention archives in plaintext; backup atomicity; proxy-aware rate limiting + unpruned hit maps; `extractPhone` digit boundaries; `method: "gemini_vision"` mislabel; dead `resolveApplicant`; triple-duplicated `GmailSender`; inline `require()` in staff routes; `updateApplicant` column allow-list; status-answer-while-queued interplay.

**Low:** orphaned repo.ts comment; stale pdf-parse header; per-call GeminiWatcher construction; watcher boilerplate false positives; dead `lifecycleIndex` export.

**Deletions:** `resolveApplicant` (after porting its tests), `lifecycleIndex`, unused pipeline type re-exports, orphaned doc block in repo.ts.
