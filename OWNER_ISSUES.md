# OWNER_ISSUES.md — acceptance gates

Statuses: **RED** = failing / not started · **GREEN** = fixed with evidence · **UNVERIFIED** = could not run, reason given.

Baseline before this round: tsc clean · 305/305 vitest · 316/316 simulate.
Current gate: tsc clean · **393/393 vitest (29 files)** · **simulate 316/316**.

---

## OR-1 — No mock data in the app — **GREEN**

**Repro (before fix):** `npm run demo` deleted the exact DB file `npm run serve` reads and rebuilt it with the simulation corpus; login worked with `admin/admin123`; the console showed a "Demo dataset loaded" banner and staff rows badged `demo`; serve/ingest printed "run npm run demo".

**Fixes (commit "Round 23 OR-1"):**
- `seedDefaults` seeds NO staff accounts — the product ships with zero credentials.
- First-run setup screen (`/setup`): on a fresh install every request redirects to `/setup`; the owner creates their own admin account (name, username, ≥8-char password with confirmation, one-time expiring token). After the first account exists `/setup` returns 404 forever.
- `npm run demo` removed (script + CLI deleted). Simulation defaults to an in-memory DB and now **hard-refuses** to run against the server's configured database.
- Demo banner, demo badges, `KNOWN_DEFAULTS` (hard-coded admin123/demo123 strings in source) and all "run npm run demo" messages removed.
- `npm run purge-mock` added: backs the DB up, deletes only `demo=1` applicants (+ child rows), demo staff and the `demo_dataset` marker; prints exactly what went; idempotent; writes nothing when clean.
- Fresh-install empty state: "No applications yet. Connect Gmail in Settings…"

**Tests (test/owner-acceptance.test.ts, group OR-1):** 6 tests.
- RED evidence (before fix): `6 failed (6)` — including "no tests" collection failure because `src/db/purge.ts` did not exist.
- GREEN evidence (after fix): `Tests 6 passed (6)`; full suite `Tests 311 passed (311)`.

**Live-run evidence (fresh DB + real server, HTTP):**
- `GET /login → 302 loc=/setup`; `GET /setup` renders "Welcome… Create administrator account".
- `POST /setup → 302 loc=/` with session cookie; all 6 console pages returned 200 with **0 demo-wording lines**.
- `GET /setup` after first run → **404**.
- Purge on contaminated file DB: `removed 2 mock applicant(s) and 2 demo account(s)`, backup written; second run: `clean — nothing to remove`. Real applicant + real staff row survived.

**Interpretations:** internal `demo` DB columns and realm filters were KEPT (invisible to users, harmless once purged, and they make any future contamination self-isolating); only user-visible demo concepts were removed. Purge identifies mock rows by the `demo=1` flag the old tool itself set.

---

## OR-2 — Status/queue model follows the pipeline — **GREEN** (model core)

**Repro (before fix):** `queueOf()` fell through to *Enquiries → New enquiry* for any
applicant with documents in hand but no routing yet — exactly the owner's "documents
submitted and awaiting review shows as waiting/new" confusion. 5 OR-2 tests written first;
2 failed RED proving the fall-through (`documents_received` and `awaiting_review` cases
landed in enquiries).

**Fixes:**
- `queueOf` now routes "documents in, no routing" to **Human Review → "Documents in —
  needs a manual decision"** before any enquiries fallback.
- Vague labels replaced with plain language: "Requirement not satisfied" → "Entry
  requirements not met — decide manually"; "Manual decision required" → "Documents in —
  needs a manual decision"; "Escalated" → "Escalated — overdue, needs attention now".
  The queue page already prints the evaluation reason beside each row, so no label appears
  without its explanation.
- `docs/STATUS_MODEL.md` written: every state, what enters/leaves it, who acts next, and
  the invariants pinned by tests.

**Evidence:** OR-2 group `5 passed` (RED first: `2 failed | 9 passed`); full suite
`316 passed`; simulate `316/316 ALL GREEN`.

**Remaining OR-2 scope (tracked):** "What needs my attention" panel ordering/scoping is
implemented with OR-8 (role scoping); escalation *who/when* display on the case page is
verified in the route scan.
## OR-3 — Responsive UI — **GREEN**

**Repro (real Chromium, throwaway DB):** resize audit visited 8 staff pages ×
5 widths (1280/1024/768/480/360) plus a continuous 1280→320 sweep. Before fix:
**10 overflowing page/width combinations** — every page at 360px (unwrapped wide
tables: 465–639px), `/applicants` at 1024px (1145px queue table), `/case` at
480/360 (529–607px fixed grids). 0 JS errors, so the break was layout, not scripting.

**Root causes:** wide `<table>`s were only given scroll containment inside
`.card` below 900px; selects and case-page grids had no min-width caps; page
padding was fixed at desktop values.

**Fixes (views.ts):** universal containment — `section, .card, .loginbox
{ max-width:100%; overflow-x:auto }` (wide tables scroll inside their own
container, per the owner's rule), `table/select/input/textarea { max-width:100% }`,
`.case-grid > * { min-width:0 }`, and a 480px tier for paddings/header chips.

**Evidence:** after fix the same audit reports `0 overflowing page/width
combinations; 0 JS errors`; permanent regression test `test/responsive.test.ts`
(real Chromium; skips with a reason if no browser binary) passes. Screenshots in
`docs/screenshots/*_360.png`. Audit tooling: `scripts/ui-resize-audit.mts`.

**Known low nit:** brand wordmark contrast at tiny widths (polish, not overflow).
## OR-4 — Gmail/Gemini connections in Settings, guided, live status — **GREEN**

**Repro:** the Gmail/Gemini connection cards rendered in **Configuration →
Replies** (`/config?tab=replies`) instead of Settings; after saving credentials,
connecting, syncing or saving a Gemini key the console redirected back to
`/config?tab=replies#gmail|gemini`; the dashboard "manage" links pointed at the
same wrong home; the Gmail card offered **Sync now** but no explicit *Test
connection*; and the setup guide gave only a free key/API-key line — no
step-by-step Google Cloud OAuth walk-through (scope, redirect URI, OAuth
Playground fallback) as the owner dictated.

**Root cause:** the cards were built into `configPage()` back when connections
were considered "reply plumbing"; the OAuth backend (server.ts) was written
against that home, so every `Location:` header and dashboard link hardcoded
`/config?tab=replies…`.

**Fixes:**
- `src/web/pages.ts` — new `connectionsSection(c)` rendered at the top of
  **Settings** (`<div id="connections">` with `#gmail` and `#gemini` cards),
  removed from `configPage` entirely. Gmail card now carries a numbered
  step-by-step guide (Google Cloud project → enable Gmail API → OAuth consent →
  OAuth client ID type Web application → add `<console>/settings/gmail/callback`
  redirect URI → copy ID/secret), states the **exact scope** requested
  (`https://www.googleapis.com/auth/gmail.modify`), documents the **OAuth
  Playground fallback** (advanced refresh-token field wired to
  `gmail_refresh_token_manual`), and shows live status: connected badge, signed-in
  address, last successful sync, last error with plain-language remedies.
- `src/web/server.ts` — new **`POST /settings/gmail/test`** (admin + CSRF): makes
  one real lightweight Gmail call (`listRecentMessageIds(1, { perPage: 1, maxPages: 1 })`);
  on success clears `gmail_last_error` + audit `gmail_tested`; on failure stores the
  exact error in `gmail_last_error`, audits `gmail_test_failed`, and redirects with
  the message — never silent. All connection redirects (`settingsBack`, Gemini
  save/remove) now land on `/settings?msg=…#connections`; audit wording fixed
  ("manual sync from Settings").
- Dashboard manage links (`/config#gmail`, `/config#gemini`) → `/settings#connections`.
- Contract updates (moves, not weakenings): `test/web.test.ts` production-readiness
  + secret-echo tests now assert the card lives in Settings and is *absent* from
  Configuration; `test/v5.test.ts` gemini-slot test fetches `/settings`.

**Evidence (RED → GREEN):** five new acceptance tests in
`test/owner-acceptance.test.ts` failed first (RED, pasted in session log):
connections section + guide strings (incl. "OAuth Playground", "gmail.modify"),
Configuration no longer hosting the cards, credential-save persisting + redirect
to `/settings#connections`, Gmail test-connection with fake credentials reporting
a helpful stored error, Gemini bad key stored + visible + surviving a restart on a
file-backed DB. After the fix: **16/16** in the file; full suite **322/322 tests
(25 files)**; `tsc --noEmit` clean; `npm run simulate` **316/316 checks across 26
scenarios — ALL GREEN**; responsive audit still 0 overflows. No restarts needed:
saved credentials/token/key go live immediately (hot-swap in serve.ts unchanged).
## OR-5 — Deterministic document-requirement generator — **GREEN**

**Repro (before fix):** which documents a file needed was stored in a
staff-editable table (`requirement_rules`) with a toggles UI
(*Configuration → Courses → "Required documents (all courses)"* — per-row
Required/optional selects, Add-rule form, Remove buttons). Nothing verified
those rows against the university's own rules, and the official
application-form checklist (pack PDF `data/pack/application-form.pdf`,
pp3–4) was not the source: an admin could add "kcpe_cert required" or delete
the leaving certificate and the pipeline would silently obey. Postgraduate
applicants were also judged by school-leaver evidence, and international
post-admission items could block a file.

**Source of truth read (as directed):** `pdftotext -f 3 -l 4
data/pack/application-form.pdf` — checklist items: certified result
slip/transcripts/leaving certificate; Law applicants only → personal
statement ≤500 words; Business-degree applicants only → statement of
objective ≤300 words; transfer cases only → transfer letter; Masters & PhD
only → undergraduate transcripts & certificate; PhD only → Masters
transcripts & certificate; passport photo; ID/passport + birth certificate;
application fee (a fee, not a document).

**Fixes:**
- `src/documents/matrix.ts` — deterministic generator: level
  (certificate/diploma/degree vs masters vs phd) × curriculum programme
  (LLB, BBA) × nationality (Kenyan vs international vs unknown) × route
  (standard vs transfer). Identity core for **all** levels
  (application_form, passport_photo, id, birth_cert); exam result slip +
  leaving certificate only for school-leavers; masters swaps those for the
  undergraduate transcript + degree certificate, PhD adds the Masters pair.
  `KENYAN_REQUIRES_KCPE = false` — KCPE is never required. Conditional
  items are generated as slots to **ask** for, never assumed present.
  International applicants get student-pass application + foreign
  qualification equivalence as **non-blocking** post-admission items
  (`required:false, blocking:false`), so they can never hold up a file.
- Vocabulary: new DocTypes for prior-degree documents, both statements,
  transfer form, post-admission items. "Academic certificate" remains a
  classifier fallback family only and is **banned** as a requirement slot
  or checklist label. `docs/DOCUMENT_MATRIX.md` documents the whole matrix
  (contains "KCPE" and lowercase "personal statement", never the banned
  phrase — pinned by tests).
- `src/db/repo.ts` — `resolveRequirements`/`effectiveRequirements` now call
  the generator (CourseLevel `postgrad` maps to the masters tier); the old
  table is frozen legacy and no longer drives any decision.
- Removal of staff configurability: the toggles table + add/delete forms are
  gone from Configuration; stale POSTs to `/settings/rules/{add,delete}`
  redirect with an explicit "generated deterministically" refusal — no
  silent success, no hidden write.
- Requirements tab (`/config?tab=requirements`) renders the live generated
  matrix per programme level plus the structured grade builder.
- Extraction pipeline extended end-to-end for every new type (classification
  rules, field scoring, labels, slot-aware missing-doc extras) so the
  generator's slots can actually be filled from real attachments.
- Simulation corpus upgraded to carry full checklist files
  (`checklistDocs()` helper); MBA route supplies the undergraduate degree
  certificate with a BCom title so the bachelor's text cannot out-rank the
  MBA code; programme inference hardened (exact programme codes beat fuzzy
  name matching; all-generic-names rule requires the programme name's
  leading **and** trailing word, so "Business" alone no longer pulls cases
  into BBA).

**Evidence (RED → GREEN):** 30 combinatorial tests in
`test/document-matrix.test.ts` written first — RED pasted in session log
(matrix module did not exist: collection failure + `fillSlots` absent).
During corpus work the simulate harness went 296/316 → 311/316 with pasted
failures (missing statement slots, MBA resolving to BBA) before landing.
Final: **352/352 vitest tests across 26 files**; `tsc --noEmit` clean;
**simulate 316/316 checks across 26 scenarios — ALL GREEN** (MBA applicant
evaluated at masters level with no school-leaver evidence demanded).

**Interpretations:** the pack PDF's "~and/or other academic certificates"
row is implemented as the academic-family filling semantics (any grade-bearing
academic document can fill the school-leaver evidence slots) rather than a
new document type; the fee line is deliberately not a slot. Programme levels
are stored as `postgrad` in the catalogue, which the generator reads as the
masters tier — a PhD tier applies only to programmes explicitly recorded as
PhD (none currently).

## OR-6 — Course config: every subject × every system, extendable — **GREEN**

**Repro (before fix):** two problems made the surface untrustworthy. (1)
**Display ≠ enforce:** the legacy *Entry requirements* editor wrote to the
`course_requirements` table, but the engine judges files from the structured
`admission_rules` trees — staff could edit the old form and watch nothing
change for applicants. (2) **Master's = PhD:** a single `postgrad` level
meant Master's and PhD files shared one set of university-wide defaults and
one document checklist tier. Grade values in the builder were free-text
(a typo like "Cplus" stored fine), the subject catalogue could only be
retired/restored (never added or renamed), and a school existed only as
free text on its courses.

**Fixes:**
- **Levels split** — `CourseLevel` is now `degree | diploma | certificate |
  masters | phd`; an idempotent forward migration rewrites `programmes`,
  `admission_rules` and `course_requirements` on open (legacy `postgrad` →
  `masters`). Requirements tab offers **BASE:masters** and **BASE:phd**
  university-wide defaults as separate, editable targets; the add-course
  form takes an explicit level.
- **Click-to-reveal grade pickers** — condition values render as pickers
  from the system's own ladder (KCSE A..E, IGCSE A*..G, IB 7..1, A-Level
  A..E, degree/diploma class ladders); numeric fields get bounded number
  inputs. `node-save` re-validates against the same ladders — a value the
  picker could not show is refused, so what you can display is exactly what
  can be enforced.
- **Editable catalogues** — subjects can be **added** (duplicates refused
  with an explicit message, never swallowed), **renamed**, retired and
  restored per qualification system, all on the Requirements tab.
- **Schools & courses on one page** — schools are first-class (`schools`
  table): listed even before they have courses, **renamed in one action**
  with every course following, and new schools can be added next to the
  course table.
- **Display == enforce** — each course row on the Courses tab prints the
  exact enforced rule trees the engine evaluates (the engine's own
  `describeRuleTree` over the active sets, marked course-specific vs
  university-wide fallback); the free-text area is relabelled
  reference-only. The legacy `/config/entry-requirements` endpoint is
  replaced by an explicit refusal (no silent write) and its dead UI code is
  deleted; every qualification system stays reachable per programme.

**Evidence (RED → GREEN):** 18 tests in `test/course-config.test.ts`
written first — RED pasted in session log (`16 failed | 2 passed`: no
masters/phd levels, no pickers, no catalogue add/rename, no schools
endpoints, no enforced summary, legacy endpoint still writing). After the
fix: **18/18**; full suite **370/370 across 27 files** (including the
real-Chromium responsive audit at 1280/1024/768/480/360); `tsc --noEmit`
clean; **simulate 316/316**. Live-run (fresh DB + real server, HTTP):
setup → 302, login, Courses page shows schools + 23 "Enforced entry
requirements" summaries + rename/add forms and 0 legacy forms; Requirements
tab shows 3 KCSE pickers for LLB, `BASE:masters`/`BASE:phd` (no
`BASE:postgrad`), 11 catalogue-add + 132 rename forms; stale POST to the
legacy endpoint is refused.

**Interpretations:** "every subject × every system" is satisfied by keeping
one central subject catalogue per qualification system (fully editable) and
one builder that reaches every programme × system pair — the structured tree
remains the single source the engine reads. The free-text course notes field
is kept (relabelled reference-only) rather than deleted, so no existing
prospectus wording is lost. Renaming a school is one action by design;
courses move atomically with it.

## OR-7 — Templates section — **GREEN**

**Repro (before fix):** email templates lived inside *Configuration → Reply
configuration* as one card among pack files and branding, with no visibility
into **which outgoing email each template serves**, no way to **reset** an
accidental edit back to the official wording, and no way to say "this reply
goes out **with the application pack attached**" — pack attachment was
hardcoded (enquiries only). The automated pipeline hardcoded its own pack
logic separately from the templates, so the editor and the sender could
disagree (display ≠ enforce).

**Fixes:**
- **Dedicated Templates section** (`/templates`, admin nav + command
  palette): lists **every outgoing email type** with *who sends it*
  annotated — automated pipeline (enquiry document request, partial-file
  notice, complete-file acknowledgement, status answer, fallback), the
  reminder ladder (reuses the missing-documents template with a REMINDER
  prefix), manual staff replies, and auto-admission.
- **Placeholders documented + live preview:** all 13 tokens are listed with
  what fills them, and each template renders a live preview against a sample
  applicant via the same `renderTemplate` the sender uses. Saving a template
  with an **unknown placeholder warns loudly** (it would reach applicants as
  literal text) while still saving.
- **Reset to default:** every template restores to the official seeded
  wording (`TEMPLATE_DEFAULTS`, admission letter included); unknown keys are
  refused politely.
- **Optional pack attachment:** each template carries an `attach_pack` flag
  (none / application pack / admission pack). Manual template sends, compose
  sends and the **automated pipeline all honour the flag** — the pipeline no
  longer hardcodes packs, so what staff configure is exactly what applicants
  receive. Migration maps the two historical pack sends onto explicit flags
  (no staff choice overwritten). Missing pack files are audited + surfaced,
  never silently dropped.
- **Old location removed:** the Replies tab no longer hosts the editor (a
  pointer card links to the section) and the legacy `/settings/template`
  endpoint refuses stale writes explicitly.

**Evidence (RED → GREEN):** 13 tests in `test/templates-section.test.ts`
written first — RED pasted in session log (`12 failed | 1 passed`: no
/templates route, no placeholders/preview, no reset, no pack flag, editor
still in Replies). After the fix: **13/13**; full suite **383/383 across 28
files**; `tsc --noEmit` clean; **simulate 316/316**. Live-run (fresh DB +
real server, HTTP): `/templates?template=missing_documents` renders the
outgoing-type table, "Who sends it" annotations, `tpl-preview` with sample
data, Reset button and the pack picker; admin nav shows Templates; the
Replies tab has 0 editor forms; reset → 302; a stale POST to
`/settings/template` redirects with the "Templates section" refusal.

**Interpretations:** "every outgoing type" is satisfied by one section that
names the sender of each template (the templates themselves already covered
every automated path). The pack flag is deliberately a property of the
template rather than a per-send checkbox, so automated and manual sends
cannot diverge. "Reset" restores only what shipped (`TEMPLATE_DEFAULTS`) —
nothing is invented.

## OR-8 — Assignment & visibility scoping — **GREEN**

**Repro (before fix):** every logged-in account saw **every** case. Roles
were only admin/user — there was no way to say "this officer handles the
School of Nursing only". Any officer could open any direct `/case/:id` URL,
see any applicant in search or the API, and act on files that were never
theirs — the opposite of realistic role separation.

**Fixes:**
- **One decision point** — `repo.visibleSchoolsFor(staff)`: admins are
  **never** scoped; staff with no schools assigned keep full visibility
  (scoping is opt-in and reversible); an assigned-but-empty set matches
  *nothing*, never everything.
- **Every surface enforced:**
  - Queues: every queue tab lists only in-scope cases;
  - Admissions: level counts and lists are scoped;
  - Overview dashboards (admin + officer): every counter scoped;
  - Search + `/api/search`: out-of-scope applicants never appear;
  - Direct case URLs: one guard in front of the case page, compose, replay
    and **every** POST action — unknown and out-of-scope ids get the SAME
    403 so scoped staff cannot probe which cases exist;
  - Alerts about out-of-scope cases are filtered out (broadcasts stay);
  - Cases with **no programme** are never visible to scoped staff (no
    accidental over-sharing); admins still see them.
  - Exports stay admin-only, and admins cannot be scoped — the existing
    guarantee holds.
- **One matrix page, one action** — Staff Configuration → *Visibility
  scope*: a staff × schools matrix; each row saves the member's **entire**
  school set in a single POST (re-saving replaces the set; unticking
  everything restores full visibility). No other page edits scopes —
  pinned by test.

**Evidence (RED → GREEN):** 10 tests in `test/scoping.test.ts` written
first — RED pasted in session log (`10 failed`: `repo.setScopes is not a
function`, no guard, no matrix). After the fix: **10/10**; full suite
**393/393 across 29 files**; `tsc --noEmit` clean; **simulate 316/316**.

**Interpretations:** "assignment" is by **school** (faculty) — the natural
unit already used for course ownership; a case's school is its programme's
school. Scoping is additive and reversible: nobody loses access until an
admin explicitly saves a scope for them. The scope matrix is deliberately
admin-only; officers do not see or manage it.

---

(Functionality scan, route inventory and 1,000-case stress run pending — tracked in REPORT.md.)
