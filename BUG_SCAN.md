# BUG_SCAN — read-only defect scan of the `Project-AA-full-fixed` tree

**Scan performed:** 2026-10-07 on branch `arena/e9eb1057-project-aa`.
**Tree scanned:** the working tree after it was overwritten with `Project-AA-full-fixed.zip`
(186 files) and merged with the files that archive omitted (see BUG-01).
**Method:** read-only. A content-and-mode snapshot (path · mode · size · MD5 of every file
outside `.git`/`node_modules`) was taken before and after the scan and compared: **identical**,
apart from `./eng.traineddata`, a gitignored cache file that the test run itself writes.
No source file, test, or configuration was edited during the scan.

> **Status: all 16 findings fixed (2026-10-07).** The scan below is preserved
> verbatim as the record of what was found and how it was found. Fixes are
> catalogued in **BUGS.md → "Phase 20 — redesign correctness pass"** and pinned
> by tests in `test/flowchart.test.ts`, `test/process-templates.test.ts` and
> `test/troubleshooter.test.ts`. Re-verified after the fixes: `npm run typecheck`
> clean, `npm test` 99 files / 828 passed / 1 skipped, `npm run simulate`
> 409/409, `npm run stress` 1000/1000, `npm run build` clean.

**Gates that were run (they only read files, they do not write them):**

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | **FAIL** — 1 error (BUG-02) |
| Tests | `npx vitest run` | **FAIL** — 96 files, 770 passed, **1 failed**, 1 skipped (BUG-03) |
| Whitespace | `git diff --check` | **FAIL** — 1 trailing-whitespace line (BUG-15) |

The 1 skipped test is `test/responsive.test.ts`, which self-skips when the Playwright Chromium
binary is absent — already recorded as **BUGS.md ENV-1**, not a new finding.

---

## Severity key

**Critical** = a documented gate fails, or data/state is lost silently.
**High** = wrong behaviour in a normal workflow, or silent loss of configuration.
**Medium** = wrong behaviour in an edge case, or a cross-tenant leakage with limited blast radius.
**Low** = cosmetic, dead code, or hygiene.

---

## A. The archive itself

### BUG-01 — `Project-AA-full-fixed.zip` is not a complete tree (Critical)

The archive ships 186 files. The git HEAD it replaced had 214. **28 files are missing from the
archive:**

- `tsconfig.json`
- `vitest.config.ts`
- `src/logs/index.ts` (the decision-log module — the whole `/logs` feature)
- `tessdata/eng.traineddata.gz` (OCR language data)
- **22 test files:** `review-hardening`, `review-pack`, `round20`, `rules`, `safe-by-default`,
  `scoping`, `sender-declares-delivery`, `stress`, `templates-section`, `tenant-attribution`,
  `today-stats`, `tpl-migration`, `triage-tile`, `v3`, `v5`, `watcher`, `web`,
  `webhook-hostile`, `webhook-ingest`, `webhook-settings-ui`, `white-label`, `with-timeout`

Consequence: a machine that takes the ZIP at face value **cannot run `npm run typecheck`,
`npm test` or `npm run build`** — there is no compiler config, no test config, and one source
module is absent. It also silently loses 22 regression suites, so "the tests pass" would have
meant 76 files instead of 96.

**Resolution in this tree:** the missing paths were restored from git HEAD (`git checkout HEAD -- …`)
and the three obsolete ZIPs were deleted. The archive remains incomplete as an artefact —
re-export it from a clean checkout if it is still distributed.

---

## B. Failures in the documented gates

### BUG-02 — `npm run typecheck` fails: unused import `PROCESS_TEMPLATES` (Critical)

```
src/web/server.ts(32,72): error TS6133: 'PROCESS_TEMPLATES' is declared but its value is never read.
```

`tsconfig.json` sets `noUnusedLocals: true`, so this is a hard error, not a warning. It breaks
`npm run typecheck`, `npm run build`, and the **first step of `.github/workflows/ci.yml`** —
CI would go red before running a single test. The redesign imported the constant but then
hard-coded the three template cards in `src/web/pages.ts` (twice: lines ~259 and ~742), so the
import was never used and the labels now exist in two places that can drift apart.

### BUG-03 — `npm test` fails: `test/web.test.ts` still asserts "Instrument Serif" (Critical)

```
❯ test/web.test.ts:275:18
    275|     expect(home).toContain("Instrument Serif");
 Test Files  1 failed | 95 passed (96)
      Tests  1 failed | 770 passed | 1 skipped (772)
```

The redesign deliberately removed Instrument Serif (`WHAT_CHANGED.md` §1: *"Instrument Serif
removed — entire UI uses Manrope only"*). The `@font-face` blocks are gone from `views.ts` and
`--font-display` now resolves to Manrope. The assertion — and its comment on lines 271-272, which
still describes the two-typeface system — was not updated. This is the only failing test in the
suite.

### BUG-15 — trailing whitespace at `src/web/pages.ts:2830` (Low)

`git diff --check` reports one line consisting only of spaces. `.github/workflows/ci.yml`
contains a PR whitespace gate, so this would fail that check.

---

## C. The flowchart editor — silent data loss and a diagram the engine does not follow

The centrepiece of the redesign is the interactive flowchart on **Config → Workflow rules**
(`src/web/pages.ts` ~2832-3090, styles in `src/web/views.ts` ~1301-1395). It posts to the same
`/config/workflow-rules/save` route as the advanced form, but it does not submit the same fields,
and it does not draw the order the engine uses.

### BUG-04 — Saving from the flowchart deletes conditions 2 and 3 (High)

`parseRuleConditions` (`src/web/server.ts` ~1467) builds up to **three** conditions from
`cond_field_0/1/2` + `cond_value_0/1/2`. The flowchart panel renders **one** condition row
(`cond_field_0`, `cond_value_0`). Opening a two- or three-condition rule and pressing
**Save step** rewrites it to a single condition. Nothing warns; the node just quietly shows
fewer "if" clauses afterwards. A rule that said *sender is known **AND** has attachments
**AND** documents complete* becomes *sender is known*.

### BUG-05 — Saving from the flowchart deletes ten action settings (High)

`parseRuleAction` (`src/web/server.ts` ~1492) returns fifteen fields. The flowchart submits six.
Because the route rebuilds the whole action object from the submitted fields, every field the
flowchart omits is reset to its default:

| Field | Silently reset to |
| --- | --- |
| `sla_hours` | `null` |
| `followup` | `"none"` (the follow-up ladder is switched off) |
| `followup_action` | `undefined` |
| `attachment_set` | `null` (PDF packs stop riding along) |
| `template_map` | `null` (green/empty/missing template routing lost) |
| `request_info` | `false` |
| `audit_code` | `undefined` |
| `fallback` | `"human_draft"` |
| `priority` | `undefined` |
| `assign` | `undefined` |

This is the "silently discard rule conditions and settings" path: a rule that armed an SLA and a
follow-up ladder loses both the first time someone renames it in the flowchart.

### BUG-06 — Editing a switched-off rule switches it back on (High)

`/config/workflow-rules/save` hard-codes `enabled: true`. The flowchart renders disabled rules
inline (greyed, labelled "· off") and lets you open and save them, so a rule an administrator
deliberately parked is silently re-armed — with the truncated condition set from BUG-04.

### BUG-07 — The diagram's order is not the order the engine follows (High)

The flowchart states: *"Rules run top to bottom — **first match wins**."* Neither half is true.

1. **Wrong precedence.** The page renders `repo.listWorkflowRules(orgId)`, which is
   `ORDER BY position, id`. The engine (`firstMatchingRule`, `src/rules/workflow.ts:165`) sorts
   by **case-type specificity first**:
   `Number(a.case_type_id === null) - Number(b.case_type_id === null) || a.position - b.position || a.id - b.id`.
   So an org-wide rule (`case_type_id IS NULL`) placed at position 1 is drawn *above* a
   case-type rule at position 2, but the case-type rule actually wins.

2. **Wrong scope.** The diagram draws **every** rule in the organization — all case types
   interleaved — as one chain. The engine evaluates `rulesForCaseScope(...)`, which keeps only
   `case_type_id === X OR case_type_id IS NULL`. Rules belonging to *other* case types appear in
   the picture but can never run for the case type you are looking at.

The page and the engine derive order from two independent pieces of code, so they can drift
again. The fix is to make the page call the engine's own ordering.

### BUG-08 — The flowchart turns a never-firing rule into a catch-all (High)

`ruleMatches` (`src/rules/workflow.ts:157-161`) returns `false` when `conditions.length === 0`,
so a rule with no conditions can never fire — that is how an administrator parks a rule without
deleting it. The flowchart's `showForm` defaults the condition row to `{ field: "always" }` when
there is no condition, and `parseRuleConditions` turns `always` into a real
`{ field: "always", value: true }` condition on save. One click on **Save step** converts a rule
that matched nothing into one that matches *every* message, and because first-match-wins applies,
it shadows every rule below it.

### BUG-09 — Flowchart nodes cannot be used from the keyboard (Medium)

Every editable node carries `role="button"` and `tabindex="0"`, but the delegated handler only
listens for `click` — there is no `keydown` handler, so Enter and Space do nothing on a focused
node. Separately `.flow-node .fn-actions` is `opacity: 0` and only becomes visible on `:hover`
(or when selected), so the **On/Off** toggle is unreachable on a touch device, which has no
hover state.

---

## D. Cross-tenant and configuration-scoping defects

### BUG-10 — The uploaded email banner leaks across organizations (Medium)

`emailBanner` (`src/branding.ts`) used to be gated to the legacy single tenant:

```ts
const configured = organizationId === 1 ? repo.getSetting("email_banner", "") : "";
```

The redesign removed the guard, and the new comment even states the reason it was there:
*"settings are installation-global in this schema"*. `repo.getSetting` has no organization
scope, so organization 2's outbound mail now carries organization 1's uploaded banner. The
per-organization fallback (`organizationLogo`) below it is correctly scoped, so only the
installation-global branch regressed.

### BUG-11 — Seeding a process template rewrites the global intake hotwords (Medium)

`seedProcessTemplate` (`src/db/seed.ts` ~200-207) appends its hotwords to the single global
`intake_hotwords` setting. That setting is read by `src/pipeline/index.ts:172` for **every**
tenant and edited from **Config → Settings**. Seeding "Job applications" for one organization
therefore adds `job`, `vacancy`, `cv`, `resume`, `hiring` to *every* organization's intake
classifier, and it silently mutates a value the tenant may have set by hand.

### BUG-12 — Classifier guidance is global and is injected after the format contract (Medium)

`src/pipeline/index.ts` reads `classifier_prompt` globally and `src/categorize/index.ts` splices
it into the Gemini prompt. Two problems:

- It is not organization-scoped, so one tenant's guidance steers another tenant's classifier.
- The guidance is concatenated **after** `Return JSON only: {"label":"...","confidence":0}.`, so
  operator-authored text sits in the strongest possible position to override the output contract
  the parser depends on. Instruction text should precede the format contract, not follow it.

---

## E. Lower-severity findings

### BUG-13 — The inline banner lost its file extension (Low)

`src/ingestion/gmailClient.ts` now emits
`Content-Disposition: inline; filename="organization-banner"`; it used to be
`filename="organization-banner.jpg"`. Several mail clients choose a renderer from the filename
extension, so a PNG or SVG banner can degrade to a generic attachment — the exact regression the
multipart rewrite in `WHAT_CHANGED.md` §5 set out to fix. The extension should be derived from
`banner.mime`.

### BUG-14 — Dead Instrument Serif font assets and routes (Low)

The `@font-face` rules were removed, but `src/web/fonts.ts` still embeds both WOFF2 blobs
(`FONT_INSTRUMENT_SERIF_WOFF2`, `FONT_INSTRUMENT_SERIF_ITALIC_WOFF2`) and
`src/web/server.ts:202-203` still serves
`/assets/fonts/instrument-serif.woff2` and `…-italic.woff2`. Roughly 60 KB of base64 ships in
the bundle and two routes answer that nothing requests.

### BUG-16 — Signature de-duplication is inconsistent between the two MIME paths (Low)

`src/web/server.ts` decides "already signed" with three heuristics, including
`body.includes(sig.name)`. A quoted reply that merely mentions the signer's name therefore
suppresses the signature entirely. The banner path in `gmailClient.ts` uses a different, weaker
check (`!body.includes("\n--\n")`), so the same message can get one signature on the plain-text
path and two on the HTML path.

---

## F. Coverage gap: the redesign shipped without tests

Every feature added by this redesign is untested. `WHAT_CHANGED.md` describes ten changes; the
suite contains tests for exactly one of them (`test/light-mode.test.ts`, the CSS assertions).
There are no tests for:

- the one-click process templates (`POST /setup/process-template`)
- the email signature (`POST /config/branding/signature`, `formatSignatureHtml/Text`)
- the classifier guidance prompt (`POST /config/classifier-prompt`)
- **the flowchart editor** — not its rendering, not its ordering, and above all not the
  round-trip that BUG-04/05/06/08 all break

That gap is why BUG-02 through BUG-08 survived: the only gate that would have caught them is the
typecheck step, and the archive did not even ship the config to run it.

---

## G. Environment notes (not defects in the code)

- `node -v` is **22.22.3**, matching `engines.node >= 22.13.0` and BUGS.md ENV-3.
- `better-sqlite3` has no usable prebuild here and `node-gyp` cannot reach `nodejs.org` for
  headers; it was compiled from source against the headers already present in
  `/usr/local/include/node`. This is a sandbox limitation, not a repository defect.
- `canvas` was installed without a build (no Cairo/Pango toolchain in this image). Raster-only
  PDF paths exercise the safe fallback — already recorded as **BUGS.md ENV-2**.
- `npm audit --omit=dev` was not re-run; **BUGS.md PROD-6** still describes the five
  development-toolchain advisories left in place deliberately.

---

## Summary

| ID | Severity | Area | One-line finding | Status |
| --- | --- | --- | --- | --- |
| BUG-01 | Critical | archive | ZIP omits tsconfig, vitest config, `src/logs/index.ts`, tessdata and 22 test files | **Closed** — restored from git; ZIPs deleted |
| BUG-02 | Critical | build | unused `PROCESS_TEMPLATES` import breaks typecheck, build and CI | **Fixed** — cards rendered from the constant |
| BUG-03 | Critical | test | `web.test.ts` still asserts the removed Instrument Serif font | **Fixed** — asserts Manrope throughout |
| BUG-04 | High | flowchart | saving drops conditions 2 and 3 | **Fixed** — one row per condition |
| BUG-05 | High | flowchart | saving resets SLA, attachment set, follow-up, template map and 6 more | **Fixed** — hidden mirrors |
| BUG-06 | High | flowchart | saving re-enables a deliberately disabled rule | **Fixed** — `enabled` round-trips |
| BUG-07 | High | flowchart | diagram order ≠ engine order (case-type precedence and scope) | **Fixed** — shared `compareRuleOrder` |
| BUG-08 | High | flowchart | empty-conditions rule becomes a match-everything catch-all | **Fixed** — "Never matches" + `[]` |
| BUG-09 | Medium | flowchart | nodes unreachable by keyboard; On/Off toggle unreachable without hover | **Fixed** — keydown + `:focus-within` |
| BUG-10 | Medium | tenancy | global banner setting applied to every organization | **Fixed** — per-org settings |
| BUG-11 | Medium | tenancy | process template mutates the global intake hotwords | **Fixed** — per-org hotwords |
| BUG-12 | Medium | tenancy/AI | classifier guidance is global and overrides the JSON format contract | **Fixed** — scoped; placed before the contract |
| BUG-13 | Low | mail | inline banner filename lost its extension | **Fixed** — derived from MIME |
| BUG-14 | Low | assets | dead Instrument Serif fonts and routes still ship | **Fixed** — removed (~58 KB) |
| BUG-15 | Low | hygiene | trailing whitespace at `src/web/pages.ts:2830` | **Fixed** |
| BUG-16 | Low | mail | signature de-duplication differs between MIME paths | **Fixed** — one shared rule |
| — | — | coverage | no tests for process templates, signature, classifier prompt or flowchart | **Closed** — 57 new tests |
