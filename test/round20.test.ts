/**
 * Round 20 — hostile-audit regression tests. Each block failed BEFORE its fix
 * and pins the behaviour afterwards: extraction must never invent facts from
 * prose or a bare year, and one corrupt row must never break every read.
 */
import { describe, expect, it } from "vitest";
import { extractFields } from "../src/extraction/fields";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";

describe("regression: a year or a reference must not read as an identity number", () => {
  it("'Reference: 2026' is a reference, and a bare year is nothing at all", () => {
    expect(extractFields("Reference: 2026").idNumber).toBeUndefined();
    expect(extractFields("Renewal notice 2026")).toEqual({});
  });

  it("genuine identity numbers still capture", () => {
    expect(extractFields("ID NO: 202612345/001").idNumber).toBe("202612345/001");
    expect(extractFields("Identification number: 12345678").idNumber).toBe("12345678");
  });
});

describe("regression: prose must not read as structured facts", () => {
  it("evaluative prose yields no facts for the rule tree", () => {
    expect(extractFields("The contact demonstrated a high level of competence in laboratory work.")).toEqual({});
    expect(extractFields("This service maintains a level of rigour expected of partners.")).toEqual({});
  });

  it("'field: value' lines do become facts", () => {
    expect(extractFields("Consent: yes\nCoverage: 1000000")).toMatchObject({ consent: "yes", coverage: "1000000" });
  });

  it("a name line is captured and cleaned", () => {
    expect(extractFields("NAME OF CONTACT: ALEX MORGAN").name).toBe("ALEX MORGAN");
  });
});

describe("regression: a corrupt extracted_fields row must not break every read", () => {
  it("listDocuments survives corrupt JSON in the documents table", () => {
    const db = openDb(":memory:");
    const repo = new Repo(db);
    seedDefaults(repo);
    configureTestOrganization(repo);
    const a = repo.getOrCreateApplicant("corrupt@example.com", "t-corrupt");
    db.prepare(
      `INSERT INTO documents (applicant_id, document_type, source_email_id, extraction_method, extracted_text, extracted_fields, confidence, confidence_score, received_at)
       VALUES (?, 'academic_cert', 'audit-corrupt-row', 'pdf_text', 'text', '{not valid json', 'high', 90, datetime('now'))`
    ).run(a.id);
    // Must not throw — corrupt fields degrade to {}
    const docs = repo.listDocuments(a.id);
    expect(docs.length).toBe(1);
    expect(docs[0].extracted_fields).toEqual({});
  });
});
