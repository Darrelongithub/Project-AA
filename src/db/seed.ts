/** Operational defaults only. Boot never creates tenants, cases, staff, profiles or files. */
import type { Repo } from "./repo";
import type { RuleNode } from "../types";
import { DEFAULT_SETTINGS, addIntakeHotwords } from "../config";

export const TEMPLATE_SEEDS = [
  { key: "ack_received", name: "Information received", subject: "Information received — {ref}", body: "Hello {first_name},\n\nWe received the information for your case {ref}.\n\n{checklist}\n\nCurrent stage: {status}. A reviewer will confirm the outcome.\n\n{institution}" },
  { key: "missing_documents", name: "Missing information", subject: "Information needed — {ref}", body: "Hello {first_name},\n\nWe have received:\n\n{checklist}\n\nStill needed:\n\n{missing_docs}\n\n{document_issues}\n\nPlease reply with the outstanding information.\n\n{institution}" },
  { key: "docs_request", name: "Information request", subject: "What we need — {ref}", body: "Hello {first_name},\n\nTo process your case {ref}, please send:\n\n{missing_docs}\n\n{institution}" },
  { key: "status_answer", name: "Case status", subject: "Status of your case {ref}", body: "Hello {first_name},\n\nCurrent stage: {status}.\n\n{checklist}\n\n{missing_docs_section}\n\n{read_back}\n\n{institution}" },
  { key: "under_review", name: "Under review", subject: "Your case is under review — {ref}", body: "Hello {first_name},\n\nYour case {ref} is under review. We will contact you if we need further information.\n\n{institution}" },
  { key: "verification", name: "Verification", subject: "Verifying your information — {ref}", body: "Hello {first_name},\n\nWe are verifying the information for your case {ref}.\n\n{institution}" },
  { key: "generic_enquiry", name: "General enquiry", subject: "Thank you for contacting us — {ref}", body: "Hello {first_name},\n\nWe have received your message about case {ref}. A team member will respond shortly.\n\n{institution}" },
];
export const TEMPLATE_DEFAULTS = Object.fromEntries(TEMPLATE_SEEDS.map((template) => [template.key, { ...template, include_banner: false, attach_pack: "none" }]));

/** Explicit opt-in starter copy; not called by boot or organization creation. */
export function seedStarterTemplates(repo: Repo, organizationId: number): void {
  if (!repo.getOrganization(organizationId)) throw new Error("Unknown organization");
  repo.db.transaction(() => {
    for (const template of TEMPLATE_SEEDS) if (!repo.getTemplate(template.key, organizationId))
      repo.upsertTemplate(template.key, template.name, template.subject, template.body, false, "none", organizationId, 0);
  })();
}

export function seedDefaults(repo: Repo, _opts: { live?: boolean } = {}): void {
  repo.db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!repo.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key)) repo.setSetting(key, value);
    }
    repo.purgeExpiredSessions();
  })();
}

/**
 * One-click process templates — domain examples, not product identity.
 * Each starter is optional, idempotent, and safe (human review by default).
 */

export type ProcessTemplateId = "applications" | "hiring" | "generic";

interface ProcessTemplate {
  id: ProcessTemplateId;
  code: string;
  name: string;
  category: string;
  blurb: string;
  terminology: Record<string, string>;
  documents: Array<{ key: string; label: string; required: boolean; blocking: boolean; position: number }>;
  hotwords: string[];
  stages: Array<{ id: string; label: string }>;
  queues: Array<{ id: string; label: string }>;
}

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: "applications",
    code: "APPLICATION",
    name: "Application / registration",
    category: "applications",
    blurb: "Someone applies or registers. Collect standard papers, review, decide.",
    terminology: {
      case: "Application",
      contact: "Applicant",
      category: "Category",
      stage: "Stage",
      outcome: "Decision",
    },
    documents: [
      { key: "application_form", label: "Completed application form", required: true, blocking: true, position: 1 },
      { key: "photo_id", label: "National ID or passport (photo page)", required: true, blocking: true, position: 2 },
      { key: "certificate", label: "Relevant certificate or qualification", required: true, blocking: true, position: 3 },
      { key: "supporting_results", label: "Results / supporting academic records", required: true, blocking: true, position: 4 },
      { key: "birth_certificate", label: "Birth certificate", required: false, blocking: false, position: 5 },
      { key: "reference_letter", label: "Reference / recommendation letter", required: false, blocking: false, position: 6 },
      { key: "personal_statement", label: "Personal statement / motivation letter", required: false, blocking: false, position: 7 },
    ],
    hotwords: ["application", "apply", "registration", "register", "enrolment", "enrollment"],
    stages: [
      { id: "application_received", label: "Received" },
      { id: "documents_received", label: "Documents received" },
      { id: "documents_checked", label: "Documents checked" },
      { id: "awaiting_review", label: "Awaiting review" },
      { id: "verification", label: "Verification" },
      { id: "completed", label: "Completed" },
    ],
    queues: [
      { id: "human_review", label: "Needs human review" },
      { id: "waiting_docs", label: "Waiting for documents" },
      { id: "decision", label: "Ready for decision" },
      { id: "enquiries", label: "Enquiries" },
    ],
  },
  {
    id: "hiring",
    code: "JOB_APPLICATION",
    name: "Job applications",
    category: "hiring",
    blurb: "Candidates apply for roles. CV, ID, and supporting papers; human shortlist.",
    terminology: {
      case: "Application",
      contact: "Candidate",
      category: "Role",
      stage: "Stage",
      outcome: "Decision",
    },
    documents: [
      { key: "cv", label: "CV / résumé", required: true, blocking: true, position: 1 },
      { key: "cover_letter", label: "Cover letter", required: false, blocking: false, position: 2 },
      { key: "photo_id", label: "National ID or passport", required: true, blocking: true, position: 3 },
      { key: "certificates", label: "Certificates / qualifications", required: false, blocking: false, position: 4 },
      { key: "references", label: "References", required: false, blocking: false, position: 5 },
    ],
    hotwords: ["job", "vacancy", "application", "apply", "cv", "resume", "position", "hiring"],
    stages: [
      { id: "application_received", label: "Received" },
      { id: "documents_received", label: "Documents received" },
      { id: "documents_checked", label: "Screened" },
      { id: "awaiting_review", label: "Shortlist review" },
      { id: "verification", label: "Checks" },
      { id: "completed", label: "Closed" },
    ],
    queues: [
      { id: "human_review", label: "Needs review" },
      { id: "waiting_docs", label: "Waiting for documents" },
      { id: "decision", label: "Ready for decision" },
      { id: "enquiries", label: "Enquiries" },
    ],
  },
  {
    id: "generic",
    code: "GENERAL_INTAKE",
    name: "General document intake",
    category: "general",
    blurb: "Blank-ish starter: one open case type, minimal checklist, you shape the rest.",
    terminology: {
      case: "Case",
      contact: "Contact",
      category: "Category",
      stage: "Stage",
      outcome: "Outcome",
    },
    documents: [
      { key: "primary_document", label: "Primary document", required: true, blocking: true, position: 1 },
      { key: "supporting_document", label: "Supporting document", required: false, blocking: false, position: 2 },
    ],
    hotwords: ["application", "submission", "documents", "request"],
    stages: [
      { id: "application_received", label: "Received" },
      { id: "documents_received", label: "Documents received" },
      { id: "documents_checked", label: "Checked" },
      { id: "awaiting_review", label: "Awaiting review" },
      { id: "verification", label: "Verification" },
      { id: "completed", label: "Completed" },
    ],
    queues: [
      { id: "human_review", label: "Needs human review" },
      { id: "waiting_docs", label: "Waiting for documents" },
      { id: "decision", label: "Ready for decision" },
      { id: "enquiries", label: "Enquiries" },
    ],
  },
];

/** Seed one process template. Idempotent — never overwrites an existing case type. */
export function seedProcessTemplate(
  repo: Repo,
  organizationId: number,
  templateId: ProcessTemplateId
): { created: boolean; caseTypeCode: string; templateName: string } {
  if (!repo.getOrganization(organizationId)) throw new Error("Unknown organization");
  const tpl = PROCESS_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Unknown process template: ${templateId}`);

  const existing = repo.getCaseType(tpl.code, organizationId);
  if (existing) {
    seedStarterTemplates(repo, organizationId);
    return { created: false, caseTypeCode: tpl.code, templateName: tpl.name };
  }

  repo.db.transaction(() => {
    const ct = repo.createCaseType(organizationId, {
      code: tpl.code,
      name: tpl.name,
      category: tpl.category,
      defaultReplyAction: "draft",
      evidenceGate: true,
      config: { rules: [] as RuleNode[] },
    });

    repo.updateCaseTypeVocabulary(ct.id, {
      terminology: tpl.terminology,
      stages: tpl.stages,
      queues: tpl.queues,
    });

    for (const d of tpl.documents) {
      repo.upsertDocumentDefinition(ct.id, d);
    }

    seedStarterTemplates(repo, organizationId);

    // BUG-11: the starter's words belong to THIS organization. Appending them
    // to the shared key used to widen every other tenant's intake as well.
    addIntakeHotwords(repo, organizationId, tpl.hotwords);
  })();

  return { created: true, caseTypeCode: tpl.code, templateName: tpl.name };
}

/** @deprecated use seedProcessTemplate('applications') */
export function seedAdmissionsStarter(repo: Repo, organizationId: number) {
  return seedProcessTemplate(repo, organizationId, "applications");
}
