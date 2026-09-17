/**
 * Regression tests for the post-v5 bug hunt — each block pins one fixed bug
 * so it cannot silently return.
 */
import { describe, expect, it } from "vitest";
import { deriveFlags, gradeBelow, normalizeGrade, parseGradeRule, ptsToGrade } from "../src/rules";
import { extractFields } from "../src/extraction/fields";
import type { DocumentRecord, RequirementSetEntry } from "../src/types";

const doc = (type: "academic_cert" | "kcpe_cert", fields: Record<string, unknown>): DocumentRecord[] => [
  {
    id: 1, applicant_id: 1, document_type: type, source_email_id: "m1",
    extraction_method: "pdf_text", extracted_text: "x", extracted_fields: fields,
    confidence: "high", superseded_by: null, received_at: "2026-09-17T00:00:00Z",
  },
];

describe("bug: required grades in word form never matched", () => {
  it("normalizes (plus)/(minus)/(plain) on BOTH sides", () => {
    expect(normalizeGrade("C (plus)")).toBe("C+");
    expect(normalizeGrade("b (plain)")).toBe("B");
    expect(gradeBelow("C", "C (plus)")).toBe(true); // C is below C+
    expect(gradeBelow("C+", "C (plus)")).toBe(false);
    expect(gradeBelow("B-", "B (MINUS)")).toBe(false);
  });
});

describe("bug: either/or subject requirements were treated as AND", () => {
  const reqs: RequirementSetEntry[] = [
    { document_type: "academic_cert", required: true, meanGrade: null, subjectGrades: "B in English/Kiswahili" },
  ];

  it("one language present and high enough satisfies the rule", () => {
    const flags = deriveFlags(reqs, doc("academic_cert", { subjectGrades: { Kiswahili: "B" } }));
    expect(flags).toEqual([]);
  });

  it("all alternatives below the rule → one grade flag", () => {
    const flags = deriveFlags(reqs, doc("academic_cert", { subjectGrades: { English: "C", Kiswahili: "C-" } }));
    expect(flags.map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("no alternative readable → one low-confidence flag", () => {
    const flags = deriveFlags(reqs, doc("academic_cert", { subjectGrades: { Mathematics: "A" } }));
    expect(flags.map((f) => f.type)).toEqual(["low_confidence"]);
  });

  it("parseGradeRule keeps the slash inside the subject entry", () => {
    const parsed = parseGradeRule("B in English/Kiswahili");
    expect(parsed).toEqual([{ grade: "B", subjects: ["English/Kiswahili"] }]);
  });
});

describe("bug: letter-grade rules on KCPE (a points exam) flagged everyone", () => {
  const reqs: RequirementSetEntry[] = [{ document_type: "kcpe_cert", required: true, meanGrade: "C+" }];

  it("readable points are converted to a grade before comparing", () => {
    expect(ptsToGrade(340)).toBe("B");
    expect(ptsToGrade(312)).toBe("B-");
    expect(deriveFlags(reqs, doc("kcpe_cert", { gradePoints: 312 }))).toEqual([]); // B- ≥ C+
    const below = deriveFlags(reqs, doc("kcpe_cert", { gradePoints: 200 })); // C-
    expect(below.map((f) => f.type)).toEqual(["grade_below_requirement"]);
  });

  it("still flags when neither grade nor points could be read", () => {
    const flags = deriveFlags(reqs, doc("kcpe_cert", {}));
    expect(flags.map((f) => f.type)).toEqual(["low_confidence"]);
  });
});

describe("bug: subject synonyms in rules never matched extraction", () => {
  const reqs: RequirementSetEntry[] = [
    { document_type: "academic_cert", required: true, meanGrade: null, subjectGrades: "C+ in Maths and Kis" },
  ];
  it("Maths→Mathematics, Kis→Kiswahili", () => {
    const flags = deriveFlags(reqs, doc("academic_cert", { subjectGrades: { Mathematics: "B", Kiswahili: "B-" } }));
    expect(flags).toEqual([]);
  });
});

describe("bug: word-form grades lost their plus/minus in extraction", () => {
  it("MEAN GRADE: C (plus) extracts C+", () => {
    expect(extractFields("KCSE CERTIFICATE. MEAN GRADE: C (plus).").meanGrade).toBe("C+");
  });
  it("ENGLISH C (plus) keeps the plus", () => {
    const f = extractFields("SUBJECTS: ENGLISH C (plus) MATHEMATICS B (minus)");
    expect(f.subjectGrades?.English).toBe("C+");
    expect(f.subjectGrades?.Mathematics).toBe("B-");
  });
});
