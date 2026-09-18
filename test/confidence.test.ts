/**
 * Numeric PDF readability: every document gets a 0-100 score, anchored to its
 * confidence tier so the two can never disagree. Automatic passing requires a
 * score of at least MIN_AUTO_PASS_SCORE (75) on every document.
 */
import { describe, expect, it } from "vitest";
import { readabilityScore, MIN_AUTO_PASS_SCORE } from "../src/extraction/extract";

const GOOD_TEXT =
  "REPUBLIC OF KENYA MINISTRY OF EDUCATION Kenya Certificate of Secondary Education. " +
  "This is to certify that the candidate named herein sat for the examination and obtained the grades recorded. " +
  "English C plus, Mathematics C, Biology B minus, Chemistry C plus, Physics C.";

describe("readability score anchoring", () => {
  it("auto-pass threshold is 75", () => {
    expect(MIN_AUTO_PASS_SCORE).toBe(75);
  });

  it("high-confidence text always clears the auto-pass threshold", () => {
    expect(readabilityScore("high", GOOD_TEXT)).toBeGreaterThanOrEqual(75);
  });

  it("medium-confidence text stays below the auto-pass threshold", () => {
    const s = readabilityScore("medium", GOOD_TEXT);
    expect(s).toBeGreaterThanOrEqual(40);
    expect(s).toBeLessThan(75);
  });

  it("low-confidence / unreadable text never auto-passes", () => {
    expect(readabilityScore("low", GOOD_TEXT)).toBeLessThan(75);
    expect(readabilityScore("low", "")).toBeLessThan(75);
    expect(readabilityScore("medium", "")).toBeLessThan(75);
  });

  it("garbage with repeated runs is pushed down", () => {
    const garbage = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbb";
    expect(readabilityScore("medium", garbage)).toBeLessThan(75);
  });
});
