# Document Requirement Matrix (OR-5)

**This matrix is generated deterministically in code (`src/documents/matrix.ts`).
It is NOT staff-configurable — there are no toggles anywhere in the console.**

Source-of-truth hierarchy (owner instruction):

1. **Pack PDFs** — `data/pack/application-form.pdf`, "CHECKLIST AND DECLARATION",
   pages 3–4 (authoritative for what an application file must contain).
2. **Owner prompt** — behaviour preserved from earlier rounds (e.g. the completed
   application form itself being part of the file).
3. **Web summary** — post-admission items for international applicants. These are
   always **non-blocking**: they are requested after admission and never hold a file.

Dimensions: **level × curriculum × nationality × route**, plus the owner constant
`KENYAN_REQUIRES_KCPE = false` (the KCPE certificate is never demanded of anyone).
Conditional items are **asked for, never assumed satisfied**. Missing data is never
treated as failure. Vague umbrella names for academic paperwork are **banned**
(see `BANNED_GENERIC_TERMS` in `src/documents/matrix.ts`) — every slot names the
exact document.

## Core file — every applicant, every level

| # | Slot | Wording sent to the applicant | Source |
|---|------|-------------------------------|--------|
| 1 | `application_form` | Completed application form | owner-prompt |
| 2 | `passport_photo` | One passport-size photograph (with your name at the back) | pack-pdf |
| 3 | `id` | Copy of your national ID or passport | pack-pdf |
| 4 | `birth_cert` | Copy of your birth certificate | pack-pdf |

## School-leaver academic evidence — certificate, diploma and degree entry

| # | Slot | Wording sent to the applicant | Source |
|---|------|-------------------------------|--------|
| 1 | `exam_result_slip` | Certified copy of the examination result slip (KCSE result slip or equivalent) — label adapts to the applicant's curriculum | pack-pdf |
| 2 | `leaving_certificate` | Copy of the high school leaving certificate | pack-pdf |

Postgraduate applicants (Master's, PhD) are NOT asked for the high-school
result slip and leaving certificate a second time — their prior-degree
paperwork (below) is the academic evidence.

## Programme-conditional (asked, never assumed)

| Slot | Applies when | Wording | Source |
|------|--------------|---------|--------|
| `law_personal_statement` | Programme = LLB | Personal statement of not more than 500 words | pack-pdf |
| `business_statement_of_objective` | Programme = BBA | Statement of objective of not more than 300 words | pack-pdf |

LLB applicants are asked for a personal statement; BBA applicants for a statement
of objective. Other programmes are never asked for either.

## Route-conditional

| Slot | Applies when | Wording | Source |
|------|--------------|---------|--------|
| `credit_transfer_form` | Route = transfer | Transfer letter / credit transfer form | pack-pdf |

## Level-conditional (postgraduate prior-degree paperwork)

| Slot | Applies when | Wording | Source |
|------|--------------|---------|--------|
| `undergraduate_transcript` | Level = Master's or PhD | Undergraduate academic transcripts | pack-pdf |
| `undergraduate_degree_certificate` | Level = Master's or PhD | Undergraduate degree certificate | pack-pdf |
| `masters_transcript` | Level = PhD | Master's academic transcripts | pack-pdf |
| `masters_degree_certificate` | Level = PhD | Master's degree certificate | pack-pdf |

## Nationality-conditional — international applicants, post-admission, NEVER blocking

| Slot | Blocking? | Wording | Source |
|------|-----------|---------|--------|
| `student_pass_application` | No — requested after admission | Student pass / study permit application | web-summary |
| `foreign_qualification_equivalence` | No — requested after admission | Equivalence certificate for foreign qualifications | web-summary |

Unknown nationality adds **no** extra slots — the console asks, it never assumes.

## Slot semantics

- Each required slot is filled by **at most one** submitted document; each
  submitted document fills **at most one** slot (duplicates never double-count).
- Exact type matches win. A document the classifier can only identify as generic
  academic paperwork (`academic_cert`) fills **one** unfilled academic slot in
  priority order: result slip → leaving certificate → undergraduate transcript →
  undergraduate degree certificate → master's transcript → master's degree
  certificate.
- Non-blocking (post-admission) slots consume no documents and never appear as
  missing.

## KCPE

`KENYAN_REQUIRES_KCPE` is an owner-set constant, currently **false**. While false,
`kcpe_cert` is never generated as a required slot for any level, route or
nationality. Flipping the constant is the only way it could ever be required, and
such a change would only affect new applicants (existing files keep their frozen
requirement snapshot).

## Frozen snapshots

Requirements are frozen onto each applicant at first triage
(`applicants.requirements_snapshot`). Changing the generator or the constant never
re-judges an existing applicant — they keep the matrix they applied under.
