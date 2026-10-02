import { describe, expect, it } from "vitest";
import { assessTextQuality, isGoodText } from "../src/extraction/quality";

const GOOD_TEXT = `REPUBLIC OF KENYA
NATIONAL IDENTIFICATION DOCUMENT
NAME: ALICE WANJIKU KAMAU
DOCUMENT NUMBER: 12345678
DATE OF BIRTH: 1995-02-14
ISSUED: 2017`;

describe("extraction quality heuristics", () => {
  it("accepts real document text", () => {
    expect(isGoodText(GOOD_TEXT)).toBe(true);
    expect(assessTextQuality(GOOD_TEXT).ok).toBe(true);
  });

  it("rejects empty or missing text", () => {
    expect(isGoodText("")).toBe(false);
    expect(isGoodText(null)).toBe(false);
    expect(isGoodText(undefined)).toBe(false);
  });

  it("rejects garbage (mostly punctuation/digits)", () => {
    expect(isGoodText("##!!$$%%^^&&**(())))___+++{{{}}}[[[]]]|||\\\\;;;:::\"\"''<<<<>>>>,,,," )).toBe(false);
  });

  it("rejects too-short text", () => {
    expect(isGoodText("NAME: A")).toBe(false);
  });

  it("rejects OCR-style garbage that happens to be mostly letters", () => {
    const ocrGarbage =
      "THEIR SER ES@)\nN\\N AN TR THIN ERS\nANSI\nTMH TRRTR ETHIE amish\nTTT TIRE =\nA SSNS RNANAN\nTEER TR\nTORRERONRL EES";
    expect(isGoodText(ocrGarbage)).toBe(false);
    expect(assessTextQuality(ocrGarbage).reasons.join(" ")).toMatch(/word length/);
  });

  it("accepts real OCR output of a clean scan", () => {
    const realOcr = `REPUBLIC OF KENYA
NATIONAL IDENTIFICATION DOCUMENT
(ID CARD)
NAME: GRACE AKINYI OTIENO
DOCUMENT NUMBER: 23456789
DATE OF BIRTH: 1993-07-02
ISSUED: 2019
SERIAL NO: 10438211`;
    expect(isGoodText(realOcr)).toBe(true);
  });

  it("rejects repeated-character runs (typical of binary garbage)", () => {
    const report = assessTextQuality("abcdef ".repeat(3) + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA word fish table");
    expect(report.ok).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/repeated/);
  });

  it("reports why text failed", () => {
    const report = assessTextQuality("x");
    expect(report.ok).toBe(false);
    expect(report.reasons.length).toBeGreaterThan(0);
  });
});
