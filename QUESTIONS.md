# QUESTIONS.md — one-line answers, please

Format: `Q<n>: <option letter>` (or a short value). Each entry states the question,
the options, my recommendation and why, what I did meanwhile (PROVISIONAL or
SKIPPED), what it affects, and exactly how to change it afterwards. The final
report re-orders these by impact.

## Answered by the owner before Part D (settled, kept for the trail)

| # | Question | Answer | Where it landed |
|---|---|---|---|
| Q1 | Attachment/PDF limits | A - keep 10 MB / 25 pages / 20 s parse budget / partial-read cap 60 | unchanged (Part C Phase 1) |
| Q2 | pdfjs-dist major upgrade | Stay on 3.11.174 unless the isolated Part D Phase 5 attempt passes every gate | Part D Phase 5 |
| Q3 | Legacy-name cleanup | A - stop here (`applicants.intake` and the legacy catalogue tables stay) | unchanged |
| Q4 | Classifier confidence floor | A - keep 0.70 | unchanged (`CLASSIFIER_MIN_CONFIDENCE`) |
| Q5 | Stranger quoting somebody else's reference | A - keep the current handling | unchanged, pinned by test |
| Q6 | Labelling export | A - add it | Part D Phase 1: `GET /export/labels.csv` |
| Q7 | Case-type routing | D - safety valve first, then alias routing; rule-based and classifier-based routing are OUT of scope for Part D | Part D Phases 2 and 3 |

The original long-form entries for Q1 to Q7 follow below the open questions.

## Open

### Q8 - After a person re-types a case, should the requirements check re-run?

**Question.** `POST /case/:id/case-type` moves a case to another case type. It re-freezes
the configuration snapshot (so the checklist and rules staff see are the new type's) but
does NOT re-evaluate: verdict, flags and outcome stay as they were, and the flash message
points at the existing **Re-evaluate** button. Should it re-evaluate automatically?

**Options.** **A. Freeze only, no re-evaluation** (implemented, PROVISIONAL) - a human
presses Re-evaluate when they want the new checklist scored; nothing is recomputed behind
their back. **B. Freeze and re-evaluate** - immediately coherent, but it recomputes flags
and verdict without anybody asking and can move a case between queues as a side effect of
a rename. **C. Freeze, re-evaluate and notify.**

**Recommendation.** A - also what the brief asked for provisionally. The product's
existing rule (PPR P0-3) is that a case keeps its frozen configuration until an *explicit*
re-evaluation, and re-typing is already an explicit human act; stacking a second invisible
consequence on it is how surprises happen.

**Meanwhile.** PROVISIONAL - A.

**Affects.** Whether a re-typed case immediately shows a verdict matching its new
checklist, or shows the older verdict until somebody presses Re-evaluate.

**How to change afterwards.** In the `POST /case/:id/case-type` handler
(`src/web/server.ts`), after `repo.reFreezeCaseConfig(...)`, call the same evaluation the
`/case/:id/reevaluate` route uses (B), plus `repo.notify("review_needed", ...)` for C.
`test/case-retype.test.ts` pins A ("leaves the recorded verdict alone") and would be
updated - not weakened - to the new behaviour.

### Q13 - How should the branch be published? (highest impact)

**Question.** Five workspace re-provisions have twice destroyed committed history. Origin
sits at `f4544c6` (Part C Phase 2) while local HEAD contains everything since, so
`git push` is rejected as non-fast-forward — and global rule 1 forbids both force-push and
merge. Nothing after Part C Phase 2 is durable: git-ignored bundles do not survive a
re-provision.

**Options.** **A.** Authorise one `git push --force-with-lease origin
arena/01a0f754-project-aa` (rewrites only the arena branch, never `main`) · **B.** Authorise
a merge or rebase of `f4544c6` into the restored history, then a normal push · **C.** Leave
it unpublished and accept the loss risk.

**Recommendation.** **A.** The content of `f4544c6` is fully contained in the restored tree
(it was re-committed byte-identically after the re-provision), so nothing is lost, and it is
the only option that stops the recurring loss of work.

**Meanwhile.** SKIPPED (rule 1 forbids it without your say-so); everything is bundled in
`backups/` and recorded in the reports.

**Affects.** Whether Part C Phases 3-7, all of Part D and the googleapis upgrade survive the
next re-provision.

**How to change afterwards.** Run the chosen command once; there is no code impact.

### Q12 - Clear the five dev-only advisories (vitest/vite major)?

**Question.** After the googleapis upgrade `npm audit` is 5 and every remaining advisory is
dev-only: `vitest` (critical — needs the Vitest UI server, which we never start), `vite`
(high), `@vitest/mocker`, `esbuild`, `vite-node` (moderate). None reaches `dist` or
`npm start`.

**Options.** **A.** Leave them, documented (current) · **B.** Migrate to vitest 5 / vite 7 in
its own isolated commit with the full gate suite · **C.** Replace vitest with `node:test`
and drop the vite toolchain entirely.

**Recommendation.** **A until after the pilot, then B.** The vitest config is what makes the
pdf.js 6 ESM bridge loadable (`server.deps.external`), so a runner migration is the one
change that could quietly undo Phase D5 — it deserves its own run with all 611 tests as the
net, not a slot beside a pilot.

**Meanwhile.** SKIPPED (outside this task's scope).

**Affects.** `npm audit` optics and dev-tooling CVEs only; nothing in production.

**How to change afterwards.** One isolated commit: `npm install -D vitest@5`, re-run every
gate, and specifically `test/pdf-hardening.test.ts` and `test/gmail-sandbox.test.ts`.

### Q11 - pdf.js 6 is in: accept Node >= 22.13 as the minimum runtime?

**Question.** Phase D5 upgraded `pdfjs-dist` 3.11.174 -> 6.3.289 (every gate passed,
including a compiled-boot read of a real PDF). It clears the last RUNTIME high advisory
(arbitrary JavaScript execution on a malicious PDF — v6 removed the eval paths entirely).
The unavoidable consequence: **pdf.js 6 requires Node >= 22.13**, and loading its ESM build
from our CommonJS code requires Node >= 22.12 (`require(esm)`). `package.json` engines,
README and `scripts/setup-linux.sh` now say 22.13+ / NodeSource 22.x.

**Options.** **A. Accept Node >= 22.13** (current state) · **B. Revert to 3.11.174** and
keep the hardening options only (one command: `git revert <the Phase D5 commit>`, then
`npm ci --ignore-scripts` and rebuild better-sqlite3) · **C. Keep v6 but pin the
deployment** to a container/base image you control, so the Node floor is not imposed on
every installer.

**Recommendation.** **A** if your hosts can run Node 22 (it is the current LTS line); it
removes the only runtime-critical dependency advisory and pdf.js 6 is where upstream
fixes land. **B** if any deployment is stuck on Node 20 — the mitigations from Part C
Phase 1 (no eval, no XFA, no remote fetching, parse budget, partial-read cap) remain in
place either way.

**Meanwhile.** PROVISIONAL - A: the upgrade is committed and all gates pass on Node
22.22.3. It is ONE isolated commit precisely so it can be reverted alone.

**Affects.** Which Node versions can run the product; one `high` advisory.

**How to change afterwards.** `git revert` the Phase D5 commit (it touches only
package.json/lock, `src/extraction/pdfOptions.ts`, `pdfText.ts`, `rasterize.ts`,
`src/types/pdfjs.d.ts`, the new `src/extraction/pdfjs-esm.mjs`, `vitest.config.ts`, one
source-scan assertion in `test/pdf-hardening.test.ts`, README and setup-linux.sh), then
`npm ci --ignore-scripts` + `npm rebuild better-sqlite3 --build-from-source`.

### Q10 - googleapis major bump (144 -> 182) to clear the uuid chain?  **ANSWERED: done**

> **Resolved (owner instruction, pre-pilot).** googleapis is now **182.0.0**
> (`googleapis-common` 9.1.0, `gaxios` 7.3.1, `google-auth-library` 11.1.0; `uuid` is no
> longer a dependency at all). **No source change was needed** — the Gmail client and
> sender compile and behave identically, and all 611 tests pass including the sandbox that
> drives the real client over HTTP. The four runtime advisories are gone: `npm audit` is
> 9 -> 5, and the remaining five (vitest critical, vite high, @vitest/mocker, esbuild,
> vite-node) are dev-only and never reach `dist`/`npm start`. The original entry follows
> for the trail.


**Question.** Five of the ten remaining advisories (`uuid`, `gaxios`,
`googleapis-common`, `googleapis`, and one moderate) are one chain: googleapis 144 pins
`gaxios ^6.0.3` and `uuid ^9.0.0`, gaxios 6.7.1 is the LAST 6.x, and the uuid fix is
11.1.1. So there is **no semver-compatible fix** — `npm audit fix` without `--force`
correctly changes nothing (npm's `fixAvailable: true` on gaxios is optimistic; the only
path it can compute is a major).

**Options.** **A. Stay on googleapis 144** (current) — the exposure is narrow: uuid's
advisory is a missing buffer bounds check that only triggers when a caller passes a `buf`
option, which googleapis does not. **B. Bump googleapis to 182** — four majors; it is the
Gmail wire path, so it needs the full gate suite plus the Gmail sandbox tests and a
pilot re-run. **C. Override uuid to 11 inside googleapis-common** — not semver-compatible
and could break its v4 usage; I would not.

**Recommendation.** **A now, B before the Gmail pilot** (Part D Phase 5's lesson is that a
major upgrade is a project, not a bump — and the pilot is the moment you want the newest
client library anyway, tested against a real mailbox).

**Meanwhile.** SKIPPED - Phase 4 kept only semver-compatible changes, and there were none.

**Affects.** Five moderate advisories in `npm audit`, all in one runtime chain; nothing
else.

**How to change afterwards.** `npm install googleapis@182 --ignore-scripts`, then run all
gates plus `test/gmail-sandbox.test.ts` (it drives the real client over a local sandbox,
so it is the right net for this), and re-run the pilot runbook.

### Q9 - Plus-addressing in alias routing

**Question.** Should `intake+billing@example.org` route like `billing@example.org`?

**Options.** **A. Honour the tag** - match the local part before `+` as well as the exact
address (implemented, PROVISIONAL). **B. Exact addresses only** - a tagged address matches
nothing and falls through to the single-case-type inference or `unconfigured_case`.

**Recommendation.** A - plus-addressing is an ordinary mailbox feature, and it is safe
here because the tag is stripped only for matching, never stored; an address that matches
nothing still falls back to a human rather than guessing.

**Meanwhile.** PROVISIONAL - A (Part D Phase 3).

**Affects.** Whether tagged sub-addresses route to a case type or fall through to a human.

**How to change afterwards.** One function, `aliasKeyCandidates()` in `src/db/repo.ts` -
drop the tag-stripping branch for B. `test/alias-routing.test.ts` covers both paths.


---

## Q1 — Attachment/PDF limits: are my provisional numbers right?

**Question.** What are the maximum attachment size, maximum PDF page count and
PDF parse time budget before a file is refused and handed to a person?

**Options.**
- **A. Keep the provisional set** — 10 MB per attachment (pre-existing), 25 pages
  read (pre-existing), 20 s parse budget (new), partial reads scored 60 (below the
  75 auto-pass floor).
- **B. Stricter** — 5 MB / 15 pages / 10 s. Fewer resources per message, more
  legitimate files pushed to a human.
- **C. Looser** — 20 MB / 50 pages / 45 s. Reads more of each file; one hostile
  file can occupy an intake pass for up to 45 s.

**Recommendation.** A. 10 MB and 25 pages were already the product's numbers and
real intake mail fits inside them; 20 s is far above a healthy parse (a 25-page
text PDF parses in well under a second here) and far below the 60 s poll interval,
so one pathological file cannot stack up passes.

**Meanwhile.** PROVISIONAL — implemented as A.

**Affects.** Which attachments are processed automatically versus handed to a
person; intake throughput under hostile mail.

**How to change afterwards.** `PDF_PARSE_TIMEOUT_MS` is an environment variable
(no code change). The others are one-line constants: `MAX_ATTACHMENT_BYTES` and
`PARTIAL_READ_SCORE` in `src/extraction/extract.ts`, `PDF_MAX_PAGES` in
`src/extraction/pdfText.ts`. Tests in `test/pdf-hardening.test.ts` reference the
constants, not literals, except the "10 MB limit" message.

---

## Q2 — pdfjs-dist major upgrade (3.11.174 → 6.x): attempt or defer?

**Question.** The only advisory with a genuine runtime exposure here is
`pdfjs-dist` (arbitrary JavaScript execution on a malicious PDF). Fixing it means
a major upgrade. Do you want it attempted now, or deferred to its own change?

**Options.**
- **A. Defer** (what I did) — stay on 3.11.174 with the hardening options applied
  (`isEvalSupported: false`, `enableXfa: false`, no range/stream/auto-fetch), and
  treat the advisory as mitigated-but-present.
- **B. Attempt now in a branch of its own** — v4+ ships **ESM only**
  (`build/pdf.mjs`); this project is strict CommonJS with `module: commonjs`, so
  the load has to become a real dynamic `import()` that TypeScript will not
  downlevel to `require()`. That means either `module: node16/nodenext` for the
  whole project or an eval-based import shim — both touch every file's module
  semantics.
- **C. Replace the PDF text layer** with a different extractor and drop pdfjs.

**Recommendation.** A now, B as a scheduled piece of work with its own review.
The mitigation is real (script evaluation and XFA are off, and we hand pdf.js a
complete local buffer so it cannot fetch), the upgrade is a module-system
migration rather than a version bump, and rule 6/7 make a half-finished module
migration the worst outcome.

**Attempted and reverted (evidence).** I did attempt B, twice, inside this run:
- pdfjs 6.3.289 installs cleanly, **loads** and **parses our PDFs correctly**
  under plain `tsx` (probe: `PARSE OK pages: 1 items: 2`), and its optional
  renderer is `@napi-rs/canvas` (prebuilt) so the `tar`/`node-pre-gyp` chain stays
  gone. `isEvalSupported` no longer exists in v6 at all — the eval code paths were
  removed upstream, which is the fix for the advisory.
- Blocker 1: v6 is **ESM-only** (`legacy/build/pdf.mjs`). This project compiles to
  CommonJS, where TypeScript downlevels `import()` to `require()`. Loading it needs
  a runtime dynamic import, and under **vitest/Vite** that fails with
  `TypeError: A dynamic import callback was not specified.` — so the whole test
  suite (55 extraction/pipeline/simulation tests that read PDFs) goes red. It
  works in plain node and tsx, i.e. production would run but tests could not.
- Blocker 2: v6 removed `PDFDocumentProxy.destroy()` (teardown moved to the
  loading task), which needed a handle change at three call sites — done, and not
  the blocker.
- Blocker 3: `src/types/pdfjs.d.ts` declares the CJS module path by hand and would
  need rewriting for the ESM entry.
Conclusion: the upgrade is a **module-system migration** (`"type": "module"` +
`module: node16` in tsconfig, or dropping vitest/Vite for a CJS-compatible
runner), not a dependency bump. Reverted to 3.11.174 with the Phase 1a hardening;
no upgrade commit exists.

**Meanwhile.** SKIPPED (option A), after two documented repair attempts.

**Affects.** One `high` advisory stays open in `npm audit`; nothing else.

**How to change afterwards.** Say "Q2: B" and the work is: switch `tsconfig.json`
`module` to `node16`, replace the single `require("pdfjs-dist/legacy/build/pdf.js")`
in `src/extraction/pdfOptions.ts` with `await import("pdfjs-dist/legacy/build/pdf.mjs")`,
then re-run all gates. Because Phase 1 collapsed every pdf.js open into that one
module, the migration is now a one-file change plus the tsconfig switch.

---

## Q3 — How far should the legacy-name cleanup go?

**Question.** C2 renamed the column that actually holds case-type data
(`applicants.programme` → `case_type_code`, plus `evaluations.programme`) and made
submission windows tenant-scoped. Three legacy names remain. Which of them do you
want retired?

**Options.**
- **A. Stop here** (what I did) — keep `applicants.intake` (holds the submission
  window name), and keep the legacy catalogue tables `programmes`,
  `course_doc_requirements`, `requirement_rules` with their helpers
  (`listProgrammes`, `programmeByCode`, `assignProgrammeOwner`, `inferProgramme`).
  They are read-only compatibility surfaces for migrated rows; `inferProgramme`
  still has regex-safety tests.
- **B. Also rename `applicants.intake` → `window_name`** — same additive rename
  mechanism, one more entry in `migrations/legacy-storage.json`, ~10 code sites.
- **C. Also retire the legacy catalogue** — drop the three tables and their
  helpers. This deletes migrated rows (owner assignments, legacy requirement
  matrices) and removes `inferProgramme` plus its two tests.

**Recommendation.** A now; B if you want the schema to read cleanly (cheap and
safe); C only after you confirm on the real database that those tables are empty
or worthless — it is the only destructive option in this list, and rule 5 kept me
away from it.

**Meanwhile.** PROVISIONAL — A. Nothing beyond the two renames and the `intakes`
rescoping was touched.

**Affects.** Schema readability and how much of the old domain's storage remains
reachable. No behaviour difference today.

**How to change afterwards.** B: add `"applicants": { "intake": "window_name" }` to
`migrations/legacy-storage.json`, rename in `src/db/db.ts` (SCHEMA), `src/types.ts`
(`ApplicantRow.intake`), `src/db/repo.ts`, `src/web/pages.ts`, `src/pipeline/index.ts`,
then extend the legacy-copy test. C: drop the tables in `dropObsolete()`, delete the
helpers and `test/enrich.test.ts`'s programme block, and re-run the gates.

---

## Q4 — Classifier confidence floor: is 0.70 right?

**Question.** A message labelled by the model below this confidence is routed by
the deterministic matcher **and** held for a person. What should the floor be?

**Options.** **A. 0.70** (provisional, implemented) · **B. 0.85** (stricter: more
messages held, fewer automated) · **C. 0.50** (looser) · **D. no floor** (only a
*fallback* label holds).

**Recommendation.** A until you have labelled data, then set it from
`scripts/eval-classifier.ts` output (Phase 4 prints the confidence distribution of
wrong answers). 0.70 is a routing threshold, not a decision threshold: nothing is
ever decided by it, it only chooses between "a person reads this first" and "the
configured reply may go out".

**Meanwhile.** PROVISIONAL — A.

**Affects.** How many messages with a model label are held for a person.

**How to change afterwards.** One constant: `CLASSIFIER_MIN_CONFIDENCE` in
`src/categorize/index.ts`. `test/safe-by-default.test.ts` and
`test/message-categories.test.ts` import the constant, so they follow automatically.

---

## Q5 — A stranger quotes somebody else's reference: what should happen?

**Question.** Today a message from an unknown sender that quotes a valid reference
is treated as conversation continuity: it is filed on the case it names, and no
reply is ever addressed to the stranger (pinned by tests). Is that what you want?

**Options.**
- **A. Keep it** (implemented) — the message is retained on the quoted case; staff
  see the real sender; nothing is sent to the stranger; the factual status answer
  stays reserved for the contact on the case.
- **B. Park it** — keep the message in Mail with no case, so a person decides
  whether it belongs to that case (stricter, more manual triage).
- **C. Open a separate case** — never merge an unverified sender into somebody
  else's case (cleanest separation, but splits genuine threads where a colleague
  replies on the contact's behalf).

**Recommendation.** A for now: it loses nothing, discloses nothing, and colleagues
replying on a contact's behalf is common. Revisit if you see mis-filed mail in the
pilot (Phase 5 tells you how to look).

**Meanwhile.** PROVISIONAL — A, and pinned by a test so a change is deliberate.

**Affects.** Where an unverified reply lands, and how much triage staff do.

**How to change afterwards.** B: in `src/matching/identity.ts`, require the sender
to match the case's contact for the quoted-reference path (`emailTargetsKnownApplicant`),
so an unknown sender falls through to the intake gate and parks. C: same change
plus a rule that opens a case for a quoted reference from an unknown sender.

---

## Q6 — Should the console export a labelling file?

**Question.** To label 100 real messages you currently have to copy subjects and bodies
out of Gmail by hand: the console's CSV exports cover cases, queues and the audit log,
but not message text. Do you want a `GET /export/labels.csv` (admin-only) that writes
`id,subject,body,true_category` with the current category pre-filled and the bodies
left for a human to check?

**Options.** **A. Yes, add it** (admin-only, redacted ids, and it would need its own
"this file contains personal data" warning plus an audit entry) · **B. No** — keep mail
text out of exports entirely and label from the mailbox.

**Recommendation.** A, with the audit entry and a warning in the download, because
labelling by hand is slow enough that people will skip it — and an unmeasured allowlist
is the thing standing between you and automated sending. It is a small route over data
the console already reads.

**Meanwhile.** SKIPPED — Phase 4 lists only the harness, template, test and guide, and
global rule "do not start work that is not listed" applies. `docs/LABELLING-GUIDE.md`
documents the manual path and points here.

**Affects.** How much effort each labelling round takes (and therefore how often you
re-measure).

**How to change afterwards.** Add the route next to `/export/audit.csv` in
`src/web/server.ts` (same admin + CSV-injection guard), writing `emails.id`, subject,
body and the stored category; add a test that the export is admin-only, escaped, and
audited.

---

## Q7 — How should inbound mail be routed to a case type?

**Question.** A tenant with several case types cannot route real inbound mail between
them: only the portal/test-intake page declares a case type, so every such case is
`unconfigured_case` (empty checklist, human review) and type-scoped rules never fire.
Phase B4 covers only the single-case-type tenant. Which option do you want?

**Options.** **A.** Organization-wide intake rules declare the case type (one new action
key + two-pass evaluation) · **B.** The classifier's label maps to a case type (measurable
via the Phase C4 harness, but puts a model in the routing path) · **C.** The delivered
address/alias picks the case type (deterministic, needs aliases per service) ·
**D.** C first, then A, with B only after labelling results — my recommendation.

**Recommendation.** D, and in every case build the safety valve first: expose
`updateCase({case_type_id})` on the case page so a person can re-type a mis-routed case
(the repo method exists; no route does). Full trade-offs in
`docs/DESIGN-case-type-routing.md`.

**Meanwhile.** SKIPPED — Phase 6 is explicitly a design note; nothing was implemented.

**Affects.** Whether a multi-service tenant can automate at all, and how explainable
routing is in the audit trail.

**How to change afterwards.** Follow the "Suggested order of work" at the end of
`docs/DESIGN-case-type-routing.md`: safety valve → C → A → measure → B.
