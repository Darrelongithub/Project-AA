/**
 * M-4 — the dashboard "documents" tile counts ACTIVE documents only.
 *
 * The case view and the CSV export both exclude superseded documents
 * (superseded_by IS NULL); the dashboard tile still counted them, so its
 * total could exceed what any per-case surface shows. After a re-upload
 * supersedes an older copy, the tile must not move.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";

function addDoc(repo: Repo, applicantId: number, type: "academic_cert", emailId: string): number {
  return repo.insertDocument({
    applicant_id: applicantId,
    document_type: type,
    source_email_id: emailId,
    extraction_method: "pdf_text",
    extracted_text: "academic transcript",
    extracted_fields: { name: "SUPERSEDE TEST" },
    confidence: "high",
    received_at: "2026-09-14T09:00:00Z",
  });
}

describe("M-4: dashboardStats().documents excludes superseded documents", () => {
  it("a superseded re-upload does not inflate the dashboard count", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    const a = repo.getOrCreateApplicant("m4-docs@example.org", "m4-thread-1", { fullName: "Mda Test" });

    const before = Number(repo.dashboardStats().documents);
    const first = addDoc(repo, a.id, "academic_cert", "m4-email-1");
    expect(first).toBeGreaterThan(0);
    expect(Number(repo.dashboardStats().documents)).toBe(before + 1);

    // A second upload of the same type supersedes the first (the pipeline
    // path under test here is supersedeOlder, as used by document intake).
    const second = addDoc(repo, a.id, "academic_cert", "m4-email-2");
    repo.supersedeOlder(a.id, "academic_cert", second);

    // The case view counts one active copy…
    expect(repo.listDocuments(a.id, { activeOnly: true }).length).toBe(1);
    // …and the dashboard now agrees.
    expect(Number(repo.dashboardStats().documents)).toBe(before + 1);

    // Sanity: the superseded row is still in the file (activeOnly: false).
    expect(repo.listDocuments(a.id, { activeOnly: false }).length).toBe(2);
    expect(repo.listDocuments(a.id, { activeOnly: false }).filter((d) => d.superseded_by !== null).length).toBe(1);
  });
});
