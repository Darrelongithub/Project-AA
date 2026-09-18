/**
 * Credit-transfer flow: transfer applicants are detected from their own
 * words, must submit the credit transfer form, and staff can send it.
 */
import { describe, expect, it } from "vitest";
import { classifyDocumentType } from "../src/extraction/classify";
import { inferTransfer } from "../src/enrich";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";

describe("classification", () => {
  it("recognises the credit transfer form (before the generic application-form rule)", () => {
    expect(classifyDocumentType("RIARA UNIVERSITY CREDIT TRANSFER APPLICATION FORM")).toBe("credit_transfer_form");
    expect(classifyDocumentType("UNIVERSITY APPLICATION FORM")).toBe("application_form");
  });
});

describe("transfer inference", () => {
  it("flags genuine transfer language", () => {
    expect(inferTransfer("I am applying for credit transfer from Kenyatta University")).toBe(true);
    expect(inferTransfer("requesting transfer of credits earned so far")).toBe(true);
    expect(inferTransfer("I am transferring from another institution")).toBe(true);
  });
  it("ignores unrelated 'transfer' mentions", () => {
    expect(inferTransfer("I made the bank transfer for the application fee")).toBe(false);
    expect(inferTransfer("please find attached my documents")).toBe(false);
  });
});

describe("requirements", () => {
  it("transfer applicants must submit the credit transfer form; others do not", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const a = repo.getOrCreateApplicant("t@example.org", "th1");
    const b = repo.getOrCreateApplicant("n@example.org", "th2");
    repo.updateApplicant(a.id, { transfer: 1 });
    const has = (id: number) =>
      repo.effectiveRequirements(repo.getApplicant(id)!).some((r) => r.document_type === "credit_transfer_form" && r.required);
    expect(has(a.id)).toBe(true);
    expect(has(b.id)).toBe(false);
  });
});
