/** Twenty-six domain-neutral end-to-end scenarios using real PDF attachments. */
import type { Attachment, DocType, IncomingEmail, Priority } from "../types";
import type { Repo } from "../db/repo";
import { genericDocumentLines, type TestConfiguration } from "./config";
import { makeScannedPdf, makeTextPdf } from "./pdfFactory";

export interface Expected {
  missing: DocType[];
  documents: number;
  superseded?: number;
  duplicates?: number;
  priority?: Priority;
  watcherFlagged?: boolean;
  parked?: boolean;
  audited?: string[];
}
export interface Fixture {
  name: string;
  description: string;
  emails: IncomingEmail[] | ((repo: Repo) => IncomingEmail[] | Promise<IncomingEmail[]>);
  expected: Expected;
  before?: (repo: Repo) => void;
  beforeEmail?: (repo: Repo, index: number) => void;
  after?: (repo: Repo) => void;
}

export async function genericAttachment(key: string, facts: Record<string, string | number> = {}, name = "ALEX MORGAN", scanned = false): Promise<Attachment> {
  const lines = genericDocumentLines(key, name, facts);
  return { filename: `${key}.pdf`, mimeType: "application/pdf", content: await (scanned ? makeScannedPdf(lines) : makeTextPdf(lines)) };
}

export async function buildFixtures(config: TestConfiguration): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const docs = async (keys = ["request_form", "identity_document"], facts: Record<string, string | number> = {}) => Promise.all(keys.map((key) => genericAttachment(key, facts)));
  const email = (id: string, attachments: Attachment[], extra: Partial<IncomingEmail> = {}): IncomingEmail => ({
    id: `sim-${id}`, threadId: `thread-${id}`, from: `${id}@contact.example.test`, fromName: "Alex Morgan",
    subject: "Service request documents", body: "Please process my service request.\nConsent: yes", receivedAt: "2026-09-14T09:00:00Z",
    organizationId: config.organizationId, caseTypeCode: "SERVICE_REQUEST", attachments, ...extra,
  });
  const add = (name: string, description: string, emails: Fixture["emails"], expected: Expected, hooks: Partial<Fixture> = {}) => fixtures.push({ name, description, emails, expected, ...hooks });
  const complete = { missing: [], documents: 2 };

  add("complete-request", "Complete request is checked and held for human confirmation", [email("complete", await docs())], complete);
  add("missing-identity", "Exactly the absent identity slot is requested", [email("missing-id", await docs(["request_form"]))], { missing: ["identity_document"], documents: 1 });
  add("missing-form", "Exactly the absent request-form slot is requested", [email("missing-form", await docs(["identity_document"]))], { missing: ["request_form"], documents: 1 });
  add("empty-request", "Empty file remains incomplete, never an approval", [email("empty", [])], { missing: ["request_form", "identity_document"], documents: 0 });
  add("split-submission", "Later documents finish the same request", [email("split-1", await docs(["request_form"]), { from: "split@contact.example.test", threadId: "thread-split" }), email("split-2", await docs(["identity_document"]), { from: "split@contact.example.test", threadId: "thread-split" })], complete);
  add("cross-thread", "Known sender continues the same request on another thread", [email("cross-1", await docs(["request_form"]), { from: "cross@contact.example.test" }), email("cross-2", await docs(["identity_document"]), { from: "cross@contact.example.test" })], { ...complete, audited: ["identity_matched"] });
  add("correction", "A corrected document supersedes rather than duplicates", [email("correction-1", await docs(), { from: "correction@contact.example.test" }), email("correction-2", [await genericAttachment("request_form", { revision: "updated" })], { from: "correction@contact.example.test" })], { ...complete, superseded: 1 });
  const repeated = await genericAttachment("identity_document");
  add("byte-duplicate", "Byte-identical resubmission stays linked to the original", [email("duplicate-1", [await genericAttachment("request_form"), repeated], { from: "duplicate@contact.example.test" }), email("duplicate-2", [repeated], { from: "duplicate@contact.example.test" })], { ...complete, duplicates: 1, audited: ["duplicate_detected"] });
  add("optional-absent", "Optional note does not block the matrix", [email("optional-absent", await docs())], complete);
  add("optional-present", "Optional note is stored without adding required slots", [email("optional-present", await docs(["request_form", "identity_document", "supporting_note"]))], { missing: [], documents: 3 });
  add("vendor-complete", "Numeric, OR and NOT vendor checks use configured facts", [email("vendor", await docs(["services_agreement", "insurance_certificate"], { coverage: 1500000, duration: 6, restricted: "no" }), { caseTypeCode: "VENDOR_INTAKE", body: "Vendor intake\nCoverage: 1500000\nDuration: 6\nRestricted: no" })], complete);
  add("vendor-low-coverage", "Failed business rule never rejects a vendor", [email("vendor-low", await docs(["services_agreement", "insurance_certificate"], { coverage: 100, duration: 6, restricted: "no" }), { caseTypeCode: "VENDOR_INTAKE", body: "Vendor intake\nCoverage: 100\nDuration: 6\nRestricted: no" })], { ...complete, audited: ["case_type_gate"] });
  add("vendor-alternative", "Legal approval satisfies the configured OR alternative", [email("vendor-alt", await docs(["services_agreement", "insurance_certificate"], { coverage: 1500000, duration: 24, legal_approved: "yes", restricted: "no" }), { caseTypeCode: "VENDOR_INTAKE" })], complete);
  add("vendor-restricted", "NOT check sends a restricted vendor to a person", [email("vendor-restricted", await docs(["services_agreement", "insurance_certificate"], { coverage: 1500000, duration: 6, restricted: "yes" }), { caseTypeCode: "VENDOR_INTAKE" })], complete);
  add("vendor-missing", "Vendor checklist is independent of service checklist", [email("vendor-missing", await docs(["services_agreement"], { coverage: 1500000, duration: 6, restricted: "no" }), { caseTypeCode: "VENDOR_INTAKE" })], { missing: ["insurance_certificate"], documents: 1 });
  add("access-complete", "Access workflow uses a different matrix and facts", [email("access", await docs(["authorization"], { manager_approved: "yes", revoked: "no" }), { caseTypeCode: "ACCESS_REQUEST" })], { missing: [], documents: 1 });
  add("access-revoked", "Revoked access is evidence for review, never auto-approved", [email("revoked", await docs(["authorization"], { manager_approved: "yes", revoked: "yes" }), { caseTypeCode: "ACCESS_REQUEST" })], { missing: [], documents: 1 });
  add("access-missing-fact", "Unread or absent rule values remain undetermined", [email("missing-fact", await docs(["authorization"]), { caseTypeCode: "ACCESS_REQUEST", body: "Please process this access request." })], { missing: [], documents: 1 });
  add("complaint", "Complaints raise priority without an automated decision", [email("complaint", await docs(), { subject: "Complaint about my service request", body: "This is unacceptable.\nConsent: yes" })], { ...complete, priority: "high" });
  add("status-question", "Status enquiry leaves the file in review", [email("status-1", await docs(), { from: "status@contact.example.test" }), email("status-2", [], { from: "status@contact.example.test", body: "Have you received my documents?\nConsent: yes" })], complete);
  add("reference-continuity", "A quoted reference continues the original case", (repo) => {
    const row = repo.createCase({ emailAddress: "ref@contact.example.test", threadId: "ref-original", organizationId: config.organizationId, caseTypeCode: "SERVICE_REQUEST" });
    return [email("ref-only", [], { from: row.email_address, body: row.ref_number })];
  }, { missing: ["request_form", "identity_document"], documents: 0, audited: ["identity_matched"] });
  add("reopen", "New evidence reopens a completed request, not a second case", [email("reopen-1", await docs(), { from: "reopen@contact.example.test" }), email("reopen-2", [await genericAttachment("request_form", { revision: "second" })], { from: "reopen@contact.example.test" })], { ...complete, superseded: 1, audited: ["case_reopened"] }, {
    beforeEmail: (repo, index) => { if (index === 1) { const row = repo.listCases(config.organizationId).find((r) => r.email_address === "reopen@contact.example.test")!; repo.setLifecycle(row.id, "completed", "test", "complete before resubmission"); } },
  });
  add("scanned-document", "Image-only PDF exercises OCR or the safe fallback", [email("scan", [await genericAttachment("request_form", {}, "ALEX MORGAN", true), await genericAttachment("identity_document")])], complete);
  add("unreadable-document", "Corrupt attachment is recorded and held, not silently dropped", [email("corrupt", [{ filename: "request_form.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF broken") }, await genericAttachment("identity_document")])], complete);
  add("watcher-specimen", "Watcher can downgrade a complete file and prevent sending", [email("specimen", await docs(["request_form", "identity_document"], { notice: "SPECIMEN NOT VALID" }))], { ...complete, watcherFlagged: true, audited: ["watcher_downgrade"] });
  add("park-newsletter", "Explicit ignore rule retains mail without opening a case", [email("newsletter", [], { subject: "Weekly newsletter" })], { missing: [], documents: 0, parked: true, audited: ["fixture_parked"] });
  return fixtures;
}
