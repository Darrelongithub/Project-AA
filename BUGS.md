# BUGS — consolidated defect index (all audit/review rounds)

**This is the single consolidated bug table.** Every defect, regression,
false positive, and piece of open hardening guidance from the historical
audit/review documents is indexed here exactly once, verified against the
current code on 2026-09-28, and marked fixed / not-a-bug / accepted /
open. The historical documents (`AUDIT.md`, `BUGLOG.md`, `CODE_REVIEW.md`,
`MIGRATION.md`, `OWNER_ISSUES.md`, `PPR-REPORT.md`, `REPORT.md`,
`STAB-ROUND-REPORT.md`) are kept untouched as the audit trail — this file
is the index, they are the evidence. Nothing was deleted: the 42 defects
from the original bughunt `BUGS.md` are rows BH-01…BH-42 below.

## Verification methodology (2026-09-28)

- **FIXED** = the fix commit is an ancestor of HEAD, the named regression
  test file exists in `test/`, and the full suite is green:
  `npm run typecheck` clean + `npx vitest run` **80 files · 667 passed +
  3 environment-gated skips · 0 failed** + `npm run simulate` 316/316 +
  `npm run stress` 1000/1000. All 40 named regression suites referenced
  below were confirmed present.
- **Spot-verified** = additionally confirmed by reading the current code
  (file:line or construct named in the row).
- **NOT A BUG** = investigated and ruled out (false positive / already
  absent / intended behavior pinned by a test).
- **ACCEPTED** = known residual risk, consciously left (with rationale).
- **OPEN** = genuine outstanding guidance, not yet done.

## Legend

- ID prefixes: **BH** = first bughunt (original BUGS.md #1–42) ·
  **BL** = BUGLOG round items (§section-item) · **CR** = CODE_REVIEW-unique ·
  **AU** = AUDIT.md recommendations · **ST** = STAB round + hardening passes ·
  **PP** = PPR round · **OR** = OWNER_ISSUES/REPORT extras · **FP** = false positives.
- Severity: crit / high / med / low (taken from the source doc where given).

## Table A — First bug hunt (original BUGS.md #1–42)

| ID | Title | Description | Repro / pin | Status | Sev | Source |
|----|-------|-------------|-------------|--------|-----|--------|
| BH-01 | Cross-case document injection via portal filename | Uploading a file named `RU-2026-000099.pdf` attached it to someone else's case (ref signal trusted on synthetic portal channel). Fix: skip ref-matching for portal channel. | Upload victim-ref filename via portal; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #1, CODE_REVIEW.md, BUGLOG §1 |
| BH-02 | CRLF header injection + non-ASCII subjects in outgoing mail | `sendReply` built raw MIME by string concat; staff-editable subject could inject headers; no RFC 2047 encoding. Fix: strip CR/LF, encode subject. | Subject with `\r\nBcc:`; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #2, CODE_REVIEW.md, BUGLOG §1 |
| BH-03 | Malformed cookie 500s every request | `parseCookies` unguarded `decodeURIComponent` (`sid=%zz` → URIError in auth middleware on every request). Fix: per-value try/catch. | `sid=%zz` cookie; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #3, CODE_REVIEW.md, BUGLOG §1 |
| BH-04 | OTP generated with Math.random() | Predictable one-time codes. Fix: crypto RNG. (Portal OTP surface later removed entirely.) | Read `otp.ts`; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #4, BUGLOG §1 |
| BH-05 | OTP wrong guesses never burned the code | Unlimited attempts inside the window. Fix: burn on wrong guess. | Guess wrong N times, code still valid; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #5, BUGLOG §1 |
| BH-06 | migrate() swallowed every ALTER error | `catch {}` hid lock/permission/corruption errors → later `no such column` explosions. Fix: rethrow unless `duplicate column name` (spot-verified: `src/db/db.ts` rethrow). | Corrupt schema migrate; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #6, CODE_REVIEW.md, BUGLOG §1 |
| BH-07 | Open redirect on /theme via Referer | `res.redirect(back)` with raw Referer guarded only by `includes("/theme")`. Fix: same-origin path-only redirect. | `Referer: https://evil.com/x/theme`; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #7, CODE_REVIEW.md, BUGLOG §1 |
| BH-08 | Staff login had no brute-force protection | Unlimited scrypt attempts at /login. Fix: per-IP throttle (now `src/web/throttle.ts`: time-expiry + oldest-eviction, spot-verified). | Rapid POST /login; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #8, CODE_REVIEW.md, BUGLOG §1 |
| BH-09 | CSV export formula injection | `=`/`+`/`@` cells execute in Excel. Fix: leading-apostrophe guard + quote doubling. | Full name `=1+1`; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #9, CODE_REVIEW.md, BUGLOG §1 |
| BH-10 | /settings/rules/add accepted any document_type | `docType as never`; typo'd rule silently never matched. Fix: validate against known types. | Add rule with typo'd type; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #10, BUGLOG §1 |
| BH-11 | Requirement-rule upsert duplicated every base rule | SQLite NULLs distinct in UNIQUE → ON CONFLICT never fired; shipped demo DB had 10 rows for 5 rules. Fix: NULL-safe upsert. | Run ingest twice, count rows; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #11, BUGLOG §1 |
| BH-12 | Corrupt requirements_snapshot silently fell back to live rules | Applicant re-judged by post-application rules, no log — versioning guarantee broken. Fix: audit the fallback / fail safe. | Corrupt snapshot JSON; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #12, CODE_REVIEW.md, BUGLOG §1 |
| BH-13 | "Today" counters reset at 03:00 local | `todayStats()` used UTC `date('now')`; Nairobi UTC+3. Fix: local day boundaries. | Dashboard at 01:00 EAT; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #13, CODE_REVIEW.md, BUGLOG §1 |
| BH-14 | Follow-up ladder fired on wrong days | Docs say Day 3/7/10 absolute; code stacked intervals (Day 0/3/10/20). Fix: absolute scheduling. | Read `runFollowUpSweep`; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #14, CODE_REVIEW.md, BUGLOG §1 |
| BH-15 | Live rules bypassed frozen snapshot in 3 places | `/case/:id/action`, `/case/:id/send`, `publicStatusResult` used `resolveRequirements` not `effectiveRequirements`. Fix: frozen snapshot everywhere. | /status vs case-file checklist diff; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #15, CODE_REVIEW.md, BUGLOG §1 |
| BH-16 | Intake-deadline date input always blank + silent delete | Full ISO into `<input type="date">` renders blank; saving "blank" deleted the deadline. Fix: YYYY-MM-DD value. | Settings with deadline set; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #16, BUGLOG §1 |
| BH-17 | getOrCreateApplicant check-then-insert race | Parallel first emails → UNIQUE throw → whole email failed. Fix: INSERT..ON CONFLICT + transaction (atomic claim). | Two parallel first emails; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #17, CODE_REVIEW.md, BUGLOG §1 |
| BH-18 | One poison email killed the whole ingest batch | No try/catch around `processEmail`; `--watch` exited. Fix: per-email isolation. | Batch with 1 bad email; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #18, CODE_REVIEW.md, BUGLOG §1 |
| BH-19 | Skip sentinel applicantId:-1 crashed callers | `simulation/run.ts` `getApplicant(-1)!` crashed instead of scoring. Fix: discriminated union enforces `skipped` check. | Fixture ending in duplicate; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #19, CODE_REVIEW.md, BUGLOG §1 |
| BH-20 | Total extraction failure logged as method:"gemini_vision" | Decision log lied about provenance. Fix: real method (`none`) on every tier. | Unreadable doc decision log; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #20, CODE_REVIEW.md, BUGLOG §1 |
| BH-21 | extractPhone matched inside longer digit runs | 12-digit ID containing 9-digit subsequence became the phone. Fix: digit boundaries. | ID `123456789012`; pin: `test/bughunt.test.ts` + `test/enrich.test.ts` | FIXED | med | BUGS.md #21, CODE_REVIEW.md, BUGLOG §1 |
| BH-22 | Draft handoff sent on any unknown decision | Only discard/edit matched; everything else fell into send. Fix: explicit `decision === "send"`. | POST decision=bogus; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #22, CODE_REVIEW.md, BUGLOG §1 |
| BH-23 | "Avg auto-response" all-time, comment said 7 days | SQL had no date filter. Fix: comment/SQL reconciled. | Dashboard tooltip vs query; pin: `test/bughunt.test.ts` | FIXED | low | BUGS.md #23, CODE_REVIEW.md, BUGLOG §1 |
| BH-24 | searchApplicants LIKE didn't escape %/_ | Typing `%` matched whole table. Fix: ESCAPE clause (spot-verified in both search paths). | Search `%`; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #24, CODE_REVIEW.md, BUGLOG §1 |
| BH-25 | /settings/intake-deadline 500 on garbage dates | `new Date("garbage…").toISOString()` threw. Fix: validate + 4xx. | POST garbage date; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #25, BUGLOG §1 |
| BH-26 | Assign route 500 on unknown staff id | FK violation unhandled. Fix: validate target, friendly refusal. | Assign to id 99999; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #26, BUGLOG §1 |
| BH-27 | ~~unansweredCases counts automated replies as answered~~ | REVERTED — not a bug: `test/v3.test.ts` pins auto docs_request as a reply. N+1 fix kept, semantics restored. | `test/v3.test.ts` pin | NOT A BUG | — | BUGS.md #27, BUGLOG §1+FP |
| BH-28 | 16-bit PDF images fed to 8-bit unfilter | Garbage pixels → garbage OCR text into classification. Fix: honor /BitsPerComponent. | 16-bit scanned PDF; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #28, BUGLOG §1 |
| BH-29 | escalation_hours changes needed a restart | Read once at boot. Fix: re-read every sweep tick (spot-verified `src/cli/serve.ts`). | Change setting, watch sweep; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #29, CODE_REVIEW.md, BUGLOG §1 |
| BH-30 | No attachment size cap on email path | Portal capped 10 MB; Gmail ingest uncapped → pdfjs/sharp/Tesseract on 25 MB. Fix: per-attachment + per-email caps. | 25 MB attachment mail; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #30, CODE_REVIEW.md, BUGLOG §1 |
| BH-31 | No timeout on Gemini calls | One hung generateContent stalled pipeline forever. Fix: timeout race, fail closed. | Hung mock; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #31, CODE_REVIEW.md, BUGLOG §1 |
| BH-32 | OCR timeout didn't cancel the worker | `Promise.race` left worker grinding; next OCRs queued behind. Fix: terminate/discard on timeout. | Slow OCR ×2; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #32, CODE_REVIEW.md, BUGLOG §1 |
| BH-33 | No busy_timeout → instant SQLITE_BUSY | Web + cron CLI collided. Fix: `busy_timeout = 5000` (spot-verified `src/db/db.ts:557`). | serve + retain concurrently; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #33, CODE_REVIEW.md, BUGLOG §1 |
| BH-34 | Backup wasn't atomic | Checkpoint-then-copyFileSync could tear. Fix: online `db.backup()` API. | Backup under write load; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #34, CODE_REVIEW.md, BUGLOG §1 |
| BH-35 | Retention archives plaintext PII, world-readable | Full bodies + ID numbers in ./data/archive with default perms. Fix: 0700 dir + 0600 files (spot-verified `src/cli/retain.ts`). Encryption remains OPEN (see CR-08). | Run retain, ls -l archive; pin: `test/bughunt.test.ts` | FIXED | high | BUGS.md #35, CODE_REVIEW.md, BUGLOG §1 |
| BH-36 | Sessions never purged after boot | Only seedDefaults purged. Fix: opportunistic purge on read/expiry. | Age a session, re-read; pin: `test/bughunt.test.ts` | FIXED | low | BUGS.md #36, CODE_REVIEW.md, BUGLOG §1 |
| BH-37 | Rate-limit maps never pruned + broken behind proxies | Unbounded growth; no trust proxy. Fix: `src/web/throttle.ts` expiry+eviction, `TRUST_PROXY=1` opt-in (spot-verified). | Long-run + proxied deploy; pin: `test/bughunt.test.ts` | FIXED | med | BUGS.md #37, CODE_REVIEW.md, BUGLOG §1 |
| BH-38 | Inline require("../util/password") in staff routes | ESM-transform failure mode under vitest. Fix: top-level imports. | Run staff tests; pin: `test/bughunt.test.ts` | FIXED | low | BUGS.md #38, CODE_REVIEW.md, BUGLOG §1 |
| BH-39 | resolveApplicant dead in production | Pipeline used resolveIdentity; only tests used the dead copy. Fix: deleted, tests ported. | grep importers; pin: suite green | FIXED | low | BUGS.md #39, CODE_REVIEW.md, BUGLOG §1 |
| BH-40 | lifecycleIndex + pipeline type re-exports, zero importers | Dead weight. Fix: deleted. | grep importers; pin: suite green | FIXED | low | BUGS.md #40, CODE_REVIEW.md, BUGLOG §1 |
| BH-41 | GmailSender defined three times | serve.ts, ingest.ts, followups.ts copies diverged. Fix: one shared sender. | grep definitions; pin: suite green | FIXED | low | BUGS.md #41, CODE_REVIEW.md, BUGLOG §1 |
| BH-42 | npm run demo wrote a different DB than serve read | demo→demo.sqlite vs serve→email-sorter.sqlite; README served empty console. Fix: single DB path. | Follow README; pin: manual verify | FIXED | med | BUGS.md #42, BUGLOG §1 |

## Table B — QA / deep-fix / hostile rounds (BUGLOG §2–§10)

| ID | Title | Description | Repro / pin | Status | Sev | Source |
|----|-------|-------------|-------------|--------|-----|--------|
| BL-02-01 | Dashboard fake zeros/100% instead of "no data" | Lying gauges on empty data. Fix: explicit no-data state. | Fresh DB dashboard; pin: `test/web.test.ts` | FIXED | med | BUGLOG §2 |
| BL-02-02 | No demo-mode banner | Demo indistinguishable from production. Fix: banner. | Demo boot; pin: `test/web.test.ts` | FIXED | med | BUGLOG §2 |
| BL-02-03 | Settings flashes claimed success for empty forms | Fix: truthful flashes only. | Submit unchanged form; pin: `test/web.test.ts` | FIXED | low | BUGLOG §2 |
| BL-02-04 | Staff creation had no validation; default-password risk unwarned | Fix: validation + warning. | Add staff with weak fields; pin: `test/web.test.ts` | FIXED | med | BUGLOG §2 |
| BL-02-05 | No double-send guard on held-draft approval | Fix: claim guard (later hardened to atomic claim, see BL-12-01). | Double-click approve; pin: `test/web.test.ts` | FIXED | high | BUGLOG §2 |
| BL-02-06 | Gmail client secret readable back through settings | Fix: write-only secret field. | GET settings page; pin: `test/web.test.ts` | FIXED | high | BUGLOG §2 |
| BL-02-07 | No sync-state display | Couldn't tell if Gmail was syncing. Fix: connections card state. | Settings connections; pin: `test/web.test.ts` | FIXED | low | BUGLOG §2 |
| BL-02-08 | Unbranded 404 + raw stack-trace errors | Fix: branded 404 + safe handler. | Bad URL; pin: `test/web.test.ts` | FIXED | med | BUGLOG §2 |
| BL-02-09 | No keyboard focus states | Fix: focus styles. | Tab through UI; pin: `test/web.test.ts` | FIXED | low | BUGLOG §2 |
| BL-03-01 | Admin "Replies to date" counted the wrong thing | Fix: counts actual sent replies. | Admin overview; pin: `test/fix-round3-ux.test.ts` | FIXED | med | BUGLOG §3 |
| BL-03-02 | Applicant filter tabs dropped the search term | `?q=` no longer matched the route. Fix: term preserved. | Search + switch tab; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-03-03 | Case-hero header stacked | Missing `.row` layout rule. Fix: CSS. | Case page; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-03-04 | Splash greeting replayed on every page load | Fix: once per tab session. | Navigate pages; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-03-05 | request_info drafts read a dead brand setting | Fix: live brand source. | Request-info draft; pin: `test/fix-round3-ux.test.ts` | FIXED | med | BUGLOG §3 |
| BL-03-06 | Own-account deactivation possible (self lockout) | Fix: blocked with message. | Deactivate self; pin: `test/fix-round3-ux.test.ts` | FIXED | med | BUGLOG §3 |
| BL-03-07 | Staff toggle gave no feedback | Fix: flash/refresh. | Toggle staff; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-03-08 | 404 page said "Command Center" | Stale product name. Fix: current name. | Bad URL; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-03-09 | whatChanged() triage markers were emoji | Fix: colored dots. Cosmetic. | Triage view; pin: `test/fix-round3-ux.test.ts` | FIXED | low | BUGLOG §3 |
| BL-04-01 | Gmail "Disconnect" never stopped polling | Loop kept stale client forever. Fix: disconnect tears down poll. | Disconnect, watch logs; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4 |
| BL-04-02 | Applicant-facing drafts read abolished institution_name | Fix: current brand source. | Render draft; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4 |
| BL-04-03 | Session login lost the demo flag | `getSession` JOIN missed it. Fix: flag carried. | Demo login; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4 |
| BL-04-04 | followup_base_at migrate-only, not in SCHEMA | Fresh-DB source of truth broken. Fix: in SCHEMA. | Fresh DB columns; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4 |
| BL-04-05 | Quoted-ref matching hardcoded 2-letter prefixes | Custom ref_prefix silently broke. Fix: configured prefix honored. | Custom prefix + quoted ref; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4, CODE_REVIEW.md |
| BL-04-06 | Officer "emails unanswered" linked wrong filter | Fix: correct filter link. | Officer dashboard; pin: `test/web.test.ts` | FIXED | low | BUGLOG §4 |
| BL-04-07 | Escalation broadcasts: nowhere to display/clear | Permanent unread pip. Fix: surface + clear path. | Trigger escalation; pin: `test/web.test.ts` | FIXED | med | BUGLOG §4 |
| BL-04-08 | Priority route claimed success for invalid values | Fix: validate + refuse. | POST priority=bogus; pin: `test/web.test.ts` | FIXED | low | BUGLOG §4 |
| BL-04-09 | Dead /portal/upload handler + stale comments/emoji | Cleanup item. Fix: removed. | grep; pin: suite green | FIXED | low | BUGLOG §4 |
| BL-05-01 | mean_grade/subject_grades migrate-only | Fix: in SCHEMA. | Fresh DB columns; pin: `test/bughunt2.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-02 | Word-form required grades ("C (plus)") never matched | Fix: normalization on both sides. | Rule "C (plus)" vs grade C+; pin: `test/bughunt2.test.ts` | FIXED | high | BUGLOG §5 |
| BL-05-03 | Extraction lost plus/minus in word-form grades | "MEAN GRADE: C (plus)". Fix: word-form extraction. | Fixture doc; pin: `test/bughunt2.test.ts` | FIXED | high | BUGLOG §5 |
| BL-05-04 | Either/or subject rules evaluated as AND | One of two languages must suffice. Fix: OR semantics. | Either/or rule eval; pin: `test/bughunt2.test.ts` | FIXED | high | BUGLOG §5 |
| BL-05-05 | Letter-grade rules on KCPE flagged everyone low-confidence | KCPE is a points exam. Fix: points-aware rules. | KCPE applicant; pin: `test/bughunt2.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-06 | Blank school demoted course into "Other programmes" | Fix: blank preserved. | Save course, blank school; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-07 | Admissions dials rendered as static full circles | Fix: shared clickable gauge helper. | Admissions page; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-08 | Row sort comparator inconsistent for equal timestamps | Fix: tiebreak. | Equal-timestamp rows; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-09 | "Pending review" not first-class | Dial linked narrower bucket than tab. Fix: reconciled. | Dashboard vs tab; pin: `test/web.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-10 | Admin overview didn't escape mean-grade rule text | XSS vector. Fix: esc(). | Rule text with tags; pin: `test/web.test.ts` | FIXED | high | BUGLOG §5 |
| BL-05-11 | Alert kinds shown as raw machine codes | Cosmetic. Fix: human labels. | Alerts UI; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-12 | Programme-requirements save claimed success on empty input | Fix: validate + honest flash. | Save empty; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-13 | Admissions page N+1; stageCounts disagreed with dials | Fix: aggregated queries. Perf. | Admissions page; pin: `test/web.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-14 | Programme grade rules re-seeded every boot | Resurrected staff deletions. Fix: seed-once markers. | Delete rule, reboot; pin: `test/web.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-15 | Course routing assigned cases to deactivated officers | Fix: active-only routing. | Deactivate + route; pin: `test/web.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-16 | Banner upload trusted Content-Type header | Fix: magic-byte validation. | Fake PNG upload; pin: `test/web.test.ts` | FIXED | high | BUGLOG §5 |
| BL-05-17 | Gemini vision prompt contained invalid-JSON example | Trailing comment → unparseable responses. Fix: valid example. | Vision call; pin: `test/bughunt2.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-18 | Subject synonyms never canonicalised vs extraction | Maths/Kis… Fix: canonical map both sides. | "Maths" subject; pin: `test/bughunt2.test.ts` | FIXED | med | BUGLOG §5 |
| BL-05-19 | KCPE field mislabeled | Cosmetic. Fix: "KCPE minimum (grade equivalent)". | Config UI; pin: `test/web.test.ts` | FIXED | low | BUGLOG §5 |
| BL-05-20 | KRCHN/DNS seeds missing published subject requirements | Fix: complete seed rows. | Seed data; pin: `test/web.test.ts` | FIXED | med | BUGLOG §5 |
| BL-06-01 | Gemini cached-null replay provenance mismatch | First read method:none, replay gemini_vision with empty text. Fix: NULL_MARKER + validator. | Replay cached null; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-02 | Realm leak: openUnassignedCasesForProgramme crossed demo/live | Shared programme codes. Fix: realm predicate. | Demo+live same code; pin: `test/round20.test.ts` | FIXED | high | BUGLOG §6 |
| BL-06-03 | DOB crosscheck flagged pure format differences as fraud | "12/03/2004" vs "2004-03-12". Fix: normalize before compare. | Format-differing DOBs; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-04 | ID capture swallowed 4-char values | "STUDENT ID: 2026" → ID `2026`. Fix: min-length/context. | Short ID fixture; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-05 | Classifier matched prose | "a level of detail" → A-level certificate. Fix: word-boundary/context. | Prose fixture; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-06 | DOB regex extracted impossible dates | 31/15/2004. Fix: calendar validation. | Impossible date; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-07 | namesConsistent false-flagged initials vs full names | Fix: initial-aware compare. | "J. Mwangi" vs "John Mwangi"; pin: `test/round20.test.ts` | FIXED | low | BUGLOG §6 |
| BL-06-08 | Oversized PDF pages silently dropped | Fix: reported in RasterReport. | Oversized PDF; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-09 | Inline base64 document images never captured | No attachmentId parts skipped. Fix: capture inline parts. | Inline-image mail; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-10 | Feedback score-0 falsy bug | `0 >= 75` comparison passed. Fix: explicit null/undefined check. | Score 0 feedback; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-11 | Bulk re-evaluation: one corrupt case crashed batch | Fix: per-case isolation. | Batch with corrupt case; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §6 |
| BL-06-12 | DOB-contradiction flag duplicated identity-check flag | Fix: merged into existing flag. | Contradictory DOBs; pin: `test/round20.test.ts` | FIXED | low | BUGLOG §6 |
| BL-07-01 | "KCSE 2026" read as 202 points; genuine totals missed | Points regex truncated years. Fix: digit boundary + TOTAL MARKS capture. | Year + total fixture; pin: `test/round20.test.ts` | FIXED | high | BUGLOG §7 |
| BL-07-02 | Exam-system detection fired on prose | "an advanced level of competence" → ALEVEL. Fix: context-gated. | Prose fixture; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §7 |
| BL-07-03 | "INDEX NO: 2026" captured bare year as index | Fix: year-exclusion/length rule. | Bare-year index; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §7 |
| BL-07-04 | rowToDocument unguarded JSON.parse crashed listDocuments | One corrupt row broke every call. Fix: guarded parse. | Corrupt row; pin: `test/round20.test.ts` | FIXED | high | BUGLOG §7 |
| BL-07-05 | Vision-cache validator accepted rows without fields | Fix: shape validation. | Malformed cache row; pin: `test/round20.test.ts` | FIXED | med | BUGLOG §7 |
| BL-07-06 | RasterReport.skipped conflated too-large vs page-cap | Staff notes misreported. Fix: distinct reasons. | Capped raster; pin: `test/round20.test.ts` | FIXED | low | BUGLOG §7 |
| BL-08-01 | Docs-in-but-unrouted cases fell into Enquiries queue | Owner-reported. Fix: "Human Review → Documents in" + reason-printed labels. | Unrouted docs-in case; pin: `test/web.test.ts` | FIXED | med | BUGLOG §8 |
| BL-09-01 | Outgoing mail recorded no attachments | Hostels list / data-protection invisible on timeline. Fix: `emails.attachments` on every send path + timeline badges. | Send pack, view timeline; pin: `test/review-pack.test.ts` | FIXED | high | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-02 | Held-draft approvals dropped the template's pack | Dominant reply path lost attachments. Fix: `outbox.template_key` honored on approval send. | Approve held draft; pin: `test/review-pack.test.ts` | FIXED | high | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-03 | Pack-defaults migration re-ran every boot | Silently reverted staff's "no pack" choice. Fix: one-shot marker. | Set no-pack, reboot; pin: `test/review-pack.test.ts` | FIXED | med | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-04 | Retention archived up to 24h early on boundary day | String-compare of mixed date formats. Fix: `retentionDue()` instant math. | Boundary-day case; pin: `test/review-hardening.test.ts` | FIXED | med | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-05 | CLI ingest dropped pack attachments + banner | Second divergent GmailSender. Fix: one shared sender. | CLI ingest send; pin: `test/review-pack.test.ts` | FIXED | med | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-06 | Inbox poll could overlap itself | Stacked ticks. Fix: `onceAtATime` guard (now returns `{ran,result}`, see ST-FINAL). | Slow poll; pin: `test/review-hardening.test.ts` | FIXED | med | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-07 | POST /login had no CSRF | Fix: double-submit token + COOKIE_SECURE (pre-session by design). | Cross-site login POST; pin: `test/review-hardening.test.ts` | FIXED | high | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-09-08 | "Transfer letter"/"transfer into" not recognised | Real transfers never asked for the form; stress caught 4 cases, 2 auto-admitted without it. Fix: extended patterns. | Transfer phrasing; pin: `test/transfer.test.ts` + stress | FIXED | high | BUGLOG §9, OWNER_ISSUES.md, REPORT.md |
| BL-10-01 | Compose draft competing submit path | Enter reloaded instead of sending. Fix: single submit path. | Enter in compose; pin: `test/compose-window.test.ts` | FIXED | med | BUGLOG §10 |

## Table C — Hostile audits, security/engine rounds, hunts 3–4 (BUGLOG §11–§17)

| ID | Title | Description | Repro / pin | Status | Sev | Source |
|----|-------|-------------|-------------|--------|-----|--------|
| BL-11-01 | AU-HIGH-1: Gemini watcher could live-lock pipeline | No timeout on `watch`; hung call stalled everything. Fix: 45s hard timeout race, fail-closed. | Hung watcher; pin: `test/audit-hardening.test.ts` (was `test/audit.test.ts`) | FIXED | high | AUDIT.md, BUGLOG §11 |
| BL-11-02 | AU-HIGH-2: processed-emails claimed at END → double-processing | Two concurrent runs processed same email. Fix: atomic claim up front. | Concurrent runs; pin: `test/audit-hardening.test.ts` | FIXED | high | AUDIT.md, BUGLOG §11 |
| BL-11-03 | AU-MEDIUM-3: applicantId:-1 sentinel crashed unchecked callers | Fix: discriminated union enforces check (see also BH-19). | Unchecked caller; pin: `test/audit-hardening.test.ts` | FIXED | med | AUDIT.md, BUGLOG §11 |
| BL-11-04 | AU-LOW-4: POST /logout had no CSRF | Fix: CSRF on logout. | Cross-site logout; pin: `test/audit-hardening.test.ts` | FIXED | low | AUDIT.md, BUGLOG §11 |
| BL-12-01 | AU-R2-HIGH: held-draft approval race double-sent replies | Draft recorded only after awaited send; two concurrent approvals both sent. Fix: `outbox.claimed_at` optimistic claim before send; loser refused. | Concurrent approvals; pin: `test/audit2-hardening.test.ts` (was `test/audit2.test.ts`) | FIXED | high | AUDIT.md, BUGLOG §12 |
| BL-12-02 | AU-R2-MEDIUM: follow-up ladder TOCTOU across sweeps | Rung marked only after insert. Fix: optimistic claim. | Parallel sweeps; pin: `test/audit2-hardening.test.ts` | FIXED | med | AUDIT.md, BUGLOG §12 |
| BL-13-01 | OAuth redirect_uri built with host 0.0.0.0 | Google rejects it; connect flow unusable behind standard bind. Fix: single `gmailRedirectUri` helper (exact byte-match). | OAuth behind 0.0.0.0 bind; pin: `test/gmail-oauth-redirect.test.ts` | FIXED | high | BUGLOG §13 |
| BL-14-01 | Cross-realm mutations where reads were guarded | Notes/tasks/decisions/reminders writable cross-realm. Fix: realm guard at /case/:id choke point, every route. | Cross-realm POST; pin: `test/fix-round3-security.test.ts` | FIXED | high | BUGLOG §14 |
| BL-14-02 | All three CSV exports bypassed realm + school scope | Fix: scoped exports (spot-verified `src/web/routes/export.ts` uses `caseScopeFor`). | Export as scoped staff; pin: `test/fix-round3-security.test.ts` | FIXED | high | BUGLOG §14 |
| BL-14-03 | Retention archive dir world-readable alongside 0600 files | Fix: 0700 dir (spot-verified `src/cli/retain.ts`). | ls -ld archive; pin: `test/fix-round3-security.test.ts` | FIXED | med | BUGLOG §14 |
| BL-14-04 | Login throttle brute map.clear() at 5,000 entries | Attacker could wipe the limiter. Fix: time-expiry + oldest-first eviction (`src/web/throttle.ts`, spot-verified). | Flood limiter; pin: `test/fix-round3-security.test.ts` | FIXED | high | BUGLOG §14 |
| BL-14-05 | Retention sweep defaulted to ALL realms | Silently archived demo cases. Fix: live-only default, `--all-realms` explicit. | Default retain run; pin: `test/fix-round3-security.test.ts` | FIXED | med | BUGLOG §14 |
| BL-14-06 | /staff/password bypassed first-run password rules | Fix: min-8 + confirm enforced. | Short admin-set password; pin: `test/fix-round3-security.test.ts` | FIXED | med | BUGLOG §14 |
| BL-15-01 | E1: frozenAt never carried real freeze time | Dead `null : null` line. Fix: `admission_rules_frozen_at` + COALESCE first-freeze. | Freeze rules twice; pin: `test/fix-round4-engine.test.ts` | FIXED | high | BUGLOG §15 |
| BL-15-02 | E2: empty rule tree auto-admitted with zero checks | Vacuous "no automated minimum". Fix: route to human review (`empty_rule_set`). | Empty tree applicant; pin: `test/fix-round4-engine.test.ts` | FIXED | crit | BUGLOG §15 |
| BL-15-03 | E3 (engine): unknown programme judged vs degree defaults | Wrong goalposts frozen on applicant. Fix: NO ladder until identified (`programme_unidentified`). | Unidentified programme; pin: `test/fix-round4-engine.test.ts` | FIXED | high | BUGLOG §15 |
| BL-15-04 | E4: confirmed failure outranked UNREAD route | "Does not meet requirements" while a route unread. Fix: passed > undetermined > failed. | Failed+unread routes; pin: `test/fix-round4-engine.test.ts` | FIXED | high | BUGLOG §15 |
| BL-15-05 | E5: unidentified certificate alongside identified route never withheld auto-admit | Fix: `system_unidentified_partial` (typed companions exempt). | Mixed identified/unidentified; pin: `test/fix-round4-engine.test.ts` | FIXED | high | BUGLOG §15 |
| BL-16-01 | B1: "most requested missing docs" tile vs pipeline SLOT semantics disagreed | Tile showed as missing exactly what applicant sent. Fix: slot-semantic tile. | Complete-by-slot file; pin: `test/bughunt3.test.ts` | FIXED | med | BUGLOG §16 |
| BL-16-02 | B2: node-save/node-delete mutated ACTIVE rule sets via draft routes | Bypassed draft→activate versioning. Fix: `updateRuleNodeIfDraft`/`deleteRuleNodeIfDraft` refuse non-drafts. | POST node on active set; pin: `test/bughunt3.test.ts` | FIXED | high | BUGLOG §16 |
| BL-16-03 | B3: inferIntake fabricated intakes from disjoint month+year | DOB month + application year → phantom "January 2026". Fix: month+year must be adjacent. | Birth cert + 2026 text; pin: `test/bughunt3.test.ts` | FIXED | med | BUGLOG §16 |
| BL-17-01 | N1: removing Gemini key never restored mock reading | `rebuildAdapters` early-returned; stale live adapters failed closed on every Green file → auto-replies silently stopped while UI claimed "back to mock". Fix: no-key branch restores mock + rebuild before claiming. | Clear key, watch Green file; pin: `test/bughunt4.test.ts` | FIXED | high | BUGLOG §17 |
| BL-17-02 | AUX-1: OAuth callback surfaced bare error code only | `access_denied` with no description/hint. Fix: code + description + cause-specific hint. | Fail OAuth; pin: `test/bughunt4.test.ts` | FIXED | low | BUGLOG §17 |
| BL-17-03 | AUX-2: http:// redirect URI on non-loopback presented as registrable | Google refuses it; no warning. Fix: page names situation + points at Public base URL field. | Proxy deploy settings; pin: `test/bughunt4.test.ts` | FIXED | low | BUGLOG §17 |

## Table D — Self-regressions, rounds 8–11, false positives, CODE_REVIEW-unique, AUDIT recs

| ID | Title | Description | Repro / pin | Status | Sev | Source |
|----|-------|-------------|-------------|--------|-----|--------|
| BL-18-01 | R1: wrong_document fired on OPTIONAL listed docs | Caught by own gates (5 rules breakages same commit). Fix: optional-listed exempt. | `test/rules.test.ts` | FIXED | med | BUGLOG §18 |
| BL-18-02 | R2: wrong_document fired on routine unlisted extras | academic_cert fallback, kcpe_cert companion. Caught by 52 simulate regressions. Fix: companion-aware. | `npm run simulate` | FIXED | med | BUGLOG §18 |
| BL-18-03 | R3: stale simulate answer keys vs E4 ranking | igcse-short-credits + alevel-one-principal. Fix: keys encode "verify unread route". | `npm run simulate` | FIXED | low | BUGLOG §18 |
| BL-19-01 | R4 (test bug): reset tests asserted 302, fetch follows to 200 | Server correct; assertions wrong. Fix: `redirect:"manual"` + comment. | `test/forgot-password.test.ts` | FIXED | low | BUGLOG §19 |
| BL-20-01 | M1: mail folders silently truncated at 100 newest | Hard LIMIT 100, no pager. Fix: 50/page pagination + pager + end marker. | Old mail invisible; pin: `test/all-mail.test.ts` | FIXED | high | BUGLOG §20 |
| BL-20-02 | M2: mailThreads INNER-JOINed applicants → NULL-applicant mail invisible | List, counts, and route all excluded parked mail. Fix: LEFT JOIN + realm rule + null-safe paths. | Parked mail; pin: `test/all-mail.test.ts`, `test/mail-window.test.ts` | FIXED | high | BUGLOG §20 |
| BL-21-01 | G1: default Gemini model gemini-1.5-flash 404s in production | Every default pointed at dead model. Fix: shared `DEFAULT_GEMINI_MODEL`, dead-model red callout in settings. | Fresh install probe; pin: `test/gemini-model.test.ts` | FIXED | high | BUGLOG §21 |
| BL-22-01 | S1: Gmail poll 2-day lookback, invisible to operator | Mail older than 48h never ingested. Fix: `gmail_lookback_days` setting (default 14) + backfill + honest connection card. | Old mail missing; pin: `test/gmail-sync.test.ts` | FIXED | high | BUGLOG §22 |
| BL-22-02 | S2: flat-word intake gate parked real applications, admitted job ads | Fix: scored intake engine (weighted phrases, subject×2, course signals, negative vocab, enquiry routing). | "seat available for Nursing" vs job ad; pin: `test/intake-engine.test.ts` | FIXED | high | BUGLOG §22 |
| FP-01 | BUGS #27 (duplicate of BH-27) | Auto docs_request counts as reply — intended, pinned by `test/v3.test.ts`. | `test/v3.test.ts` | NOT A BUG | — | BUGLOG FP |
| FP-02 | /settings/gemini stores key before probing | Investigated: on probe failure key never activated, adapters kept (last-working), error surfaced. Judged acceptable. | Failed probe; no test (accepted behavior) | NOT A BUG | — | BUGLOG FP |
| CR-00 | updateApplicant column-name interpolation (CODE_REVIEW carry-over) | Caller-supplied keys into SQL — one careless caller from identifier injection. Fix: allow-list. | `test/bughunt.test.ts` | FIXED | med | CODE_REVIEW.md, BUGLOG §1 |
| CR-01 | "Rafiki University" branding in outgoing mail | Templates signed wrong university. Fix: "Riara University" + demo-DB UPDATE. (Later generalized to org branding.) | Auto-reply signoff; pin: suite green | FIXED | med | CODE_REVIEW.md |
| CR-02 | admin/admin123 seeded unconditionally, live mode included | Wide-open door + printed creds. Fix: OR-1 — NO staff seeded; one-time setup screen creates owner admin (spot-verified `src/db/seed.ts`). | Fresh live boot; pin: `test/owner-acceptance.test.ts` | FIXED | high | CODE_REVIEW.md |
| CR-03 | Nothing serialized per-applicant across pipeline awaits | Two parallel emails for new sender hit repo race. Fix: repo-layer idempotency (atomic claims) — chosen over mutex (see BH-17, BL-11-02). | Parallel same-sender emails; pin: suite green | FIXED | med | CODE_REVIEW.md |
| CR-04 | Status answers auto-sent while case queued for human | Interplay never audited. Fix: decided explicitly — draft-first/qualification-gate holds (staged pipeline `reply.ts` send-or-queue + S2-3 explicit actions). | Held reply flow; pin: `test/ppr-p1-response-actions.test.ts` | FIXED | med | CODE_REVIEW.md |
| CR-05 | Pipeline god-function (480 lines, 11 jobs, untestable stages) | Fix: split into `src/pipeline/stages/` (intake/evaluation/reply/closeout + types), each stage unit-called (spot-verified). | File layout; pin: suite green | FIXED | med | CODE_REVIEW.md |
| CR-06 | getApplicant(id)! ×7 crash sites on concurrent delete | Minor then; 9 `!` sites remain today. Retention only deletes completed+old cases (never in-flight), single-process better-sqlite3. Residual accepted. | Code read | ACCEPTED | low | CODE_REVIEW.md |
| CR-07 | GeminiWatcher constructed per call (SDK re-require per email) | Fix: constructed once in `src/pipeline/adapters.ts` (spot-verified). | Perf profile; pin: suite green | FIXED | low | CODE_REVIEW.md |
| CR-08 | Retention archives are plaintext PII (no encryption) | 0700/0600 perms landed (BH-35); encryption deliberately not done — documented posture, still open guidance. | `src/cli/retain.ts` header | OPEN | low | CODE_REVIEW.md |
| CR-09 | Gemini constructor require() threw opaquely if SDK missing | Fix: loud configuration error naming the SDK; mock mode never touches it (spot-verified `src/extraction/gemini.ts`). | Live boot w/o SDK; pin: suite green | FIXED | low | CODE_REVIEW.md |
| CR-10 | MockVisionAdapter returned {unknown…} instead of null | Comment/code disagreed; downstream mislabeled provenance. Fix: NULL_MARKER + validator, real method recorded (see BL-06-01). | Sidecar-less attachment; pin: `test/round20.test.ts` | FIXED | med | CODE_REVIEW.md |
| CR-11 | listRecentMessageIds capped at 50, newest-first (starvation) | Fix: paginated listing, whole mailbox seen (spot-verified `src/ingestion/gmailClient.ts` pageToken loop + header comment). | >50 burst; pin: `test/gmail-sync.test.ts` | FIXED | med | CODE_REVIEW.md |
| CR-12 | /export/audit.csv ran raw SQL in server.ts (convention) | Fix: routes use repo methods; realm-scoped (spot-verified `src/web/routes/export.ts`). | Code read; pin: suite green | FIXED | low | CODE_REVIEW.md |
| CR-13 | Restore over live-DB can corrupt both files | No active refusal today; guarded by explicit-arg requirement + WAL-sidecar cleanup; STAB pass 3 deemed correct. Accepted residual. | `src/cli/restore.ts` | ACCEPTED | low | CODE_REVIEW.md |
| CR-14 | deleteApplicantFull per-applicant, outside transaction | Fix: wrapped in `repo.db.transaction` (spot-verified `src/db/repo/cases.ts`). | Kill mid-retain; pin: suite green | FIXED | med | CODE_REVIEW.md |
| CR-15 | queueView/unansweredCases N+1 (per-row queries) | Fix: grouped/EXISTS queries, flags for whole page in ONE query (spot-verified `src/db/repo/stats.ts`). | Queue page; pin: suite green | FIXED | med | CODE_REVIEW.md |
| CR-16 | dashboardStats "documents" counted superseded docs | Fix: `superseded_by IS NULL` (see ST-M-4). | Dashboard vs case view; pin: `test/m4-dashboard-superseded.test.ts` | FIXED | med | CODE_REVIEW.md |
| CR-17 | Proxy deployment hardening (trust proxy deliberate + documented) | Fix: `TRUST_PROXY=1` opt-in (spot-verified `src/web/server.ts`), documented in `.env.example`. | Proxied deploy; pin: suite green | FIXED | med | CODE_REVIEW.md |
| AU-R1 | Rec: keep claim-first shape for future async side-channels | Guidance adopted as pattern (outbox claim, processed claim, ladder claim). | Pattern grep | ADOPTED | — | AUDIT.md §5 |
| AU-R2 | Rec: fold two ad-hoc withTimeout copies into one shared util when a third site appears | Conditional — third site has not appeared. | Code read | OPEN (conditional) | low | AUDIT.md §5 |
| AU-R3 | Rec: unmarkProcessed stays the only manual claim release, with audit | Dead-letter retry endpoint uses it (spot-verified `src/db/repo/ingest.ts`). | Code read | ADOPTED | — | AUDIT.md §5 |
| AU-R4 | Rec: revisit theme CSRF-lessness if theme ever persisted per-user | Theme still cookie-only; condition not triggered. | Code read | OPEN (conditional) | low | AUDIT.md §5 |
| AU-R5 | Rec: union pattern for future "no entity attached" results | Guidance (refNumber already sentinel-free). | Code read | ADOPTED | — | AUDIT.md §5 |

## Table E — STAB round + hardening passes, PPR round, owner-report extras

| ID | Title | Description | Repro / pin | Status | Sev | Source |
|----|-------|-------------|-------------|--------|-----|--------|
| ST-C-1 | CRITICAL: boot crash when DB_PATH outside ./data | `Unknown attachment set 'application'` — bundled data resolved vs CWD. Fix: resolve from module location (`__dirname` walk, `BUNDLED_DATA_DIR` override). | `DB_PATH=/tmp/x.sqlite npm run serve`; pin: `test/boot-outside-repo.test.ts` | FIXED | crit | STAB-ROUND-REPORT.md, STATUS.md |
| ST-H-2 | createStaff hard-coded organization_id=1 | /staff/add never passed a tenant; staff surfaces unscoped. Fix: real org param end to end; no unscoped render remains. | Org-2 admin login; pin: `test/h2-staff-org-scope.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-H-3 | Cross-tenant IDOR on /staff/* writes | toggle/password/reset-code/permissions/scopes acted on foreign ids. Fix: `staffInOrganization` gate; foreign ≡ unknown. | Org-2 admin vs org-1 id; pin: `test/h2-staff-org-scope.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-M-3 | Auto-admit unreachable dead code | Path existed but could never fire. Fix: restored, strictly opt-in (`autoAdmitPolicy`, default OFF), reversible. | Qualifying Green file; pin: `test/m3-auto-admit.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-M-1 | round19 hard-failed without native canvas (test defect) | Fix: probe + skip like responsive tests. | Canvas-free env; pin: `test/round19.test.ts` | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-M-2 | Username normalization inconsistent | Mixed-case duplicates, case-sensitive login. Fix: `src/util/username.ts` (trim+lower, `^[a-z0-9_.-]{2,32}$`), NOCASE match, one-time startup fold. | `Admin` vs `admin`; pin: suite green | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-M-4 | Dashboard counted superseded documents | Fix: `AND d.superseded_by IS NULL` (RED→GREEN: expected 2 to be 1). | Superseded doc; pin: `test/m4-dashboard-superseded.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-H-1 | Simulate scorecard stale; exit-code contract doubted | Exit-1-on-failure already correct (earlier "0" was a `tail` pipe artifact); answer key updated for M-3 behavior. Verified both directions. | `npm run simulate` w/ forced failure; pin: 316/316 exit 0 | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-L-1 | README wrong port/test-count/scripts | Fix: 8080, real counts, full scripts table incl. CI-gate contract. | Read README | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-L-3 | Lint ambiguity (ad-hoc eslint vs policy) | Fix: "Static analysis policy" section — strict tsc is the only gate. | Read README | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-L-4 | COOKIE_SECURE/TRUST_PROXY undocumented | Fix: `.env.example` documents both. | Read .env.example | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-L-5 | Alleged pipeline formatting issue | Verified ABSENT: every `; identifier` hit is in strings/types; neighborhood rewritten by M-3. | Code read | NOT A BUG | — | STAB-ROUND-REPORT.md |
| ST-L-6 | Markdown sprawl (no single status doc) | Fix then: STATUS.md created. Superseded for bugs by THIS file (Phase 7); STATUS.md stays the living status doc. | Doc layout | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-LIGHT-1 | Light mode: register-flow band stayed dark | Bone-white labels + pale-pink links invisible on paper. Fix: `[data-theme="light"]` overrides. | Light theme dashboard; pin: `test/light-mode.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-LIGHT-2 | Light mode: beveled-slab shadows baked dark | Dirty dark lines on paper cards. Fix: `--slab-*` theme variables. | Light theme cards; pin: `test/light-mode.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-BRAND | Default pink accent washed out / "no pink" | `#e18b9a` everywhere, near-invisible on paper. Fix: antique gold `#c89a4a` + paper-deepening + auto-migration. | Any page; pin: `test/brand-accent.test.ts` | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-1 | Config IDOR: attachment-set upload into foreign org | File injection into another tenant's outgoing mail. Fix: set must belong to acting org. | Cross-org upload; pin: `test/h3-config-idor.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-2 | Config IDOR: workflow-rules toggle flipped any org's rule | Fix: scoped to acting org. | Cross-org toggle; pin: `test/h3-config-idor.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-3 | Config IDOR: workflow-rules save hung rules on foreign CaseType | Fix: acting org must match CaseType org. | Cross-org save; pin: `test/h3-config-idor.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-4 | outbox missing (applicant_id, mode) index | Queue listings full-scanned per row. Fix: `idx_outbox_applicant` (EXPLAIN SCAN→SEARCH). Perf. | EXPLAIN queue query; pin: `test/env-and-schema.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-5 | Typo'd numeric env vars leaked NaN | PORT→listen(NaN) crash; byte-guard silently off. Fix: `src/util/envnum.ts` fallbacks everywhere. | `PORT=abc`; pin: `test/env-and-schema.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-6 | npm run build/start documented but never verified | Fix: verified — compiled boot clean with hostile DB_PATH. | `npm run build && npm start`; pin: manual | FIXED | low | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P2-7 | ppr-attachment-sets test depended on cross-tenant uploads (test defect) | Fix: acting-admin flip moved before set management. | `test/ppr-attachment-sets.test.ts` | FIXED | low | STAB-ROUND-REPORT.md |
| ST-P3-1 | retain/escalate crashed on corrupt numeric settings | retain RangeError (Invalid Date); escalation audit poisoned. Fix: envnum fallbacks. | Corrupt retention_days; pin: `test/env-and-schema.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-P3-OK | Pass-3 sweep: backup/restore/CSV/cookies/XSS/portal/ref-race | All verified already-safe (online backup API, formula guard, HttpOnly/SameSite, esc() sinks, OTP tables dropped, transactional refs). | Code audit | NOT A BUG | — | STAB-ROUND-REPORT.md, STATUS.md |
| ST-FINAL | "Sync now" claimed success for a skipped pass | `onceAtATime` conflated skip with success. Fix: returns `{ran,result}`; skip reported explicitly. | Sync during bg pass; pin: `test/gmail-sync-skip.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-F1a | attachment-sets/create honored form-supplied organization_id | Footgun vs org-checked uploads. Fix: always files under acting org. | Forged org field; pin: `test/h3-config-idor.test.ts` | FIXED | med | STAB-ROUND-REPORT.md, STATUS.md |
| ST-F1b | Corrupt numeric SETTINGS crashed intake per email | Bad `sla_target_hours` → Invalid Date → RangeError per email (bricked intake); escalation/unanswered math too. Fix: fallbacks. | Corrupt sla setting; pin: `test/env-and-schema.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-F2 | Admin /staff/password reset left live sessions valid | Up to 8h attacker session after compromise reset. Fix: purge target sessions, audit count (matches reset-code path). | Reset + reuse session; pin: `test/h2-staff-org-scope.test.ts` | FIXED | high | STAB-ROUND-REPORT.md, STATUS.md |
| ST-F2-OK | Final+2 render sweep (esc, LIKE, text/plain, WAL/busy/FK) | All verified already-safe. | Code audit | NOT A BUG | — | STAB-ROUND-REPORT.md, STATUS.md |
| PP-E3 | Transfer-pack send hole (cross-org by name) | Pack sent across organizations by bare name; new orgs couldn't send without Riara files. Fix: org-owned attachment sets; E3 structurally closed. | Cross-org pack ref; pin: `test/ppr-attachment-sets.test.ts` | FIXED | high | PPR-REPORT.md (S1-5) |
| PP-S23a | Intake rule carrying its reply ignored for non-education profiles | `humanTriageOnly` over-triggered. Fix: reply honored per profile. | Non-edu profile + reply rule; pin: `test/ppr-p1-response-actions.test.ts` | FIXED | med | PPR-REPORT.md (S2-3) |
| PP-S23b | draft/approve/hold verb could silently escalate to send | Both gates open → quiet send. Fix: explicit action gating. | Dual-open gates; pin: `test/ppr-p1-response-actions.test.ts` | FIXED | high | PPR-REPORT.md (S2-3) |
| OR-HR-7 | Stress-harness defects (validated STRESS_N, transfer drops, determinism, null-guards, tsx) | Test-harness fixes, not product bugs. Fix: hardened harness. | `npm run stress`; pin: 1000/1000 | FIXED | low | OWNER_ISSUES.md |
| OR-HR-8a | inferProgramme didn't escape data-driven regexes | Programme names compiled raw into RegExp. Fix: escape. | Hostile programme name; pin: suite green | FIXED | med | OWNER_ISSUES.md |
| OR-HR-8b | Pack dir not anchored to DB path | Fix: anchored to DB dir (later generalized: module-location resolution, see ST-C-1). | Relocated DB; pin: suite green | FIXED | med | OWNER_ISSUES.md |
| OR-HR-8c | Hygiene batch: fillSlots typing, exports aggregate, dead portal code, 25 unused symbols, noUnusedLocals on | Non-behavioral hardening. Fix: all applied, flags permanent. | `npm run typecheck`; pin: suite green | FIXED | low | OWNER_ISSUES.md |
| OR-STR | Stress-design error: certificate floor assumed, not read from data | Harness expected rejection at D+; data says D+ IS the certificate floor. Fix: per-level floor computation. (Proof floors come from data.) | `npm run stress` design; pin: 1000/1000 | FIXED | low | OWNER_ISSUES.md |
| OR-RPT | REPORT.md listed phantom routes (/check-status, …) | Never existed. Fix: removed from report. Doc-only. | Read REPORT.md | FIXED | low | OWNER_ISSUES.md, REPORT.md |

## Totals

| Status | Count | IDs |
|--------|-------|-----|
| FIXED / ADOPTED | 203 | All rows except those below |
| NOT A BUG | 6 | BH-27, FP-01 (=BH-27), FP-02, ST-L-5, ST-P3-OK, ST-F2-OK |
| ACCEPTED residual risk | 2 | CR-06 (getApplicant `!` sites), CR-13 (restore-over-live refusal) |
| OPEN guidance | 3 | CR-08 (archive encryption), AU-R2 (shared withTimeout when 3rd site appears), AU-R4 (theme CSRF if ever persisted) |

Unique confirmed defects fixed: **199** (200 FIXED rows minus FP-01 which duplicates BH-27).
No open product bug: the 3 OPEN items are conditional/future guidance, and the
2 ACCEPTED items are judged low-risk residuals. `MIGRATION.md` contains no
defects (migration plan + rollback + verification) and contributes no rows.




