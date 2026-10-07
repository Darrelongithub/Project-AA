# WHAT CHANGED

Summary of work done on Project-AA in this redesign / simplification pass.

---

## 1. UI redesign (light-first, no AI-slop look)

**Files:** `src/web/views.ts`, `test/light-mode.test.ts`

- **Light mode is the default** (dark still available via toggle).
- **Instrument Serif removed** — entire UI uses **Manrope** only.
- **Purple theme kept** and refined for light paper backgrounds.
- Heavy **3D beveled card shadows removed**; replaced with soft modern shadows.
- Improved **home mast** for light mode (no stuck dark control-room block).
- Stronger **case headers**, **lifecycle stepper**, **gauges**, and **tables**.
- Design tokens cleaned so light text never vanishes on paper.

---

## 2. University language purged

**Files:** `src/db/seed.ts`, `src/web/pages.ts`, `src/web/server.ts`, `src/types.ts`, `src/categorize/index.ts`

- Removed product copy that framed the app as a university / admissions-only system.
- Product remains **general-purpose** document intake (as intended in the README).
- Legacy internal DB names (`applicants`, `programmes`) kept for schema stability; staff-facing wording is neutral.

---

## 3. Easy startup — process templates

**Files:** `src/db/seed.ts`, `src/web/server.ts`, `src/web/pages.ts`

One-click templates on home + empty queues:

| Template | Code | Purpose |
|----------|------|---------|
| Application / registration | `APPLICATION` | Forms, ID, certificates |
| Job applications | `JOB_APPLICATION` | CV, ID, supporting papers (employer path) |
| General document intake | `GENERAL_INTAKE` | Minimal checklist |

- Route: `POST /setup/process-template` with `template=applications|hiring|generic`
- All starters are **idempotent**, **draft-first**, **human review by default**
- Custom case types still available under Configuration

---

## 4. Visual if/then flowchart

**Files:** `src/web/pages.ts`, `src/web/views.ts`

- **Config → Workflow rules** now shows a **Live path** diagram:
  - Email received → intake rules → documents checked → response rules
  - Each enabled rule rendered as a node: **If** conditions → **Then** actions
  - Colour cues for park / review / send paths
- Existing form-based rule editor unchanged (still the source of truth)
- Intro text explains first-match-wins order in plain language

---

## 5. Email banner fix (was showing as a loose image)

**File:** `src/ingestion/gmailClient.ts`

**Bug:** Banner was attached as `Content-Disposition: inline` with a CID, but the body was **plain text only**, so many clients showed a separate picture instead of a header banner.

**Fix:** When a banner is present, mail is built as:

1. `multipart/alternative` (plain text + HTML)
2. HTML embeds `<img src="cid:organization-banner">` at the top
3. Banner remains a true inline related part

---

## 6. Customizable email signature

**Files:** `src/branding.ts`, `src/web/server.ts`, `src/web/pages.ts`, `src/pipeline/adapters.ts`, `src/ingestion/gmailClient.ts`

- Settings under **Configuration → Email signature**:
  - Name, title, phone, extra line
- Appended to **plain-text** and **HTML** outbound mail
- Organization name used if signature fields are empty
- Sender identity (From name / Reply-To) still comes from organization settings

Routes:

- `POST /config/branding/signature`

---

## 7. Classifier guidance (Gemini)

**Files:** `src/categorize/index.ts`, `src/pipeline/index.ts`, `src/web/server.ts`, `src/web/pages.ts`

- Free-text **classifier prompt** stored in settings (`classifier_prompt`)
- Passed into Gemini as additional guidance when labelling mail
- Categories allow-list still enforced (model cannot invent outcomes)
- UI: **Configuration → Classifier guidance (Gemini)**

Routes:

- `POST /config/classifier-prompt`

---

## 8. Employer-style gap review (findings)

| Scenario | Result |
|----------|--------|
| Job application intake | Supported via **Job applications** template |
| Missing / wrong documents | Human review + missing-docs templates |
| Follow-ups / status | Templates + follow-up ladder in workflow rules |
| Banner as real header | **Fixed** |
| Signature / name at bottom | **Added** |
| Reject / shortlist | Human `record_outcome` only (by design) |
| Unknown sender + forged ref | No auto disclosure (by design) |
| Park non-relevant mail | Intake rules + park path |
| Custom Gemini “what to look for” | **Added** (org-level guidance) |
| Drag-drop flowchart builder | Visual **read-only** path added; full canvas editor still future work |

---

## How to apply this pack

Copy these files into your project (from the zip), then restart:

- `src/db/seed.ts`
- `src/web/server.ts`
- `src/web/pages.ts`
- `src/web/views.ts`
- `src/ingestion/gmailClient.ts`
- `src/branding.ts`
- `src/pipeline/index.ts`
- `src/pipeline/adapters.ts`
- `src/categorize/index.ts`
- `src/types.ts`
- `test/light-mode.test.ts`
- `WHAT_CHANGED.md` (this file)

```bash
npm run serve
```

Recommended first run path:

1. Log in as admin  
2. Choose a process template (e.g. Job applications)  
3. Set organization name + optional signature + banner  
4. Open **Config → Workflow rules** and review the Live path  
5. Optional: add classifier guidance and connect Gmail  

---

## Intentionally unchanged

- Core pipeline, rules engine, SQLite schema compatibility  
- Human-only outcomes (no machine approval/rejection)  
- Tenant isolation and audit logging  
- Advanced case-type / document matrix editors (still available for power users)

---

## 9. Interactive flowchart editor (centrepiece)

**Files:** `src/web/pages.ts`, `src/web/views.ts`

The **Workflow rules** screen is now an interactive flowchart editor:

- Visual path: **Email received → intake steps → documents checked → response steps**
- **Click a step** to edit **If** / **Then** in a side panel
- **+ Add intake step** / **+ Add response step**
- Toggle On/Off on each card; Save / Delete from the panel
- Colour legend: open/continue · human review · send · park
- Advanced table + full form moved under a collapsed **Advanced** section

Saves still go through the existing secure endpoints (`/config/workflow-rules/save`, toggle, delete). First matching enabled rule still wins.


---

## 10. Break-test fixes (pre full-project pack)

See **BUGS.md** (top section) for the table. Summary of code fixes:

1. **`seed.ts`** — RuleNode import moved to file top (build break).
2. **`pages.ts`** — removed unused `firstCond`.
3. **`gmailClient.ts`** — banner embedded as real HTML CID header; plain part can take `signatureText`.
4. **`server.ts` `sendOrgMail`** — no double signature when banner HTML path is used.
5. **`branding.ts` `emailBanner`** — custom banner not limited to organization id 1.

Full project zip includes UI redesign, process templates, flowchart editor, classifier guidance, signatures, and these fixes.

---

## 11. Correctness pass over the redesign (2026-10-07)

The ten changes above shipped without a typecheck, without tests, and inside an
archive that omitted the compiler config, the test config, `src/logs/index.ts`
and 22 test files — so nothing had ever run them. A read-only scan
(**`BUG_SCAN.md`**, 16 findings) was performed and every fixable finding was
fixed and pinned with tests.

**Build / test gates**

- `src/web/server.ts` — the `PROCESS_TEMPLATES` import was unused, and
  `noUnusedLocals` makes that a hard error: `npm run typecheck`, `npm run build`
  and the first step of CI were all red. The three starter cards are now
  rendered **from** `PROCESS_TEMPLATES` (two hand-written copies in `pages.ts`
  are gone), and the save route validates the requested template against the
  catalogue instead of a second hard-coded list.
- `test/web.test.ts` — the Instrument Serif assertion outlived the font it was
  asserting on; it now asserts the type system is Manrope throughout.
- `src/web/pages.ts` — trailing whitespace removed (`git diff --check` is clean).

**Flowchart editor** (previously able to lose configuration silently)

- Conditions 2 and 3 are no longer dropped on save — the panel renders one row
  per condition, up to the three the parser accepts.
- A rule with more conditions than the panel can express is now **flagged and
  refused** rather than silently truncated.
- Every action field the panel does not surface (SLA, attachment set, follow-up
  ladder, template map, priority, assign, audit code, fallback, request-info)
  travels as a hidden mirror carrying its current value, so saving from the
  diagram no longer resets them.
- Editing a switched-off rule no longer switches it back on.
- The chain is now drawn with the engine's own comparator and scoping helpers,
  grouped per case type with the organization-wide group last, so the picture
  matches `firstMatchingRule`. The preview route uses the same comparator.
- A rule with no conditions is labelled **"Never matches"** and round-trips as
  `[]` instead of being upgraded to a match-everything catch-all.
- Nodes respond to Enter/Space, and the On/Off control is reachable without
  hover (touch) and on keyboard focus.

**Cross-tenant correctness**

- `emailBanner` no longer applies organization 1's uploaded banner to every
  tenant; settings are read and written per organization, with the legacy
  un-suffixed key honoured for organization 1 only.
- Email signature and classifier guidance are scoped the same way.
- Seeding a process template no longer appends its hotwords to the shared
  `intake_hotwords` setting, so one tenant's starter cannot widen another
  tenant's intake.
- Classifier guidance is now placed **before** the output contract in the Gemini
  prompt, so operator text cannot override the JSON format the parser relies on.

**Mail**

- The inline banner keeps a real file extension (`organization-banner.png`), so
  a PNG or SVG banner is not degraded to a generic attachment — the regression
  the multipart rewrite set out to fix.
- Both MIME paths now share one "already signed" rule, so a quoted reply that
  merely mentions the signer no longer loses its signature.

**Cleanup**

- The two dead Instrument Serif WOFF2 blobs and their routes are gone
  (~58 KB of base64 that nothing requested any more).

**New: a troubleshooter for failing tests**

`npm test` now ends with a classified diagnosis of every failure, and
`npm run test:troubleshoot` gives a deeper, re-runnable pass with environment
pre-flight. See **`TROUBLESHOOTING.md`**.
