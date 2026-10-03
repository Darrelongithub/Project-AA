# BUGS — issue register, decisions, and historical fixes

**Canonical issue/status record.** Updated for the Phase 16 Markdown consolidation (2026-10-03). Status labels mean: **OPEN** = action still required; **UNVERIFIED** = no evidence from the available environment; **ACCEPTED** = known limitation/risk consciously left in place; **FIXED** = corrected and covered by regression evidence; **RETIRED** = the old feature/path was removed by the later general-purpose redesign; **NOT A BUG** = investigated behavior retained by the specification.

No live Gmail/Gemini endpoint, real test message, real tenant database, real archive conversion, or production migration was exercised in this work.

## Current open and unverified items

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

## Phase 9-12 status

The historical acceptance material names four consecutive rounds—Owner Round, Generalization Round, White-Label Round, and CaseType Round—rather than labelling them explicitly “Phase 9” through “Phase 12.” The table below records them in that chronological order to satisfy the requested Phase 9–12 status; the numbering is a reconstruction, not a quoted source label.

| Phase (chronological alignment) | Acceptance scope | Recorded status and current caveat |
| --- | --- | --- |
| **9 — Owner Round (OR-1–OR-8)** | No mock production data; state/queue model; responsive UI; Gmail/Gemini Settings; deterministic requirements; configuration; templates; staff visibility/assignment. | **GREEN at acceptance.** Route/scenario/stress and hostile-review gates were recorded green. OR-6’s education-specific course/rule surface and school scopes were later replaced by the generic CaseType model in Phase 13; OR-3’s earlier Chromium pass does not replace the current browser re-run (ENV-1). |
| **10 — Generalization Round (GR-1–GR-7)** | Organizations/cases/case types/outcomes; organization-owned document matrices; generic rule trees; tenant category labels; branding/copy; empty organization pack slots; organization + CaseType staff scoping. | **GREEN.** Acceptance tests exercised the organization model and generic configuration; new organizations do not inherit another tenant’s data. |
| **11 — White-Label Round (WLR)** | Tenant-owned identity, name/logo/colors; tenant-scoped email/document/web branding; empty packs/templates for new organizations; removal of runtime identity defaults. | **GREEN for the white-label requirements.** The round’s contemporaneous full-suite record had two optional native-canvas failures and one Chromium skip; these were environment/legacy test limitations, not WLR regressions. Current suite has no failures and one Chromium skip. |
| **12 — CaseType Round (CTR-1–CTR-6)** | Generic CaseType editor and routes; end-to-end configured pipeline; no academic defaults for new organizations; organization reference prefixes; deterministic classifier fallback; compatibility and safety. | **GREEN for the feature acceptance.** The contemporaneous scorecard still had stale simulation expectations and optional canvas failures. Subsequent generalization/hardening fixed the scorecard; the current simulation is 409/409. |

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
