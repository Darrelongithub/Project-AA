# REPORT — Part C (hardening, migration, readiness)

Autonomous run, branch `arena/01a0f754-project-aa`, 2026-10-02 06:00 → 07:35 UTC.
Every phase committed, bundled to `backups/` (git-ignored) and a push attempted.
Gates after each phase: `npm run typecheck`, `npm test`, `npm run simulate`,
`npm run stress` (seed 7331), `npm run build` + a compiled boot, and
`rg -i 'riara|kcse|kcpe|igcse|admission' src` = 0 matches.

Two housekeeping incidents, both handled per global rule 2:

- The sandbox **re-provisioned a third time** (05:59 UTC, immediately before this run):
  HEAD was reset to the base commit `47c025a` and the eight commits from Phase 13b/Part B
  were discarded as objects, while the files survived. Restored by re-committing the
  identical tree as `d40dcdb` (DECISIONS.md D1). `node_modules` was wiped and rebuilt
  (`npm ci --ignore-scripts` + a local-headers `better-sqlite3` rebuild).
- `git push` **worked for Phases 0–2** and then started failing with
  `could not read Username for 'https://github.com': terminal prompts disabled` — the
  credential helper did not survive the re-provision. Per rule 2 this is stated once:
  **the push is not currently permitted**; every phase is bundled locally instead, and
  the last successful push is `f4544c6` (Phase 2). Phases 3–7 exist only in the bundles
  and the working tree until GitHub auth is restored.
- Tooling rule kept: only `./node_modules/.bin/*` was used. (A bare `npx` had wiped
  `node_modules` twice in earlier sessions.)

## a) Status table

| Phase | Status | Commit(s) | Gates before | Gates after |
|---|---|---|---|---|
| **0** Preflight | DONE | `d40dcdb` (restore) · `bca9a99` (report/logs) | — | typecheck clean · **545** tests: 544 pass / 0 fail / 1 env-skip · simulate 409/409 (26 scenarios) · stress 1000/1000 + 11/11 replays · build + compiled boot (fresh boot empty, `/`→`/setup`, mail-not-connected warning) · grep 0 |
| **1** PDF & dependency hardening | DONE, except 1.4 | `140cf1d` (1a hardening) · `5db7728` (1b canvas chain) · `bff381c` (1c) | Phase 0 gates | typecheck clean · **555** tests: 554 pass / 0 fail / 1 env-skip · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot · grep 0 · audit **13 → 10** |
| **1.4** pdfjs-dist major upgrade | **ATTEMPTED → REVERTED** (2 repair attempts, exact blocker in Q2) | no upgrade commit exists; revert recorded in `bff381c` | — | unchanged (dependency back at 3.11.174, `npm ci` verified) |
| **2** C2 migration | DONE (**not** run on any real database; runbook written) | `f4544c6` | Phase 1 gates | typecheck clean · **557** tests: 556 pass / 0 fail / 1 env-skip · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot (fresh DB has `case_type_code`, no `programme`; `intakes` PK `(organization_id, name)`) · grep 0 |
| **3** Safe-by-default sending | DONE | `77c7483` | Phase 2 gates | typecheck clean · **567** tests: 566 pass / 0 fail / 1 env-skip · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot · grep 0 |
| **4** Classifier evaluation harness | DONE | `4a7e14e` | Phase 3 gates | typecheck clean · **582** tests: 581 pass / 0 fail / 1 env-skip · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot · grep 0 · harness smoke-run on `docs/eval-template.csv` |
| **5** Pilot runbook | DONE (docs only) | `c270ceb` | Phase 4 gates | unchanged by content; gates re-run in Phase 7 |
| **6** Case-type routing design note | DONE (docs only, **not** implemented, as instructed) | `c270ceb` | Phase 4 gates | unchanged |
| **7** Final | DONE | this commit | Phase 4/5/6 gates | see below |

**Final gates (Phase 7, on the finished state):**

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (0 errors, `src/` and `test/`) |
| `npm test` | **582 tests: 581 passed, 0 failed, 1 skipped** across 74 files. The skip is `test/responsive.test.ts`, which needs a Chromium binary and says so. No file failed at hook level. |
| `npm run simulate` | **409/409 checks, 26/26 scenarios — ALL GREEN**, exit 0 |
| `npm run stress` | **1000/1000 cases clean** (seed 7331); **11/11** sampled cases re-ran identically |
| `npm run build` + compiled boot | builds; `DB_PATH=/tmp/... node dist/src/cli/serve.js` → `/healthz` 200, `/` 302 → `/setup`, fresh DB empty, `MAIL IS NOT CONNECTED` warning logged |
| `rg -i 'riara\|kcse\|kcpe\|igcse\|admission' src` | **0 matches** |

Test count went 545 → 582 (+37): `pdf-hardening` (10), `safe-by-default` (10),
`eval-classifier` (15), `ppr-p07-migration` (+2). No test was deleted, skipped or
weakened; eight existing tests were updated to open the new per-category allowlist
through a shared helper, and two fixtures were updated to renamed columns
(DECISIONS.md D5, D8, D9, D10).

### What each phase actually changed

**Phase 1 — PDF and dependency hardening.**
- Every pdf.js open now goes through one module (`src/extraction/pdfOptions.ts`) with
  `isEvalSupported: false`, `enableXfa: false`, `disableRange/Stream/AutoFetch: true`,
  `verbosity: 0`, and `disableFontFace: true` on text reads (the render path keeps font
  faces because it produces the images OCR reads). **The page-count probe was previously
  opened with no hardening options at all.** A test asserts `getDocument` and the pdf.js
  module specifier appear in exactly one file, so a new call site cannot skip this.
- Opening a PDF has a wall-clock budget (`PDF_PARSE_TIMEOUT_MS`, 20 s) that tears the
  loading task down and reports a distinct `timeout` status, which becomes an unreadable
  document for a person rather than a guess.
- A document read only **partly** (beyond the 25-page cap, a render budget, oversized
  pages) is capped at score 60 — below the 75 auto-pass floor — and the cap now survives
  the pipeline's re-scoring when a routing hint renames the document. Before this, a
  32-page file was read to page 25, scored 84 "high", and could be auto-replied to; with
  every automation gate open it now holds for a person, while an identical fully-read
  file still sends.
- Attachment size cap (10 MB) was already enforced and is now covered by a test;
  oversized and timed-out files are recorded for a human and never auto-processed.
- The nested optional `canvas@2.11.2` under `pdfjs-dist` (which dragged in
  `@mapbox/node-pre-gyp` and `tar@6.2.1`) was removed with a lockfile-reproducible
  `overrides` entry pinning it to the `canvas@3.2.3` we already install. Verified with
  `npm ci`, `npm ls`, build, boot and the full suite.
- **1.4 reverted.** pdfjs-dist 6.3.289 installs, loads and parses our PDFs correctly
  under plain `tsx`, and v6 removed the eval paths entirely (that is the advisory's fix).
  But v6 is **ESM-only**, and inside vitest/Vite a runtime dynamic import fails with
  `TypeError: A dynamic import callback was not specified` — which reddens every
  PDF-reading test even though production node would run it. `src/types/pdfjs.d.ts` also
  declares the CJS path by hand. The upgrade is a module-system migration
  (`"type": "module"` + `module: node16`, or a CJS-compatible runner), not a version
  bump; two repair attempts were spent and it was reverted per rule 7. Details in Q2.

**Phase 2 — C2 migration.** `applicants.programme` → `case_type_code` and
`evaluations.programme` → `case_type_code`, declared in `migrations/legacy-storage.json`
so old databases rename on open; values copied, never reinterpreted. `intakes` is
tenant-scoped: `organization_id` added and the primary key rebuilt to
`(organization_id, name)` through the existing tested `rebuildConstraint` path (row ids,
indexes, triggers and the AUTOINCREMENT high-water mark preserved); existing windows keep
their deadlines and are attributed to organization 1. The repo API takes the tenant, the
pipeline resolves windows inside the message's own tenant, and the settings route writes
to the acting administrator's tenant. The legacy-copy test caught a real bug in my own
rebuild during development (ADDITIONS had already added the column, so appending it again
failed with "duplicate column name"). `docs/RUNBOOK-C2-MIGRATION.md` is the procedure for
running it on a real database; **I did not run it against any real or tenant database.**

**Phase 3 — safe-by-default sending.** Verified first: the global switch
(`automation_mode`, shipped as `draft`) already outranked case types and rules for
pipeline replies. Three things did not hold, and now do:
- the **reminder ladder ignored the switch entirely** — a rung whose rule said `send` on
  an un-gated case type went out even with the global switch off;
- per-category automation was a **blocklist**, so releasing the global switch turned on
  every category at once — it is now an explicit **allowlist, default empty**, and the
  Settings copy says so;
- `queueForHuman` **did not suppress a send** — a fallback classification or a
  low-confidence model label queued the case for a person *and still mailed the contact*.
  Uncertain classification now marks the draft audience `human`
  (`held_for_classification` audit + notification).
Also pinned: missing template holds and names the key; unreadable attachment holds with
every switch released; a stranger quoting somebody else's reference is never sent
anything; and the switch governs automation, **not** people — a staff member's own Send
still works while it is off (tested over HTTP).

**Phase 4 — classifier evaluation harness.** `scripts/eval-classifier.ts` +
`docs/eval-template.csv` + `docs/LABELLING-GUIDE.md` + `test/eval-classifier.test.ts`
(15 tests on tiny synthetic fixtures). Bars are fixed in code: overall accuracy ≥ 90 %,
auto-send needs precision ≥ 95 % on ≥ 30 labelled examples, every wrong-with-high-
confidence label listed individually by id. Reports contain ids, labels and numbers only
— asserted by planting canary strings in a subject and body and grepping the rendered
report and JSON for them. Exit 0 = bars met, 1 = a bar failed, 2 = bad input. The harness
never changes the product's allowlist.

**Phases 5–6 — documentation only.** `docs/PILOT-RUNBOOK.md` (throwaway mailbox, verify
the draft-only switch in the UI *and* the DB, ten test messages including the
deleted-thread retry / an attachment / a CC'd message, per-message audit expectations,
go/no-go checklist) and `docs/DESIGN-case-type-routing.md` (the routing gap, three
options with trade-offs and effort, a recommendation, and three invariants any choice must
hold). Nothing implemented.

## b) npm audit — before and after

| | total | critical | high | moderate | low |
|---|---|---|---|---|---|
| Before (Phase 0) | 13 | 2 | 4 | 7 | 0 |
| **After (Phase 7)** | **10** | **1** | **2** | **7** | **0** |

Removed: `tar` (critical), `@mapbox/node-pre-gyp` (high), nested optional `canvas@2.11.2`
(high) — all three from one optional dependency chain, via the `overrides` entry.

Remaining, with real exposure assessed:

| Package | Sev | Where it lives | Exploit path in our usage | Patch fix? |
|---|---|---|---|---|
| `pdfjs-dist` 3.11.174 | high | **runtime** (untrusted PDF attachments) | Arbitrary JS execution on a malicious PDF. Mitigated: `isEvalSupported:false`, `enableXfa:false`, no range/stream/auto-fetch, complete local buffer, and a parse budget. Not eliminated — the fix is the v6 upgrade (Q2) | No — major, ESM-only |
| `vitest` 2.1.9 | critical | dev-only | Needs the Vitest **UI server** listening; we never run `vitest --ui`, and dev deps are absent from `dist`/`npm start` | No — major |
| `vite` 5.4.21 | high | dev-only (vitest toolchain) | No Vite dev server is ever run | No — major |
| `@vitest/mocker`, `esbuild`, `vite-node` | moderate | dev-only | as above | No — major |
| `uuid` 9.0.1 ← `googleapis-common`/`gaxios`/`googleapis` | moderate | **runtime** (Gmail) | Missing buffer bounds check in v3/v5/v6 **only when a `buf` option is supplied**; googleapis does not call it that way | `gaxios` has a semver-compatible fix; the `uuid` chain needs a `googleapis` major |

No dependency was added by this run (`package-lock.json` changes only from the override
and the reverted upgrade). Dev-only advisories are documented, not fixed, per the phase
brief.

## c) Secrets scan

- **Added lines in the whole changeset** (`git diff 47c025a..HEAD`, `+` lines) scanned for
  `AIza…`, `GOCSPX-…`, `ya29.…`, `1//…`, `-----BEGIN … PRIVATE KEY-----`, `xox[baprs]-…`,
  `ghp_…`, `github_pat_…`, `sk-…`: the only match is `ya29.sandbox-access-token`, a
  literal in `test/gmail-sandbox.test.ts` used to stop google-auth-library attempting a
  token refresh against a local sandbox. It is not a credential.
- **Every tracked file** (`git grep`): only obviously-fake test placeholders —
  `AIzaFakeKeyForUnitTestsOnly`, `AIzaFAKE-KEY`, `AIza-tenant-two`,
  `AIza-fake-key-not-real`, `GOCSPX-fake-secret`, `1//fake-refresh-token`,
  `ya29.sandbox*`, `sk-legacy-gemini-9f3` (a legacy-shaped fixture row in the migration
  test). No private keys, no real tokens, no password hashes beyond `hashPassword()` of
  literal test passwords.
- **No `.env` file** is tracked or present; `.env.example` has empty values only.
- **Bundles:** `strings` over all ten bundles found no credential-shaped strings. Caveat,
  stated plainly: a git bundle is a zlib-compressed packfile, so `strings` cannot see file
  contents — the authoritative scan is the working-tree/diff scan above, and
  `git bundle verify` confirms each bundle records exactly the committed history
  ("The bundle records a complete history").
- Nothing was printed, logged or committed from any real credential, and **no real Gmail
  or Gemini endpoint was called** at any point (the only network use was the npm registry
  and the two successful `git push` operations).

## d) Backups and push

Bundles in `backups/` (git-ignored, ~11.6 MB each, 122 MB total):

```
backups/phase0-20261002T060154Z.bundle        backups/phase3-20261002T071033Z.bundle
backups/phase0-final-20261002T060519Z.bundle  backups/phase4-20261002T072145Z.bundle
backups/phase1a-20261002T062103Z.bundle       backups/phase5-6-20261002T072558Z.bundle
backups/phase1b-20261002T062616Z.bundle       backups/phase7-final-20261002T073117Z.bundle
backups/phase1c-20261002T064150Z.bundle
backups/phase2-20261002T065531Z.bundle
```

**Push:** succeeded for Phases 0, 1 (a/b/c) and 2 — origin/arena/01a0f754-project-aa is
at `f4544c6`. From Phase 3 onward every attempt failed with
`fatal: could not read Username for 'https://github.com': terminal prompts disabled`
(the credential helper did not survive the 05:59 re-provision). **Phases 3–7 are therefore
only in the bundles and the working tree.** Restoring GitHub auth in Arena and running
`git push origin arena/01a0f754-project-aa` publishes them; every commit is already local
and nothing was force-pushed, and `main` was never touched.

## e) What needs you later

1. **Run the C2 migration on the real database** — `docs/RUNBOOK-C2-MIGRATION.md`. I ran
   it only on synthetic legacy copies inside the repo. The runbook is ordered: stop
   writers → back up and *verify* the backup by row counts → migrate a copy and verify →
   migrate the original → spot-check → exact rollback steps (which include checking out
   the pre-C2 commit, because the new code reads `case_type_code`).
2. **Label 100 real emails and run the harness** — `docs/LABELLING-GUIDE.md` +
   `scripts/eval-classifier.ts`. Until that is done the per-category auto-send allowlist
   should stay empty: the bars (precision ≥ 95 % on ≥ 30 examples) cannot be met on
   synthetic data, and the harness's own tests explicitly say they measure nothing about
   real accuracy.
3. **Run the Gmail pilot** — `docs/PILOT-RUNBOOK.md`, on a throwaway mailbox and a
   throwaway database, with the draft-only switch verified on before any test mail. This
   is the first time the wire meets real Google endpoints; everything so far is sandbox-
   verified only.
4. **Restore GitHub auth** so Phases 3–7 can be pushed (see (d)).
5. **Answer Q7** (case-type routing) — it is the one functional gap that blocks a
   multi-service tenant from automating at all, and the design note is ready to build from.

## f) What I could not verify

- **Real Gmail and real Gemini.** Never called (rule 4). The wire path is verified against
  a local sandbox that mimics Gmail's HTTP shape — MIME bytes, threading, retry, inbound
  parsing — which is not the same as Google's server: real OAuth refresh, quota errors,
  `429`s, label semantics and deliverability are untested.
- **The migration on a real customer database.** Proven on a production-shaped synthetic
  copy (renames, tenant stamping, secrets, history byte-identical, school dimension
  dropped and narrowed, uniqueness rebuilt, one-shot markers, failed-migration integrity),
  not on your file.
- **pdfjs-dist v6 in production.** It loaded and parsed correctly under plain `tsx`, but I
  reverted it because the test runner cannot load ESM; so "v6 would work in `dist`" is
  plausible and unverified.
- **Chromium-dependent UI checks.** `test/responsive.test.ts` and `scripts/ui-*.mts` skip
  without a browser binary; no horizontal-scroll or layout verification ran in this pass.
- **OCR/raster quality.** `canvas` cannot be built in this environment, so the
  rasterise-then-OCR tier exercises its safe fallback rather than real rendering.
- **Effect of the allowlist change on an existing installation.** It is strictly more
  conservative (an install that had global `auto` + a few `draft` rows now holds
  everything until each category is allowlisted), but there is no tenant data here to
  observe. DECISIONS.md D8 records it.
- **Concurrency beyond the tested races** (double approval, two sweepers, processed-mail
  claim) and multi-process ingestion at volume.
- **Bundle contents by string scan** — packfiles are compressed; verified structurally
  instead (`git bundle verify`).

## g) QUESTIONS — ordered by impact

Answer each in one line, e.g. `Q1: D`. Full text in `QUESTIONS.md`.

---

### Q7 (highest impact) — How should inbound mail be routed to a case type?

**Question.** A tenant with several case types cannot route real inbound mail between
them: only the portal/test-intake page declares a case type, so every such case is
`unconfigured_case` (empty checklist, human review) and type-scoped rules never fire.
Phase B4's default covers only single-case-type tenants.

**Options.** **A.** Organization-wide intake rules declare the type (new action key +
two-pass evaluation) · **B.** The classifier's label maps to a type (measurable via the
Phase C4 harness; puts a model in the routing path) · **C.** The delivered address/alias
picks the type (deterministic; needs aliases per service) · **D.** C first, then A, then B
once labelling data exists.

**Recommendation.** **D**, and build the safety valve first: expose
`updateCase({case_type_id})` on the case page so a person can re-type a mis-routed case
(the repo method exists; no route does). Full trade-offs in
`docs/DESIGN-case-type-routing.md`.

**Meanwhile.** SKIPPED — Phase 6 was explicitly design-only; nothing implemented.

**Changes if you answer differently.** A alone is the cheapest path for a shared inbox and
can ship without any address plumbing; B alone is the best for fuzzy language but should
not precede measurement; C alone is the most deterministic but useless without aliases.

---

### Q2 — pdfjs-dist major upgrade (the last runtime `high` advisory): attempt the module migration, or defer?

**Question.** The one advisory with genuine runtime exposure is `pdfjs-dist` (arbitrary JS
on a malicious PDF). v6 removes the eval paths entirely, but is ESM-only.

**Options.** **A. Defer** (current state: 3.11.174 + hardening options) · **B. Do the
module-system migration** (`"type": "module"` + `module: node16`, or swap the test runner)
· **C. Replace the PDF text layer** with another extractor.

**Recommendation.** **B as a scheduled, reviewed change** — not inside a hardening pass.
Attempted and reverted here: v6 loads and parses our PDFs under plain node/tsx, and the
only hard blocker is that vitest/Vite cannot perform a runtime dynamic import
(`A dynamic import callback was not specified`), which would red-line every PDF-reading
test. Mitigations already in place reduce (not eliminate) the exposure.

**Meanwhile.** SKIPPED (A) after two documented repair attempts; no upgrade commit exists.

**Changes if you answer differently.** B: the work is one file
(`src/extraction/pdfOptions.ts`), `src/types/pdfjs.d.ts`, the tsconfig module switch, and
re-running all gates — Phase 1 already collapsed every pdf.js open into that one module
precisely so this migration is small. C: a new extractor plus re-baselining the
extraction/quality tests.

---

### Q3 — How far should the legacy-name cleanup go?

**Question.** C2 renamed the columns that hold case-type data. Three legacy names remain.

**Options.** **A. Stop here** (current) — keep `applicants.intake` (submission-window
name) and the legacy catalogue tables `programmes`, `course_doc_requirements`,
`requirement_rules` with their read-only helpers (`listProgrammes`, `programmeByCode`,
`assignProgrammeOwner`, `inferProgramme`, which still has regex-safety tests) ·
**B. Also rename `applicants.intake` → `window_name`** (same additive mechanism, ~10
sites) · **C. Also retire the legacy catalogue** (deletes migrated rows and two tests).

**Recommendation.** **A now, B if you want the schema to read cleanly.** C is the only
destructive option and should wait until you have looked at those tables in the real
database.

**Meanwhile.** PROVISIONAL — A.

**Changes if you answer differently.** B: one more entry in `migrations/legacy-storage.json`
plus renames in db/types/repo/pages/pipeline and the legacy-copy test. C: drop the tables
in `dropObsolete()`, delete the helpers and the `inferProgramme` tests, re-run gates.

---

### Q1 — Attachment/PDF limits: are the provisional numbers right?

**Question.** Maximum attachment size, maximum pages read, and the PDF parse budget before
a file is refused and handed to a person.

**Options.** **A. Keep** — 10 MB (pre-existing), 25 pages (pre-existing), 20 s parse
budget (new), partial reads scored 60 (below the 75 auto-pass floor) · **B. Stricter** —
5 MB / 15 pages / 10 s · **C. Looser** — 20 MB / 50 pages / 45 s.

**Recommendation.** **A.** 10 MB and 25 pages were already the product's numbers and real
intake mail fits inside them; 20 s is far above a healthy parse (a 25-page text PDF parses
in well under a second here) and far below the 60 s poll interval, so one pathological file
cannot stack passes.

**Meanwhile.** PROVISIONAL — A implemented and tested.

**Changes if you answer differently.** `PDF_PARSE_TIMEOUT_MS` is an environment variable
(no code change). The rest are one-line constants: `MAX_ATTACHMENT_BYTES` and
`PARTIAL_READ_SCORE` in `src/extraction/extract.ts`, `PDF_MAX_PAGES` in
`src/extraction/pdfText.ts`. Tests reference the constants, not literals, except the
"10 MB limit" message.

---

### Q4 — Classifier confidence floor: is 0.70 right?

**Question.** A model label below this confidence is routed by the deterministic matcher
**and** held for a person.

**Options.** **A. 0.70** (provisional) · **B. 0.85** (stricter) · **C. 0.50** (looser) ·
**D. no floor** (only a *fallback* label holds).

**Recommendation.** **A until you have labelled data**, then set it from the harness
output — `scripts/eval-classifier.ts` lists every wrong label at or above the floor, which
is exactly the evidence needed. It is a routing threshold, not a decision threshold.

**Meanwhile.** PROVISIONAL — A.

**Changes if you answer differently.** One constant: `CLASSIFIER_MIN_CONFIDENCE` in
`src/categorize/index.ts`. Both test files import it, so they follow automatically.

---

### Q5 — A stranger quotes somebody else's reference: what should happen?

**Question.** Today that message is treated as conversation continuity: filed on the case
it names, nothing sent to the stranger, and the factual status answer stays reserved for
the contact on the case (all pinned by tests).

**Options.** **A. Keep it** (implemented) · **B. Park it** — keep the message in Mail with
no case, so a person decides · **C. Open a separate case** — never merge an unverified
sender into somebody else's case.

**Recommendation.** **A** for now: nothing is lost or disclosed, and colleagues replying on
a contact's behalf is common. Revisit if the pilot shows mis-filed mail (the runbook tells
you where to look).

**Meanwhile.** PROVISIONAL — A, pinned by a test so any change is deliberate.

**Changes if you answer differently.** B: in `src/matching/identity.ts`, require the sender
to match the case's contact for the quoted-reference path, so an unknown sender falls
through to the intake gate and parks. C: the same, plus a rule that opens a case for a
quoted reference from an unknown sender.

---

### Q6 — Should the console export a labelling file?

**Question.** Labelling 100 messages currently means copying subjects and bodies out of
Gmail by hand: the CSV exports cover cases, queues and the audit log, not mail text.

**Options.** **A. Add `GET /export/labels.csv`** (admin-only, `id,subject,body,
true_category` pre-filled, with a personal-data warning and an audit entry) · **B. No** —
keep mail text out of exports and label from the mailbox.

**Recommendation.** **A**, because hand-labelling is slow enough that people skip it, and
an unmeasured allowlist is what stands between you and automated sending.

**Meanwhile.** SKIPPED — Phase 4 lists only the harness, template, test and guide, and the
global rule against unlisted work applies. `docs/LABELLING-GUIDE.md` documents the manual
path and points here.

**Changes if you answer differently.** A: add the route beside `/export/audit.csv` (same
admin guard and CSV-injection escaping) plus a test that it is admin-only, escaped and
audited.
