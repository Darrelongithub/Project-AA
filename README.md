# Admissions Intake — document-intake email triage + case management (v3)

> **UI**: Riara University identity — white & purple, gold crest, full **dark
> mode** (toggle in the top bar), branded splash entry, sidebar app shell,
> **⌘/Ctrl-K command palette**, avatar initials, live relative timestamps,
> toast notifications, and a printable one-page case brief. Fully
> self-contained: zero external fonts, CDNs or assets.

Automated first stage of a document-intake email workflow modeled on university
admissions triage. It reads incoming emails + PDF attachments, tracks what each
applicant has submitted across their whole thread, classifies every applicant
(**Green / Orange / Red**), and gives admissions staff a full case-management
console: dashboards, review queue, one-click case files, search, audit trail,
SLAs, exports, and an applicant self-service status page.

> **The system never makes the admission decision.** It triages document
> completeness. Anything uncertain, borderline, or ambiguous goes to a human,
> and a human always makes the actual call. Automation is strictly *factual*:
> receipts, missing-doc lists, status answers.

---

## Quick start

```bash
npm install

npm test        # 128 unit/integration/web tests
npm run simulate  # 19 scenarios, 232 checks scored against an answer key

npm run demo    # seed the serve DB (./data/email-sorter.sqlite) through the REAL pipeline
npm run serve   # staff console on http://localhost:8080
```

Sign in at `/login` — seeded accounts (change immediately in **Staff**):

| user | password | role |
|---|---|---|
| `admin` | `admin123` | admin — everything |
| `manager` | `manager123` | manager — cases + configuration |
| `kofi` | `kofi123` | it — cases + automation/settings, no staff management |
| `jane` / `otis` | `jane123` / `otis123` | officer — cases only |

Public applicant pages:

- `/status` — reference + email lookup (try `RU-2026-000002` +
  `brian.ruto@student.example.org`).
- `/portal` — authenticated applicant portal: reference + email + **one-time
  code** (demo mode shows the code on screen). Applicants check their
  checklist and upload missing documents straight into their case (try
  `RU-2026-000003` + `carol.maina@student.example.org`).

---

## The core principle (unchanged, enforced by design)

**Code decides. AI only reads/flags.**

- `/rules` is the *only* thing that assigns Green/Orange/Red — a **pure
  function** with zero dependencies beyond shared types, exhaustively
  unit-tested with fake data.
- Gemini is a *sensor*: extraction fallback + one narrow pre-auto-send sanity
  check ("watcher"). The watcher can only **downgrade** a Green, and **fails
  closed** (API unavailable ⇒ human queue, never an auto-reply).
- Borderline = human. Grades below the floor raise a flag → Orange. Never
  auto-approved, never auto-rejected.
- What v2 automates is *factual communication only*: acknowledgements for
  verified-complete files, "we are still missing X" notices, document
  requests, and "here is your real status" answers.

## Feature map

| # | Feature | Where |
|---|---|---|
| 1 | Reference numbers `RU-2026-000085` (permanent, searchable) | `repo.nextRefNumber`, `applicants.ref_number` |
| 2 | Case files: name/email/phone/programme/ref/status/history | `applicants` + enrichment (`src/enrich`) |
| 3 | Email ingestion, auto-attach to applicant, auto-create | `/ingestion`, `/matching` |
| 4 | Full email history per applicant (in & out, chronological) | `emails` table |
| 5–6 | Attachment detection + extraction `text → Tesseract → Gemini` with fields | `/extraction` |
| 7 | Document checklist ✓/✗ | case page + `/status` |
| 8, 36–37 | Configurable requirements per programme & intake | `requirement_rules`, Settings UI |
| 9 | Versioning — new submission supersedes old, history kept | `documents.superseded_by` |
| 10 | Deterministic rules engine, AI never decides | `/rules` (pure) |
| 11 | Human-review queue with urgency counts | `/queue` page |
| 12 | One-click case review (docs, fields, flags, history, actions) | `/case/:id` |
| 13 | Automatic missing-document emails | gate v2 + `missing_documents` template |
| 14 | `[RU-2026-000085]` in every outgoing subject | `subjectWithRef` |
| 15–16 | Lifecycle stages + who/what/when/why history | `status_history` |
| 17 | Audit log | `audit_log` |
| 18–19 | Search (ref/name/email/phone) + filters | `searchApplicants` |
| 20–21 | Applicant self-service status page; "have you received my docs?" answered from reality | `/status` + `status_answer` |
| 22 | Duplicate detection (content hash) | `documents.sha256` |
| 23 | Name-mismatch detection incl. one-letter typo variants (Levenshtein) | `/rules` |
| 24–25 | Unreadable / unknown documents → human review | quality gates + `unknown` handling |
| 26 | Email categorization (8 categories, deterministic) | `/categorize` |
| 27 | Priority normal/high/urgent (complaints auto-raise) | `applicants.priority` |
| 28–29 | Response-time targets + escalation | SLA fields + `runEscalationSweep` |
| 30 | Dashboard analytics | `dashboardStats` |
| 31–32 | Staff accounts + role permissions | `staff_users`, `requireRole` |
| 33 | Assignment | `/case/:id/assign` |
| 34 | Internal notes (never visible to applicant) | `notes` |
| 35 | Editable email templates with placeholders | `templates`, Settings UI |
| 38 | CSV export (Excel-compatible) | `/export/*.csv` |
| 39 | Notifications (escalations, review needed, assignments) | `notifications` |
| 40 | Backup & restore | `npm run backup` / `npm run restore` |

## v3 feature map

| # | Feature | Where |
|---|---|---|
| 1 | **Unanswered-email detection** — per-case hours waiting, configurable target, Command Center panel | `repo.unansweredCases`, `unanswered_target_hours` |
| 4 | **Conversation reconstruction** — same sender, any thread/subject/forward → same case; threads linked, never fragmented | `resolveIdentity`, `applicant_threads` |
| 5 | **Identity matching by signals** — quoted ref > known sender > new; low-confidence attach → `identity_check` flag, never silent wrong-attach | `src/matching/identity.ts` |
| 6 | **Document-intelligence fields** — index number, subjects/grades, exam year, confidence | `extractFields` |
| 7 | **Authenticity/anomaly flagging** — conflicting dates etc. → `anomaly` flag → human verification, never an AI "fake" verdict | `deriveFlags` (cross-doc dates) |
| 9 | **Corrections supersede** old documents, history kept | `supersedeOlder` |
| 12 | **Applicant Action Center** — missing-doc notice has an **[Upload]** path; portal upload auto-attaches to the case | `/portal` + channel `portal` |
| 13 | **Automatic follow-up ladder** — Day 0 notice → Day 3 reminder → Day 7 final → Day 10 human; configurable | `/followups`, `followup_ladder_days` |
| 15 | **Conversation memory** — replies are rebuilt from case reality (checklist/status), never boilerplate | `renderTemplate` + live requirements |
| 16 | **Human handoff** — held drafts get **[Send] [Save] [Discard]** with the reason on screen | `/case/:id/draft` |
| 17 | **Draft-first mode** — global or per-category: hold every automated reply for approval, then relax gradually | `automation_mode`, `automation_config` |
| 18 | **Staff-configurable rules** — requirements editor, no programmer | Settings → Requirement rules |
| 19 | **Rules versioning** — requirement set frozen at first triage; old applicants keep old rules | `requirements_snapshot` |
| 20–21 | **Intake deadlines** — late arrival → `late_submission` flag → human, never auto-rejected | `intakes.deadline`, deadline check |
| 25 | **Tasks** — cases become work items (verify doc, contact applicant…) | `tasks`, case page |
| 28–29 | **Bottleneck analytics** — where applicants get stuck (category share) | Command Center |
| 30–31 | **Automation Accuracy Dashboard** — greens, watcher catches, human overrides, send errors | `repo.accuracyStats` |
| 32 | **Full decision replay** — click "why was this flagged?" → step-by-step chain | `/case/:id/replay` |
| 33 | **"What changed?"** — diff of last two decisions surfaced on the case | `whatChanged` |
| 34 | **Reopen, don't duplicate** — completed applicant emails again → same case reopens | reopen block in pipeline |
| 35 | **Secure applicant auth** — ref identifies the case, OTP proves identity; short-lived sessions | `portal_otps`, `portal_sessions` |
| 38 | **Data retention** — configurable days; completed cases archived to JSON then removed | `npm run retain` |
| 40 | **Multi-channel** — email & portal feed the same case via a `channel` field | `emails.channel` |
| — | **Admissions Command Center** — greeting → needs-attention banner → today counters → bottlenecks → accuracy. Not an inbox clone. | `/` (dashboard) |

## The triage pipeline per email

1. **Categorize** — deterministic keywords → 8 categories; complaints raise priority.
2. **Identify the applicant (v3)** — strongest signal first: a reference number
   quoted in subject/body → a known sender address across **any** thread →
   create new. Quoted-ref from an unexpected sender still lands on the right
   case but raises `identity_check` for a human. Completed/verification cases
   that receive substantive new email **reopen** instead of duplicating.
3. **Store** the incoming email in the case history (with its `channel`);
   audit event; phone/programme/intake enrichment; requirement set frozen on
   first triage; intake deadline checked (`late_submission` flag if past).
4. **Extract** each attachment — fixed chain, cheapest first: embedded text
   layer (pdf.js) → Tesseract OCR on embedded images → Gemini vision. Each
   tier quality-checked (length, letter ratio, distinct words, avg word
   length, repeat runs). Byte-identical resubmissions are detected by SHA-256
   and deduplicated, not double-counted.
5. **Match & version** — new docs of an existing type supersede the old one.
6. **Rules** — pure `decide(requirements, activeDocs, flags)` → Green/Orange/Red.
   Requirements are resolved per applicant's programme+intake (most specific wins).
7. **Watcher** — Green only; can only downgrade; fails closed.
8. **Gate v2**:
   - Green + watcher clean → auto acknowledgement
   - Red *only because docs are missing*, nothing ambiguous → factual
     missing-docs notice / document request (and the **follow-up ladder** is
     armed: reminder days configurable, final rung hands the case to staff)
   - "Have you received my documents?" style follow-up → factual status answer
   - **everything else → human queue** (Orange, watcher-downgrades,
     identity/lateness/anomaly flags, anything ambiguous)
   - **draft-first mode** can hold *any* of the above for approval — globally
     or per category. Send failures are also never fatal: the reply becomes a
     queued draft for a human.
9. **Drafting** — DB-editable templates, `{ref} {name} {missing_docs} {checklist} {status}`
   placeholders, `[RU-…]` prepended to every subject. Held drafts surface on
   the case page with **[Send] [Save] [Discard]**.
10. **Lifecycle** — Application Received → Documents Received → Documents
    Checked → Awaiting Review → Verification → Completed; every transition
    recorded with actor + reason. Queued cases start the SLA clock.
11. **Log** — DecisionLog + audit trail, regardless of outcome. The full chain
    is browsable per case under **decision replay**.

## Commands

```bash
npm test                     # unit + integration + web smoke tests
npm run simulate             # score pipeline against answer key (CI-ready exit code)
npm run demo                 # seed demo DB through the real pipeline (always rebuilt fresh)
npm run serve                # web console (+ live Gmail polling in MODE=live)
npm run queue                # terminal view of the human queue
npm run ingest [-- --watch]  # live Gmail ingestion (needs .env credentials)
npm run escalate             # one-shot SLA escalation sweep (cron-friendly; also runs every 5 min in serve)
npm run followups            # one-shot follow-up ladder sweep (also runs every 2 min in serve)
npm run retain               # archive + remove completed cases past retention_days (PII hygiene)
npm run backup               # consistent DB copy to ./backups/
npm run restore -- <file>    # restore a backup
```

### v3 settings worth knowing (Settings page)

- **Automation mode** — `draft` holds every automated reply for human
  approval (recommended for rollout); flip individual categories to `auto`
  as trust grows.
- **Intake deadlines** — a date per intake; late arrivals are flagged, never
  auto-rejected.
- **Follow-up ladder** — reminder days (default `3,7,10`).
- **Unanswered-email target** — threshold for the ⚠️ panel.
- **Retention days** — how long completed cases live before `npm run retain`
  archives + removes them.
- **Portal OTP delivery** — `screen` (demo) or `email` (live mode).

Simulation knobs: `DISABLE_OCR=1` (force Gemini tier for scans),
`SIM_DB_PATH=./data/x.sqlite` (persist a run), `AUTO_MISSING_DOCS_EMAILS=0` /
`AUTO_STATUS_ANSWERS=0` (switch the factual auto-replies off).

## Live mode

Copy `.env.example` → `.env`:

- `MODE=live`, `GEMINI_API_KEY` — enables real Gemini vision + watcher.
- Gmail OAuth2 (installed-app): `GMAIL_ADDRESS`, `GMAIL_OAUTH_CLIENT_ID`,
  `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`.
- `PORT`, `DB_PATH`, `INGEST_LOOKBACK_DAYS`, SLA defaults.

`npm run serve` then also polls the inbox every 60s; auto-replies are sent
through Gmail in-thread.

## Implementation notes

- **`pdf-parse` → `pdfjs-dist`**: the spec named `pdf-parse`, but its pinned
  2018 pdf.js core failed nondeterministically ("bad XRef entry", in-process
  state leaks) on modern PDFs. We use the maintained pdf.js legacy build —
  same engine family, same free/local cost profile, reliable. Tier semantics
  unchanged.
- **OCR reads embedded images**: Tesseract is an image engine, so scanned
  PDFs have their image XObjects extracted (JPEG as-is, FlateDecode
  re-encoded to PNG with predictor un-filtering). Exotic codecs skip to
  Gemini, which reads PDFs natively. Language data ships in `tessdata/` —
  OCR works offline out of the box.
- **Security posture**: DB-backed sessions, scrypt password hashes with
  constant-time comparison, CSRF tokens on all state-changing POSTs, role
  guards, HttpOnly/SameSite cookies, rate-limited public status lookups, no
  external web assets (fully self-contained pages).
- **Portability**: single-file SQLite DB (swap to PostgreSQL by rewriting
  `db.ts`+`repo.ts` only), one `npm install`, no services required.
- **Watcher fail-closed** and gate invariants are unit-tested: Orange/Red can
  never auto-send, and a Green without a clean watcher can't either.

## What this system will never do

- Decide admissions/approvals — automated emails confirm receipt/status only.
- Auto-send anything ambiguous, flagged, or watcher-doubted.
- Auto-reject a borderline case — a sub-floor grade becomes a human flag, full stop.
