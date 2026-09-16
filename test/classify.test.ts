import { describe, expect, it } from "vitest";
import { classifyDocumentType } from "../src/extraction/classify";
import { extractFields } from "../src/extraction/fields";

describe("document-type classification (plain code)", () => {
  it("classifies each known type", () => {
    expect(classifyDocumentType("KENYA CERTIFICATE OF SECONDARY EDUCATION transcript")).toBe("academic_cert");
    expect(classifyDocumentType("KENYA CERTIFICATE OF PRIMARY EDUCATION (KCPE)")).toBe("kcpe_cert");
    expect(classifyDocumentType("REPUBLIC OF KENYA NATIONAL IDENTITY CARD")).toBe("id");
    expect(classifyDocumentType("CERTIFICATE OF BIRTH registration")).toBe("birth_cert");
    expect(classifyDocumentType("UNIVERSITY APPLICATION FORM office of admissions")).toBe("application_form");
  });

  it("application forms mentioning exam points are NOT academic certs (rule order)", () => {
    const text = "UNIVERSITY APPLICATION FORM\nNAME OF APPLICANT: X\nKCSE POINTS: 300";
    expect(classifyDocumentType(text)).toBe("application_form");
  });

  it("returns unknown for unrelated text", () => {
    expect(classifyDocumentType("WEEKLY MARKET LIST tomatoes onions")).toBe("unknown");
    expect(classifyDocumentType("")).toBe("unknown");
  });
});

describe("structured field extraction", () => {
  it("pulls name, points, mean grade, id number and year", () => {
    const f = extractFields(
      "KENYA CERTIFICATE OF PRIMARY EDUCATION\nNAME: GRACE AKINYI OTIENO\nKCPE POINTS: 289\nMEAN GRADE: B\nYEAR: 2019"
    );
    expect(f.name).toBe("GRACE AKINYI OTIENO");
    expect(f.gradePoints).toBe(289);
    expect(f.meanGrade).toBe("B");
    expect(f.examYear).toBe("2019");
  });

  it("handles the 'NAME OF APPLICANT' variant", () => {
    const f = extractFields("UNIVERSITY APPLICATION FORM\nNAME OF APPLICANT: DANIEL OTIENO AYIERO");
    expect(f.name).toBe("DANIEL OTIENO AYIERO");
  });

  it("extracts national ID numbers", () => {
    const f = extractFields("NATIONAL IDENTITY CARD\nNAME: X\nID NO: 23456789");
    expect(f.idNumber).toBe("23456789");
  });

  it("ignores implausible point values", () => {
    const f = extractFields("KCPE POINTS: 99999");
    expect(f.gradePoints).toBeUndefined();
  });

  it("returns an empty object for empty text", () => {
    expect(extractFields("")).toEqual({});
  });
});
