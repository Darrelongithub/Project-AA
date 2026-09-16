# BUG HUNT — email-sorter

Passes: repo.ts ×3, pipeline ×2, server.ts ×2, pages.ts ×2, views.ts ×2, db.ts ×2,
plus full reads of every other src file. 42 confirmed defects. Each gets: location,
what breaks, evidence, fix.

**STATUS: all 42 FIXED.** Verification: `tsc` clean · **150/150 vitest** (130 prior +
20 new regression tests in `test/bughunt.test.ts`, each failing against pre-fix code) ·
**232/232 simulation checks** · demo DB rebuilt and smoke-tested live (deadline input
now renders `2027-01-15`, open-redirect trap bounces to `/`, rule table deduped 10→5,
`Riara University` in outgoing-mail settings).

One finding (#27) was initially "fixed" and then REVERTED: the v3 test suite pins
"automated replies count as answered" as intended behavior — my judgment call lost
to the spec, as it should.

## Security / data-integrity (fix first)

1. **Cross-case document injection via portal filename** — `matching/identity.ts` signal-1 + `server.ts /portal/upload`. Uploads become synthetic emails with `subject: "Portal upload: <filename>"`; identity resolution trusts a ref quoted in the subject, so uploading `RU-2026-000099.pdf` attaches your document to someone else's case. Violates the core "never attach to the wrong applicant" guarantee.
2. **CRLF header injection in outgoing mail** — `gmailClient.sendReply` concatenates `Subject: ${subject}`; subjects are staff/template-editable. `\r\nBcc: …` injects headers; non-ASCII subjects produce invalid MIME (no RFC 2047).
3. **One malformed cookie 500s every request** — `auth.ts parseCookies` calls `decodeURIComponent` unguarded; a cookie like `sid=%zz` throws `URIError` inside middleware on every page. Any anonymous client can plant it.
4. **OTP generated with `Math.random()`** — `repo.createOtp`. Predictable PRNG for an authentication code.
5. **OTP wrong guesses never burn the code** — `repo.consumeOtp`. 10-minute window, unlimited attempts within the 6/min/IP limiter; multiple IPs bypass even that.
6. **`migrate()` swallows every ALTER error** — `db.ts`. A failed migration yields a DB missing columns that explodes later as `no such column`.
7. **Open redirect on `/theme`** — `server.ts`: `res.redirect(referer)` with only an `includes("/theme")` check.
8. **Staff login has no brute-force protection** — `/login` unlimited attempts (portal & status pages are limited; login isn't).
9. **CSV export formula injection** — `/export/*.csv`: cells starting `=`,`+`,`@` execute as formulas in Excel.
10. **`/settings/rules/add` accepts any `document_type`** — `docType as never`; a typo'd type stores a rule that silently never matches, while staff believe it's active.
11. **Requirement-rule upsert broken for NULL programme/intake** — SQLite treats NULLs as distinct in UNIQUE, so `ON CONFLICT(programme,intake,document_type)` never fires. **Verified live: the shipped demo DB contains 10 rows for 5 base rules (all duplicated).** Every `npm run ingest` run and every "All programmes" rule added in Settings doubles them.
12. **Corrupt `requirements_snapshot` silently falls back to live rules** — `repo.effectiveRequirements`: an applicant gets re-judged by rules changed after they applied, no log entry. Violates the versioning guarantee.

## Correctness

13. **"Today" dashboard counters reset at 03:00 local** — `todayStats()` uses `date('now')` (UTC); Nairobi is UTC+3.
14. **Follow-up ladder fires on wrong days** — docs/config say Day 3/7/10 from the notice; code adds each rung interval to the *previous reminder*: actual ladder Day 0/3/10/20. Verified by reading `runFollowUpSweep`.
15. **Live rules bypass the frozen snapshot in three places** — `server.ts /case/:id/action` (request_info), `/case/:id/send`, and `pages.ts publicStatusResult` all call `resolveRequirements()` instead of `effectiveRequirements()`. Applicants see a different checklist on /status than the case file shows.
16. **Settings intake-deadline date input is always empty** — `<input type="date">` receives full ISO `2027-01-15T23:59:59.000Z`; browsers reject non-`YYYY-MM-DD` values, so the field renders blank while a deadline exists — and saving "blank" silently deletes the deadline.
17. **`getOrCreateApplicant` check-then-insert race** — SELECT then INSERT, no transaction; two parallel first emails from one sender → second hits `UNIQUE(email_address, thread_id)` and the whole email fails.
18. **One poison email kills the whole ingest batch** — `ingestion/index.ts` has no try/catch around `processEmail`; in `ingest --watch` the process exits.
19. **Pipeline skip sentinel `applicantId: -1` crashes callers** — `simulation/run.ts` does `repo.getApplicant(last!.applicantId)!`; any fixture whose last email is already processed crashes instead of scoring.
20. **Total extraction failure logged as `method: "gemini_vision"`** — `extract.ts` fallback; the decision log (the scoring source of truth) lies about provenance.
21. **`extractPhone` matches inside longer digit runs** — no digit boundaries; a 12-digit ID containing a valid 9-digit subsequence silently becomes the applicant's phone.
22. **Draft handoff sends on any unknown `decision`** — only `discard`/`edit` are matched; everything else falls into the send branch.
23. **Dashboard "avg auto-response" comment says last-7-days, SQL has no date filter** — it's all-time.
24. **`searchApplicants` LIKE doesn't escape `%`/`_`** — typing `%` matches the whole table.
25. **`/settings/intake-deadline` 500s on garbage dates** — `new Date("garbageT23:59:59Z").toISOString()` throws.
26. **Assign route 500s on unknown staff id** — FK violation (foreign_keys=ON) → unhandled throw.
27. ~~**`unansweredCases` counts automated replies as "answered"**~~ — **REVERTED, not a bug.** `test/v3.test.ts` explicitly pins this: "auto docs_request counts as a reply → not unanswered". Kept the N+1 fix, restored the pinned semantics.
28. **16-bit PDF images fed to an 8-bit unfilter** — `pdfImages.ts` ignores `/BitsPerComponent 16`; garbage pixels → garbage OCR text flows into classification.
29. **`escalation_hours` changes need a restart** — `serve.ts` reads it once at boot.

## Robustness / operations

30. **No attachment size cap on the email path** — portal caps 10 MB; Gmail ingest caps nothing → pdfjs/sharp/Tesseract on 25 MB attachments.
31. **No timeout on Gemini calls** — one hung `generateContent` stalls the pipeline forever.
32. **OCR timeout doesn't cancel the worker** — `Promise.race` leaves `worker.recognize` running; next OCR queues behind it.
33. **No `busy_timeout`** — web server + any cron CLI (`retain`, `escalate`, `backup`) → instant `SQLITE_BUSY`.
34. **Backup isn't atomic** — checkpoint-then-`copyFileSync` can miss writes landing between the two; should use `db.backup()`.
35. **Retention archives are plaintext PII, world-readable** — full email bodies + ID numbers written to `./data/archive` with default permissions.
36. **Sessions never purged after boot** — only `seedDefaults` purges; long-running servers accumulate expired rows.
37. **Rate-limit maps never pruned** — `portalHits`/`statusHits` grow unbounded; also broken behind any reverse proxy (no `trust proxy`).
38. **Inline `require("../util/password")` inside two staff routes** — the same ESM-transform failure mode already hit in `/api/search` under vitest.

## Waste / dead weight

39. **`resolveApplicant` dead in production** — pipeline uses `resolveIdentity`; only `matching.test.ts` exercises the dead copy.
40. **`lifecycleIndex` + pipeline type re-exports** — zero importers.
41. **`GmailSender` defined three times** — `serve.ts`, `ingest.ts`, `followups.ts`.
42. **`npm run demo` writes a different DB than `npm run serve` reads** — demo defaulted to `./data/demo.sqlite`, `loadConfig()` to `./data/email-sorter.sqlite`; following the README served an empty console. (Found while verifying fixes.)

Plus cosmetic-but-lying: config brands outgoing mail "Rafiki University" while everything else is Riara; `extract.ts` header still says pdf-parse.
