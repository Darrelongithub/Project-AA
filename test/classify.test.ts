/**
 * Document classification and field extraction — plain code, no domain
 * vocabulary. The classifier only knows generic document hints; an
 * organization's own document definitions are resolved separately by the
 * pipeline. Extraction pulls identity facts plus whatever `field: value`
 * lines the organization's rule tree needs.
 */
import { describe, expect, it } from "vitest";
import { classifyDocumentType } from "../src/extraction/classify";
import { extractFields } from "../src/extraction/fields";

describe("document-type classification (plain code)", () => {
  it("classifies each generic hint", () => {
    expect(classifyDocumentType("SERVICE REQUEST FORM — page 1")).toBe("request_form");
    expect(classifyDocumentType("INTAKE FORM for vendor onboarding")).toBe("request_form");
    expect(classifyDocumentType("APPLICATION FORM sent by email")).toBe("request_form");
    expect(classifyDocumentType("CERTIFICATE OF BIRTH registration")).toBe("birth_cert");
    expect(classifyDocumentType("REPUBLIC OF KENYA NATIONAL IDENTITY CARD")).toBe("id");
    expect(classifyDocumentType("NATIONAL IDENTIFICATION DOCUMENT")).toBe("id");
    expect(classifyDocumentType("PASSPORT PHOTOGRAPH")).toBe("passport_photo");
    expect(classifyDocumentType("passport-sized photo")).toBe("passport_photo");
  });

  it("a request form that quotes an identity number is still a request form (rule order)", () => {
    const text = "SERVICE REQUEST FORM\nNAME OF CONTACT: X\nNATIONAL ID: 12345678";
    expect(classifyDocumentType(text)).toBe("request_form");
  });

  it("returns unknown for unrelated text", () => {
    expect(classifyDocumentType("WEEKLY MARKET LIST tomatoes onions")).toBe("unknown");
    expect(classifyDocumentType("")).toBe("unknown");
  });
});

describe("structured field extraction", () => {
  it("pulls the contact name, identity number and date of birth", () => {
    const f = extractFields(
      "SERVICE REQUEST FORM\nNAME: GRACE AKINYI OTIENO\nID NO: 23456789\nDATE OF BIRTH: 1995-02-14"
    );
    expect(f.name).toBe("GRACE AKINYI OTIENO");
    expect(f.idNumber).toBe("23456789");
    expect(f.dateOfBirth).toBe("1995-02-14");
  });

  it("handles the 'NAME OF CONTACT' variant", () => {
    const f = extractFields("SERVICE REQUEST FORM\nNAME OF CONTACT: DANIEL OTIENO AYIERO");
    expect(f.name).toBe("DANIEL OTIENO AYIERO");
  });

  it("keeps organization-defined facts for the rule tree", () => {
    const f = extractFields("Consent: yes\nCoverage: 250000\nDuration: 24");
    expect(f).toMatchObject({ consent: "yes", coverage: "250000", duration: "24" });
  });

  it("does not invent an identity number from a short digit run", () => {
    expect(extractFields("Order 42 is ready").idNumber).toBeUndefined();
  });

  it("returns an empty object for empty text", () => {
    expect(extractFields("")).toEqual({});
  });
});
