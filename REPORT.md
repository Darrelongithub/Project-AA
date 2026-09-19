# Owner Round — Final Report

**Date:** 2026-09-19 · **Branch:** `main` · Final commit of the round: `2ecea68`
**Gates:** TypeScript clean · **vitest 393/393 (29 files)** · simulate matrix **316/316** · stress **1000/1000** · all pushed to origin.

---

## 1. What shipped (all 8 owner issues, test-first RED → GREEN)

| Issue | What was done | Commits |
|---|---|---|
| **OR-1** "Admin sees zero mock data" | Removed every demo/seeded applicant; `demo_user` deleted; demo login refused loudly; `demo_dataset` flag now drives *only* the banner (off by default) | `455c51f` |
| **OR-2** "Status/queue model follows the pipeline" | `queueOf()` no longer falls through to *Enquiries* for cases with documents in but no routing yet — they land in **Human Review → "Documents in — needs a manual decision"**; vague queue labels replaced with plain language that always prints its reason; `docs/STATUS_MODEL.md` written and test-pinned | `16445a5` |
| **OR-3** "Responsive layout" | Every console page renders with **zero horizontal scroll at any width** (tested down from 1560px); content reflows instead of clipping; verified by a dedicated responsive suite | `0a2036d`, `8a1c22c` |
| **OR-4** "Gmail/Gemini connections in Settings" | Connection cards moved out of Configuration into **Settings → Connections** with one home each; guided setup copy, an explicit **Test connection** action, live status (last sync, last error) surfaced after every sync attempt | `1397a06` |
| **OR-5** "Checklist documents + requirements structured" | Brochure-application-form checklist rebuilt as the frozen document matrix (`src/documents/matrix.ts`); `DocType` = the 12 checklist slots + classifier fallbacks only; KCPE dropped as a Kenyan requirement; pipeline extracts by slot; gate = blocking matrix only; `DOCUMENT_MATRIX.md` is data-derived and test-pinned | `5a9e869`…`08ae32d` |
| **OR-6** "Requirements structured and enforced — multiple qualification systems, central catalogue, auto-admit only when clearly qualified" | `CourseLevel` (degree/diploma/certificate/masters/phd, postgrad migrated); schools table + rename cascade; per-course structured AND/OR/NOT/GROUP rule trees (KCSE/IGCSE/A-LEVEL/IB/DIPLOMA/PREUNI/DEGREE routes) + university-wide base floors; frozen `admission_rule_sets`; triage split (rules engine Green/Red only; Gemini = facts, never the decision); failure never auto-rejects (Red = human review); missing docs = waiting | `a557ba8`…`8353505` |
| **OR-7** "Templates and packs never fail silently" | `templates.attach_pack` (none/application/admission, default admission); `/templates` admin page (save, reset, 13-token legend, live preview, unknown-placeholder warning); every send resolves its pack explicitly; `pack_incomplete` audit + flag | `34f7db2`…`e6d9169` |
| **OR-8** "Scoped staff see only their school's cases everywhere" | `staff_scopes`; `POST /staff/scopes` (whole-set replace, validated, audited); guard on `/case/:id*` (identical 403 for missing and out-of-scope); queues, admissions levels+counts, dashboards, applicants search, `/api/search`, all case actions scoped; no-programme cases hidden from scoped staff; admins never scoped; exports stay admin-only | `0f14ed8`…`d0d1649`, evidence `c09bfe4` |

Every issue in `OWNER_ISSUES.md` carries its RED → GREEN evidence verbatim.

## 2. The three OR deliverable docs

- **`docs/STATUS_MODEL.md`** — the four states (Green/Orange/Red/Final), the triage→evaluation flow, and the **never** rules (never auto-reject on missing docs, never auto-admit with open doubts).
- **`docs/DOCUMENT_MATRIX.md`** — the document matrix, generated deterministically from `src/documents/matrix.ts` (single source of truth; test-pinned; KCPE-free; checklist labels verbatim from the brochure).
- **`docs/ROUTE_SCAN.md`** — functionality scan of every route (~80): CSRF coverage, no silent failures, scoping enforcement, retired-endpoint refusals. **No open items.**

## 3. Verification volume

- **Unit/integration:** 393 tests / 29 files — every fix landed RED-first with the failing output recorded in OWNER_ISSUES.md.
- **Scenario matrix B** (the extended adversarial matrix): `npm run simulate` — 6 groups, **316/316** assertions: rule-tree evaluation, grade routing, document-matrix fills, international/transfer/masters flows, duplicates, freeze semantics.
- **1,000-case stress:** `npm run stress` — seeded (20260919) synthetic applicants through the real pipeline: 499 school-leaver, 156 master's/PhD, 97 transfer, 248 adversarial (empty, junk, duplicates). Invariants enforced per case: no crash; exact missing-list equality against the frozen matrix; `auto_admitted ⇒ missing=[] ∧ no blocking flags` (and the reverse for below-floor grades); KCPE never demanded; `[REF]` on every outgoing subject; determinism re-run 13/13. **1000/1000 clean** (Red 462 / Green 393 / Orange 51 / duplicate-skips 94). A 120-case slice runs inside vitest.

## 4. Interpretations of voice-worded instructions

All recorded under OWNER_ISSUES.md → Interpretations; the consequential ones:

1. "Admin sees zero mock data" ⇒ mock applicant data zeroed; the mock **Gmail adapter** remains (only external integration, still marked Demo mode).
3. Checklist wording ⇒ verbatim brochure labels; fee item (KES 2,000) noted as not-a-document; `academic_cert` survives only as classifier fallback.
4. KCPE is NOT required for Kenyan applicants.
5. Exports remain admin-only (admins are never scoped; scoped officers were never able to export).
6. "Scenario matrix B" ⇒ the 316-assertion simulation matrix + the new 1,000-case stress run.

## 5. Guarantees preserved (the owner's non-negotiables)

- **Determinism:** seeded pipeline + frozen snapshots; stress re-runs byte-identical.
- **No wrong applicant admitted:** auto-admit requires complete blocking matrix + satisfied rule tree + no active flags — checked in both directions across 1,000 cases.
- **Failure never auto-rejects:** Red = human review, always.
- **No silent failures:** every refused/skipped path is explicit (templates, packs, OAuth, setup, retired endpoints) — verified by the route scan.
- **No paid dependencies added**; zero new external services.

## 6. Remaining / known (none blocking)

- Legacy `/queue` and `/team` aliases still resolve (harmless, noted in ROUTE_SCAN.md).
- The stress determinism sample covers 13 of 1,000 cases by design (full re-run would double the 31 s wall time).

*— Project-AA Bot, 2026-09-19*
