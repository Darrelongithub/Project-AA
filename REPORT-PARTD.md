# REPORT — Part D (routing safety valve, alias routing, labelling export, audit fix, pdfjs migration)

Autonomous run on branch `arena/01a0f754-project-aa`, 2026-10-02 07:40 → 08:50 UTC.
Owner decisions Q1–Q7 were treated as settled. Every phase committed, bundled, and a push
attempted. Gates run at baseline and after every phase: `npm run typecheck`, `npm test`,
`npm run simulate`, `npm run stress` (seed 7331), `npm run build` + a compiled boot, and
`rg -i 'riara|kcse|kcpe|igcse|admission' src` = 0.

**Incident (rule 2).** The workspace re-provisioned a **fourth** time immediately before
this run (07:40 UTC): HEAD was reset to the base commit `47c025a`, all ten Part C commits
were discarded as objects, `node_modules` was wiped, **and `backups/` was empty** — because
it is git-ignored, and ignored paths are excluded from the snapshot that survives a
re-provision. Nothing outside the repository survives either (`/home/user` held only the
repo). The working tree survived, so the identical Part C tree was re-committed as
`04efd07` (DECISIONS.md D1 note, recorded in the commit message) and dependencies were
rebuilt (`npm ci --ignore-scripts` + a local-headers `better-sqlite3` rebuild). **Operational
consequence: bundles in a git-ignored directory are not a durable backup in this
environment** — they protect against a bad edit, not against a re-provision. Only a
successful `git push` does, and that is currently blocked (see (d)).

## a) Status table

| Phase | Status | Commit | Gates before | Gates after |
|---|---|---|---|---|
| **0** Preflight + restore | DONE | `04efd07` | — | typecheck clean · **582** tests: 581 pass / 0 fail / 1 env-skip (74 files) · simulate 409/409 (26 scenarios) · stress 1000/1000 + 11/11 · build + compiled boot (healthz 200, `/`→`/setup`, fresh DB empty) · grep 0 · audit **10** |
| **1** Labelling export (Q6) | DONE | `5346bef` | Phase 0 gates | typecheck clean · **591**: 590 / 0 / 1 · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot · grep 0 · audit 10 |
| **2** Routing safety valve (Q7 step 1) | DONE | `a6f21ca` | Phase 1 gates | typecheck clean · **600**: 599 / 0 / 1 · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot · grep 0 · audit 10 |
| **3** Alias routing (Q7 step 2) | DONE | `97c794b` | Phase 2 gates | typecheck clean · **611**: 610 / 0 / 1 · simulate 409/409 · stress 1000/1000 + 11/11 · build + compiled boot (fresh DB has `case_type_aliases`) · grep 0 · audit 10 |
| **4** `npm audit fix` (no `--force`) | DONE — **changed nothing** (no semver-compatible fix exists) | `83592c1` | Phase 3 gates | unchanged: 611 / 610 / 0 / 1 · 409/409 · 1000/1000 + 11/11 · build + boot · grep 0 · audit **10 → 10** |
| **5** pdfjs-dist 6 migration (isolated) | DONE — **KEPT** (every gate passed) | `df62738` | Phase 4 gates | typecheck clean · **611**: 610 / 0 / 1 · simulate 409/409 · stress 1000/1000 + 11/11 · build (bridge copied into `dist`) + compiled boot + **compiled `pdfRead` of a generated PDF → status `ok`, correct text** · grep 0 · audit **10 → 9** |
| **6** Final | DONE | this commit | Phase 5 gates | see below |

**Final gates on the finished state**

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (0 errors, `src/`, `test/`, `scripts/`) |
| `npm test` | **611 tests: 610 passed, 0 failed, 1 skipped** across 77 files; no file failed at hook level. The skip is `test/responsive.test.ts` (needs a Chromium binary and says so). |
| `npm run simulate` | **409/409 checks, 26/26 scenarios — ALL GREEN**, exit 0 |
| `npm run stress` | **1000/1000 cases clean** (seed 7331); **11/11** replays identical |
| `npm run build` + compiled boot | builds (and copies the ESM bridge into `dist`); `/healthz` 200, `/` 302 → `/setup`; **compiled `pdfRead` of a real generated PDF returns `ok` with the right text** |
| `rg -i 'riara\|kcse\|kcpe\|igcse\|admission' src` | **0 matches** |

Tests went 582 → 611 (+29): `labels-export` (9), `case-retype` (9), `alias-routing` (10),
`ppr-p07-migration` (+1). **No test was deleted, skipped or weakened.** Two assertions were
*changed because behaviour intentionally changed*, both logged in DECISIONS.md: eight
auto-send tests now open the Phase C allowlist through `releaseAutomation()` (D8, Part C),
and the pdf-hardening source-scan now expects the pdf.js specifier in the externalized
`.mjs` bridge and scans `.mjs` too — a stronger claim than before (D15).

### What each phase delivered

**Phase 1 — `GET /export/labels.csv` (Q6).** Admin-only, beside `/export/audit.csv`, same
CSV helper and formula-injection escaping. Columns `id,subject,body,true_category` with
`true_category` **deliberately blank**. Tenant-scoped at both layers (the route resolves
the acting admin's organization and ignores `?organization_id=`; the new
`repo.labelableMessages(organizationId, limit)` filters in SQL). Capped: default 200, hard
maximum 1000, garbage/negative → default; most recent first (the `ORDER BY` is qualified —
an unqualified `id` resolved to the `message_id` alias and sorted alphabetically). Parked
(case-less) mail is included, because the messages a classifier must learn to refuse are
part of the measurement. Marked as personal data three ways: a `#` note line inside the
file (the harness skips comment lines before the header), an ASCII-only `X-Personal-Data`
header (Node rejects non-ASCII header values — found the hard way), and a `labels_exported`
audit entry naming actor, row count, organization and the fact that it holds personal data.
`docs/LABELLING-GUIDE.md` now starts from the export.

**Phase 2 — the routing safety valve (Q7 step 1).** `POST /case/:id/case-type`, open to any
staff member who can see the case (requireLogin + CSRF + the existing visibility/tenant
guard), like the other case edits. The target must be one of the **case's** organization's
types; a forged id is refused, another tenant's admin cannot reach the case at all, and a
no-op says so. `Repo.updateCase` now keeps `case_type_code` and `category` coherent with
`case_type_id` in the same transaction, so a case can never be two cases at once. The
configuration snapshot is re-frozen (so the checklist and rules staff see are the new
type's) while the recorded verdict is left untouched until somebody presses Re-evaluate —
PROVISIONAL per the brief, Q8. Audited `case_type_changed` with actor and both ends. Sends
nothing and fires no rule even with every automation switch released and a send rule armed
on the target type (tested). The control sits on the case page under the reference line, in
the tenant's own vocabulary, listing only that organization's types.

**Phase 3 — alias routing (Q7 step 2).** New additive table `case_type_aliases`
(`organization_id`, `case_type_id`, `address`, `active`) with **`address` UNIQUE across the
whole installation** — a mailbox address can never belong to two tenants. Resolution reads
the recipients ingestion already parses (Delivered-To/To/Cc), case-insensitive, stripping
display names and angle brackets, honouring plus-addressing (`intake+billing@…` routes like
`billing@…`; PROVISIONAL, Q9), and considers **only the message's own tenant's** active
aliases. Precedence: connector declaration → alias → single-case-type default → nothing.
Two aliases on one message pointing at different types are ambiguous: the case stays
unconfigured with a flag whose detail names both addresses, audit
`case_type_alias_ambiguous`, and a `review_needed` notification — a person uses the Phase 2
control. Audit `case_type_by_alias` names the alias that routed the case. Routes
`POST /config/case-type-aliases/{create,retire}` are admin-only and tenant-guarded
(foreign case type refused; an address another tenant holds refused; another tenant's
address cannot be retired). Retiring keeps the row and stops the routing. Minimal UI on
Configuration → CaseTypes (`#aliases`), forms rendered only for the acting admin's own
tenant. Migration idempotency is pinned in `ppr-p07-migration` (11th test).

**Phase 4 — `npm audit fix` without `--force`: nothing to keep.** `package.json` and
`package-lock.json` are byte-identical afterwards; the audit stays at 10. There is **no
semver-compatible fix**: the five-advisory `uuid`/`gaxios`/`googleapis-common`/`googleapis`
chain can only be cleared by a googleapis major (144 → 182) — gaxios 6.7.1 is the last 6.x
and still depends on `uuid ^9.0.1`, while googleapis-common 7.2.0 pins `gaxios ^6.0.3` and
`uuid ^9.0.0`, and the uuid fix is 11.1.1. npm's `fixAvailable: true` on gaxios is
optimistic; every path it can compute is `isSemVerMajor`. A `--dry-run` also wanted to add
platform-specific optional rollup/fsevents binaries to the lock — refused as unrelated
churn. Q10 records the choice.

**Phase 5 — pdfjs-dist 3.11.174 → 6.3.289, kept (one isolated commit).** This clears the
last **runtime** high advisory (arbitrary JavaScript execution on a malicious PDF): v6
removed the eval code paths and the `isEvalSupported` option with them, which is a
structural fix rather than the mitigation available on 3.x. The Part C blocker is solved —
pdf.js is now loaded through `src/extraction/pdfjs-esm.mjs`, a one-line bridge
**externalized in `vitest.config.ts`** so Node's real ESM loader executes it (inside a
transformed module a runtime `import()` has no import callback, which is what reddened
every PDF-reading test before); CommonJS `require()`s that ES module. The build script
copies the bridge into `dist`. v6 also removed `PDFDocumentProxy.destroy()`, so opens
return `{doc, close}` and teardown goes through the loading task (three call sites), and
`src/types/pdfjs.d.ts` now declares the bridge. **Unchanged:** the hardened-options file is
still the single `getDocument` call site, with the parse budget, the partial-read cap and
every hardening option (the source-scan test now also asserts the specifier lives only in
the bridge). **Consequence, disclosed:** pdf.js 6 requires Node ≥ 22.13, so `engines`,
README and `scripts/setup-linux.sh` (NodeSource 22.x) now say so — Q11, and the commit is
isolated precisely so it can be reverted alone.

## b) npm audit — before and after

| | total | critical | high | moderate | low |
|---|---|---|---|---|---|
| Before Part D (Phase 0) | 10 | 1 | 2 | 7 | 0 |
| After Phase 4 (`audit fix`, no `--force`) | 10 | 1 | 2 | 7 | 0 |
| **After Phase 5 (final)** | **9** | **1** | **1** | **7** | **0** |

Removed in Phase 5: **`pdfjs-dist` (high, runtime)** — the only remaining advisory with a
genuine exposure in this product, since we open untrusted PDF attachments.

Remaining 9, all documented and not fixed:

| Package | Sev | Where | Exposure here | Fix |
|---|---|---|---|---|
| `vitest` 2.1.9 | critical | dev-only | Needs the Vitest **UI server** listening; never run; absent from `dist`/`npm start` | major (vitest 5) |
| `vite` 5.4.21 | high | dev-only | No Vite dev server is ever run | major |
| `@vitest/mocker`, `esbuild`, `vite-node` | moderate | dev-only | as above | major |
| `uuid` ← `gaxios` ← `googleapis-common` ← `googleapis` | moderate ×4 | **runtime** (Gmail) | uuid's missing buffer bounds check only triggers when a caller passes a `buf` option; googleapis does not | googleapis major 144 → 182 (Q10) |

(For the record, Part C had already taken the count from 13 → 10 by removing the nested
optional `canvas@2.11.2` chain — `tar` critical, `@mapbox/node-pre-gyp` high, `canvas` high.)

## c) Secrets scan

- **Added lines, `git diff 47c025a..HEAD`** (the whole Part B/C/D changeset) scanned for
  `AIza…`, `GOCSPX-…`, `ya29.…`, `1//…`, `-----BEGIN … PRIVATE KEY-----`, `xox[baprs]-…`,
  `ghp_…`, `github_pat_…`, `sk-…`: exactly two hits, both obvious test placeholders —
  `AIzaFakeKeyForUnitTestsOnly` (`test/gemini-model.test.ts`) and
  `ya29.sandbox-access-token` (`test/gmail-sandbox.test.ts`, which exists to stop
  google-auth-library attempting a token refresh against the local sandbox). Both also
  appear as text inside `REPORT-PARTC.md`'s own secrets-scan section.
- **Every tracked file** (`git grep`): the same two placeholders and nothing else. No
  private keys, no real tokens, no real credentials, no password hashes beyond
  `hashPassword()` of literal test passwords.
- **No `.env` is tracked or present**; `.env.example` carries empty values only.
- **Bundles:** `git bundle verify` reports the final bundle "is okay / records a complete
  history". Caveat stated plainly: a bundle is a zlib-compressed packfile, so a `strings`
  scan cannot see file contents — the authoritative scan is the tree/diff scan above.
- **No real Gmail or Gemini endpoint was called** at any point in this run, and no real
  email was sent. The only outbound network use was the npm registry and the (failed)
  `git push` attempts.

## d) Backups and push

13 files in `backups/` (git-ignored): bundles `phaseD0-…`, `phaseD1-…`, `phaseD2-…`,
`phaseD3-…`, `phaseD4-…`, `phaseD5-…`, `phaseD6-final-20261002T084934Z.bundle` plus a
`tree-<timestamp>.tar.gz` archive of the tracked tree at Phases 0, 1, 2, 3, 5 and 6.

**The push does not work.** Two distinct failures, in order:

1. Phases 0–4: `! [rejected] … (fetch first)` — **non-fast-forward**. The 07:40
   re-provision rewrote local history (Part C's pushed tip `f4544c6` is no longer an
   ancestor of the restored tree), and rule 1 forbids both force-push and merge, so there
   is no permitted way to reconcile. Origin still holds Part C up to `f4544c6`.
2. Phase 5 onward: `fatal: could not read Username for 'https://github.com': terminal
   prompts disabled` — the credential helper disappeared again.

So **all of Part D exists only in the local repository and the bundles**. Restoring GitHub
auth will not be enough on its own: because history was rewritten, publishing it needs
either a force-push (forbidden here) or a merge/rebase onto origin's tip (also forbidden
here) — that is your call, and it is listed in (e).

## e) What still needs you

1. **Publish Part D.** GitHub auth must be restored *and* the divergence resolved. The
   clean options: (a) allow a one-time `git push --force-with-lease origin
   arena/01a0f754-project-aa` (rewrites the arena branch only, never `main`), or (b) allow
   a merge/rebase of `f4544c6` into the restored history. I did neither, because rule 1
   forbids both. Until then, `backups/phaseD6-final-*.bundle` is the only copy — and it
   will not survive another re-provision.
2. **Run the C2 migration on the real database** — `docs/RUNBOOK-C2-MIGRATION.md`
   (verified backup → dry run on a copy → row counts and spot-checks → the original →
   exact rollback). Still never run against any real or tenant database.
3. **Label 100 real messages and run the harness** — export with the new
   `GET /export/labels.csv`, strip personal data, label per `docs/LABELLING-GUIDE.md`, then
   `scripts/eval-classifier.ts`. The auto-send allowlist should stay empty until a category
   clears precision ≥ 95 % on ≥ 30 examples.
4. **Run the Gmail pilot** — `docs/PILOT-RUNBOOK.md`, throwaway mailbox and database, with
   the draft-only switch verified on first. It now includes alias, ambiguity and re-type
   test messages (11–13) and three matching go/no-go boxes.
5. **Decide Q11 (Node ≥ 22.13) before deploying**, since it changes what your hosts must
   run; and Q10 (googleapis major) ideally before the pilot.

## f) What I could not verify

- **Real Gmail and real Gemini** — never called (rule 4). The wire path remains verified
  only against the local sandbox that mimics Gmail's HTTP shape (`test/gmail-sandbox.test.ts`),
  which now runs on pdf.js 6 but still does not prove real OAuth refresh, quota/429
  behaviour, label semantics or deliverability.
- **The C2 migration on a real customer database** — proven on the synthetic
  production-shaped copy in `test/ppr-p07-migration.test.ts` (now 11 tests, including the
  new alias table and the failed-migration integrity check).
- **pdf.js 6 on Node 20** — it cannot work there (that is the point of the `engines` bump);
  everything was verified on Node 22.22.3 only. I did not verify that every deployment
  target you have can run 22.13+.
- **OCR/raster quality on pdf.js 6** — `canvas` cannot be built in this environment, so the
  rasterise-then-OCR tier exercises its safe fallback; the render path's hardened options
  and `{doc, close}` teardown typecheck and run, but no real page was rasterised here.
- **Chromium-dependent UI checks** — `test/responsive.test.ts` and `scripts/ui-*.mts` skip
  without a browser binary; the new alias card and re-type control were verified through
  HTTP and markup assertions, not visually.
- **Alias routing against a real mailbox** — plus-addressing behaviour depends on the
  provider (some strip or reject tags); the pilot's message 11 is designed to catch that.
- **Concurrency beyond the tested races**, and multi-process ingestion at volume.
- **Bundle contents by string scan** (compressed packfiles) — verified structurally instead.

## g) QUESTIONS — ordered by impact

Answer each in one line, e.g. `Q11: A`. Q1–Q7 were settled before this run and are recorded
in `QUESTIONS.md` (all implemented as answered: Q1/Q3/Q4/Q5 kept as they were, Q6 built in
Phase 1, Q7 option D built in Phases 2–3 with rule-based and classifier-based routing left
out, Q2 resolved by Phase 5).

---

### Q11 (highest impact) — pdf.js 6 is in: accept Node ≥ 22.13 as the minimum runtime?

**Question.** Phase 5 upgraded `pdfjs-dist` to 6.3.289 and every gate passed, clearing the
last runtime `high` advisory. pdf.js 6 requires **Node ≥ 22.13** (and CommonJS `require()`
of its ESM build needs ≥ 22.12), so `engines`, README and `scripts/setup-linux.sh`
(NodeSource 22.x) now say so.

**Options.** **A. Accept Node ≥ 22.13** (current state) · **B. Revert to 3.11.174** and keep
only the Part C hardening options · **C. Keep v6 but pin deployment to a base image you
control**, so the floor is not imposed on every installer.

**Recommendation.** **A** if your hosts can run Node 22 (the current LTS line): it removes
the only runtime-critical dependency advisory, and v6 is where upstream fixes land. **B** if
anything is stuck on Node 20 — the mitigations (no eval, no XFA, no remote fetching, parse
budget, partial-read cap) stay in place either way.

**Meanwhile.** PROVISIONAL — A: committed, all gates green on Node 22.22.3, in **one
isolated commit** so it can be reverted alone.

**Affects.** Which Node versions can run the product; one `high` advisory.

**How to change afterwards.** `git revert df62738`, then `npm ci --ignore-scripts` and
`npm rebuild better-sqlite3 --build-from-source`. That commit touches only
`package.json`/lock, `src/extraction/{pdfOptions,pdfText,rasterize}.ts`, the new
`src/extraction/pdfjs-esm.mjs`, `src/types/pdfjs.d.ts`, `vitest.config.ts`, one source-scan
assertion in `test/pdf-hardening.test.ts`, README and `scripts/setup-linux.sh`.

---

### Q10 — googleapis major bump (144 → 182) to clear the uuid chain?

**Question.** Five of the nine remaining advisories are one chain: googleapis 144 pins
`gaxios ^6.0.3` and `uuid ^9.0.0`; gaxios 6.7.1 is the last 6.x; the uuid fix is 11.1.1. So
`npm audit fix` without `--force` correctly changes nothing.

**Options.** **A. Stay on googleapis 144** (current) — narrow exposure: uuid's advisory is a
missing buffer bounds check that only triggers when a caller passes a `buf` option, which
googleapis does not · **B. Bump to googleapis 182** (four majors) — it is the Gmail wire
path, so it needs the full gates plus `test/gmail-sandbox.test.ts` and a pilot re-run ·
**C. Override uuid to 11 inside googleapis-common** — not semver-compatible; I would not.

**Recommendation.** **A now, B before the Gmail pilot** — Phase 5's lesson is that a major
upgrade is a project, not a bump, and the pilot is exactly when you want the newest client
library, tested against a real mailbox.

**Meanwhile.** SKIPPED — Phase 4 kept only semver-compatible changes, and there were none.

**Affects.** Five moderate advisories in one runtime chain; nothing else.

**How to change afterwards.** `npm install googleapis@182 --ignore-scripts`, then all gates
plus `test/gmail-sandbox.test.ts` (it drives the real client over a local sandbox, so it is
the right net), then re-run the pilot runbook.

---

### Q8 — After a person re-types a case, should the requirements check re-run?

**Question.** `POST /case/:id/case-type` re-freezes the configuration snapshot (so the
checklist and rules staff see are the new type's) but does **not** re-evaluate: verdict,
flags and outcome stay as they were until somebody presses Re-evaluate.

**Options.** **A. Freeze only, no re-evaluation** (implemented) · **B. Freeze and
re-evaluate** — immediately coherent, but recomputes flags and verdict without anybody
asking and can move a case between queues as a side effect of a rename · **C. Freeze,
re-evaluate and notify.**

**Recommendation.** **A** — also what the brief asked for provisionally. PPR P0-3 already
says a case keeps its frozen configuration until an *explicit* re-evaluation, and re-typing
is already an explicit human act; stacking a second invisible consequence on it is how
surprises happen.

**Meanwhile.** PROVISIONAL — A.

**Affects.** Whether a re-typed case immediately shows a verdict matching its new
checklist, or shows the older verdict until Re-evaluate.

**How to change afterwards.** In the `POST /case/:id/case-type` handler, after
`repo.reFreezeCaseConfig(...)`, call the same evaluation `/case/:id/reevaluate` uses (B),
plus `repo.notify("review_needed", …)` for C. `test/case-retype.test.ts` pins A ("leaves the
recorded verdict alone") and would be updated — not weakened.

---

### Q9 — Plus-addressing in alias routing: keep honouring the `+tag`?

**Question.** Should `intake+billing@example.org` route like `billing@example.org`?

**Options.** **A. Honour the tag** (implemented) — the local part before `+` is also tried ·
**B. Exact addresses only** — a tagged address matches nothing and falls through to the
single-case-type default or `unconfigured_case`.

**Recommendation.** **A**: plus-addressing is an ordinary mailbox feature and it is safe
here — the tag is stripped only for matching, never stored, and an address that matches
nothing still falls back to a human rather than guessing. Verify it in the pilot (message
11), because some providers strip or reject tags.

**Meanwhile.** PROVISIONAL — A.

**Affects.** Whether tagged sub-addresses route to a case type or fall through to a person.

**How to change afterwards.** One function — `aliasKeyCandidates()` in `src/db/repo.ts`:
drop the tag-stripping branch for B. `test/alias-routing.test.ts` covers both the tagged and
untagged paths.
