# Project-AA — Document Intake Console

Project-AA is a general-purpose intake console for offices that receive work by email. It turns inbound messages and attachments into organization-owned cases, checks documents against each case type's configured requirements, evaluates configured rules over extracted facts, and sends uncertain work to staff. It is not a preconfigured industry workflow: a new organization starts empty and defines its own case types, checklists, rule trees, vocabulary, templates, and workflows.

The pipeline provides evidence and routing. **A machine outcome is never an approval or rejection:** a person with the `record_outcome` permission records an outcome and a written reason. Missing, unreadable, ambiguous, or low-confidence evidence is held for a person.

## Product model

### Organization-owned configuration

An administrator configures the following for each organization:

| Surface | Purpose |
| --- | --- |
| **CaseTypes** | Different kinds of work. A case type owns its documents, fact fields, rule tree, vocabulary, stages, queues, and workflow scope. |
| **Document matrix** | Document key, contact-facing label, required/optional, blocking/non-blocking, display order, and optional organization-defined axes/values. |
| **Rule tree** | Deterministic `AND` / `OR` / `NOT` / group logic over configured scalar facts. Rules that cannot be evaluated remain undetermined and route to a human. |
| **Workflow rules** | Intake and response actions, stages, queues, assignment, templates, attachment sets, follow-ups, and service targets. A stage can declare information required before a case advances. |
| **Message categories (Settings)** | An organization-owned allow-list. Gemini may return only a configured category; a category is routing metadata, never an outcome. |
| **Templates and attachment sets** | Organization-owned reply copy and uploaded files. A template can explicitly request an attachment set; missing resources are reported rather than silently omitted. First-run setup creates seven neutral starter templates for that organization only; edit their wording before sending. |
| **Organization branding** | Organization-owned name, logo, and theme colors are rendered in the web console and documents; new tenants do not inherit another tenant's identity. |
| **Sender identity** | Organization-owned From display name and Reply-To are applied consistently to pipeline, follow-up, manual, and approved-draft mail. |
| **Inbound addresses and aliases** | Attribute mail to an organization and, when configured, route it to a case type. |
| **Submission windows** | Organization-scoped names and deadlines. A late arrival raises a review flag; it is not auto-rejected. |
| **Staff scopes and permissions** | Staff can be scoped to case types. Administrators are not scoped. `publish_rules`, `send_automated`, `approve_automation`, and `record_outcome` are separate enforced permission grants. |

Workflow rules are data, not hard-coded case-type branches: intake rules can create, attach, ignore, or review; response rules select explicit `none`, `draft`, `send`, `hold`, or `approve` actions and may configure assignment, stage/queue, template, attachment set, SLA, and follow-up behavior. Administrators can preview unsaved rules against a sample email; preview reports the match/no-match and winning published rule without writing to the database.

Response targets, escalation timing, and follow-up days are configurable in Settings. The reminder ladder is anchored to the original missing-information date (default days 3, 7, and 10), not stacked from the previous reminder. A factual status reply can be drafted while the underlying case remains in human review; this dual state is explicitly audited.

A new organization has **no academic or other domain defaults**, no copied tenant-specific templates or bundled packs, and no prefilled checklist. First-run setup supplies only the neutral starter templates noted above; its administrator creates the rules and checklist it needs.

### Document requirements

A checklist comes only from the selected case type's `document_definitions` and configured axes; there is no bundled requirement catalogue. An organization with no configured definitions has an empty checklist and an `unconfigured_case` is held for a human.

- A document fills **one exact slot**: its `document_type` must match the configured key. Similar names are not inferred as equivalent.
- A missing slot blocks only when it is both `required` and `blocking`. Optional and non-blocking items can be requested but do not hold a case.
- A file that fills no slot remains visible and raises a `wrong_document` flag for human review; it is never silently discarded or counted as a required document.
- Re-evaluation against changed configuration is explicit. Cases retain their frozen checklist/rules until an authorized re-evaluation. Re-typing freezes the new type's configuration but does **not** re-evaluate automatically; a person uses the Re-evaluate action when ready.

### Case-type routing

Inbound type resolution is deterministic, in this order: a connector-supplied type, a matching active recipient alias, the sole configured case type when there is exactly one, and otherwise no type. Alias matching is case-insensitive, reads Delivered-To/To/Cc, and honors plus-address tags. If recipients match aliases for different case types, the system does not guess: it records the ambiguity and leaves the case for a person. Staff who can access a case can use its **Re-type this case** control to select a type belonging to that organization; the change is audited and sends nothing.

Rule-based and classifier-category-to-case-type routing are intentionally not enabled. For a shared mailbox with several case types and no reliable address distinction, staff must route/re-type the case.

### Web submissions

An organization can accept submissions from its own website, form builder or automation tool through `POST /api/v1/ingest/:org_key`. The address, its permanent per-organization key, the request budget and the recent-delivery log all live under **Settings → Web submissions**, next to the Connections setup, with copy-paste examples for a plain HTML form, WordPress, Zapier, Make and Webflow.

Accepted fields are `email` (required), `full_name`, `external_id`, `case_type`, `message` and `metadata`. The response returns the case's `ref_number`, so the caller can tell a person asking for their reference what it is. A submission is a message, not an instruction: it becomes an `IncomingEmail` on the `webhook` channel and runs the ordinary path — the same case-type rules, the same document and evidence gates, the same draft-first automation switch, the same human-only outcomes. Nothing on this endpoint can read a case, change one or decide one.

Three properties are deliberate. Validation refuses rather than truncates, and a `case_type` the organization has not configured is an error rather than a new type or a silent fallback to `other`. `external_id` is an idempotency key, so a retry or a double-clicked form replays the first result instead of opening a second case; if processing fails the claim is released and a retry is welcome. The key is a bearer credential and is never written to a log line, an audit row or a delivery record, so rotation is one database update with no grace period — the old address is refused on the next request. Because a browser-side form must contain the address to post to it, anyone who can view that page can read it and submit through it: post from your own server when that is not acceptable, and rotate if it leaks (see `BUGS.md` PROD-13).

### Case states and queues

State is derived from separate facts rather than one overloaded status string: lifecycle, routing, routing reason, outcome, escalation, and follow-up schedule. Each case appears in one queue:

1. **Completed / Verification** — lifecycle is in verification or completed.
2. **Outcomes** — a human outcome has been recorded.
3. **Waiting for Documents** — a required blocking item is genuinely missing.
4. **Human Review Required** — a person must inspect evidence, make a manual route/decision, verify a flag, or handle an escalation. Documents received without a routing decision also belong here, never in Enquiries.
5. **Enquiries & Communication** — correspondence that is not waiting on a document or review action.

Queue rows show a plain-language reason. Escalation keeps work in human review; it does not decide the case.

## Automation, outcomes, and mail safety

Automated messages are safe-by-default and require multiple gates:

- The global `automation_mode` starts at **draft**.
- The per-category auto-send allow-list starts **empty**. Releasing the global mode does not release every category.
- New case types are draft-first and have the evidence gate on.
- A configured workflow must request a permitted send, the case type/global/category settings must allow it, and the classifier must not have held the message.
- **A non-Green case is never auto-sent.** `evidence_gate=0` and a rule's `send` action cannot waive the Green, no-blocking-flags qualification; replies for other cases stay as suggested drafts for staff.
- A fallback category or confidence below `CLASSIFIER_MIN_CONFIDENCE` (0.70) is held for a person. A category does not make an approval/rejection decision.
- A staff member's deliberate send is separate from automated sending. When no delivering Gmail sender is connected, automated replies remain queued drafts; the application writes no outbound-email or auto-sent record for undelivered mail, and audits the hold as `email_not_delivered`.

Human outcomes are recorded through the case page with `record_outcome` permission and a written reason. The automated pipeline never records an outcome. Historical `auto_approved` values may be preserved as imported legacy data; they are not produced by the current pipeline.

### Identity matching and message safety

A quoted reference is not sufficient to disclose a case to an unverified sender. Under the settled behavior, the inbound message is retained on the case it names so staff can see who wrote it, but an unknown or mismatched sender receives no automatic status reply or case disclosure; a person decides what to do next. Portal-like synthetic channels do not get to redirect uploaded documents by putting somebody else's reference in a filename. Attachment, sender, tenant, and case-type scope checks apply before staff actions and exports.

### Gmail and Gemini

The default mode is `MODE=mock`; external services are not contacted in that mode. Gmail setup is performed by an administrator in **Settings → Connections**. The product's Gmail operations require only these OAuth scopes:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`

Do **not** grant `gmail.modify`: the application does not delete, label, move, or mark mail as read. No Gmail or Gemini endpoint has been exercised against a real account as part of the repository's automated checks. See the pilot checklist in [`BUGS.md`](BUGS.md#real-mail-pilot-unverified).

Gmail and Gemini credentials are stored in the organization-scoped `secrets` table rather than the rendered/exportable settings bag. The Gemini API key is installation-wide, is managed through **Settings → Connections**, and is read only from that secret store; `GEMINI_API_KEY` environment values are not used. Headless CLI tools read the same database secret. `GEMINI_MODEL` remains an optional, non-secret model-name override. Do not put credentials into source control or chat.

## Architecture and limits

- **Runtime:** Node.js **22.13+**, TypeScript strict mode, Express, better-sqlite3, server-rendered HTML, Vitest. The UI does not use a client framework.
- **Storage:** SQLite in WAL mode, foreign keys on, with a 5-second `busy_timeout`. Repository methods own tenant scope and transactional writes; `case_type_code` is the generic case-type code column.
- **Ingestion:** Gmail messages are tenant-attributed from configured addresses, checked by the intake gate, and either parked (with an audit trail) or sent through the case pipeline. The normal mailbox lookback is 14 days; administrators can request an audited one-off 30/90/365-day backfill. A pass lists at most 1,000 message IDs, so exceptionally high-volume windows need a segmented backfill. Mailbox-wide reads exclude sent, spam, and trash unless a configured Gmail label narrows the watch target. Parked mail remains visible to staff and is included in classifier evaluation exports.
- **Extraction:** PDF.js 6 reads untrusted PDFs through centralized hardened options; parsing has a 20-second budget, a 25-page cap, and the inbound attachment cap is 10 MB. Partially read material is capped at score 60, below the 75 auto-pass floor. OCR is best-effort and runs locally before Gemini on image attachments; raster-only PDF pages can require the optional `canvas` native module. Gemini vision is an optional last-resort reader, not a decision-maker. The duplicate-content heuristic can conservatively flag distinct files with long shared letterheads; that path holds for a person.
- **Routing/evaluation:** document slots and rule trees are deterministic; missing or unread values are not treated as failures. Unknown, ambiguous, incomplete, or low-confidence cases route to a person.
- **Web surface:** first-run setup/login; case pages, search, queues and mail; organization configuration (CaseTypes, rules, documents, aliases, workflows, templates, attachment sets); Settings (connections, automation, intake, SLA/retention); staff and scopes; admin exports. Mutating staff routes use authentication, tenant/scope checks, and CSRF protection. `/queue` and `/team` remain compatibility redirects.
- **Operational CLIs:** serving, ingestion, escalation, follow-ups, online backup/restore, retention, demo seeding, and simulation/stress harnesses.

## First run

A fresh database contains no organization, staff account, case, contact, or seeded workflow. Setup creates the first organization and its administrator; there is no default `admin/admin123` account.

Requirements: Node.js ≥22.13 and the platform's native build prerequisites for any packages that need compiling. On supported Linux, the setup script installs the build toolchain and project dependencies:

```bash
npm run setup:linux
npm run typecheck
npm test
npm run serve
```

The console listens on port **8080** by default. Open `http://localhost:8080`; the first request redirects to the one-time setup page. Use `PORT` to change the port and `DB_PATH` to select a database. Defaults are `PORT=8080`, `DB_PATH=./data/email-sorter.sqlite`, and `MODE=mock`. See `.env.example` for the complete configuration surface.

For a production-style compiled run:

```bash
npm ci
npm run build
MODE=live DB_PATH=/path/to/email-sorter.sqlite PORT=8080 npm start
```

Opening an older database invokes the declared storage migration transactionally. **Do not use an unverified copy or a real tenant database as a test target.** The exact stop-writers / backup / dry-run / verify / rollback procedure for the C2 schema migration is in [`BUGS.md`](BUGS.md#existing-database-migration-c2).

### Reverse proxy deployment

When deployed behind exactly one trusted reverse proxy, set `TRUST_PROXY=1` so Express uses the expected forwarded client address for request/rate-limit handling. Under HTTPS, set `COOKIE_SECURE=1` so session cookies are `Secure`. Do not enable proxy trust unless the network topology is controlled; forwarding headers from an untrusted client must not be treated as authoritative.

## Optional demo organization

Aperture People Ops is an **optional**, idempotently seeded second organization. It is not added on a normal boot and does not copy another organization's settings, templates, documents, or cases.

```bash
npm run seed:demo-org                 # uses DB_PATH
SEED_DEMO_ORG=1 npm run serve         # alternatively seed at startup
```

The demo uses reference prefix `APO` (`APO-YYYY-NNNNNN`), a navy/teal theme, and sender name “Aperture People Ops Team”. Its rules are draft-first with the evidence gate enabled.

| CaseType | Blocking checklist examples | Rule-tree example |
| --- | --- | --- |
| `NEW_HIRE_ONBOARDING` (`people`) | Signed offer acceptance, photo ID, tax withholding; payroll instructions are required but non-blocking; emergency contact is optional. | Full-time or part-time **and** right-to-work confirmed **and not** a failed background check. |
| `CONTRACTOR_INTAKE` (`vendors`) | Services agreement, insurance certificate, NDA; vendor tax registration is required/non-blocking; statement of work is optional. | Coverage ≥1,000,000 **and** (engagement ≤12 months **or** legal approval) **and not** a sanctions match. |
| `EQUIPMENT_REQUEST` (`it`) | Requisition and manager sign-off; vendor quote is required/non-blocking; previous-asset receipt is optional. | Cost ≤1,500 **or** (cost ≤5,000 **and** manager approved), **and not** an outstanding asset. |

Each work type also has organization-owned neutral reply templates; changing the demo is safe. Re-running the seed adds only missing defaults and does not overwrite staff edits. The source is `src/db/demoOrg.ts` and the isolation contract is covered by `test/demo-org.test.ts`.

## Encrypted retention archives

Retention archives are authenticated **AES-256-GCM** ciphertext. The retention CLI requires an external `ARCHIVE_ENCRYPTION_KEY` containing exactly 32 bytes, expressed as canonical base64 (recommended: `openssl rand -base64 32`) or 64 hexadecimal characters. Keep the key in a secret manager separate from both the database and archive directory. Retention fails closed when the key is absent or malformed; there is no plaintext fallback.

```bash
# Generate once, then store the output in an external secret manager:
openssl rand -base64 32

# For each run, load that same stored value into ARCHIVE_ENCRYPTION_KEY:
npm run retain
npm run archive:migrate -- /path/to/legacy-archive-directory
npm run archive:decrypt -- /path/to/archive.json.enc /private/path/review.json
```

Do not generate a fresh key for each run: archive recovery requires the original key. The offline migration utility writes and verifies encrypted `.json.enc` siblings and preserves the plaintext originals. The decrypt utility writes a new mode-0600 file and refuses to overwrite a destination. Treat both old archives and any decrypted output as sensitive personal data. This repository has **not** run the migration against real archive data; see [`BUGS.md`](BUGS.md#retention-archive-operations-open).

## Classifier evaluation and personal-data handling

The per-category auto-send allow-list starts empty. Measure any candidate category on the organization's own mail before adding it:

1. An administrator downloads `GET /export/labels.csv` (default 200 most recent inbound messages; `?limit=500` selects a larger sample, hard-capped at 1,000). The export is tenant-scoped, includes parked mail, leaves `true_category` blank, is audited, and marks the CSV with a personal-data note and `X-Personal-Data` header.
2. Save it under `labels/` (the directory and `*.labels.csv` are git-ignored), replace real names, phone numbers, addresses, reference/ID/account numbers with placeholders, and use opaque IDs. Do not commit or share the raw export. The harness report contains IDs, labels, and counts, not message text.
3. Label before looking at model output. Use one of these keys: `complaint`, `document_submission`, `missing_document`, `fee_enquiry`, `follow_up`, `general_enquiry`, `application`, `other`. Tie-break order: **complaint → general_enquiry → document_submission → fee_enquiry → missing_document → follow_up → application → other**. An attachment alone is not a document submission; the message must say documents are being sent. Have a second person label 20 messages and clarify the rubric if there are more than 2–3 disagreements.
4. Run the local harness (no network for deterministic mode):

   ```bash
   ./node_modules/.bin/tsx scripts/eval-classifier.ts \
     --csv labels/round1.labels.csv \
     --auto-send general_enquiry,complaint \
     --json labels/round1.report.json
   ```

   To evaluate the configured Gemini classifier, add `--classifier configured --categories a,b,...` and ensure the selected workspace database (`DB_PATH` or the default) has a valid key saved through Settings → Connections; the CLI does not print or store the key in its report.

Fixed acceptance bars: overall accuracy ≥90%; a category may be considered for auto-send only with precision ≥95% on at least 30 labelled examples. The report lists every wrong high-confidence prediction by ID (confidence floor 0.70). The harness never changes the product allow-list. Until real labels clear the bars, keep it empty and keep automation draft-only.

The retained template is [`docs/eval-template.csv`](docs/eval-template.csv); it is CSV, not a separate Markdown guide.

## Verification commands

Run these from the repository root with the checked-in lockfile and local project tools:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsx src/cli/simulate.ts
./node_modules/.bin/tsx src/cli/stress.ts
npm run build
npm audit
npm audit --omit=dev
rg -i 'riara|kcse|kcpe|igcse|admission' src
git diff --check
```

The current suite has one environment-gated responsive test: it skips when Playwright Chromium is unavailable. The simulation is a 26-scenario / 409-check gate; stress runs 1,000 synthetic cases plus deterministic replays. See the current dated gate results, known limitations, and accepted decisions in [`BUGS.md`](BUGS.md).

At the latest Phase 16 Part 3 validation on this worktree, typecheck, all runnable tests, simulation, stress, build, production dependency audit, source-domain grep, and diff checks passed. `npm audit` still exits non-zero on the documented **development-only** advisories; `npm audit --omit=dev` is clean. No GitHub Actions or other CI workflow is present in the repository, so run the gates explicitly before a release.

## Main scripts

| Command | Purpose |
| --- | --- |
| `npm run serve` | Start the TypeScript server and pipeline using `DB_PATH`. |
| `npm start` | Start the compiled server (`npm run build` first). |
| `npm run typecheck` / `npm test` | Strict TypeScript check / Vitest suite. |
| `npm run simulate` | Synthetic scenario suite through the real pipeline using mock external adapters; refuses the server DB. |
| `npm run stress` | Deterministic 1,000-case synthetic load/stress harness with throwaway storage. |
| `npm run ingest`, `queue`, `escalate`, `followups` | One-shot operational CLIs. |
| `npm run backup`, `restore` | SQLite online backup and restore tools. Backups contain sensitive database data. Stop the server and every writer before restore; the CLI does not detect a live server. See `BUGS.md` for storage risks and safe migration/restore procedure. |
| `npm run retain` | Encrypt, verify, and delete due completed-case rows transactionally; requires `ARCHIVE_ENCRYPTION_KEY`. |
| `npm run archive:migrate -- <directory>` | Offline plaintext-to-encrypted archive conversion; preserves source files. |
| `npm run archive:decrypt -- <archive.json.enc> <output.json>` | Decrypt one archive to a new, protected plaintext file. |
| `npm run seed:demo-org` | Opt-in, idempotent Aperture People Ops demo organization seed. |
| `npm run purge-mock` | Back up then remove only rows explicitly marked as old demo/simulation data. |

## Static checks and audits

`npm run typecheck` is the TypeScript static gate; the project has no configured ESLint policy. There is currently no checked-in CI workflow. Run typecheck, the full tests, simulation, stress, and build explicitly. `npm audit` is expected to report five development-tool advisories (Vitest/Vite toolchain); they are intentionally left unchanged rather than forcing a breaking test-runner upgrade. `npm audit --omit=dev` currently reports zero production vulnerabilities. See the detailed issue/decision register in [`BUGS.md`](BUGS.md).
