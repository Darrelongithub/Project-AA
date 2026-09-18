/**
 * Round 20 — hostile-audit regression tests. Each block failed BEFORE its
 * fix and pins the behaviour afterwards.
 */
import { describe, expect, it } from "vitest";
import { extractFields } from "../src/extraction/fields";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";

describe("regression: exam label + year must not read as points", () => {
  it("'KCSE 2026' is an exam year, not 202 points", () => {
    expect(extractFields("KCSE 2026").gradePoints).toBeUndefined();
    expect(extractFields("KCPE 2025 RESULTS SLIP").gradePoints).toBeUndefined();
    expect(extractFields("KCSE 2026 MEAN GRADE B-").gradePoints).toBeUndefined();
  });

  it("genuine totals still capture — including the TOTAL MARKS wording", () => {
    expect(extractFields("KCSE TOTAL MARKS: 388").gradePoints).toBe(388);
    expect(extractFields("KCPE: 388 POINTS").gradePoints).toBe(388);
    expect(extractFields("KCSE MARKS 412").gradePoints).toBe(412);
  });

  it("4-digit years are never truncated into points", () => {
    expect(extractFields("KCPE 2019 388 POINTS").gradePoints).toBe(388);
  });
});

describe("regression: exam-system detection must not fire on prose", () => {
  it("'advanced level of' / 'a level of' in prose stays unrouted", () => {
    expect(
      extractFields("The candidate demonstrated an advanced level of competence in laboratory work.").examSystem
    ).toBeUndefined();
    expect(
      extractFields("This programme maintains a level of academic rigour expected of graduates.").examSystem
    ).toBeUndefined();
  });

  it("genuine A-level documents still route", () => {
    expect(extractFields("UGANDA ADVANCED LEVEL CERTIFICATE OF EDUCATION").examSystem).toBe("ALEVEL");
    expect(extractFields("CAMBRIDGE INTERNATIONAL A LEVEL RESULTS").examSystem).toBe("ALEVEL");
    expect(extractFields("GCE ADVANCED LEVEL EXAMINATION").examSystem).toBe("ALEVEL");
  });

  it("an index number needs more than a bare year", () => {
    expect(extractFields("INDEX NO: 2026").indexNumber).toBeUndefined();
    expect(extractFields("INDEX NO: 202612345/001").indexNumber).toBe("202612345/001");
  });
});

describe("regression: a corrupt extracted_fields row must not break every read", () => {
  it("listDocuments survives corrupt JSON in the documents table", () => {
    const db = openDb(":memory:");
    const repo = new Repo(db);
    seedDefaults(repo);
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
