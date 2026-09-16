import { describe, expect, it } from "vitest";
import { extractPhone, inferIntake, inferProgramme } from "../src/enrich";

const PROGRAMMES = [
  { code: "BCS", name: "BSc Computer Science" },
  { code: "BBIT", name: "Bachelor of Business Information Technology" },
  { code: "LAW", name: "Bachelor of Laws (LLB)" },
];
const INTAKES = ["September 2026", "January 2027"];

describe("programme inference", () => {
  it("matches programme codes as words", () => {
    expect(inferProgramme("applying for BCS september", PROGRAMMES)).toBe("BCS");
  });
  it("matches name keywords", () => {
    expect(inferProgramme("I want to study computer science", PROGRAMMES)).toBe("BCS");
    expect(inferProgramme("apply for the laws programme (LLB)", PROGRAMMES)).toBe("LAW");
  });
  it("does not match unrelated text", () => {
    expect(inferProgramme("here are my documents thanks", PROGRAMMES)).toBeNull();
  });
});

describe("intake inference", () => {
  it("matches explicit intake names", () => {
    expect(inferIntake("joining the September 2026 intake", INTAKES)).toBe("September 2026");
  });
  it("matches month + year phrasing", () => {
    expect(inferIntake("planning for january 2027", INTAKES)).toBe("January 2027");
  });
  it("no intake mentioned → null", () => {
    expect(inferIntake("documents attached", INTAKES)).toBeNull();
  });
});

describe("phone extraction", () => {
  it("normalises Kenyan formats to +254", () => {
    expect(extractPhone("call me on 0712 345 678")).toBe("+254712345678");
    expect(extractPhone("reach me: +254798765432")).toBe("+254798765432");
  });
  it("no phone → null", () => {
    expect(extractPhone("no number here")).toBeNull();
  });
});
