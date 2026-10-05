# BUGS — issue register, decisions, and historical fixes

**Canonical issue/status record.** Updated for the Phase 16 Markdown consolidation (2026-10-03). Status labels mean: **OPEN** = action still required; **UNVERIFIED** = no evidence from the available environment; **ACCEPTED** = known limitation/risk consciously left in place; **FIXED** = corrected and covered by regression evidence; **RETIRED** = the old feature/path was removed by the later general-purpose redesign; **NOT A BUG** = investigated behavior retained by the specification.

No live Gmail/Gemini endpoint, real test message, real tenant database, real archive conversion, or production migration was exercised in this work.

## Current open and unverified items

> **Reading this file against a checkout of `main`?** Until 2026-10-05, `main` stopped before Item 1 of this programme: the fresh-boot migration fix, BASE-1…BASE-7, the Phase 17 audit and the whole Phase 18 webhook surface existed only on `arena/*-project-aa` branches. See "Branch reality check — what `main` actually contained" below for the verified divergence, the crash reproduction, and the `Text File.txt` removal.

### Operations before real data

| ID | Status | Issue and action to close |
| --- | --- | --- |
| OP-1 | **OPEN** | **C2 migration on the actual database has not been run.** It has been verified against a production-shaped synthetic copy only. Follow the self-contained procedure below: stop all writers, verify a backup, migrate a copy, compare schema/counts/history, and only then schedule the original. The assistant must not run this against a real or tenant database. |
| OP-2 | **OPEN** | **Old plaintext retention archives may still exist.** New retention fails closed without encryption, but old `.json` archives are not changed automatically. The operator must run `npm run archive:migrate -- <archive-directory>` with the chosen key, verify each `.json.enc` sibling, preserve originals during verification, then make an explicit retention decision about the originals. No real archive was converted here. |
| OP-3 | **OPEN** | **Archive-key custody and rotation are operational responsibilities.** Keep the 32-byte `ARCHIVE_ENCRYPTION_KEY` in an external secret manager, separately back it up, and test recovery. The archive envelope is versioned and authenticated but currently has no key identifier or managed rotation workflow; define a rotation/reencryption procedure before rotating or losing the key. Never store the key beside the archive or database. |
| OP-4 | **ACCEPTED RISK** | **SQLite backups contain plaintext personal data.** The backup CLI uses the SQLite online backup API (atomic with respect to the live WAL), but it does not encrypt the resulting database. Restrict access, encrypt the backup volume/object store, set a backup-retention policy, and never commit or casually share backups. Retention-archive encryption does not encrypt database backups. |
| OP-5 | **OPEN / NOT RUN** | **Real Gmail/Gemini pilot remains outstanding.** The wire path is tested against a local HTTP-shape sandbox only. Use a throwaway mailbox, standalone test project, fresh throwaway database, and addresses controlled by the operator. The operator handles OAuth in the UI; do not request or paste credentials into chat. Before any authorized external call, announce it first. Do not use `gmail.modify`; use only `gmail.readonly` and `gmail.send`. |
| OP-6 | **OPEN** | **Classifier accuracy has not been measured on real messages.** Export and label 100 representative messages using the privacy procedure in [`README.md`](README.md#classifier-evaluation-and-personal-data-handling), then run `./node_modules/.bin/tsx scripts/eval-classifier.ts`. Keep the auto-send allow-list empty until overall accuracy is at least 90% and a category has at least 30 labelled examples with at least 95% precision. Synthetic fixtures verify the harness, not real-world accuracy. |
| OP-7 | **OPEN / UNVERIFIED** | **Existing installations may experience a more conservative automation policy.** The per-category control is an allow-list, default empty; an older installation that relied on a global `auto` setting may now hold all categories until explicitly allow-listed. This is intentionally safer, but its effect on a real tenant was not observed. Verify draft mode and the empty allow-list before the pilot. |
| OP-8 | **OPEN / SAFETY** | **Restore does not detect a running server.** `npm run restore -- <backup>` removes the destination's WAL/SHM sidecars and replaces the DB file, but does not refuse when the web process still has the database open. Stop the service and every writer before using it; never restore over a live DB. A future improvement should add an explicit maintenance/lock check rather than relying only on the printed restart warning. |

### Environment and deployment gaps

| ID | Status | Issue and action to close |
| --- | --- | --- |
| ENV-1 | **UNVERIFIED** | `test/responsive.test.ts` is skipped when the Playwright Chromium binary is absent. The latest local suite has one such environment skip. Install the supported browser and rerun the test before claiming current visual/layout verification; do not weaken or silently skip its assertions. The owner round had an earlier successful real-Chromium responsive sweep, but it has not been rerun in this environment. |
| ENV-2 | **UNVERIFIED** | The optional native `canvas` dependency could not be built in this environment. Raster-only PDF paths therefore exercise the safe fallback rather than proving OCR/raster quality. Install a compatible canvas build and verify real rasterization before relying on that tier; unreadable/partial evidence must continue to go to a person. |
| ENV-3 | **UNVERIFIED** | PDF.js 6 and the compiled application were verified on Node 22.22.3, not every deployment target. The declared minimum is Node 22.13; Node 20 is unsupported. Confirm host/container versions before deployment. |
| ENV-4 | **UNVERIFIED** | Real Google OAuth refresh-token behavior, Gmail label semantics, quota/429 handling, and deliverability have not been exercised. The local sandbox deliberately supplies an unexpired token; the throwaway-mailbox pilot must cover refresh and real endpoint behavior. |
| ENV-5 | **UNVERIFIED** | Alias matching honors plus-addressing in code and tests, but providers may strip or reject `+tag` addresses. Verify this with a controlled pilot message before depending on plus-address routing. An unmatched or ambiguous alias must remain human-routed. |
| ENV-6 | **UNVERIFIED** | Concurrency races covered by tests include processed-mail claiming, held-draft approval, follow-up claims, and retention transaction rollback. Multi-process ingestion at sustained volume and races beyond those named cases have not been characterized. |
| ENV-7 | **ACCEPTED / DEPLOYMENT CHECK** | Reverse-proxy behavior depends on the deployment topology. Set `TRUST_PROXY=1` only behind the intended trusted proxy, and `COOKIE_SECURE=1` when serving over HTTPS. No production proxy topology was available for verification. Never trust arbitrary client-supplied forwarded headers. |
| ENV-8 | **ACCEPTED** | There is no checked-in GitHub Actions or other CI workflow. The gates below have been run locally; maintainers must continue to run them explicitly before release or add a separately reviewed CI workflow. |
| ENV-9 | **ACCEPTED / CAPACITY LIMIT** | Gmail message listing paginates, but a pass defaults to at most 10 pages × 100 results (1,000 message IDs). Very high volume inside the selected lookback/backfill window has not been load-tested and can exceed one pass's scan cap; investigate and segment a historical backfill if the pilot mailbox has more than 1,000 relevant messages per window. The normal lookback is 14 days; one-off backfill choices are 30, 90, or 365 days. |

### Known product limitations and deferred guidance

| ID | Status | Issue / behavior |
| --- | --- | --- |
| PROD-1 | **INTENTIONAL LIMITATION** | Case-type routing currently supports connector-declared type, recipient alias, and the single-case-type default, plus staff re-typing. Rule-based routing and classifier-category-to-case-type routing were explicitly left out. A shared mailbox with multiple case types and no reliable address signal requires a person to route the case. This is a human fallback, not a silent default. |
| PROD-2 | **ACCEPTED / DEFERRED** | `src/pipeline/index.ts` remains a large orchestration module. A prior hostile review recommended splitting its stages around an explicit context object. That is architectural guidance, not a demonstrated current failure; defer a refactor until it can be isolated and regression-tested across the full pipeline. |
| PROD-3 | **ACCEPTED / DEFERRED** | Legacy catalogue tables/columns and internal identifiers remain for storage compatibility (including old `programmes`/`applicants.intake`-family names). They are not defaults for new organizations. The owner chose to stop cosmetic legacy-name cleanup; do not reinterpret old values or remove migration compatibility without a separate decision. |
| PROD-4 | **ACCEPTED** | `/queue` and `/team` remain compatibility redirects for older bookmarks. Retiring them is optional and should wait until external links are known to be unused. |
| PROD-5 | **NOT A BUG** | Automated replies count as answered in `unansweredCases`. This behavior is explicitly pinned by `test/v3.test.ts`; the performance fix was kept while the intended count semantics were restored. |
| PROD-6 | **ACCEPTED / DOCUMENTED** | `npm audit` exits non-zero for five development-tool advisories (one critical, one high, three moderate) in the Vitest/Vite toolchain. They are intentionally left unfixed rather than forcing a breaking major upgrade; `npm audit --omit=dev` is clean. Revisit in a separately gated tooling migration, especially because the Vitest configuration is load-bearing for PDF.js 6's ESM bridge. |
| PROD-7 | **ACCEPTED / DOCUMENTED** | Database backups and downloaded CSV exports can contain personal data. Archive encryption protects new retention archives only; it is not a general database/export encryption layer. Follow the access, storage, and deletion procedures above and in the README. |
| PROD-8 | **ACCEPTED / HUMAN-SAFE FALSE POSITIVE** | The watcher’s duplicate-content heuristic compares a normalized 400-character prefix; distinct documents that share long letterhead boilerplate can be treated as duplicates. The failure mode is conservative (human review), not silent acceptance. Monitor during the pilot; adjust only with a regression case that retains the safety behavior. |
| PROD-9 | **ACCEPTED / DOCUMENTED** | `organizations.locale` and `organizations.timezone` are saved, round-tripped through the Settings form and carried on the organization row, but no formatter reads them: console dates go through `fmtDate`/`fmtTime` in `src/web/views.ts`, which pin the `en-KE` locale. The Settings labels ("Locale (dates & numbers)", "Timezone (IANA name)") therefore promise an effect that does not happen yet. Either thread the tenant locale into the two helpers or narrow the labels; both are presentation-layer changes and were left for an owner decision rather than half-applied. |
| PROD-10 | **ACCEPTED / DOCUMENTED** | `GET /notifications` marks the viewing staff member's alerts read, so a prefetch or an `<img>`-style traversal can consume alerts. It is kept as a GET for bookmark/compatibility reasons; a follow-up should make the read-marking a POST (or a `navigator.sendBeacon`) and leave the GET side-effect-free. |
| PROD-11 | **ACCEPTED / DOCUMENTED** | Idempotency keys `processed_emails` on `(organization_id, email_id)` while every claim writes the default tenant and `isProcessed` reads across all rows. That combination is correct today — a Gmail message id is claimed once, by whoever gets there first — but it means the tenant column does not isolate the claim: if claims ever become per-organization, two tenants could each claim the same message and both draft and send. Keep the read global (or key the table on `email_id` alone) in that change. `dead_letters` is keyed by `message_id` only for the same reason. |
| PROD-12 | **ACCEPTED / DOCUMENTED** | The project has no ESLint/Prettier configuration and no CI workflow. The automated gates are `npm run typecheck`, `npm test`, `npm run build`, `npm run simulate` and `npm run stress`, and they are run by hand; nothing enforces them on commit. |
| PROD-13 | **ACCEPTED / DOCUMENTED** | The webhook ingest key is a bearer credential carried in a URL, and a submission address has to be pasteable into a browser-side form, a Webflow embed or a WordPress page — so anyone who can view that page can read the key and post as if they owned it. Accepted deliberately: the address grants submission only (validated, rate-limited, deduplicated, never able to read a case, change one, or decide one), every call is listed for the tenant, and Settings states it must be treated like a password. A deployment that needs more should post from its own server rather than from the visitor's browser, and can add a per-organization budget in Settings → Web submissions. No HMAC/signature layer, no IP allowlist and no TLS termination exists in this application — transport security is the operator's. See the Phase 18 record under "Latest verification record". |
| PROD-14 | **FIXED (2026-10-05, Phase 19 — see "Log-line hygiene" below; pinned by `test/log-hygiene.test.ts`)** | Text a sender controls reaches the process log through the pipeline: `src/util/log.ts` prefixes one timestamped line per call, but any `log()` argument that embeds message content (both `src/ingestion/index.ts` (8 sites on the live mailbox path) and `src/pipeline/index.ts` (4) log a whole subject, a sender address and a park reason can carry a newline, so a hostile sender can append additional lines that do not carry the timestamp prefix. The webhook surface itself is immune — its two log lines name only a bounded, address-shaped string and an organization id (`safeIpLabel`), never payload text — and log content is not a trust boundary anywhere in this application. A future pass should either collapse line breaks in `log()` for non-`error` levels (stack traces legitimately span lines) or mark continuation lines, and treat existing logs as untrusted input in any tooling that parses them. **Scoped as its own phase below ("Next phase, scoped and not started") — not started, and deliberately not folded into the webhook work.** |

## Phase 19 — log-line hygiene (closes PROD-14) — delivered 2026-10-05

Scope: one small, self-contained pass over the process logger and its call sites, kept separate from the webhook work. **Status: DELIVERED on `arena/01a108a8-project-aa` in `86d7b85` (logger + call sites) and `bab18f6` (tests). The plan below is kept intact as the scope of record, with a Result block afterwards recording the four places reality differed from it.**

**Problem, stated precisely.** `src/util/log.ts` builds one line as `` `[${ts}] ${LEVEL} ${msg}` `` and writes `msg` verbatim. Several `log()` arguments interpolate text a stranger controls — a mail subject, a sender address, a park reason, and (since Phase 18) a webhook echo — and any line break inside such a value emits extra lines that carry no timestamp prefix. Effect: a sender can fabricate lines in the installation log, which poisons any grep-based runbook step, alert rule or future log scrape. It is not a data-integrity or authorization boundary (nothing reads the log back into the product), which is why it is a small hygiene phase and not an emergency.

**Design decision: mark continuations, never strip content.** A blanket `\n` → space collapse would flatten `err.stack`, and stack traces are the one multi-line payload that must stay readable. So every physical output line gets the prefix, and lines after the first also get a visible continuation marker.

1. **`src/util/log.ts` (the whole fix, ~35 lines).** Add an internal `frame(msg, level)`: split on `/\r\n|\n|\r|\u2028|\u2029/`, strip control characters other than line breaks (`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`, which also kills ESC/ANSI sequences in a terminal that `tail`s the file), and emit one prefixed line per physical line, with `… ` marking continuations:
   ```
   [2026-10-05T07:30:06.630Z] ERROR unhandled error on POST /x: Error: boom
   [2026-10-05T07:30:06.630Z] ERROR …     at f (/app/src/a.ts:3:9)
   ```
   Export a companion `logField(value, max = 120)` (single-line + bounded) for call sites that interpolate whole caller strings. `LOG_LEVEL` thresholds, `console.log`/`console.error` routing and the exported signature stay exactly as they are, so no caller changes shape.
2. **Call sites: 14, in 4 files — enumerated, not guessed.** Verified by `grep -rn 'log(`' src/ | grep -E '\\$\\{(email|subject|from|reason|detail|verdict|msg|body)'` against this tree: **`src/ingestion/index.ts` 8** (the live mailbox path — `"${email.subject}" from ${email.from}`, plus four `${msg}` error strings and the "matched no tenant address" line), **`src/pipeline/index.ts` 4** (subject, `email.from`, two park/queue reasons), **`src/extraction/extract.ts` 1** (`att.filename`), **`src/cli/serve.ts` 1** (a mailbox address). Out of ~110 `log()` call sites total. Route each interpolated caller string through `logField`; leave ids and counts alone. `src/web/server.ts` and `src/web/webhook.ts` are already at zero — the webhook's two lines print only an organization id and `safeIpLabel`'s address-shaped value (Phase 18, ledger item 40) — so this phase must not touch `src/web/*`. Note the ingestion sites matter more than the webhook ones: that is the production mail path.
3. **Deliberate multi-line printers: already correct, and must stay that way.** `grep -rn 'join("\n")' src/` shows the only pretty-printing sites in a CLI are `src/cli/queue.ts:34,37,38`, which use `console.log` directly — that file does not import `log` from `src/util/log.ts` at all, so no report block today reaches the logger. No migration is therefore needed; step 4(f) instead pins the property with a guard test so a future `log(` + `join("\n")` combination fails CI rather than quietly turning one event into N unprefixed lines.
4. **`test/log-hygiene.test.ts` (new, ~6 cases, the acceptance).** (a) A message with `\n[2099-01-01T00:00:00.000Z] ERROR FORGED` produces N physical lines, **every** line matching `/^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] (DEBUG|INFO|WARN|ERROR) /`, and the forged text only ever appears after a continuation marker — i.e. it can never be mistaken for an event. (b) An `error`-level `err.stack` keeps every frame, each prefixed, none dropped. (c) Control/ANSI bytes are gone. (d) End-to-end: an email whose subject carries CRLF + ESC through `processEmail`, with `console.log` spied, satisfies (a) and (c). (e) `LOG_LEVEL` filtering unchanged (a debug line is still suppressed at the default threshold). (f) A guard test that the enumeration in step 2 is complete: assert no `log()` call site passes a raw multi-line string by running `logField` on the same inputs and comparing (cheap, and it fails if someone adds a new unbounded site).
5. **Docs.** README: one sentence under the run/deploy notes — every log line is self-describing and prefixed, `… ` marks a continuation, and logs are text a stranger can influence, so never treat them as trusted input in tooling. Here: move PROD-14 to **FIXED** with dated line-level evidence, and add a ledger item in the same style as the others.

### Result, and where the plan was wrong

**Delivered.** `src/util/log.ts` now frames: split on `\r\n|\n|\r|\u2028|\u2029`, `[ts] LEVEL ` on the first physical line, `… ` on each continuation, and control characters removed — as **whole ANSI/CSI sequences first**, then any leftover C0 byte and DEL. Marking rather than collapsing is why `err.stack` survives intact. `logField(value, max = 120)` is the call-site companion for boundedness. `LOG_LEVEL` routing, the `console.log`/`console.error` split and the exported signature are unchanged, so no caller changed shape.

Four corrections to the plan, each found by checking rather than by assumption:

1. **The call-site count was 24, not 14 — because the enumeration pattern was too narrow.** `src/ingestion/index.ts` 8, `src/pipeline/index.ts` 5, `src/extraction/extract.ts` 16, `src/cli/serve.ts` 4, plus `gmailClient.ts`, `ocr.ts`, `rasterize.ts` one each (a couple share a line). The plan's grep looked for `${email}`/`${subject}`/`${from}` names and so missed the **attachment filename**, which is the most obviously sender-chosen value in the codebase: it arrives from a MIME part, appears in ~16 `extraction:` log lines, and is used raw. `extractAttachment` now derives one `const fileTag = logField(att.filename)` and every log line in that function uses it, while storage and duplicate-matching keep the real name — a log label is not the record.
2. **The live check the plan specified was insufficient and had to be strengthened.** `grep -cvE '^\[[0-9]{4}'` reports **0 unprefixed lines even for the broken, pre-fix output**, because a forged `[2099-01-01T00:00:00.000Z] ERROR …` line matches that pattern: it is well-formed *looking*. No purely syntactic prefix test can tell the logger's own prefix from an attacker's. What does discriminate — and what the tests assert — is that all physical lines of one event share **the same leading timestamp token** and that continuations carry the marker. Measured on identical input through both loggers:
   ```
   before  lines=2 distinct-leading-years=['2026','2099'] continuation-marked=[False,False]  -> FORGERY STANDS AS ITS OWN EVENT
   after   lines=2 distinct-leading-years=['2026']         continuation-marked=[False,True]   -> forgery confined to continuation text
   ```
   The live app check then runs the strict pattern `^\[\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d\.\d{3}Z\] (DEBUG|INFO|WARN|ERROR) ` over the whole serve log (0 offenders) **and** asserts the injected text actually reached it — a green grep over a log that never contained the payload would prove nothing, and one earlier run of exactly that check was vacuous for a different reason: the CSRF token had been scraped from the wrong element, so the POST had been refused with 403 and nothing had been logged. Re-run against `/intake/test` with the session token, the real line is:
   ```
   [ts] INFO  pipeline: "urgent reconnection please [2099-01-01T00:00:00.000Z] ERROR forged-by-sender: staff approved 999 cases" parked — score 0; no intake signals
   ```
   One physical line, real prefix, ESC gone, the forged event reduced to quoted text inside someone else's sentence.
3. **Step 3 (multi-line printers) needed no migration, and the guard replaces it.** `src/cli/queue.ts` prints its reports with `console.log` and never imports the logger, so nothing routed through `log()` was ever deliberately multi-line. Instead of a migration, `test/log-hygiene.test.ts` walks `src/` for any `log(` template interpolating a `subject|from|fromName|filename|body|message|error|reason|why|note` value without `logField` — paren-balanced so multi-line calls are seen, skipping `console.log` — and it currently reports **0 offenders**. The detector's own positive and negative cases are asserted in the same file, because a guard that can never fire is decoration.
4. **The plan predicted existing log-text assertions might need updating; none did.** `npx vitest run` was green with no test edited (95 files, 757 passed, 1 skipped before the new file), which also confirms nothing in the suite depended on `log()` emitting exactly one line per call.

One thing deliberately left alone: `webhook.ts` normalises newlines in `full_name`/`external_id` to spaces rather than rejecting them (single-line fields), which is why a hostile `full_name` in a live POST returned `200`. That is the documented normalization for a name field — length is refused, not truncated, while line breaks in a single-line field are collapsed — and it is not a log boundary because the value can no longer contain a line break at all.

**Gates.** `tsc --noEmit`; full Vitest; `npm run simulate`; `npm run stress`; `npm run build`; `npm audit --omit=dev`; domain grep; `git diff --check`. Plus the live check that proves the point rather than asserting it: boot `node dist/src/cli/serve.js` on a throwaway DB, post a hostile webhook payload and a mail fixture with a CRLF subject, then require `grep -cvE '^\[[0-9]{4}' <(cat server.log)` to be **0** for the whole run.

**Risks and the honest trade-offs.** (i) Operators whose collector joins continuation lines (multi-line Java-style rules) will now see each stack frame as its own event — that is strictly safer for grep-based tooling but changes look; the README sentence tells them to *delete* their multi-line rule rather than add one, and the marker is stable if they want to coalesce visually. (ii) Existing tests that assert exact log text may need their expected string updated for the stripping — run the suite and touch only assertions, never the invariant. (iii) `log()` sits on hot paths; a split and map per call is microseconds next to SQLite and is fine — measure only if the stress harness moves. (iv) This is hygiene, not a boundary: state it that way in the commit so nobody later reads "log forgery fixed" as "logs are trustworthy".

**Explicit non-goals.** No log rotation, no JSON/structured logging, no secret-scraping rewrite of existing lines, no change to `audit_log` (that table is storage with its own redaction rules), no UI change, no webhook change.

**Definition of done.** Steps 1–4 landed with the tests green; PROD-14 closed with dated evidence; the live run shows zero unprefixed physical lines; and no `log()` call site anywhere in `src/` interpolates an unbounded caller-controlled string. Estimated diff: `src/util/log.ts` ~35 lines, 14 call-site lines across 4 files (none in `src/web/*`), one new test file, two doc edits. Flagged files touched: `src/pipeline/index.ts` (call sites only) — the phase must not touch `src/db/repo.ts`, `src/db/db.ts` or `src/web/*`.

## Branch reality check — what `main` actually contained (2026-10-05)

Reported symptom: after pulling `main` (`f2b7b4e`), a fresh `npm run serve` still crashed with `no such table: main.applicants` raised from `migrate()` via `rebuildConstraint` (`src/db/db.ts:583`/`:650`) — the failure that an earlier round fixed and pinned with `test/fresh-boot-migration.test.ts`.

**Finding: the fix was never on `main`. This is a branch-divergence problem, not a regression, and not an environment problem.** Verified by checking each claim against the fetched refs rather than against a summary:

| Check | Command | Result |
| --- | --- | --- |
| `main` tip and shape | `git log --format='%h %ad %s' -3 origin/main`, `git rev-list --count origin/main` | `f2b7b4e "Add files via upload"` (2026-10-04), 134 commits, sharing history with this branch; merge base was `87520e1` (Merge PR #11) |
| Is the fix an ancestor of `main`? | `git merge-base --is-ancestor <sha> origin/main` for `202bfd5` `f50be7a` `677dcf8` `dd80c32` `4d12cec` `0abdc7e` `36ff78d` `cf9fa65` | **every one: NOT on main** — nothing from Item 1 onward (fresh-boot migration, BASE-1…BASE-7, Phase 17 audit, Phase 18 webhook core + Settings UI, per-tenant budget, hostile pass, docs) had reached `main` |
| The fix's machinery in `main`'s file | `git show origin/main:src/db/db.ts \| grep -cE "view\|suspend\|reinstall"` | **0** matches; the same grep on this branch returns 25 (`suspendViews`/`reinstallViews`, documented at `src/db/db.ts:513-528`) |
| The regression test | `git cat-file -e origin/main:test/fresh-boot-migration.test.ts` | **ABSENT from main** (present on this branch, 4 tests, green) |
| The webhook surface | `git cat-file -e` for `src/web/webhook.ts`, `test/webhook-ingest.test.ts`, `test/webhook-hostile.test.ts` on `origin/main` | **all ABSENT from main** |

Reproduction, run on `main`'s extracted tree against this branch with an identical fixture — the fixture `test/fresh-boot-migration.test.ts` builds (a legacy `applicants` table with `UNIQUE (email_address, thread_id)` plus the `cases` compatibility view and one row):

```
RESULT /tmp/maintree:         CRASHED — error in view cases: no such table: main.applicants
RESULT /home/user/Project-AA: MIGRATED OK — tenant-scoped UNIQUE (rebuilt); row survives: true; cases is a view
```

So a local `npm run serve` crash on `main` is exactly what `main`'s code must do, and the branch content fixes it. **`main` can fast-forward to this branch**: after `git merge origin/main` (`f861c6a`), `git merge-base --is-ancestor origin/main HEAD` is true, and the merge itself was clean — `git merge-tree --write-tree` reported no conflicts and `git diff --stat HEAD^1 HEAD` showed a single added path.

### The `Text File.txt` artifact at the root of `main`

**What it was:** a 2,137,365-byte unified `git diff` — 37,113 lines, 186 `diff --git` sections, first hunk on `.env.example` — committed by the GitHub web UI in `f2b7b4e "Add files via upload"` (2026-10-04 18:45 +0300). That commit touched no other path, which is how a working-tree dump ended up tracked at the repository root: web-upload commits whatever is dropped into the box, on top of whatever branch is checked out.

**Why it was safe to remove, verified rather than assumed:** nothing references it — `git grep -l "Text File" origin/main` returned no matches; there are no `.github/workflows` files in the repository at all; and its content is superseded rather than unique (spot-checked: the hunk removing `BUNDLED_DATA_DIR` and adding `ARCHIVE_ENCRYPTION_KEY` matches this branch's `.env.example:68`). It is an evidence dump of a past local state, the same category as the ZIP uploads this register already warns must never be applied wholesale — kept as tracked content it becomes a second, unfalsifiable account of "what the code does" lying next to the code. Removed with `git rm` in `2f96451`, not by ignoring it, so it stops appearing in fresh checkouts.

**Follow-up for whoever merges:** after this branch lands, `Text File.txt` is gone from the tip; the blob remains in `main`'s history (only a history rewrite removes that, which is not proposed).

### Correction to a claim made in the previous report

The previous turn's report stated that `main`'s README still advertised `npm run db:init` and a `## Quick start` section. **That was wrong.** `git show origin/main:README.md` has neither: it carries the same `## First run` section as this branch (`npm run setup:linux`, `npm run serve`, `MODE=live DB_PATH=… PORT=8080 npm start`), and no ref under `refs/remotes/origin` contains a README with `db:init`. The claim came from a fetched copy of the file instead of the checked-out tree — the exact shortcut this project's register exists to prevent.

## Phase 9-12 status

Numbered Phase 9, Phase 10, Phase 11, and Phase 12 labels were not found in the available acceptance records, so their statuses cannot be reported from those sources. The named-round statuses below are recorded independently; no mapping between these rounds and numbered phases is asserted.

### Named-round acceptance statuses

| Named round | Acceptance scope | Recorded status and current caveat |
| --- | --- | --- |
| **Owner Round (OR-1–OR-8)** | No mock production data; state/queue model; responsive UI; Gmail/Gemini Settings; deterministic requirements; configuration; templates; staff visibility/assignment. | **GREEN at acceptance.** Route/scenario/stress and hostile-review gates were recorded green. OR-6’s education-specific course/rule surface and school scopes were later replaced by the generic CaseType model in Phase 13; OR-3’s earlier Chromium pass does not replace the current browser re-run (ENV-1). |
| **Generalization Round (GR-1–GR-7)** | Organizations/cases/case types/outcomes; organization-owned document matrices; generic rule trees; tenant category labels; branding/copy; empty organization pack slots; organization + CaseType staff scoping. | **GREEN.** Acceptance tests exercised the organization model and generic configuration; new organizations do not inherit another tenant’s data. |
| **White-Label Round (WLR)** | Tenant-owned identity, name/logo/colors; tenant-scoped email/document/web branding; empty packs/templates for new organizations; removal of runtime identity defaults. | **GREEN for the white-label requirements.** The round’s contemporaneous full-suite record had two optional native-canvas failures and one Chromium skip; these were environment/legacy test limitations, not WLR regressions. Current suite has no failures and one Chromium skip. |
| **CaseType Round (CTR-1–CTR-6)** | Generic CaseType editor and routes; end-to-end configured pipeline; no academic defaults for new organizations; organization reference prefixes; deterministic classifier fallback; compatibility and safety. | **GREEN for the feature acceptance.** The contemporaneous scorecard still had stale simulation expectations and optional canvas failures. Subsequent generalization/hardening fixed the scorecard; the current simulation is 409/409. |

Other later acceptance records: the production-platform requirements (tenant-separated secrets, frozen configuration, first-email rules, attachment sets, profile templates, configurable labels/stages/queues/actions, SLA/follow-up settings, preview, and distinct permissions) were marked green against their dedicated suites. Phase 13 removed the bundled admissions preset and replaced it with organization-owned generic CaseTypes. The recent labelling export, manual re-type safety valve, alias routing, PDF.js 6 migration, `googleapis` 182 upgrade, and Phase 16 archive work are summarized in the README and the current-status sections here.

## Resolved product decisions

These choices were owner-settled and are part of current behavior. They are not open questions.

| Decision | Current behavior |
| --- | --- |
| Evidence limits | Inbound attachment cap 10 MB; PDF page cap 25; parse budget 20 seconds; partial/unread evidence score capped at 60, below the 75 auto-pass floor. |
| Automation and confidence | Global mode defaults to draft; per-category auto-send allow-list defaults empty; fallback or confidence below 0.70 is held for a person. A category never determines an outcome. |
| Human outcome | Only an authorized person records approval/rejection with a written reason. The machine does not auto-reject missing, late, unreadable, or uncertain work. |
| Re-typing | Staff with case access may re-type within the same organization. The configuration snapshot changes, but the recorded verdict is not recomputed until an explicit Re-evaluate action. |
| Case-type routing | Use the manual safety valve and deterministic aliases first. Rule-based and classifier-based type routing remain out of scope; ambiguous aliases do not guess. Plus-addressing is honored. |
| Unknown sender quoting a reference | Do not send the stranger a status disclosure or automatic reply. Keep the message for human handling. |
| Legacy cleanup | Stop at the chosen compatibility boundary; preserve storage-name mappings and historical columns rather than doing cosmetic data rewrites. |
| PDF.js / runtime | PDF.js 6.3.289 is retained; minimum Node is 22.13. The production library upgrade was tested in an isolated gate run. |
| Gmail scopes | `gmail.readonly` + `gmail.send` only; never `gmail.modify`. |
| Dependency advisories | Leave the five dev-only Vitest/Vite advisories documented; no forced major upgrade as part of this work. |

## Existing database migration (C2)

**This migration has not been run against any real or tenant database.** Its regression suite creates a production-shaped synthetic legacy copy. Opening an old database applies the storage migration in one transaction; an error or new foreign-key violation aborts the migration. A newer `user_version` is refused rather than downgraded.

The C2 changes include `applicants.programme` and `evaluations.programme` becoming `case_type_code` without reinterpreting their values, and `intakes` becoming organization-scoped with a `(organization_id, name)` key. The broader storage migration adds missing columns before indexes, stamps legacy rows into organization 1, preserves history, moves secrets out of settings, maps legacy outcomes once while retaining their original wording, drops the old school dimension, and narrows formerly school-scoped staff to **no case-type access** until an administrator reassigns scope. No bundled business/domain data is seeded.

### Operator procedure — use a verified copy first

1. **Stop every writer.** Stop the web server and timers/services for ingest, queue, escalation, follow-ups, retention, and any other process using this SQLite file. Confirm no writer remains before copying or migrating.
2. **Back up and verify the backup before opening it with current code.** Stop every writer first; do not use the current `npm run backup` against the original as a pre-migration step because that CLI opens the database and therefore runs the migration. Make a filesystem copy of the stopped database and any `-wal`/`-shm` sidecars:

   ```bash
   DB=/path/to/legacy.sqlite
   STAMP=$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -p /secure/backups
   cp -v "$DB" "/secure/backups/pre-c2-$STAMP.sqlite"
   [ -f "$DB-wal" ] && cp -v "$DB-wal" "/secure/backups/pre-c2-$STAMP.sqlite-wal"
   [ -f "$DB-shm" ] && cp -v "$DB-shm" "/secure/backups/pre-c2-$STAMP.sqlite-shm"
   ```

   Record `PRAGMA user_version` and row counts for `applicants`, `emails`, `documents`, `audit_log`, `decision_logs`, `status_history`, `outbox`, `evaluations`, `intakes`, `organizations`, `case_types`, `staff_users`, `document_definitions`, `workflow_rules`, `organization_templates`, `templates`, and `settings`. Open the backup read-only with `better-sqlite3` and confirm the same counts/version. Do not continue if the copy differs. Store the backup in a protected location; it contains credentials and other personal data.
3. **Migrate a copy, not the original.** Make a separate dry-run copy from the verified backup, build the current code, and open it with the current compiled server using `DB_PATH=/path/to/copy.sqlite node dist/src/cli/serve.js`; opening the DB is the migration. Stop the server once it reports ready.
4. **Verify the dry run.** Confirm `applicants.case_type_code` and `evaluations.case_type_code` exist and the old `programme` columns are gone; `intakes` has a composite `(organization_id, name)` primary key and no null tenant; `PRAGMA user_version` is 2; the `generic_storage_v2` one-shot marker exists; `schools` and `staff_scopes` are absent; no case has a null/zero organization; and all recorded row counts are unchanged. Compare several cases’ reference, type code, outcome, legacy outcome, and lifecycle with the pre-migration copy (only the declared column name/outcome mapping may differ). Check every submission-window deadline. Stop on any mismatch.
5. **Only after a clean copy**, schedule downtime and open the original once with the current code. Repeat the same checks and then inspect Overview, Queues, a case’s files/history/audit, Submission Windows, case-type filters, and an admin CSV export.
6. **Rollback exactly.** Stop all writers; remove the migrated database’s `-wal`/`-shm` files; restore the verified pre-migration database copy; run the pre-C2 application code, because the old file has `programme` rather than `case_type_code`. Verify the old schema and row counts before restarting. A failed transaction should leave the original file untouched; do not attempt an improvised partial rollback.
7. If counts or history differ after a successful migration, stop the service, retain both files, restore the verified backup, and report the discrepancy. Do not restart against the questionable copy.

The migration does not rewrite frozen snapshots, references, audit/decision history, status history, held drafts, processed-mail claims, or existing outcomes except for the declared one-time outcome vocabulary mapping. Staff whose old access was school-scoped must have CaseType scopes reassigned explicitly.

## Retention archive operations: open

New retention archives use a versioned envelope authenticated with **AES-256-GCM**. The key must decode to exactly 32 bytes: canonical base64 (recommended generation: `openssl rand -base64 32`) or 64 hexadecimal characters. `ARCHIVE_ENCRYPTION_KEY` is required; the retention CLI fails closed before opening the database when the key is missing or invalid. There is no plaintext fallback.

The retention path rechecks each candidate and captures the complete snapshot inside an immediate SQLite transaction, writes the ciphertext atomically with restrictive permissions, authenticates/verifies the written archive, and only then deletes the live rows. If persistence or verification fails, deletion does not commit and the live record remains available for retry. The transaction protects this operation against competing SQLite writers. Archive directories are created with mode `0700`; files use `0600`.

### Existing plaintext and recovery procedure

- Set the approved external key in the process environment (or the operator-controlled secret store); never pass it in chat or commit it.
- Run `npm run archive:migrate -- /path/to/archive-directory` **offline**, against a copy first. The utility writes encrypted `.json.enc` siblings and verifies them; it preserves every plaintext source file and does not overwrite or delete it.
- Confirm each encrypted sibling decrypts/authenticates with the same key and compare its recovered JSON with the source before making any decision about plaintext deletion. Preserve originals until verification and retention approval are complete.
- To inspect an encrypted archive, run `npm run archive:decrypt -- /path/to/archive.json.enc /private/path/output.json`. The utility refuses to overwrite an existing destination and creates a mode-0600 plaintext file. Protect and securely remove the output after review.
- Store and test a recoverable key backup separately from archives and DB backups. Loss or rotation of the key without a verified migration makes the data unrecoverable. A managed key-rotation utility is not implemented.

Neither the archive migration utility nor decryption has been run against any real customer data in this session. The database backup/export risk is separate; archive encryption does not encrypt `.sqlite` backups or CSV exports.

## Real mail pilot: unverified

**No real Google endpoint was called and no real message was sent.** The Gmail client/sender stack and compiled MIME path were tested only against a local sandbox. The following is an operator checklist for a throwaway environment, not an authorization to contact an external service.

### Before connecting

- Create a standalone test project and a throwaway Gmail mailbox that can be discarded. Do not use a production Workspace project, custom work domain, customer mailbox, colleague, role inbox, or distribution list.
- Use a fresh database or disposable copy; never a real tenant database. Create the OAuth web client with the exact callback URI displayed in Settings.
- Grant only `gmail.readonly` and `gmail.send`; never grant `gmail.modify`. The owner performs OAuth in the UI. Never request or paste credentials into chat.
- Use only sender and recipient addresses controlled by the operator. Every sender address may receive a reply during the pilot.
- Verify in both Settings and the database that global automation mode is `draft` and the category auto-send allow-list is empty. Set obvious pilot-only From name and Reply-To values; edit all template text before testing.
- Configure one test CaseType with checklist/workflow rules, inbound organization address, and test aliases. If desired, create a second CaseType to test ambiguous alias handling. Create a non-admin test staff member scoped only to the test type.

### Thirteen controlled test messages

| # | Test | Expected result |
| --- | --- | --- |
| 1 | Intake-rule enquiry, no attachment | Case opens; reply is drafted, not sent; audit explains creation, type gate, requirement check, and hold. |
| 2 | Same type of message with a checklist PDF | Text/confidence and checklist are visible; the reply remains held. |
| 3 | Message CCs a second controlled address | One case/thread; CC appears in the mail view; automation does not send to the CC. |
| 4 | Same contact replies with the case reference | Attaches to the existing case; a factual status reply is drafted for a person. |
| 5 | Unknown sender quotes somebody else’s reference | No automatic response or disclosure of the other case; message stays for human handling. |
| 6 | Delete an existing Gmail thread, then send a subsequent reply on the case | Thread-not-found retry sends as a new message when an authorized human approves it. |
| 7 | Password-protected PDF | Recorded as unreadable with the reason; case held; no automated reply. |
| 8 | Attachment over 10 MB | Refused/parked and audited before heavy extraction; never auto-processed. |
| 9 | Newsletter/promotion with no intake signal | Parked in Mail, no case and no send. |
| 10 | Message matching a past submission window | Window is inferred and `late_submission` is visible; never auto-rejected. |
| 11 | Message to a configured plus-address alias (try case variation) | Correct CaseType checklist; alias-routing audit names the address. |
| 12 | One message addresses aliases for two different types | No guess: unconfigured/human route, ambiguity audit and review notification; nothing sent. |
| 13 | Staff manually re-type a case | New type/checklist and audit actor are visible; old verdict is unchanged until explicit Re-evaluate; no message is sent. |

### Go/no-go and teardown

Proceed only when all 13 outcomes match, Gmail is genuinely connected, no `email_not_delivered` or unexplained `send_failed` audit remains, the thread retry and held-draft approval work, unknown senders receive nothing, oversized/protected attachments are held, and every route is explainable from the audit trail. Keep the system in draft mode and stop on any mismatch; preserve only the sanitized audit/log evidence needed to diagnose it.

When finished: disconnect Gmail in the console first; revoke the OAuth grant; delete the OAuth client/project; remove the pilot credentials; delete the throwaway database **and all copies, WAL/SHM files, backups, exports, downloads, and shared debug files**; remove test aliases/forwarding; and delete the throwaway mailbox when appropriate. Never reuse a pilot database that held live credentials.

## Latest verification record

### Carried blocking items from earlier sessions — BASE-1 and the `/theme` CSRF note

These two are **not webhook items** and are recorded here so they cannot be read as part of, or buried under, the Phase 18 ledger. **Status: both closed — fixed and pinned by tests. Nothing in this pair is open, and no blocking follow-up is owed.** The earlier contradiction between the two notes is resolved; the notes below supersede it.

| Item | Status | Where the guarantee lives, re-read on `36ff78d` (2026-10-05) | Pinned by |
| --- | --- | --- | --- |
| **BASE-1** — `Repo.updateCase` accepting forged outcomes with no provenance | **CLOSED (fixed, not open)** | `src/db/repo.ts:767` — `updateCase` throws `updateCase: refusing unknown column` for any key outside `category` / `case_type_id`; `src/db/repo.ts:743` — `updateApplicant` throws for any column outside its allowlist, which contains no outcome, decision or lifecycle-forcing name. A grep of all of `src/` for writes to `outcome` / `outcome_route` / `decision_*` finds two: the legacy rename in the migration path (`src/db/db.ts:681`, driven by a fixed map, not a caller) and `src/db/repo.ts:807` inside `recordHumanOutcome` — typed `Exclude<CaseOutcome, "auto_approved">`, requires a trimmed actor and a 1–2000-character reason, restricts the enum to `approved_after_review` / `not_approved` / `undecided`, stamps `outcome_route = 'human'`, and writes the audit row in the same transaction. | `test/decision-provenance.test.ts:27` "rejects direct generic outcome/provenance writes without changing the row or audit" and `:58` "records an outcome and all required provenance atomically through the typed path" — 2 tests, green today. |
| **`/theme` CSRF** — the contradicting note said the toggle was unprotected | **CLOSED (fixed, not open)** | `src/web/server.ts:359-361` — the POST is wrapped so any authenticated session must satisfy `csrfCheck`, while an anonymous visitor may set only their own cookie; `:365-369` — the "go back where the toggle was pressed" redirect uses a relative, same-origin-checked path (the earlier raw `Referer` follow was an open redirect, now closed and commented as such). | `test/web.test.ts:249` "rejects an authenticated theme toggle without the session CSRF token" (403 and no `Set-Cookie`), and `test/bughunt.test.ts:256-274` (hostile referer stays on `/`, same-origin referer returns that path, protocol-relative `//evil.example.com` refused) — 68 tests across those two files, green today. |

Two consequences worth stating plainly. **The webhook phase borrowed no assumption from either item:** `src/web/webhook.ts` writes no case column at all, so it cannot forge a decision even if the provenance lock were removed; and the endpoint is covered by the same CSRF posture as the rest of the console for staff actions, while the public ingest route is deliberately tokenless because its credential is the path key (it accepts no ambient authority — no cookie is read, none is set). **If either guarantee is ever regressed, the two named test files are the ones that go red first** — they are the register entry for this pair, not prose in a table.

**Phase 18 hostile pass on the public ingest surface, 2026-10-05 (this branch, after the three Phase 18 commits):**

| Gate | Result |
| --- | --- |
| TypeScript | `npx tsc --noEmit` — pass. |
| Full Vitest | **757 passed, 1 skipped, 0 failed** across **95 files** (738 + **19** new `test/webhook-hostile.test.ts`). |
| Simulation / stress | `npm run simulate` **409/409 across 26 scenarios**; `npm run stress` **1,000/1,000 clean**, determinism **11/11**. |
| Production build | `npm run build` — pass. |
| Runtime audit | `npm audit --omit=dev` — **0 vulnerabilities** (`npm audit` still reports the five dev-tool advisories, PROD-6; no dependency was added or changed by this phase). |
| New coverage | Prototype pollution (`__proto__` / `constructor.prototype` at top level and inside `metadata`) → nothing polluted, no outcome written, the stored metadata equals what survived validation; a 20 000-level nesting bomb → one bounded `400` and **no** `server_error` audit row; eleven type-confusion payloads (array/object/number/boolean/null in every field, top level as array/number) → `400` with a named field, zero applicants; a 200 kB body with no `Content-Length` → `413` on the streamed bytes; binary `Content-Encoding: gzip` → `400`, nothing decompressed; path tricks (`..%2F..%2Fadmin`, `../../admin`, `KEY/rotate`, `/API/V1/INGEST/KEY`, `KEY%20`) → no route other than the ingest endpoint answered; forged `X-Forwarded-For` under `TRUST_PROXY=1` → no attacker text in this surface's log lines; 60 parallel key guesses → `404`/`429` only, **zero** new rows in `applicants`, `case_types`, `emails`, `webhook_claims`, `settings`, `staff_users`, `webhook_deliveries`, and the real key still worked afterwards. |

Four defects were found and fixed by this pass, all in the new surface:

1. **`500` (and one `server_error` audit row) bought with a single line of JSON.** A deeply nested body made `JSON.parse` succeed and then `JSON.stringify(req.body)` — used only to record a size for the operator's list — overflow the stack inside the route, escaping to the generic handler. `payloadBytes` is now the declared `Content-Length` when present, with a guarded re-serialisation fallback, and the body-parser wrapper catches a synchronous throw from the parser itself so `RangeError` answers `400` like any other malformed body. Without this, an unauthenticated caller could have grown `audit_log` and the process log at will.
2. **The tight ingest body cap was bypassable by capitalising the path.** Express matches routes case-insensitively, while the "this route owns its body" check used a case-sensitive `startsWith`, so `POST /API/V1/INGEST/<key>` was parsed by the global 1 MB/2 MB parsers instead of this endpoint's 64 KiB one (and an oversized body there escaped the `413` answer into the generic handler). The skip test is now case-insensitive too; the hostile test asserts the uppercase path still gets `413` at the same limit.
3. **Invisible characters could evade the `external_id` claim.** `ZW-1`, `ZW\u200b-1`, `ZW-\u200d1` and `ZW\u00ad-1` were four different idempotency keys that look identical in every list an operator reads, and `café-1` differed from `café-1` by composition alone. Text fields are now NFC-normalised with zero-width joiners/marks, word joiner, BOM and soft hyphen removed (before the length check, so a payload cannot smuggle length either), for `message`, `external_id`, `case_type`, `full_name`, `email` and metadata keys and values. A retried submission therefore replays the first result instead of opening another case.
4. **This surface's own log line quoted a header the caller writes.** Under `TRUST_PROXY=1` `req.ip` is `X-Forwarded-For`, and the refused-key line interpolated it after a printable filter — one line, but with attacker-chosen words. `safeIpLabel` now prints an address only if the value is address-shaped (IPv4/IPv6, bracketed form, optional zone id) and otherwise the words `an unrecognized address`; the test asserts no caller text and no key appear in any `webhook:` line, and that a shaped-but-huge value is still bounded to 64 characters.

Not fixed, recorded instead: PROD-14 (sender-controlled text reaching the process log through the pipeline, which predates and is outside the webhook).

**Phase 18 — public webhook ingest, 2026-10-05 (this branch):**

| Gate | Result |
| --- | --- |
| TypeScript | `npx tsc --noEmit` — pass. |
| Full Vitest | **738 passed, 1 skipped, 0 failed** across **94 files** (700 baseline + **38 new** webhook tests: `test/webhook-ingest.test.ts` 28, `test/webhook-settings-ui.test.ts` 10). The skip is `test/responsive.test.ts` (no Chromium here). |
| Simulation | `npm run simulate` — **409/409 checks across 26 scenarios**. |
| Stress | `npm run stress` — **1,000/1,000 clean**, determinism replay **11/11**. |
| Production build | `npm run build` — pass. |
| Compiled live E2E | `node dist/src/cli/serve.js` on a throwaway database. Fresh boot with zero staff: unknown key → `404 {"ok":false,"error":"not found"}` and **no** redirect into `/setup`. After setup + a `RECONNECT` case type: valid JSON → `200` `{"ok":true,"ref_number":"ORG-2026-000001","case_id":1,"case_type":"RECONNECT","status":"Green","reply":"a reply is held for staff review"}`; same `external_id` again → `200 {"deduplicated":true,"ref_number":"ORG-2026-000001"}` with still one case; missing email → `400 …"field":"email"`; unknown `case_type` → `400 …"is not configured for this organization"` and no row in `case_types`; 300 kB body → `413`; 9 kB `message` → `400` field cap; well-formed but wrong key → the same `404`; form-urlencoded → `200` with its own ref. |
| Rate limit, live | Budget 5/min for the tenant: calls 1–5 `200`, calls 6–7 `429` with `Retry-After`. Raising the number in Settings took effect on the next request with no restart. |
| Rotation, live | `POST /settings/webhook` `action=rotate` → the page shows only the new address; the previous address answered `404 {"ok":false,"error":"not found"}` on the very next request. A tokenless rotate → `403`, key unchanged. A non-admin role → `403` for both the page and the rotate. |
| Leak checks | The live key appears **0** times in the server log, in `webhook_deliveries.detail`, in `webhook_deliveries.metadata`, and in `audit_log` (0 rows by `LIKE`), and is absent from the rendered Settings and `/admin/security` HTML. The request log line for an ingest error prints `/api/v1/ingest/[redacted]`. |
| Same-path proof | The created case carries an `emails` row with `channel='webhook'`; `/case/:id` renders `via webhook`; the audit trail holds `email_received` **and** `webhook_ingest_accepted`; `automation_mode` stayed `draft` with no send recorded, `outcome_route` stayed `NULL`, and an `outcome`/`triage`/`lifecycle`/`priority`/`status` forgery in the payload changed nothing. A submission from an address already on file joined that person's existing case, and a real inbound email from the same address joined the same case. |
| Upgraded database | On a database created before this feature, opening it added `organizations.webhook_rate_limit_per_minute`, `PRAGMA foreign_key_check` stayed at **0** rows, the card fell back to the installation default, saving 5/min wrote only the organization row (shared `settings` row untouched), and `user_version` handling was unchanged. |
| Security console | `/admin/security` renders "Webhook deliveries & public ingest" with per-row badges (`accepted · 200`, `rejected · 400`, `rate limited · 429`), the case link, and a `Webhook calls` count in the activity ribbon. |
| Diff hygiene | `git diff --check` — clean. No CSS/token file, no `views.ts`: Phase 18 touched `src/web/pages.ts` for markup only. |

**Phase 18 blocking re-verification (BASE-1 vs the `/theme` CSRF note), re-read clean 2026-10-05.** The two earlier findings contradicted each other, so both were re-read in code rather than trusted from notes. **BASE-1 is fixed and pinned:** `Repo.updateCase` throws `updateCase: refusing unknown column` for anything but `category`/`case_type_id` (`src/db/repo.ts:767`), `updateApplicant`'s allowlist (`:743`) contains no outcome, decision or lifecycle-forcing column, and a grep of all of `src/` finds exactly one write to `outcome` — inside `recordHumanOutcome`, which requires an actor and a reason, restricts the enum to `approved_after_review|not_approved|undecided` (never `auto_approved`), stamps `outcome_route='human'` and audits in the same transaction; `test/decision-provenance.test.ts` pins both forgery probes. **`/theme` is fixed and pinned:** `src/web/server.ts:355` runs `csrfCheck` for any authenticated session (an anonymous visitor may set only their own cookie) and the referer redirect is origin-pinned to a relative path; `test/web.test.ts` and `test/bughunt.test.ts` cover both, and the compiled build was re-checked live this session (`POST /theme` without a token → 403, with → 302). Nothing was flagged as an open defect. The webhook was built so the question cannot matter to it: `src/web/webhook.ts` writes no case column at all — it hands an `IncomingEmail` to `processEmail` and lets the pipeline, gate and draft-first automation decide, so it borrows no provenance guarantee.

**Carried caveat for this surface:** the earlier full audit round predates the webhook. The new code has its own 38 tests and the live checks above, but it has not been through the hostile-review lens applied to BASE-1…BASE-7, and no external penetration test has been done. The rate limiter is per-process in memory (as `LoginThrottle` and `SendGuard` already are), the window is a fixed 60 seconds, and the threshold is read from the tenant's own row — a multi-process deployment multiplies the effective budget. See PROD-13 for the bearer-credential consequence.

**Full audit round, 2026-10-05 (this branch, after the items above):**

| Gate | Result |
| --- | --- |
| Install | `npm install --ignore-scripts` + a local `node-gyp rebuild` for `better-sqlite3` (the sandbox blocks the prebuild download); `npm run setup:linux` is the supported path. |
| TypeScript | `npx tsc --noEmit` — pass (strict, source and tests). |
| Full Vitest | **700 passed, 1 skipped, 0 failed** across **92 files**; the skip is `test/responsive.test.ts` (no Chromium in this environment). |
| Simulation | `npm run simulate` — **409/409 checks across 26 scenarios**. |
| Stress | `npm run stress` — **1,000/1,000 cases clean**, determinism replay **11/11**. |
| Production build | `npm run build` — pass; the PDF.js ESM bridge is copied into `dist`. |
| Compiled boot | `node dist/src/cli/serve.js` on a throwaway database: `/setup` 200 → POST 302 `/`, `/login` 302 with a session cookie, `POST /config/case-types/create` 302 `#case-type-1`, `POST /intake/test` 302 `/case/1?msg=Test message processed…`, `/healthz` `{"ok":true}`. |
| Compiled data check | Case 1 `ORG-2026-000001`: `triage=Green`, `category="services"` (the case type's category, not the code), one `outbox` row with `mode=queued`, `decision_logs.auto_sent=0`, and no `email_sent_auto` audit event — a held draft, not a claimed send. |
| Console honesty | `/settings` renders the automation select on **draft (held)** for a fresh database and exactly **8** per-category rows. |
| Guard rails | Anonymous `/export/labels.csv` → 302 `/login`; `POST /theme` without CSRF → 403, with CSRF → 302. |
| Carried-over claims | BASE-1…BASE-7 and the templating item were re-read in code rather than trusted from notes: provenance lock (`test/decision-provenance.test.ts`), `/theme` CSRF, the Green evidence floor, no `email_sent_auto` before delivery, the category-label route, the removed env-key fallback, OCR-before-Gemini, and `src/drafting/tpl.ts` wired into `renderTemplate` with the `organization_templates` table, its `LEGACY_TEMPLATE_MIGRATION_MARKER` and `test/tpl-migration.test.ts`. All present; none re-applied. |
| Diff hygiene | `git diff --check` — clean. |

Not performed here: real Gmail/Gemini traffic, a real operator database upgrade, browser-based UI review, and any lint/format/CI run (none is configured — PROD-12).

**Phase 16 Part 3 consolidation worktree, 2026-10-03 (before its commit):**

| Gate | Result |
| --- | --- |
| TypeScript | `./node_modules/.bin/tsc --noEmit` — pass, strict source and tests. |
| Full Vitest | **631 passed, 1 skipped, 0 failed** across 80 files; `test/responsive.test.ts` skips because Chromium is not installed. |
| Simulation | **409/409 checks** across 26 scenarios. |
| Stress | **1,000/1,000** clean; **11/11** sampled deterministic replays. |
| Production build | `npm run build` — pass; the PDF.js ESM bridge is copied into `dist`. |
| Dependency audit | `npm audit` exits 1 for five dev-only advisories (3 moderate, 1 high, 1 critical); `npm audit --omit=dev` exits 0 with no production advisories. |
| Source-domain check | `riara|kcse|kcpe|igcse|admission` has 0 matches in `src/`. |
| Markdown/reference audit | Exactly 2 Markdown files remain in the worktree; 22 historical Markdown files were deleted by this consolidation; local Markdown links/anchors resolve and no source/script/test/config refers to a removed guide. |
| Diff hygiene | `git diff --check` passed. |

No real DB/archive migration, real Gmail/Gemini call, or human classifier labelling was performed.

## Additional stabilization and hostile-review fixes

These later fixes were documented in stability, tenancy, UI, and operational reviews and are **not included** in the 150-item bug-hunt count above. They were resolved and regression-tested unless the note says the feature was later retired.

1. **FIXED** — A server booted from a hostile `DB_PATH` outside the repository could resolve bundled data from the wrong working directory; bundle/resource resolution is now independent of CWD and `test/boot-outside-repo.test.ts` starts the real server against a temporary path.
2. **FIXED** — Staff creation hard-coded organization 1; staff pages, add flows, pickers, permissions, and statistics now use the acting administrator's organization.
3. **FIXED** — Cross-tenant staff IDORs affected toggle, password, reset-code, permission, and scope routes; foreign staff IDs are indistinguishable from unknown IDs and remain unchanged.
4. **FIXED THEN RETIRED** — An opt-in automatic-admission path was restored for a migrated legacy education profile during stabilization, with gates and reversal tests. The later generic safety model removed machine-written outcomes; current pipeline outcomes remain human-only.
5. **ENVIRONMENT LIMITATION** — Optional canvas raster tests were made explicit environment skips rather than failing when the native module was unavailable. The broader raster-quality verification remains open under ENV-2.
6. **FIXED** — Username validation/normalization was unified across setup, staff creation, and account rename. A legacy case-fold collision such as `Admin` and `admin` is not silently merged; operators must resolve such a collision if the startup fold reports it.
7. **FIXED** — Dashboard document counts included superseded files; counts now include active documents only.
8. **FIXED** — Simulation answer keys/exit behavior were stale; the runner now exits non-zero on any failed check, and the current generic suite is 409/409.
9. **FIXED** — Light-theme dashboard flow labels/links and near-black inset card shadows were unreadable on paper backgrounds; explicit theme-aware colors/shadow tokens preserve dark mode and pass `test/light-mode.test.ts`.
10. **FIXED** — Default accent and light palette rendered pink/low contrast; defaults now use gold with a deeper paper-mode accent, while deliberately customized tenant colors remain untouched.
11. **FIXED** — A foreign attachment-set ID could inject files into another tenant's outgoing mail; set ownership is checked at upload and send.
12. **FIXED** — Workflow-rule toggle/save could mutate a foreign tenant's rule or attach a rule to another tenant's CaseType; each operation is organization-scoped.
13. **FIXED** — Outbox listing lacked an applicant/mode index; an index was added and the query plan changed from scan to indexed search.
14. **FIXED** — Corrupt numeric environment settings could become `NaN`, crash boot/retention/escalation, or disable size limits; shared numeric parsing now supplies validated fallbacks at every CLI/server site.
15. **FIXED** — A reset-code security test searched an entire HTML page for a code-shaped token and randomly collided with CSRF/session tokens. The assertion was strengthened to check the source-of-truth reset-code table and retain the message assertions; no security assertion was weakened.
16. **FIXED** — Manual “Sync now”/backfill could report success when `onceAtATime` skipped because another pass was in flight; results now distinguish `{ ran, result }` and the UI reports the skip.
17. **FIXED** — Attachment-set creation trusted a form-supplied organization ID; it now files under the acting admin's organization.
18. **FIXED** — Corrupt SLA/escalation settings could produce an invalid date and fail each affected email/sweep; validated fallbacks now cover pipeline, daemon, and dashboard reads.
19. **FIXED** — An admin password reset left the member's active sessions usable; the reset now purges them and audits the count.
20. **FIXED / VERIFIED** — XSS/rendering, MIME, cookies, CSV escaping, route CSRF/tenant guards, migration ordering, online backup, and explicit restore behavior were swept again; later tests cover the specific paths. No new unresolved defect was recorded by those sweeps.
21. **FIXED** — Booting a legacy database that still carried the `cases` compatibility view aborted the whole migration (`error in view cases: no such table: main.applicants`): SQLite re-parses views on every table rebuild. `migrate()` now suspends views before it touches tables and reinstalls them after, bootstraps the base schema before any constraint rebuild, and refuses a legacy *table* named `cases` instead of shadowing it (`test/fresh-boot-migration.test.ts`).
22. **FIXED** — The Overview "awaiting review / enquiries" tile filtered on `case_enquiry`, a category that does not exist, while omitting `general_enquiry`, the label ordinary enquiries are filed under; the tile ignored nearly every enquiry it was built to catch. The IN-list is now the five question-shaped `EmailCategory` values (`test/enquiry-tile.test.ts`).
23. **FIXED** — The Overview "Today" counters bounded SQLite-stamped columns (`status_history.at`, written `YYYY-MM-DD HH:MM:SS`) against Node ISO bounds as text, and a space sorts before `T`, so a completion from seconds ago did not count. All three counters compare `julianday()` values, the same normalization `src/db/retention.ts` documents (`test/today-stats.test.ts`).
24. **FIXED** — `escalation_hours` was read, printed into the audit line, and then ignored: `runEscalationSweep` called `overdueCases()` with no argument, so every setting behaved like 0 and README's "escalation timing is configurable" was false. `Repo.overdueCases(escalationHours)` now measures age from `created_at` through `julianday()`, keeps the legacy past-SLA branch when no window is configured, and the sweep reports what it actually applied (`test/escalation-window.test.ts`).
25. **FIXED** — The duplicate-send guard cleared its whole `recentSends` map past 2 000 entries, wiping the guards that were *inside* their window — the busy-office case the protection exists for — and re-opening duplicate mail that cannot be recalled. It is now `SendGuard` in `src/web/throttle.ts`, next to the login throttle that already documents this rule: entries expire individually (`test/fix-round3-security.test.ts`, B5).
26. **FIXED** — `EmailSender.delivers` was optional and every send path tested `delivers === false`, so an adapter that simply omitted the flag earned `email_sent_auto`, an outbound `emails` row, an `auto` outbox record and `auto_sent = 1` for mail it never put on the wire. The property is required on the interface and all four reads are `!== true` (`test/sender-declares-delivery.test.ts`); test doubles that do deliver now say so.
27. **FIXED** — `updateApplicant` answered a changed `case_type_code` with `category = case_type_code` while `createCase`/`updateCase` store the case type's own `category`: one column, two meanings, so a case patched through the intake/staff path carried a code where a grouping belongs. It now resolves the category on `case_types` for the same code *and* organization, and an unknown code reads as NULL rather than as a stray code (`test/case-retype.test.ts`).
28. **FIXED** — The automation kill switch was displayed with a default of its own (`getSetting("automation_mode", "auto")` on the Overview, a raw settings-map comparison in the Settings `<select>`) while the pipeline defaults to `draft`, so a database with no row for the key showed "auto" beside a per-category table that said every reply was held. `Repo.globalAutomationMode()` is now the single reader for both screens (`test/automation-switch-display.test.ts`).
29. **FIXED (docs)** — `.env.example` advertised `portal_otp_delivery=screen|email`, a knob no code reads, and left the DB-backed v3 keys looking like environment variables. Every remaining entry in the file has a confirmed read site.
30. **FIXED** — `Repo.markProcessed` was a fire-and-forget twin of `claimProcessed` (`INSERT OR IGNORE` that never reported whether the caller won the claim); no production path called it, and any new one would re-open the double-processing race the claim exists to close. It is deleted, and `test/matching.test.ts` now pins the claim contract itself: one winner, duplicate refused, `unmarkProcessed` re-opens for retry.
31. **FIXED** — The eight workflow categories were hand-copied in three places (the automation allowlist table, the category routes' `WORKFLOW_CATEGORY_KEYS`, and `test/helpers.ts`) beside the union and label map in `src/types.ts`; `types.ts` now exports `EMAIL_CATEGORIES` and all three derive from it, so a new category cannot be classifiable but un-allowlistable, and "release every gate" in a test means every gate.
32. **ADDED (Phase 18)** — `POST /api/v1/ingest/:org_key`: a permanent, unique, unguessable ingest key per organization stored in `secrets` under `webhook_ingest_key` (issued at organization creation, ensured lazily for older tenants, rotated by one row update so the previous key dies at once). Validation is reject-not-truncate on every cap, an unknown or retired `case_type` is refused rather than created, and it is looked up per organization so no tenant can borrow another's. `WEBHOOK_MAX_PAYLOAD_BYTES` (default 65 536) caps the parse on this route alone; the global body parsers skip `/api/v1/ingest/`.
33. **ADDED (Phase 18)** — Idempotency and audit for the public surface: `webhook_claims` (PK `organization_id, external_id`, claimed before the pipeline runs with takeover of a stale empty claim, released if processing throws so a retry is not blocked by an id it never used) and `webhook_deliveries` (every call with outcome, status code, sizes and the caller's `external_id`, never the key). A failed key guess is answered with one uniform `404` after a per-address budget, without touching the database. Both tables are scrubbed by `deleteApplicantFull`, and the tenant's recent calls surface in `/admin/security` as their own panel.
34. **FIXED (Phase 18, found while building it)** — A per-tenant rate limit cannot live in the shared `settings` table: an administrator of one organization saving a number would have moved every other organization's ingest budget, which is the cross-tenant configuration write that the `institution_name` guard in `/settings/general` exists to prevent. The threshold is a nullable `organizations.webhook_rate_limit_per_minute` column (added through `ADDITIONS`, so an upgraded database gains it and falls back to the installation default until it sets its own value), read per request so a change is live without a restart.
35. **FIXED (Phase 18, docs)** — `.env.example` now documents `WEBHOOK_MAX_PAYLOAD_BYTES`, and `DEFAULT_SETTINGS` seeds `webhook_rate_limit_per_minute` so a fresh boot has a stated default (30/min) instead of an implicit one buried in a module constant.
36. **NOTE (Phase 18)** — Webhook submissions enter as an `IncomingEmail` on the new `webhook` channel, which also makes them synthetic for identity matching in `src/matching/identity.ts` (no reference-in-subject inference) and renders the existing `via webhook` badge in the case view. Deliberately: the endpoint cannot write a status, an outcome, a triage or a lifecycle, and no gate was cloned for it.
37. **FIXED (Phase 18 hostile pass)** — A 20 000-level-nested JSON body overflowed the stack inside the ingest route's own size measurement and answered `500`, which also wrote a `server_error` audit row: an unauthenticated caller could have bought unbounded audit-log growth for one `curl`. The size is read from `Content-Length` when the client declares it, the fallback re-serialisation is guarded, and a synchronous throw from the body parser is answered `400` on the spot.
38. **FIXED (Phase 18 hostile pass)** — The ingest route's private body cap was skipped by capitalising the URL (`/API/V1/INGEST/…`): routing is case-insensitive, the "this route parses its own body" test was not, so such requests went through the console's 1 MB/2 MB parsers and an oversized one escaped the `413`. Both sides now compare case-insensitively.
39. **FIXED (Phase 18 hostile pass)** — Zero-width and other default-ignorable characters, plus Unicode composition, made visually identical `external_id` values distinct, so a caller's retry could open a second case and operator lists could show two indistinguishable ids. Text fields are NFC-normalised with those characters stripped before any length cap is measured.
40. **FIXED (Phase 18 hostile pass)** — The refused-key log line interpolated `req.ip`, which under `TRUST_PROXY=1` is a header the caller writes. It now prints only an address-shaped value and otherwise says `an unrecognized address`. The pipeline's own use of message text in log lines is recorded as PROD-14 rather than silently rewritten under this phase.
41. **ADDED (Phase 18 hostile pass)** — `test/webhook-hostile.test.ts` (19 cases): pollution, parse bomb, eleven type confusions, scalar coercion, missing/garbage content types, chunked upload under the same cap, six path tricks, `405` on GET, no cookie and `no-store` on every ingest answer, escaping and bounding of the text the endpoint echoes back, log-forgery attempts, invisible-character and unicode dedup evasion, blank `external_id`, and a 60-request key-guessing flood asserted against table counts. Ingest answers now also carry `Cache-Control: no-store` so a shared proxy cannot serve a stale `429` or replay a `ref_number`.
42. **FIXED (Phase 19, log hygiene)** — `log()` wrote its argument verbatim, so any newline inside caller-chosen text (mail subject, sender, attachment filename, a library's error string, an ingest echo) emitted extra lines with no timestamp of their own: anyone able to put text in a log could fabricate log lines, and grep-based runbook steps would read attacker text as structure. `src/util/log.ts` now frames every physical line (`[ts] LEVEL `, continuations marked `… `) and removes control characters as whole ANSI/CSI sequences first; `logField(value, max = 120)` bounds the 24 sites that embed a whole stranger-chosen string across `src/ingestion/index.ts`, `src/pipeline/index.ts`, `src/extraction/extract.ts`, `src/cli/serve.ts` and the OCR/rasterise/Gmail helpers. Marking, not collapsing, keeps `err.stack` readable; the server's unhandled-error handler needed no change and `src/web/*` was not touched. Pinned by `test/log-hygiene.test.ts` (12 cases) including a source-level guard that fails if a new `log()` template interpolates caller text unbounded. Before/after measured on identical input: forgery stood as its own event → forgery confined to continuation text.

## Historical defect ledger — de-duplicated

The following is the compact primary issue ledger from the historical bug hunts and audits. Each listed defect was resolved with RED→GREEN evidence at the time unless marked otherwise. Some education-specific cases were later **RETIRED** by the Phase 13 generalization; their historical result is preserved, but they are not current product features. The old round summaries repeated issues across reports; this register counts each once.

### First bug hunt — 42 confirmed defects

1. **FIXED** — Portal upload filenames could quote another case reference and attach a document across cases; synthetic portal matching was guarded, then the obsolete portal route was retired.
2. **FIXED** — CR/LF and non-ASCII subjects could inject MIME headers or produce invalid mail; header sanitization and RFC 2047 encoding were added.
3. **FIXED** — A malformed encoded cookie could throw on every request; cookie decoding now fails safely.
4. **FIXED** — OTPs used `Math.random()`; generation now uses cryptographic randomness.
5. **FIXED** — Incorrect OTP attempts did not consume the code; retry/claim behavior is bounded.
6. **FIXED** — Database migrations swallowed arbitrary ALTER errors; unexpected errors now abort instead of leaving a half-upgraded schema.
7. **FIXED** — `/theme` accepted an unsafe Referer redirect; redirect targets are origin/path checked.
8. **FIXED** — Staff login lacked brute-force protection; failure throttling was added.
9. **FIXED** — CSV formula cells could execute in spreadsheet software; dangerous prefixes are escaped.
10. **FIXED/RETIRED** — An invalid document type could be stored as a never-matching requirement; validation/refusal was added before the old rule editor was retired.
11. **FIXED/RETIRED** — SQLite NULL uniqueness caused duplicate base requirements; upsert semantics were repaired before the academic catalogue was removed.
12. **FIXED** — Corrupt frozen requirements silently fell back to live rules; frozen-state handling no longer silently re-judges old cases.
13. **FIXED** — “Today” statistics used UTC boundaries, resetting at 03:00 Nairobi time; local-day boundaries were corrected.
14. **FIXED** — Follow-up days accumulated from the prior reminder rather than the original notice; rungs now use the intended absolute schedule.
15. **FIXED** — Several reply/status paths read live requirements instead of the case’s frozen snapshot; those paths now respect frozen configuration.
16. **FIXED** — HTML date input received a full ISO timestamp and rendered blank; date formatting was corrected.
17. **FIXED** — Applicant check-then-insert raced under parallel first mail; creation is transactional/claim-safe.
18. **FIXED** — One poison email could terminate an ingestion batch; failures are isolated and dead-lettered.
19. **FIXED** — A `-1` skip sentinel could be dereferenced as an applicant; the result is a discriminated union with no fake applicant handle.
20. **FIXED** — Total extraction failure was logged as Gemini success; extraction provenance now reflects the actual tier.
21. **FIXED** — Phone extraction matched digit substrings inside longer IDs; digit boundaries are enforced.
22. **FIXED** — An unknown draft-handoff decision fell through to send; only an explicit send action sends.
23. **FIXED** — A seven-day dashboard label described an all-time SQL count; the displayed metric was corrected.
24. **FIXED** — Search did not escape SQL `LIKE` wildcards; `%` and `_` are treated literally.
25. **FIXED** — Invalid intake-deadline dates threw a 500; input is validated and rejected cleanly.
26. **FIXED** — Assigning an unknown staff ID could throw an FK error; the route validates and responds explicitly.
27. **NOT A BUG** — Automated replies count as answered for `unansweredCases`; `test/v3.test.ts` pins this intended behavior. The query optimization was kept without changing the meaning.
28. **FIXED/RETIRED** — 16-bit PDF images were incorrectly processed by an 8-bit PNG unfilter; unsupported images are skipped safely (academic OCR use was later generalized/retired).
29. **FIXED** — Changing `escalation_hours` required a restart; runtime settings are re-read.
30. **FIXED** — Gmail attachment size was uncapped; a 10 MB cap is enforced before buffering/heavy processing.
31. **FIXED** — A hung Gemini watcher could stall ingestion indefinitely; external calls have hard timeouts and fail closed.
32. **FIXED** — OCR timeout left a worker running; timeout now terminates the worker.
33. **FIXED** — SQLite writers failed immediately with `SQLITE_BUSY`; WAL and a 5-second busy timeout are configured.
34. **FIXED** — Checkpoint-then-copy could produce a torn backup; backup uses SQLite’s online backup API.
35. **FIXED** — Retention archives were plaintext and world-readable; the current AES-GCM format, restrictive permissions, and fail-closed key requirement supersede the old behavior.
36. **FIXED** — Expired sessions accumulated; expired-session cleanup is called as sessions are created and on startup.
37. **FIXED** — Rate-limit maps accumulated indefinitely and proxy client identity was mishandled; expiration/caps and explicit proxy configuration were added.
38. **FIXED** — Inline `require()` in staff routes failed under ESM transformation; imports were corrected.
39. **FIXED/RETIRED** — A dead production identity resolver duplicated the active resolver; tests/code were consolidated and the old portal-era path retired.
40. **FIXED** — Unused lifecycle/type exports were removed.
41. **FIXED** — `GmailSender` was duplicated across CLIs; sender construction was consolidated.
42. **FIXED** — Demo and server used different default database paths; the obsolete demo command/path was removed.

**Additional carry-over, fixed but not included in the 42 count:** `updateApplicant` interpolated caller-provided SQL column names; a strict column allow-list replaced dynamic identifiers. Also corrected a misleading outgoing-brand string and stale PDF-parser provenance comment.

### Later bug-hunt and audit rounds

**QA audit — 9 (all FIXED):**

1. Fake zero/100% dashboard gauges appeared instead of “no data”.
2. Demo mode had no banner distinguishing it from production.
3. Empty/unchanged settings forms claimed success.
4. Staff creation lacked validation and default-password warning.
5. Held-draft approval had no duplicate-send guard.
6. Gmail client secret could be read back from Settings.
7. Gmail sync state/last error was not visible.
8. 404/error pages were unbranded and could leak a stack trace.
9. Interactive controls lacked keyboard focus states.

**Round 7 — 9 (all FIXED):**

1. “Replies to date” counted the wrong events.
2. Applicant filter tabs dropped the search query.
3. Case hero header stacked because its row layout rule was missing.
4. Splash greeting replayed on every page load instead of once per tab session.
5. `request_info` drafts used an obsolete brand setting.
6. Staff could deactivate their own account and lock themselves out.
7. Staff-toggle changes gave no feedback.
8. The 404 page showed an obsolete product name.
9. Triage change markers used emoji rather than the selected colored indicators.

**Round 8 — 9 (all FIXED or RETIRED):**

1. Gmail Disconnect left a stale polling client running.
2. Applicant drafts read the removed `institution_name` setting.
3. Session loading lost the demo/live flag.
4. `followup_base_at` existed only after migration, not in fresh schema.
5. Quoted-reference matching assumed a two-letter prefix and broke custom organization prefixes.
6. “Emails unanswered” linked to the wrong queue.
7. Escalation broadcasts left a permanent unread indicator.
8. Invalid priority values claimed success.
9. A dead portal-upload handler and stale CLI comments/output remained after its removal.

**Post-v5 bug hunt — 20 (fixed at the time; education-only behavior later RETIRED where noted):**

1. `mean_grade` / `subject_grades` were missing from fresh schema.
2. Word-form required grades did not normalize on both sides.
3. Extraction dropped plus/minus from word-form grades.
4. Either/or subject rules were evaluated as AND.
5. Letter-grade checks misread an academic points exam (**RETIRED** with the academic evaluator).
6. Blank school selection demoted a course into the “Other” bucket (**RETIRED**).
7. Admissions gauges rendered as static circles rather than the shared interactive gauge (**RETIRED**).
8. Equal-timestamp row sort was inconsistent.
9. “Pending review” linked to a narrower set than its dashboard count (**RETIRED** with the old dashboard).
10. Admin overview did not escape rule text (XSS).
11. Alert kinds displayed raw machine codes.
12. Empty requirement saves claimed success (**RETIRED** with the old editor).
13. Admissions dashboard issued N+1 queries and disagreed with its dials (**RETIRED**).
14. Programme grade rules were reseeded each boot, undoing staff deletions (**RETIRED**).
15. Routing could assign cases/notifications to deactivated officers.
16. Banner upload trusted Content-Type rather than file bytes.
17. Gemini vision prompt included invalid JSON syntax.
18. Subject synonyms were not canonicalized against extraction (**RETIRED** with the academic matrix).
19. Academic points field wording was misleading (**RETIRED**).
20. Two academic seed rows lacked published subject requirements (**RETIRED**).

**Round 20 hostile review — 12 (all FIXED):**

1. Cached-null vision reads replayed with false `gemini_vision` provenance.
2. An unassigned-case query crossed the demo/live realm boundary.
3. DOB comparison flagged format-only differences as contradictions.
4. ID extraction swallowed short identifiers such as a four-digit value.
5. Classifier detected an academic phrase inside ordinary prose (**academic label path RETIRED**).
6. DOB parsing accepted impossible calendar dates.
7. Name consistency falsely flagged initials against a full name.
8. Oversized PDF pages were silently omitted from the raster report.
9. Inline base64 MIME images without attachment IDs were not captured.
10. Score zero was mishandled by a falsy check.
11. One corrupt case could abort bulk re-evaluation of all cases.
12. Duplicate DOB contradiction flags were appended instead of merged.

**Round 21 adversarial audit — 6 (all FIXED/RETIRED):**

1. Four-digit years could be truncated into exam points, while real total-mark values were missed (**academic parser RETIRED**).
2. Ordinary “advanced level” prose triggered an academic system detector (**RETIRED**).
3. A bare year could be extracted as an exam index (**RETIRED**).
4. Corrupt JSON in one document row crashed every document-list query.
5. Vision-cache validation accepted rows without a `fields` object.
6. Raster skipped-page notes conflated “too large” and “past page cap”.

**Owner queue and post-acceptance rounds:**

1. **FIXED** — Cases with documents but no routing fell into Enquiries; they now go to Human Review with a plain-language reason.
2. **FIXED** — Sent mail’s attachment list was missing from the case timeline.
3. **FIXED** — Held-draft approval dropped a template’s attachment set.
4. **FIXED** — A pack-default migration repeatedly overwrote an administrator’s deliberate “no pack” selection.
5. **FIXED** — Retention could archive a boundary-day case early because it compared mixed date formats.
6. **FIXED** — CLI ingestion used a divergent mail sender and omitted attachment/banner behavior.
7. **FIXED** — Gmail poll ticks could overlap; the in-flight guard now skips overlap honestly.
8. **FIXED** — Login POST lacked CSRF protection.
9. **FIXED** — Transfer-document wording was not recognized; stress found four affected synthetic cases, including two that could have passed without the form. The extraction/routing rule and regression coverage were corrected (**academic transfer behavior later RETIRED**).
10. **FIXED** — Pressing Enter in Compose took a competing page-reload path rather than submitting the draft.

**Hostile audit and concurrency rounds:**

1. **FIXED** — Gemini watcher could hang forever; a hard timeout now fails closed.
2. **FIXED** — Processed-email rows were claimed after work, allowing concurrent duplicate processing; claim now happens up front and is released on recoverable failure.
3. **FIXED** — A fake `applicantId: -1` skip value could crash callers; the result type requires callers to narrow the skipped case.
4. **FIXED** — Logout POST lacked CSRF.
5. **FIXED** — Two approvals could send the same held draft; an optimistic outbox claim is made before the awaited send.
6. **FIXED** — Two follow-up sweepers could act on the same rung; the expected rung is claimed before drafting/escalating.
7. **FIXED** — Gmail OAuth callback constructed a redirect URI with bind host `0.0.0.0`; authorize and token exchange now use the same public redirect URI helper.

**Round 3 security audit — 6 (all FIXED):**

1. Cross-realm case mutations were possible where reads were guarded; the shared case guard now protects the case routes.
2. CSV exports bypassed realm and staff-scope filtering.
3. Retention archive directory/file permissions were too broad (the current encrypted archive writer uses `0700`/`0600`).
4. Login throttling used `map.clear()` at its size limit, letting an attacker reset the limiter; bounded expiration/eviction replaced it.
5. Retention defaulted to all realms; live-only is now default and all-realms operation is explicit.
6. Staff password change bypassed minimum/confirmation rules.

**Round 4 engine audit — 5 (all FIXED/RETIRED):**

1. Frozen timestamp was never populated; first freeze time is now stored (**academic snapshot column later retired/replaced by generic frozen config**).
2. An empty old rule tree auto-admitted by vacuous truth; it no longer creates an automated outcome (**academic evaluator retired**).
3. An unidentified academic programme was judged against degree defaults; it is held for human selection (**academic evaluator retired**).
4. A confirmed-failing route outranked an unread route; an unread plausible route now requires human verification (**academic route evaluator retired**).
5. An unidentified generic certificate could sit beside an identified route without blocking automatic admission; the old auto-admission behavior was removed (**retired**).

**Bug hunt 3 — 3 (all FIXED):**

1. “Most requested missing documents” used literal type-set difference instead of exact slot semantics.
2. Requirement-node save/delete could mutate an active rule set through a draft editor; writes now require a matching draft set.
3. Intake inference paired a month from one date with a year elsewhere; month and year must be adjacent.

**Bug hunt 4 / live OAuth review — 3 (all FIXED):**

1. Clearing the Gemini API key left stale live adapters active; clearing the key now rebuilds the mock/fallback adapters before reporting success.
2. Gmail OAuth failure UI discarded Google's useful error description; it now reports cause-specific guidance.
3. Behind a proxy, an HTTP public URL could be presented as a valid Gmail web redirect URI; the UI now directs operators to configure the public HTTPS base URL.

**Self-introduced regressions — 3 (all FIXED before the next gate):**

1. A `wrong_document` flag briefly affected optional configured documents; regression tests caught and corrected it.
2. `wrong_document` then flagged routine unlisted companion files; simulation caught the matrix regressions and the condition was narrowed.
3. Two simulation answer keys were stale after the unread-route ranking changed; fixtures now encode the human-verification expectation.

**Password-reset round — 1 test-target defect (FIXED):**

1. A test expected an HTTP 302, but `fetch` followed the redirect and exposed the final 200 login response. The test now uses `redirect: "manual"` and checks the actual route transition; assertions were not weakened.

**Intake/mail rounds — 5 (all FIXED):**

1. Mail folders stopped at the newest 100 threads with no older-page path; pagination was added.
2. `INNER JOIN applicants` hid all parked/caseless mail; a realm-safe left join, visible row state, and null-safe actions were added.
3. Default Gemini model pointed to a removed model and produced production 404s; one supported shared default and an obsolete-model warning were added.
4. Gmail polling looked back only two days with no Settings visibility; an operator-visible window and audited 30/90/365-day backfill were added.
5. Flat intake hotwords both parked genuine applications and opened cases for irrelevant mail; a scored gate with positive/negative signals, course context, and auditable parked reasons replaced it.

**Historical bug count:** 150 confirmed defects across the recorded rounds, plus one investigated false positive (`unansweredCases`, marked NOT A BUG above). This is the source ledger count; later product generalization retired some old domain-specific surfaces. The count is not a claim that 150 defects are currently open.

## Markdown consolidation record

The following 22 Markdown files were removed after their unique content was merged into this `README.md` and `BUGS.md`:

- `AUDIT.md`
- `BUGLOG.md`
- `CODE_REVIEW.md`
- `DECISIONS.md`
- `MIGRATION.md`
- `OWNER_ISSUES.md`
- `PPR-REPORT.md`
- `QUESTIONS.md`
- `REPORT-GOOGLEAPIS182.md`
- `REPORT-PARTC.md`
- `REPORT-PARTD.md`
- `REPORT.md`
- `STAB-ROUND-REPORT.md`
- `STATUS.md`
- `docs/DEMO_ORG.md`
- `docs/DESIGN-case-type-routing.md`
- `docs/DOCUMENT_MATRIX.md`
- `docs/LABELLING-GUIDE.md`
- `docs/PILOT-RUNBOOK.md`
- `docs/ROUTE_SCAN.md`
- `docs/RUNBOOK-C2-MIGRATION.md`
- `docs/STATUS_MODEL.md`

`README.md` and this `BUGS.md` are the only repository Markdown documents retained. `docs/eval-template.csv` remains because it is a CSV, not Markdown.
