# REPORT — googleapis 144 → 182 (pre-pilot upgrade)

Branch `arena/01a0f754-project-aa`. First run 10:15–10:30 UTC; **re-verified 10:45–11:05 UTC
after a sixth workspace re-provision**. Owner instruction: Q10 option B — bump googleapis
before the Gmail pilot. Same global rules as Part D.

## What happened, in one paragraph

The upgrade was applied, gated and committed in isolation as `6e9643b`. The sandbox then
re-provisioned a **sixth** time: HEAD reset to base `47c025a`, every commit discarded as
objects (including `6e9643b` and its report commit), `node_modules` and the git-ignored
`backups/` wiped — the working tree survived, `package.json` still declaring
`googleapis: ^182.0.0`. Dependencies were rebuilt, the identical tree re-committed as
`858500b`, and every gate re-run from scratch. **Consequence for the "single isolated
commit" requirement:** the upgrade *was* isolated when first committed; after the
re-provision it is necessarily part of the restore commit. Its content is still exactly two
files (`package.json` one range, `package-lock.json`), so it stays trivially separable and
revertible — see "Reverting" below.

**No API breaks existed.** Zero of the two permitted repair attempts were used: no source
file needed editing.

## a) Status

| Step | Status | Commit |
|---|---|---|
| Restore after the sixth re-provision (googleapis 182 intact, deps rebuilt) | DONE | `858500b` |
| 1. Baseline gates + audit + backups | DONE (re-run after the restore) | bundles + archives below |
| 2. `npm install googleapis@latest --ignore-scripts` + fix API breaks | DONE — **no breaks, no fixes, 0/2 repair attempts used** | originally `6e9643b`, now inside `858500b` |
| 3. Every gate incl. `test/gmail-sandbox.test.ts` + compiled boot | DONE, all green | `858500b` |
| 4. Revert path | **not needed** | — |
| 5. Audit before/after + report | DONE | `5f0de94` (test stabilisation) + this file |
| Extra: flaky, false-positive-prone assertion found while gating | FIXED, separate commit | `5f0de94` |

Resolved dependency tree: **googleapis 182.0.0**, googleapis-common 9.1.0, gaxios 7.3.1,
google-auth-library 11.1.0, and **`uuid` is no longer a dependency at all**. Unchanged and
still working: CommonJS `require("googleapis")`, `google.auth.OAuth2`,
`google.gmail({ version, auth, rootUrl })`, `users.messages.list/get/send`,
`users.messages.attachments.get`. (npm notes transitive `node-domexception@1.0.0` as
deprecated — not vulnerable.)

### Gates (all re-run on the final state)

| Gate | Baseline (before upgrade) | After |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm test` | 611: 610 pass / 0 fail / 1 env-skip (77 files) | **611: 610 / 0 / 1**, no file failing at hook level |
| `test/gmail-sandbox.test.ts` | 10/10 | **10/10, unchanged** |
| `npm run simulate` | 409/409, 26/26 | **409/409, 26/26 — ALL GREEN** |
| `npm run stress` (seed 7331) | 1000/1000, 11/11 replays | **1000/1000, 11/11** |
| `npm run build` + compiled boot | OK; healthz 200, `/`→`/setup` | OK (ESM bridge in `dist`); healthz 200, `/`→`/setup`, mail-not-connected warning logged |
| Compiled Gmail wire check (from `dist`) | — | one request to `/gmail/v1/users/me/messages/send`, `delivers === true`, and `To` / `Subject` / `From: "Intake Desk" <intake@example.org>` / `Reply-To` / `multipart/mixed` / `filename="note.pdf"` / body / `threadId` all correct |
| `rg -i 'riara\|kcse\|kcpe\|igcse\|admission' src` | 0 | **0** |
| `npm audit` | 9 (measured 13 on the untouched base tree) | **5** |

### The one gate failure encountered — diagnosed, not a googleapis problem

Across six full-suite runs, `test/h2-staff-org-scope.test.ts` failed **once** ("org-2 admin
cannot issue a reset code for org-1 staff"), passed in isolation and passed on every re-run.
Root cause, measured: the assertion proved "no reset code was issued" by scanning the whole
rendered page for `/[A-HJKMNPQRSTUVWXYZ2-9]{10}/`, and the page embeds session/CSRF tokens
generated as `randomBytes(16).toString("hex")`. A run of ten digits `2-9` appears in
**251 of 20 000** such tokens (~1.26 %), so the page-wide pattern fails at random about one
run in eighty. It is a false positive, not a leak, and unrelated to googleapis.

Fixed in its **own commit** (`5f0de94`) so the upgrade stays isolated, and fixed by
*strengthening* the test: it now asserts the property at its source — zero rows in
`password_reset_codes` for that member and zero in the table — keeping both precise message
assertions. Nothing was weakened, skipped or deleted (DECISIONS.md D18).

## b) npm audit — before and after (both measured, not recalled)

Measured by running `npm audit` against the base commit's `package.json` + lock in a temp
directory, and against the current tree:

| Tree | total | critical | high | moderate | low |
|---|---|---|---|---|---|
| Base `47c025a` (googleapis 144, pdfjs 3.11.174, nested optional canvas 2.11.2) | **13** | 2 | 4 | 7 | 0 |
| After Part C (canvas chain removed via `overrides`) | 10 | 1 | 2 | 7 | 0 |
| After Part D Phase 5 (pdfjs-dist 6.3.289) | 9 | 1 | 1 | 7 | 0 |
| **After this upgrade (googleapis 182)** | **5** | **1** | **1** | **3** | **0** |

Cleared by this upgrade — the entire **runtime** chain: `googleapis`, `googleapis-common`,
`gaxios`, `uuid` (all moderate).

Remaining five, all **dev-only** (never in `dist`, never in `npm start`): `vitest` 2.1.9
(critical — requires the Vitest **UI server** listening, which is never run), `vite` 5.4.21
(high — no Vite dev server is ever run), `@vitest/mocker`, `esbuild`, `vite-node` (moderate).
**The product now has zero known-vulnerable runtime dependencies.**

## c) Secrets scan

- Added lines of the whole changeset (`git diff 47c025a`) scanned for `AIza…`, `GOCSPX-…`,
  `ya29.…`, `1//…`, `-----BEGIN … PRIVATE KEY-----`, `xox[baprs]-…`, `ghp_…`,
  `github_pat_…`, `sk-…`: exactly two hits — `AIzaFakeKeyForUnitTestsOnly`
  (`test/gemini-model.test.ts`) and `ya29.sandbox-access-token` (`test/gmail-sandbox.test.ts`,
  present so google-auth-library never attempts a token refresh against the local sandbox).
  Both pre-date this task; the upgrade added no strings at all.
- Tracked-file scan: the same two placeholders, plus their quotation inside the three
  report files' own secrets-scan sections. No private keys, no real tokens, no real
  credentials.
- No `.env` is tracked or present; `.env.example` holds empty values only.
- Bundles: `git bundle verify` reports "is okay". Caveat as before — a bundle is a
  compressed packfile, so the authoritative scan is the tree/diff scan.
- **No real Gmail or Gemini endpoint was called and no real email was sent.** Outbound
  network use: the npm registry and the (rejected) `git push`.

## d) Backups and push

`backups/` (git-ignored) currently holds exactly two artifacts, both created after the
restore and both verified: `final-googleapis182-20261002T110026Z.bundle`
(`git bundle verify` → "is okay") and `tree-final-20261002T110026Z.tar.gz` (a `git archive`
of the tracked tree). The earlier set from this task —
`baseline-20261002T102255Z.{bundle,tar.gz}`, `googleapis182-20261002T102807Z.*`,
`final-20261002T103026Z.bundle` — was **destroyed by the sixth re-provision**, which is the
sixth demonstration that git-ignored backups are not durable in this environment.

**Push: PUBLISHED (Q13 answered A after this report was first written).** The earlier
attempts were rejected as non-fast-forward because the re-provisions rewrote local history;
the owner then authorised a lease-pinned force-push of the arena branch only.

One incident is recorded in full, because it matters operationally: the workspace
re-provisioned a **seventh** time *while that push was in flight*. HEAD had been reset to
base `47c025a` with the whole tree uncommitted, so the push moved the remote branch to
`47c025a` — briefly rolling back the remote's `f4544c6` — instead of publishing the
restored work. Recovery took one command: the identical tree was re-committed (`d7dd63d`)
and pushed forward as a fast-forward. **The remote branch now equals local HEAD
(`d7dd63d`), `main` was never touched, and no content was lost** — the tree is
byte-identical to the state that passed every gate. Lesson (DECISIONS.md D19): verify
`git rev-parse HEAD` and a clean `git status` *inside the same command* as any push.

### Reverting the upgrade (if you want 144 back)

```bash
npm install googleapis@144.0.0 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts && npm_config_nodedir=/usr/local npm rebuild better-sqlite3 --build-from-source
npm run typecheck && npm test && npm run simulate && npm run stress && npm run build
```
No source edits are needed in either direction — that is the evidence that the four majors
changed nothing this product touches.

## e) What still needs you

1. ~~**Publish the branch (Q13)**~~ — **DONE**: answered A and executed; origin's arena
   branch is at `d7dd63d` (identical to local HEAD), `main` untouched. The work is durable
   off-box for the first time since Part C Phase 2.
2. **Run the Gmail pilot** — `docs/PILOT-RUNBOOK.md`, which records the exact versions
   verified here (googleapis 182.0.0, google-auth-library 11.1.0, gaxios 7.3.1,
   pdfjs-dist 6.3.289, Node 22.22.3). Throwaway mailbox and database, draft-only switch
   verified first; messages 11–13 cover alias routing, ambiguity and re-typing. The first
   thing it exercises that nothing here could is **google-auth-library 11's real refresh
   flow** (the sandbox uses a live access token by design).
3. **Run the C2 migration on the real database** — `docs/RUNBOOK-C2-MIGRATION.md`; still
   never run against any real or tenant database.
4. **Label 100 real messages and run the harness** — `GET /export/labels.csv` →
   `docs/LABELLING-GUIDE.md` → `scripts/eval-classifier.ts`; keep the auto-send allowlist
   empty until a category clears precision ≥ 95 % on ≥ 30 examples.
5. ~~**Q11 (Node ≥ 22.13)**~~ — **answered A (accept)**; no change needed, it is already the
   committed state. Q8 (freeze-only), Q9 (honour plus-addressing) and Q12 (leave the
   dev-only advisories) were likewise answered A and all confirmed the code as built.

## f) What I could not verify

- **Real Google endpoints.** googleapis 182 is verified against a local sandbox that mimics
  Gmail's HTTP shape (from both `src` under vitest and the compiled `dist`), not against
  Google. Real OAuth **refresh** with a genuine refresh token, quota/429 behaviour, label
  semantics and deliverability are the pilot's job.
- **`google-auth-library` 11's token-refresh path** — four majors moved underneath it and
  the sandbox deliberately supplies an unexpired access token. Failure would be loud
  (`gmail_last_error` in Settings, a `review_needed` notification, ingestion retries next
  poll rather than stopping), but it is untested here.
- **pdf.js 6 on Node 20** — impossible by design (that is the `engines` bump); everything
  verified on Node 22.22.3 only.
- **Long-running ingestion at volume** and concurrency beyond the tested races.
- **Chromium-dependent UI probes** (skip without a browser binary) and **OCR/raster quality**
  (`canvas` cannot be built here; that tier exercises its safe fallback).
- **Durability of this work** — six re-provisions, twice destroying committed history; the
  bundles that would have covered it are git-ignored and did not survive.

## g) QUESTIONS — ordered by impact

One line each, e.g. `Q13: A`. Q1–Q7 were settled before Part D; **Q10 is done** (this run)
and marked answered in `QUESTIONS.md`.

**Q13 (highest) — How should the branch be published?** Six re-provisions have twice
destroyed committed history; origin sits at `f4544c6`, local HEAD is ahead of a rewritten
base, so the push is rejected as non-fast-forward and rule 1 forbids force-push and merge.
Nothing since Part C Phase 2 is durable. **Options:** **A** authorise one
`git push --force-with-lease origin arena/01a0f754-project-aa` (rewrites only the arena
branch, never `main`) · **B** authorise a merge/rebase of `f4544c6` into the restored
history, then a normal push · **C** leave it unpublished and accept the loss risk.
**Recommendation: A** — `f4544c6`'s content is fully contained in the restored tree
(re-committed byte-identically), so nothing is lost, and it is the only option that stops
the recurring loss. **Meanwhile:** SKIPPED (rule 1 forbids it without your say-so); all work
bundled locally. **Affects:** whether Part C Phases 3–7, all of Part D and this upgrade
survive the next re-provision. **Change later:** run the chosen command once; no code impact.

**Q11 — pdf.js 6 is in: accept Node ≥ 22.13 as the minimum runtime?** **Options:** **A**
accept ≥ 22.13 (current: `engines`, README, `setup-linux.sh` → NodeSource 22.x) · **B**
revert the isolated pdf.js 6 commit and keep only the hardening options · **C** keep v6 but
pin deployment to a base image you control. **Recommendation: A** if your hosts can run
Node 22 (current LTS) — v6 removes the eval paths structurally, clearing the last runtime
`high`; **B** if anything is stuck on Node 20, since the mitigations (no eval, no XFA, no
remote fetching, parse budget, partial-read cap) hold either way. **Meanwhile:**
PROVISIONAL — A, committed and gated. **Affects:** which Node versions can run the product.
**Change later:** revert that one commit, then `npm ci --ignore-scripts` +
`npm rebuild better-sqlite3 --build-from-source`.

**Q12 — Clear the five dev-only advisories (vitest/vite major)?** **Options:** **A** leave
them, documented (current) · **B** migrate to vitest 5 / vite 7 in its own isolated commit
with the full gate suite · **C** replace vitest with `node:test` and drop the vite toolchain.
**Recommendation: A until after the pilot, then B** — `vitest.config.ts`'s
`server.deps.external` is exactly what makes the pdf.js 6 ESM bridge loadable, so a runner
migration is the one change that could quietly undo Phase D5; it deserves its own run with
all 611 tests as the net. **Meanwhile:** SKIPPED (outside this task's scope). **Affects:**
`npm audit` optics and dev-tooling CVEs only; nothing in production. **Change later:** one
isolated commit, `npm install -D vitest@5`, re-run every gate — especially
`test/pdf-hardening.test.ts` and `test/gmail-sandbox.test.ts`.

**Q8 — After a person re-types a case, should the requirements check re-run?**
**Options:** **A** freeze only, no re-evaluation (implemented) · **B** freeze and
re-evaluate · **C** freeze, re-evaluate and notify. **Recommendation: A** — PPR P0-3 already
requires an *explicit* re-evaluation, and re-typing is already an explicit human act.
**Meanwhile:** PROVISIONAL — A. **Affects:** whether a re-typed case immediately shows a
verdict matching its new checklist. **Change later:** in `POST /case/:id/case-type`, after
`repo.reFreezeCaseConfig(...)`, call the evaluation `/case/:id/reevaluate` uses (B), plus a
`review_needed` notification (C); `test/case-retype.test.ts` pins A and would be updated, not
weakened.

**Q9 — Plus-addressing in alias routing: keep honouring the `+tag`?** **Options:** **A**
honour the tag (implemented) · **B** exact addresses only. **Recommendation: A** — ordinary
mailbox feature, stripped only for matching and never stored; an unmatched address still
falls back to a human. Verify in pilot message 11, since some providers strip or reject
tags. **Meanwhile:** PROVISIONAL — A. **Affects:** whether tagged sub-addresses route or
fall through. **Change later:** one function, `aliasKeyCandidates()` in `src/db/repo.ts`.
