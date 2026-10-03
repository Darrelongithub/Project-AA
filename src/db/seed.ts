/** Operational defaults only. Boot never creates tenants, cases, staff, profiles or files. */
import type { Repo } from "./repo";
import { DEFAULT_SETTINGS } from "../config";

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
