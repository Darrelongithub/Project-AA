import { describe, expect, it } from "vitest";
import { heuristicWatcher } from "../src/watcher";
import type { WatcherInput } from "../src/types";

function input(docs: WatcherInput["docs"]): WatcherInput {
  return { applicantEmail: "a@example.org", subject: "docs", docs };
}

function doc(over: Partial<WatcherInput["docs"][number]> = {}): WatcherInput["docs"][number] {
  return {
    document_type: "id",
    extraction_method: "pdf_text",
    confidence: "high",
    name: "ALICE WANJIKU KAMAU",
    gradePoints: null,
    textExcerpt: "REPUBLIC OF KENYA NATIONAL IDENTITY CARD NAME: ALICE WANJIKU KAMAU ID NO: 23456789 DATE OF ISSUE",
    ...over,
  };
}

describe("heuristic watcher (the pre-auto-send sanity check)", () => {
  it("passes a clean record", () => {
    const res = heuristicWatcher(
      input([
        doc(),
        doc({ document_type: "academic_cert", textExcerpt: "KENYA CERTIFICATE OF SECONDARY EDUCATION NAME: ALICE WANJIKU KAMAU MEAN GRADE B MINUS YEAR 2021" }),
      ])
    );
    expect(res.flagged).toBe(false);
    expect(res.concerns).toEqual([]);
  });

  it("flags specimen/sample markings", () => {
    const res = heuristicWatcher(
      input([doc({ document_type: "academic_cert", textExcerpt: "ACADEMIC TRANSCRIPT NAME ALICE SPECIMEN - SAMPLE COPY NOT VALID" })])
    );
    expect(res.flagged).toBe(true);
    expect(res.concerns.join(" ")).toMatch(/specimen/i);
  });

  it("flags the same content submitted as two different document types", () => {
    const same = "KENYA CERTIFICATE OF PRIMARY EDUCATION NAME: ALICE WANJIKU KAMAU KCPE POINTS: 312 YEAR: 2017 INDEX NO";
    const res = heuristicWatcher(
      input([
        doc({ document_type: "kcpe_cert", textExcerpt: same }),
        doc({ document_type: "academic_cert", textExcerpt: same }),
      ])
    );
    expect(res.flagged).toBe(true);
    expect(res.concerns.join(" ")).toMatch(/identical content/i);
  });

  it("flags disagreeing names across documents", () => {
    const res = heuristicWatcher(
      input([doc(), doc({ document_type: "academic_cert", name: "ALICE WAMBUI OTIENO", textExcerpt: "ACADEMIC TRANSCRIPT NAME ALICE WAMBUI OTIENO YEAR 2021 GRADE" })])
    );
    expect(res.flagged).toBe(true);
  });
});
