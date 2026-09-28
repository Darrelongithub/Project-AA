/**
 * DEMO — a real, persistent second organization that proves the CaseType
 * engine is general. It is seeded ALONGSIDE Organization #1 and never reads,
 * copies or edits Organization #1's rows (programmes, requirement matrix,
 * admission rule sets, templates, settings or branding).
 *
 * How it is seeded (idempotent — safe to run repeatedly):
 *   - `npm run seed:demo-org`            (one-off CLI; see src/cli/seedDemoOrg.ts)
 *   - `SEED_DEMO_ORG=1 npm run serve`    (seeds on boot, then serves)
 *
 * Re-running never overwrites staff edits: an existing demo organization is
 * detected by its reference prefix and only missing pieces are added.
 */
import type { Repo } from "./repo";
import type { RuleNode } from "../types";

export const DEMO_ORG_NAME = "Aperture People Ops";
export const DEMO_ORG_PREFIX = "APO";
export const DEMO_ORG_THEME = { primary: "#1f4e79", accent: "#5fb3a1" };

/** Simple placeholder logo: a teal-on-navy aperture ring, inline SVG. */
const DEMO_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="#1f4e79"/><circle cx="24" cy="24" r="12" fill="none" stroke="#5fb3a1" stroke-width="4"/><circle cx="24" cy="24" r="4" fill="#ffffff"/></svg>`;
export const DEMO_ORG_LOGO = `data:image/svg+xml;base64,${Buffer.from(DEMO_LOGO_SVG).toString("base64")}`;

type Slot = { key: string; label: string; required: boolean; blocking: boolean };
const cond = (field: string, comparator: NonNullable<RuleNode["comparator"]>, value: string): RuleNode => ({ kind: "condition", field, comparator, value });
const group = (logic: "AND" | "OR" | "NOT", ...children: RuleNode[]): RuleNode => ({ kind: "group", logic, children });

export interface DemoCaseTypeSeed {
  code: string;
  name: string;
  category: string;
  /** Plain-English reading of the rule tree, shown in the report/README. */
  ruleSummary: string;
  /** Surface words on the case page (PPR P1-1 terminology). */
  terminology: Record<string, string>;
  documents: Slot[];
  rules: RuleNode[];
  template: { key: string; name: string; subject: string; body: string };
}

export const DEMO_CASE_TYPES: DemoCaseTypeSeed[] = [
  {
    code: "NEW_HIRE_ONBOARDING",
    name: "New Hire Onboarding",
    category: "people",
    terminology: { case: "New hire", contact: "Employee", category: "Category", stage: "Stage", outcome: "Outcome" },
    ruleSummary: "(employment_type = full-time OR employment_type = part-time) AND right_to_work = yes AND NOT (background_check = failed)",
    documents: [
      { key: "offer_acceptance", label: "Countersigned offer acceptance", required: true, blocking: true },
      { key: "photo_id", label: "Government photo ID (passport or national ID)", required: true, blocking: true },
      { key: "tax_withholding", label: "Tax withholding declaration", required: true, blocking: true },
      { key: "payroll_banking", label: "Payroll banking instructions", required: true, blocking: false },
      { key: "emergency_contact", label: "Emergency contact sheet", required: false, blocking: false },
    ],
    rules: [
      group("AND",
        group("OR", cond("employment_type", "=", "full-time"), cond("employment_type", "=", "part-time")),
        cond("right_to_work", "=", "yes"),
        group("NOT", cond("background_check", "=", "failed")),
      ),
    ],
    template: {
      key: "new_hire_welcome",
      name: "New hire — welcome & first-day logistics",
      subject: "Welcome aboard — your onboarding file {ref}",
      body: `Hi {first_name},

Welcome to the team! We've opened your onboarding file ({ref}) and here's where it stands:

{checklist}

Still needed before your first day:

{missing_docs}

On day one, please arrive at reception by 9:00 with your photo ID. Your manager will meet you there, and IT will have your laptop and accounts ready once your file is complete.

If anything above looks wrong, just reply to this email.

Cheers,
{institution}`,
    },
  },
  {
    code: "CONTRACTOR_INTAKE",
    name: "Contractor Intake",
    category: "vendors",
    terminology: { case: "Contractor", contact: "Contractor", category: "Category", stage: "Stage", outcome: "Outcome" },
    ruleSummary: "insurance_coverage >= 1000000 AND (engagement_months <= 12 OR legal_approved = yes) AND NOT (sanctions_match = yes)",
    documents: [
      { key: "services_agreement", label: "Master services agreement", required: true, blocking: true },
      { key: "insurance_certificate", label: "Certificate of liability insurance", required: true, blocking: true },
      { key: "nondisclosure", label: "Non-disclosure agreement (NDA)", required: true, blocking: true },
      { key: "vendor_tax_registration", label: "Vendor tax registration", required: true, blocking: false },
      { key: "statement_of_work", label: "Statement of work and rate card", required: false, blocking: false },
    ],
    rules: [
      group("AND",
        cond("insurance_coverage", ">=", "1000000"),
        group("OR", cond("engagement_months", "<=", "12"), cond("legal_approved", "=", "yes")),
        group("NOT", cond("sanctions_match", "=", "yes")),
      ),
    ],
    template: {
      key: "contractor_intake_confirmation",
      name: "Contractor — intake confirmation",
      subject: "Contractor paperwork received — {ref}",
      body: `Hello {first_name},

Thanks for sending your contractor paperwork. Your vendor file is {ref}.

Received so far:

{checklist}

Outstanding:

{missing_docs}

{document_issues}

Please note: you can't start billable work until Procurement has countersigned the services agreement and confirmed your insurance cover. We'll email you as soon as that's done.

Regards,
Vendor Onboarding — {institution}`,
    },
  },
  {
    code: "EQUIPMENT_REQUEST",
    name: "Equipment Request",
    category: "it",
    terminology: { case: "Request", contact: "Requester", category: "Category", stage: "Stage", outcome: "Outcome" },
    ruleSummary: "(estimated_cost <= 1500 OR (estimated_cost <= 5000 AND manager_approved = yes)) AND NOT (asset_outstanding = yes)",
    documents: [
      { key: "equipment_requisition", label: "Equipment requisition", required: true, blocking: true },
      { key: "manager_signoff", label: "Line manager sign-off", required: true, blocking: true },
      { key: "vendor_quote", label: "Vendor quote", required: true, blocking: false },
      { key: "asset_return_receipt", label: "Previous asset return receipt", required: false, blocking: false },
    ],
    rules: [
      group("AND",
        group("OR",
          cond("estimated_cost", "<=", "1500"),
          group("AND", cond("estimated_cost", "<=", "5000"), cond("manager_approved", "=", "yes")),
        ),
        group("NOT", cond("asset_outstanding", "=", "yes")),
      ),
    ],
    template: {
      key: "equipment_request_update",
      name: "Equipment request — status update",
      subject: "Your equipment request {ref}",
      body: `Hi {first_name},

We've logged your equipment request as {ref}. Current status: {status}.

{checklist}

Anything still missing:

{missing_docs}

Requests under 1,500 are usually fulfilled within five working days; larger requests need your line manager's sign-off first. You'll get a pickup notice from the IT service desk when it's ready.

Thanks,
IT Service Desk — {institution}`,
    },
  },
];

/** Organization-wide replies the intake pipeline drafts by key. Without these
 *  the demo org would have no auto-draft copy — it never falls back to
 *  Organization #1's wording (getTemplate is organization-scoped). */
export const DEMO_ORG_TEMPLATES: Array<{ key: string; name: string; subject: string; body: string }> = [
  {
    key: "ack_received",
    name: "Paperwork received (complete file)",
    subject: "Everything received — {ref}",
    body: `Hi {first_name},

Thanks — your file {ref} is now complete:

{checklist}

A member of the People Ops team will review it and get back to you. Current status: {status}.

Best,
{institution}`,
  },
  {
    key: "missing_documents",
    name: "Missing paperwork notice",
    subject: "A few items still needed — {ref}",
    body: `Hi {first_name},

We've received part of your paperwork for {ref}:

{checklist}

Still missing:

{missing_docs}

{document_issues}

Just reply to this thread with the outstanding items attached (PDF is best).

Best,
{institution}`,
  },
  {
    key: "docs_request",
    name: "Paperwork request (new request)",
    subject: "What we need from you — {ref}",
    body: `Hi {first_name},

Thanks for getting in touch. To open your file ({ref}) please send the following as attachments:

{missing_docs}

We'll confirm on this thread once they arrive.

Best,
{institution}`,
  },
  {
    key: "status_answer",
    name: "Status answer",
    subject: "Status of your request {ref}",
    body: `Hi {first_name},

Here's the current status of {ref}: {status}.

{checklist}

Best,
{institution}`,
  },
  {
    key: "generic_enquiry",
    name: "General reply (staff suggestion)",
    subject: "Re: your message — {ref}",
    body: `Hi {first_name},

Thanks for your message. A member of the People Ops team is looking into it and will reply shortly.

Best,
{institution}`,
  },
];

export interface DemoSeedResult { organizationId: number; created: boolean; caseTypes: string[] }

/** Idempotently seed the demo organization. Touches ONLY rows it owns. */
export function seedDemoOrganization(repo: Repo): DemoSeedResult {
  const existing = repo.listOrganizations().find((o) => o.id !== 1 && o.ref_prefix === DEMO_ORG_PREFIX);
  const org = existing ?? repo.createOrganization({ name: DEMO_ORG_NAME, refPrefix: DEMO_ORG_PREFIX, theme: DEMO_ORG_THEME, logo: DEMO_ORG_LOGO });
  if (org.id === 1) throw new Error("Refusing to seed demo content into Organization #1");
  if (!existing) {
    repo.updateOrganization(org.id, { fromName: `${DEMO_ORG_NAME} Team`, locale: "en", timezone: "UTC" });
  }
  const seededTypes: string[] = [];
  for (const def of DEMO_CASE_TYPES) {
    let ct = repo.getCaseType(def.code, org.id);
    if (!ct) {
      ct = repo.createCaseType(org.id, { code: def.code, name: def.name, category: def.category, config: { rules: [] }, educationModule: false, defaultReplyAction: "draft" });
      repo.replaceDocumentDefinitions(ct.id, def.documents);
      repo.updateCaseTypeRules(ct.id, def.rules);
      repo.updateCaseTypeVocabulary(ct.id, { terminology: def.terminology });
      seededTypes.push(def.code);
    }
    if (!repo.getTemplate(def.template.key, org.id, ct.id)) {
      repo.upsertTemplate(def.template.key, def.template.name, def.template.subject, def.template.body, true, "none", org.id, ct.id);
    }
  }
  for (const t of DEMO_ORG_TEMPLATES) {
    if (!repo.getTemplate(t.key, org.id)) repo.upsertTemplate(t.key, t.name, t.subject, t.body, true, "none", org.id, 0);
  }
  return { organizationId: org.id, created: !existing, caseTypes: seededTypes };
}
