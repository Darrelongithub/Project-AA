/**
 * Round 13: structured entry requirements — qualification systems checked
 * deterministically (KCSE grades, IGCSE credits, A-Level principals, IB
 * points, diploma/degree classes, GPAs), with a subject matrix per course.
 */
import { describe, expect, it } from "vitest";
import { checkQualificationSystems, checkSystemBlock } from "../src/rules";
import { extractFields } from "../src/extraction/fields";
import type { SystemBlock } from "../src/types";
import type { ExtractedFields } from "../src/types";

const kcse = (rest: Partial<SystemBlock>): SystemBlock => ({ system: "KCSE", enabled: true, overall: null, ...rest });

describe("checkSystemBlock — per-system determinism", () => {
  it("KCSE: mean grade below the floor flags, at/above passes", () => {
    const block = kcse({ overall: "C+" });
    expect(checkSystemBlock(block, { meanGrade: "C" }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
    expect(checkSystemBlock(block, { meanGrade: "C+" })).toEqual([]);
    expect(checkSystemBlock(block, { meanGrade: "B-" })).toEqual([]);
    // Unreadable → human, never a guess.
    expect(checkSystemBlock(block, {}).map((f) => f.type)).toEqual(["low_confidence"]);
  });

  it("KCSE subjects: either/or alternatives — one subject reaching the grade is enough", () => {
    const block = kcse({ subjects: [{ subject: "English", grade: "B", alts: ["Kiswahili"] }] });
    expect(checkSystemBlock(block, { subjectGrades: { Kiswahili: "B" } })).toEqual([]);
    expect(checkSystemBlock(block, { subjectGrades: { English: "C", Kiswahili: "C-" } }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
    expect(checkSystemBlock(block, {}).map((f) => f.type)).toEqual(["low_confidence"]);
  });

  it("IGCSE: credit count compared against the minimum", () => {
    const block: SystemBlock = { system: "IGCSE", enabled: true, overall: null, minCredits: 5 };
    expect(checkSystemBlock(block, { credits: 6 })).toEqual([]);
    expect(checkSystemBlock(block, { credits: 4 }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
    expect(checkSystemBlock(block, {}).map((f) => f.type)).toEqual(["low_confidence"]);
  });

  it("A-Level: principal passes compared against the minimum", () => {
    const block: SystemBlock = { system: "ALEVEL", enabled: true, overall: null, minPrincipals: 2 };
    expect(checkSystemBlock(block, { principals: 2, subsidiaries: 1 })).toEqual([]);
    expect(checkSystemBlock(block, { principals: 1 }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("IB: total points compared against the minimum", () => {
    const block: SystemBlock = { system: "IB", enabled: true, overall: null, minPoints: 24 };
    expect(checkSystemBlock(block, { ibPoints: 27 })).toEqual([]);
    expect(checkSystemBlock(block, { ibPoints: 21 }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("Diploma class ladder: Credit beats Pass, Distinction beats Credit", () => {
    const block: SystemBlock = { system: "DIPLOMA", enabled: true, overall: null, minClass: "Credit" };
    expect(checkSystemBlock(block, { classAwarded: "Credit" })).toEqual([]);
    expect(checkSystemBlock(block, { classAwarded: "Distinction" })).toEqual([]);
    expect(checkSystemBlock(block, { classAwarded: "Pass" }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("Degree class ladder: Second Upper required for the MBA route", () => {
    const block: SystemBlock = { system: "DEGREE", enabled: true, overall: null, minClass: "Second Class Honours (Upper Division)" };
    expect(checkSystemBlock(block, { classAwarded: "Second Class Honours (Upper Division)" })).toEqual([]);
    expect(checkSystemBlock(block, { classAwarded: "First Class Honours" })).toEqual([]);
    expect(checkSystemBlock(block, { classAwarded: "Second Class Honours (Lower Division)" }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("Pre-University: GPA compared against the minimum", () => {
    const block: SystemBlock = { system: "PREUNI", enabled: true, overall: null, minGpa: 2.5 };
    expect(checkSystemBlock(block, { gpa: 3.1 })).toEqual([]);
    expect(checkSystemBlock(block, { gpa: 2.2 }).map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });
});

describe("checkQualificationSystems — routing", () => {
  const doc = (fields: ExtractedFields) => ({
    id: 1, applicant_id: 1, document_type: "academic_cert" as const, source_email_id: "e1",
    extraction_method: "pdf_text" as const, extracted_text: "x", extracted_fields: fields,
    confidence: "high" as const, superseded_by: null, received_at: "2026-09-15T00:00:00Z",
  });

  it("a system with no configured route goes to a human", () => {
    const flags = checkQualificationSystems([kcse({ overall: "C+" })], [doc({ examSystem: "IB", ibPoints: 30 })]);
    expect(flags.map((f) => f.type)).toEqual(["alternative_qualification"]);
  });

  it("a disabled route goes to a human", () => {
    const flags = checkQualificationSystems(
      [{ system: "IB", enabled: false, overall: null }],
      [doc({ examSystem: "IB", ibPoints: 30 })]
    );
    expect(flags.map((f) => f.type)).toEqual(["alternative_qualification"]);
  });

  it("an unidentifiable system goes to a human", () => {
    const flags = checkQualificationSystems([kcse({ overall: "C+" })], [doc({})]);
    expect(flags.map((f) => f.type)).toEqual(["low_confidence"]);
  });

  it("non-academic documents are ignored", () => {
    const idDoc = { ...doc({}), document_type: "id" as const };
    expect(checkQualificationSystems([kcse({ overall: "C+" })], [idDoc])).toEqual([]);
  });
});

describe("extractFields — qualification system detection", () => {
  it("reads IGCSE credits at C or better", () => {
    const f = extractFields("CAMBRIDGE INTERNATIONAL EXAMINATIONS\nINTERNATIONAL GCSE (IGCSE)\nNAME: JANE DOE\nENGLISH: C\nMATHEMATICS: B\nPHYSICS: F");
    expect(f.examSystem).toBe("IGCSE");
    expect(f.credits).toBe(2);
    expect(f.subjectGrades?.English).toBe("C");
  });

  it("counts A-Level principal passes and subsidiaries", () => {
    const f = extractFields("GCE ADVANCED LEVEL EXAMINATION\nNAME: JANE DOE\nMATHEMATICS: B\nPHYSICS: C\nSUBSIDIARY: 1");
    expect(f.examSystem).toBe("ALEVEL");
    expect(f.principals).toBe(2);
    expect(f.subsidiaries).toBe(1);
  });

  it("reads IB total points", () => {
    const f = extractFields("INTERNATIONAL BACCALAUREATE DIPLOMA\nNAME: JANE DOE\nTOTAL POINTS: 28");
    expect(f.examSystem).toBe("IB");
    expect(f.ibPoints).toBe(28);
  });

  it("reads diploma class and degree classifications", () => {
    const d = extractFields("DIPLOMA IN BUSINESS MANAGEMENT — DIPLOMA TRANSCRIPT\nNAME: JANE DOE\nOVERALL GRADE: CREDIT");
    expect(d.examSystem).toBe("DIPLOMA");
    expect(d.classAwarded).toBe("Credit");
    const deg = extractFields("BACHELOR OF BUSINESS ADMINISTRATION — DEGREE TRANSCRIPT\nNAME: JANE DOE\nDEGREE CLASSIFICATION: SECOND CLASS HONOURS (UPPER DIVISION)");
    expect(deg.examSystem).toBe("DEGREE");
    expect(deg.classAwarded).toBe("Second Class Honours (Upper Division)");
  });

  it("reads Pre-University GPA", () => {
    const f = extractFields("PRE-UNIVERSITY CERTIFICATE\nNAME: JANE DOE\nGPA: 3.20");
    expect(f.examSystem).toBe("PREUNI");
    expect(f.gpa).toBe(3.2);
  });

  it("KCSE slips keep their system and mean grade", () => {
    const f = extractFields("KENYA CERTIFICATE OF SECONDARY EDUCATION\nNAME: JANE DOE\nMEAN GRADE: B-\nENGLISH: B");
    expect(f.examSystem).toBe("KCSE");
    expect(f.meanGrade).toBe("B-");
  });
});
