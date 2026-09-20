# Project-AA — Admissions Email Triage

Automated document-intake triage for Riara University admissions. Applicant emails with
attachments flow through a deterministic pipeline (text layer → Tesseract OCR → Gemini vision
as a last-resort reader), a rules engine classifies documents and evaluates entry requirements,
and anything uncertain goes to a human queue. The system never makes the final admission
decision on its own and never auto-rejects.

## Stack

Node 20 · TypeScript (strict) · Express · better-sqlite3 · pdfjs-dist · sharp · tesseract.js ·
vitest. SSR staff console (no client framework).

## First-run setup (no default credentials)

The app ships with **no accounts and no mock data**. On a fresh database:

1. `npm install`
2. `npm run serve` (default port 3000; `PORT=…` to change)
3. Open `http://localhost:3000` — every page redirects to the one-time **setup screen**
4. Create your administrator account (your name, a username, a password of ≥8 characters)

The setup screen disappears permanently after the first account exists. There is no
`admin/admin123` anywhere.

## Run on Linux (Ubuntu/Debian)

Everything is portable Node/TypeScript — no platform-specific code anywhere
(OCR is tesseract.js, PDF is pdfjs-dist, SQLite is embedded). One setup script:

```bash
npm run setup:linux   # node 20+, build toolchain for native modules, npm ci
npm run typecheck && npm test && npm run serve
```

- Requires **Node.js ≥ 20** (`engines` field enforced by npm).
- `better-sqlite3` / `sharp` / `canvas` ship prebuilt Linux binaries; the setup
  script also installs the fallback build toolchain (`build-essential`,
  cairo/pango dev headers) in case a custom Node build needs to compile them.
- Chromium is **optional** and only used by the UI layout probes
  (`scripts/ui-*.mts`) and the responsive tests — those skip themselves when no
  browser is present. Nothing else needs it.
- All npm scripts are POSIX (`VAR=value command`) and run unchanged under
  bash/zsh/sh. Line endings are pinned to LF via `.gitattributes`.

## Connecting Gmail and Gemini

Both live in the staff console under **Settings → Connections** (see OR-4 work for the guided
flow). For headless/live ingestion via environment variables, copy `.env.example`:
`MODE=live`, `GMAIL_ADDRESS`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
`GMAIL_OAUTH_REFRESH_TOKEN`, `GEMINI_API_KEY`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run serve` | Start the staff console + pipeline (reads `data/email-sorter.sqlite`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Full vitest suite (311 tests) |
| `npm run simulate` | Fixture corpus through the pipeline — **in-memory DB only**; it refuses to touch the server database |
| `npm run purge-mock` | One-time safe cleanup of old demo/simulation rows (backup first, idempotent) |
| `npm run ingest / queue / escalate / followups / retain / backup / restore` | Operational CLIs |

## Simulation tooling is isolated

`src/simulation` (fixtures, PDF factory, answer key) is **developer/test tooling only**:

- `npm run simulate` runs against an in-memory database by default.
- `runSimulation()` throws if asked to write the server's configured database.
- Nothing in the simulation is ever seeded into the product database; `npm run demo` no
  longer exists.

If an older install ran the removed demo tool against the live DB, run
`npm run purge-mock` once — it backs the database up and removes only rows flagged as
demo/simulation, never real Gmail or staff data.

## Tests

`npm test` — unit + integration + HTTP tests (in-memory DBs, ephemeral ports).
Acceptance gates for owner-reported issues live in `test/owner-acceptance.test.ts`;
evidence log in `OWNER_ISSUES.md`.
