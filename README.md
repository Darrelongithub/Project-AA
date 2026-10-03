# Project-AA — Document Intake Console

A general-purpose intake console for any office that receives work by email. Inbound
messages with attachments flow through a deterministic pipeline (embedded text layer →
Tesseract OCR → Gemini vision as a last-resort reader), the documents are classified
against **your own** configured checklist, a rules engine evaluates **your own** rule
tree, and anything uncertain goes to a human queue.

The product ships with no domain built in: no bundled tenants, cases, contacts, checklists,
templates or files. Every organization describes its own work — case types, required
information, and the facts that decide a route — and the console enforces exactly that.
Outcomes are recorded by people; the machine never approves, never rejects, and never
auto-rejects a late arrival.

## What a tenant configures

| Surface | Where | What it does |
| --- | --- | --- |
| Case types | Configuration → CaseTypes | One per kind of work; owns everything below |
| Document checklist | CaseType → Document matrix | Required/optional items, and which ones block the gate |
| Rule tree | CaseType → Rule tree | Scalar `AND` / `OR` / `NOT` conditions over facts read from mail and documents |
| Vocabulary | CaseType → Vocabulary | Its own words for case/contact/category/stage/outcome, its own stage and queue labels |
| Workflow rules | Configuration → Workflow rules | Intake rules (open/attach/ignore/review) and response rules (which reply, drafted/sent/held/approved, follow-up rung, assignment) |
| Attachment sets | Configuration → Document library | Your own PDFs, attached by name from a template or a rule |
| Templates | Templates section | Every outgoing message type, per organization, with a live preview and reset-to-default |
| Submission windows | Configuration → Requirements & repairs | Named windows and their deadlines; a late arrival raises `late_submission` for a human |
| Visibility scope | Team | Which case types each staff member sees (administrators always see all) |
| Inbound address | Settings → Letters & identity | Which mailbox address belongs to this organization — one mailbox can serve several tenants, and mail that names no tenant falls back to the head office with an audit line saying so |
| Message categories | Settings | The only labels a message may be given. With a Gemini key reachable, the model is offered this list and nothing else; an off-list answer is rejected and the deterministic matcher decides. A label is routing metadata for people — it never approves or rejects |

Automation is opt-in twice over: the global automation mode holds every automated reply
for approval by default (`automation_mode=draft`), and each new case type starts
draft-first with the evidence gate **on** — automated mail only for a fully evidenced
case, and only once an administrator switches the case type to sending.

## Stack

Node 22.13+ · TypeScript (strict) · Express · better-sqlite3 · pdfjs-dist · sharp · tesseract.js ·
vitest. SSR staff console (no client framework).

## First-run setup (no default credentials, no seeded data)

A fresh database contains **no organizations, no cases, no contacts and no staff accounts**:

1. `npm install`
2. `npm run serve` (default port 8080; `PORT=…` to change)
3. Open `http://localhost:8080` — every page redirects to the one-time **setup screen**
4. Name your organization and create your administrator account (your name, a username,
   a password of ≥8 characters)

The same step creates seven **neutral starter reply templates** for your organization —
the wording the pipeline and workflow rules refer to. Edit every line (or reset one to
its own default later); nothing else is pre-filled. An organization created before this
behaviour, or one whose templates were deleted, can add the set again from the Templates
section (it never overwrites wording you have written).

The setup screen disappears permanently after the first account exists — the same
transaction created your organization, so the console opens on an empty, unconfigured
workspace that you then describe in Configuration. There is no `admin/admin123` anywhere.

## Run on Linux (Ubuntu/Debian)

Everything is portable Node/TypeScript — no platform-specific code anywhere
(OCR is tesseract.js, PDF is pdfjs-dist, SQLite is embedded). One setup script:

```bash
npm run setup:linux   # node 22.13+, build toolchain for native modules, npm ci
npm run typecheck && npm test && npm run serve
```

- Requires **Node.js ≥ 22.13** (`engines` field enforced by npm). pdf.js 6 — which removes
  the JavaScript-evaluation paths the 3.x line only let us disable — needs 22.13+, and
  CommonJS `require()` of its ESM build needs ≥ 22.12.
- `better-sqlite3` / `sharp` ship prebuilt Linux binaries; the setup script also installs
  the fallback build toolchain (`build-essential`, cairo/pango dev headers) in case a
  custom Node build needs to compile them. `canvas` is optional: where it is unavailable,
  raster-only PDFs fall back to OCR or are held for a human instead of being guessed at.
- Chromium is **optional** and only used by the UI layout probes (`scripts/ui-*.mts`) and
  the responsive test — those skip themselves when no browser is present. Nothing else
  needs it.
- All npm scripts are POSIX (`VAR=value command`) and run unchanged under bash/zsh/sh.
  Line endings are pinned to LF via `.gitattributes`.

## Connecting Gmail and Gemini

Both live in the staff console under **Settings → Connections**. For headless/live
ingestion via environment variables, copy `.env.example`: `MODE=live`, `GMAIL_ADDRESS`,
`GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`,
`GEMINI_API_KEY`. Credentials are stored in the `secrets` table — never in the settings
bag that is rendered or exported. The Gemini key is installation-wide (one key powers
document reading, the watcher and message classification), so only the head-office tenant
may change it; a stored key wins over the environment, and either one is honoured.

**Until a mailbox is connected, nothing is delivered.** The console says so on every page,
the boot log warns, and a reply that could not be sent is audited as `email_not_delivered`
rather than recorded as a delivery. Automated replies also stay drafts until automation is
opted in: the global automation mode, the case type's own reply default, its evidence gate,
and a workflow rule that says `send` — all four must be open before the machine speaks to a
contact.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run serve` | Start the staff console + pipeline (reads `data/email-sorter.sqlite`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` (`tsc -p tsconfig.json`) |
| `npm start` | Run the compiled build (`node dist/src/cli/serve.js`) — run `npm run build` first |
| `npm test` | Full vitest suite (545 tests across 71 files; one test skips itself without a Chromium binary) |
| `npm run simulate` | Fixture corpus — 26 scenarios / 409 checks — through the pipeline against a **configured generic tenant**; in-memory DB by default, and it refuses to touch the server database. CI gate: exits non-zero when any check fails |
| `npm run stress` | Load/stress harness: 1000 generated cases (seed 7331) plus replay determinism, against a throwaway database |
| `npm run seed:demo-org` | Optional, idempotent seed of a **demo second organization** (Aperture People Ops, `APO`) alongside your own — see [docs/DEMO_ORG.md](docs/DEMO_ORG.md). `SEED_DEMO_ORG=1 npm run serve` does the same on boot |
| `npm run purge-mock` | One-time safe cleanup of old demo/simulation rows (backup first, idempotent) |
| `npm run ingest / queue / escalate / followups / retain / backup / restore` | Operational CLIs |

## Simulation and stress tooling are isolated

`src/simulation` (fixtures, PDF factory, answer key) and `src/cli/stress.ts` are
**developer/test tooling only**:

- Both run against an in-memory or throwaway database by default.
- `runSimulation()` throws if asked to write the server's configured database.
- Nothing in either is ever seeded into the product database; `npm run demo` no longer
  exists, and no bundled tenant, checklist, template or PDF ships with the product.

If an older install ran the removed demo tool against the live DB, run
`npm run purge-mock` once — it backs the database up and removes only rows flagged as
demo/simulation, never real mail or staff data.

## Optional demo tenant

The demo organization is separate and off by default: it is created only by
`npm run seed:demo-org` or `SEED_DEMO_ORG=1`. It never reads, copies or edits another
tenant's rows, its cases are marked as demo, and `test/demo-org.test.ts` pins that
isolation end-to-end (including that a demo-only administrator cannot switch tenants).

## Upgrading an existing installation

Opening a database migrates its storage in place, inside one transaction that aborts
rather than half-applying:

- Historical table and column names are renamed as declared in
  [`migrations/legacy-storage.json`](migrations/legacy-storage.json) — storage names only;
  no catalogue, preset, identity or decision data is loaded.
- Missing columns, indexes and tables are added; the legacy uniqueness constraints on
  cases and processed mail are rebuilt per tenant, so two organizations may hold the same
  contact email while a duplicate inside one organization is still refused.
- The school dimension is dropped. Visibility scope is now the **case type**, so staff who
  were school-scoped are narrowed to *no* case types (never widened) until an
  administrator assigns them on the Team page.
- History is never rewritten: reference numbers, frozen configuration snapshots, audit and
  decision logs survive byte-identical, and a recorded outcome is mapped once into the
  generic vocabulary while the original text is kept beside it.
- A database written by a newer version of the application is refused rather than
  downgraded. `test/ppr-p07-migration.test.ts` proves all of the above on a
  production-shaped copy.

## Tests

`npm test` — unit + integration + HTTP tests (in-memory DBs, ephemeral ports).
Acceptance gates for owner-reported issues live in `test/owner-acceptance.test.ts`;
evidence log in `OWNER_ISSUES.md`.

## Static analysis policy

`npm run typecheck` (`tsc --noEmit`, strict mode) is the project's **only** static
gate — it runs before every test run and in CI. There is deliberately no ESLint
config: `npx eslint` here reflects no project policy, and ad-hoc lint output can
be ignored. Keep new code strict-clean under the existing `tsconfig.json`.
