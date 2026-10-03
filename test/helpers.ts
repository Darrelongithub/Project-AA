/**
 * Shared generic test fixtures.
 *
 * Nothing here assumes an industry: a fresh boot is empty, and every test
 * that needs configuration builds it explicitly through the same public
 * repository API an administrator uses.
 */
import type { Confidence, DocType, DocumentRecord, RequirementSetEntry, RuleNode } from "../src/types";
import { genericDocumentLines } from "../src/simulation/config";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults, seedStarterTemplates } from "../src/db/seed";

/** A configured, blocking/optional document checklist used across the suite. */
export const REQS: RequirementSetEntry[] = [
  { document_type: "request_form", label: "Request form", required: true, blocking: true },
  { document_type: "id", label: "Identity document", required: true, blocking: true },
  { document_type: "supporting_document", label: "Supporting note", required: false, blocking: false },
];

let nextId = 1;

export function mkDoc(
  type: DocType,
  opts: {
    confidence?: Confidence;
    fields?: Record<string, unknown>;
    method?: DocumentRecord["extraction_method"];
    name?: string;
    text?: string;
  } = {}
): DocumentRecord {
  return {
    id: nextId++,
    applicant_id: 1,
    document_type: type,
    source_email_id: "email-test-1",
    extraction_method: opts.method ?? "pdf_text",
    extracted_text: opts.text ?? `some ${type} text`,
    extracted_fields: opts.fields ?? (opts.name ? { name: opts.name } : {}),
    confidence: opts.confidence ?? "high",
    confidence_score: opts.confidence === undefined || opts.confidence === "high" ? 100 : opts.confidence === "medium" ? 60 : 20,
    superseded_by: null,
    received_at: "2026-09-14T00:00:00Z",
  };
}

/** A complete, clean, high-confidence document set (including the optional note). */
export function completeDocs(): DocumentRecord[] {
  return [
    mkDoc("request_form", { name: "ALEX MORGAN", fields: { name: "ALEX MORGAN", consent: "yes" } }),
    mkDoc("id", { name: "ALEX MORGAN" }),
    mkDoc("supporting_document", { name: "ALEX MORGAN" }),
  ];
}

/** Every blocking slot filled, without the optional note. */
export function requiredDocs(): DocumentRecord[] {
  return completeDocs().filter((doc) => doc.document_type !== "supporting_document");
}

const condition = (field: string, comparator: NonNullable<RuleNode["comparator"]>, value: string): RuleNode => ({ kind: "condition", field, comparator, value });
const group = (logic: "AND" | "OR" | "NOT", ...children: RuleNode[]): RuleNode => ({ kind: "group", logic, children });

/**
 * Build the generic configuration a test needs: one organization, three case
 * types with document checklists and scalar rule trees, draft-first workflow
 * rules, and the starter templates. Mirrors what an administrator does in
 * Configuration — no bundled presets exist on boot.
 */
export function configureTestOrganization(repo: Repo, opts: { name?: string; refPrefix?: string } = {}): { organizationId: number; codes: string[] } {
  const organization = repo.createOrganization({ name: opts.name ?? "Example Service Cooperative", refPrefix: opts.refPrefix ?? "ORG" });
  const definitions: Record<string, Array<{ key: string; label: string; required: boolean; blocking: boolean }>> = {
    SERVICE_REQUEST: [
      { key: "request_form", label: "Request form", required: true, blocking: true },
      { key: "id", label: "Identity document", required: true, blocking: true },
      { key: "supporting_document", label: "Supporting note", required: false, blocking: false },
    ],
    VENDOR_INTAKE: [
      { key: "services_agreement", label: "Services agreement", required: true, blocking: true },
      { key: "insurance_certificate", label: "Insurance certificate", required: true, blocking: true },
    ],
    ACCESS_REQUEST: [{ key: "authorization", label: "Authorization", required: true, blocking: true }],
  };
  const trees: Record<string, RuleNode[]> = {
    SERVICE_REQUEST: [condition("consent", "=", "yes")],
    VENDOR_INTAKE: [group("AND", condition("coverage", ">=", "1000000"), group("OR", condition("duration", "<=", "12"), condition("legal_approved", "=", "yes")), group("NOT", condition("restricted", "=", "yes")))],
    ACCESS_REQUEST: [group("AND", condition("manager_approved", "=", "yes"), group("NOT", condition("revoked", "=", "yes")))],
  };
  const categories: Record<string, string> = { SERVICE_REQUEST: "services", VENDOR_INTAKE: "vendors", ACCESS_REQUEST: "access" };
  const codes = Object.keys(definitions);
  for (const code of codes) {
    const type = repo.createCaseType(organization.id, { code, name: code.replace(/_/g, " ").toLowerCase(), category: categories[code] });
    repo.replaceDocumentDefinitions(type.id, definitions[code]);
    repo.updateCaseTypeRules(type.id, trees[code]);
    repo.updateCaseTypeVocabulary(type.id, {
      terminology: { case: "Request", contact: "Contact", category: "Category", stage: "Stage", outcome: "Outcome" },
      stages: [{ id: "application_received", label: "Received" }, { id: "awaiting_review", label: "In review" }, { id: "completed", label: "Done" }],
      queues: [{ id: "waiting", label: "Waiting for information" }, { id: "human_review", label: "Review" }],
    });
    repo.saveWorkflowRule({
      organizationId: organization.id, caseTypeId: type.id, kind: "intake", name: "Open or continue a request", position: 1,
      conditions: [{ field: "always", value: true }], action: { decision: "create", audit_code: "fixture_opened" },
    });
    repo.saveWorkflowRule({
      organizationId: organization.id, caseTypeId: type.id, kind: "response", name: "Prepare a factual status draft", position: 0,
      conditions: [{ field: "always", value: true }], action: { reply_action: "draft", template_key: "status_answer", audit_code: "fixture_drafted" },
    });
  }
  seedStarterTemplates(repo, organization.id);
  return { organizationId: organization.id, codes };
}

/** Every workflow category the router understands. */
export const EMAIL_CATEGORIES = [
  "application", "document_submission", "missing_document", "fee_enquiry",
  "general_enquiry", "follow_up", "complaint", "other",
];

/**
 * Opens EVERY automation gate the product requires, for tests that assert an
 * automated send: the global switch plus the explicit per-category allowlist
 * (Phase C3 made the allowlist default-empty, so releasing the global switch
 * alone no longer sends anything). A test that wants to prove a hold simply
 * does not call this.
 */
export function releaseAutomation(repo: Repo, categories: string[] = EMAIL_CATEGORIES): void {
  repo.setSetting("automation_mode", "auto");
  for (const category of categories) repo.setAutomationMode(category, "auto");
}

/**
 * A ready-to-use repository: empty database, operational defaults seeded, and
 * one explicitly configured organization. Cases, contacts and staff are still
 * absent until the test creates them.
 */
export function freshRepo(opts: { name?: string; refPrefix?: string; configured?: boolean } = {}): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  if (opts.configured !== false) configureTestOrganization(repo, opts);
  return repo;
}

/**
 * Full sign-in flow for fetch-based tests: GET /login (collect its one-time
 * hidden token), then POST credentials with that token. Returns the session
 * cookie and a page CSRF token for subsequent POSTs.
 */
export async function webLogin(
  base: string,
  username: string,
  password: string
): Promise<{ cookie: string; csrf: string; status: number }> {
  const page = await fetch(`${base}/login`);
  const html = await page.text();
  const hidden = (/name="_lcsrf" value="([^"]+)"/.exec(html) || [])[1] ?? "";
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&_lcsrf=${encodeURIComponent(hidden)}`,
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  let csrf = "";
  if (res.status === 302) {
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    csrf = (/name="csrf" content="([^"]+)"/.exec(home) || [])[1] ?? "";
  }
  return { cookie, csrf, status: res.status };
}

/**
 * Synthetic document text for a configured slot, so tests can build PDFs the
 * extractor recognises without bundling any real-world document.
 */
export function docLines(key: string, fields: Record<string, unknown> = {}): string[] {
  const { name, ...rest } = fields;
  return genericDocumentLines(
    key,
    typeof name === "string" && name.trim() ? name : "ALEX MORGAN",
    Object.fromEntries(Object.entries(rest).map(([field, value]) => [field, String(value)]))
  );
}
