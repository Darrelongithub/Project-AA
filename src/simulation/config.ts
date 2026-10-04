/** Explicit, organization-owned configuration for developer tools. Never loaded on boot. */
import type { Repo } from "../db/repo";
import type { CaseType, RuleNode } from "../types";

const condition = (field: string, comparator: NonNullable<RuleNode["comparator"]>, value: string): RuleNode => ({ kind: "condition", field, comparator, value });
const group = (logic: "AND" | "OR" | "NOT", ...children: RuleNode[]): RuleNode => ({ kind: "group", logic, children });

export const TEST_CASE_TYPES = [
  {
    code: "SERVICE_REQUEST", name: "Service request", category: "services",
    documents: [
      { key: "request_form", label: "Request form", required: true, blocking: true },
      { key: "identity_document", label: "Identity document", required: true, blocking: true },
      { key: "supporting_note", label: "Supporting note", required: false, blocking: false },
    ],
    rules: [condition("consent", "=", "yes")],
  },
  {
    code: "VENDOR_INTAKE", name: "Vendor intake", category: "vendors",
    documents: [
      { key: "services_agreement", label: "Services agreement", required: true, blocking: true },
      { key: "insurance_certificate", label: "Insurance certificate", required: true, blocking: true },
    ],
    rules: [group("AND", condition("coverage", ">=", "1000000"), group("OR", condition("duration", "<=", "12"), condition("legal_approved", "=", "yes")), group("NOT", condition("restricted", "=", "yes")))],
  },
  {
    code: "ACCESS_REQUEST", name: "Access request", category: "access",
    documents: [{ key: "authorization", label: "Authorization", required: true, blocking: true }],
    rules: [group("AND", condition("manager_approved", "=", "yes"), group("NOT", condition("revoked", "=", "yes")))],
  },
];

export interface TestConfiguration { organizationId: number; types: Record<string, CaseType> }

export function seedGenericTestConfig(repo: Repo): TestConfiguration {
  const org = repo.listOrganizations().find((o) => o.ref_prefix === "SIM")
    ?? repo.createOrganization({ name: "Example Service Cooperative", refPrefix: "SIM" });
  const types: Record<string, CaseType> = {};
  for (const def of TEST_CASE_TYPES) {
    let type = repo.getCaseType(def.code, org.id);
    if (!type) {
      type = repo.createCaseType(org.id, { code: def.code, name: def.name, category: def.category });
      repo.replaceDocumentDefinitions(type.id, def.documents);
      repo.updateCaseTypeRules(type.id, def.rules);
      repo.updateCaseTypeVocabulary(type.id, {
        terminology: { case: "Request", contact: "Contact", category: "Category", stage: "Stage", outcome: "Outcome" },
        stages: [{ id: "application_received", label: "Received" }, { id: "awaiting_review", label: "In review" }, { id: "completed", label: "Done" }],
        queues: [{ id: "waiting", label: "Waiting for information" }, { id: "human_review", label: "Review" }],
      });
      repo.saveWorkflowRule({ organizationId: org.id, caseTypeId: type.id, kind: "intake", name: "Ignore newsletters", position: 0,
        conditions: [{ field: "subject", op: "contains_any", values: ["newsletter"] }], action: { decision: "ignore", audit_code: "fixture_parked" } });
      repo.saveWorkflowRule({ organizationId: org.id, caseTypeId: type.id, kind: "intake", name: "Open or continue a request", position: 1,
        conditions: [{ field: "always", value: true }], action: { decision: "create", audit_code: "fixture_opened" } });
      repo.saveWorkflowRule({ organizationId: org.id, caseTypeId: type.id, kind: "response", name: "Prepare a factual status draft", position: 0,
        conditions: [{ field: "always", value: true }], action: { reply_action: "draft", template_key: "status_answer", audit_code: "fixture_drafted" } });
    }
    types[def.code] = repo.getCaseType(def.code, org.id)!;
  }
  for (const key of ["status_answer", "generic_enquiry", "ack_received", "docs_request", "missing_documents"]) {
    if (!repo.getTemplate(key, org.id)) repo.upsertTemplate(key, key.replace(/_/g, " "), "Update on your request {ref}",
      "Hello {first_name},\n\nYour request {ref}: {status}.\n\n{checklist}\n\n{missing_docs}\n\n{institution}", false, "none", org.id, 0);
  }
  return { organizationId: org.id, types };
}

export function genericDocumentLines(key: string, name = "ALEX MORGAN", facts: Record<string, string | number> = {}): string[] {
  const TITLES: Record<string, string> = {
    request_form: "SERVICE REQUEST FORM",
    id: "NATIONAL IDENTIFICATION DOCUMENT",
    identity_document: "NATIONAL IDENTIFICATION DOCUMENT",
    birth_cert: "BIRTH CERTIFICATE",
    passport_photo: "PASSPORT PHOTOGRAPH",
  };
  const title = TITLES[key] ?? key.replace(/_/g, " ").toUpperCase();
  return [title, `Document key: ${key}`, `Name: ${name}`, "Identification number: 12345678", "Date of birth: 1995-02-14",
    ...Object.entries(facts).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
    "This document records the requested information for processing by the service team.",
    "The contact confirms that these details are current and consents to verification."];
}
