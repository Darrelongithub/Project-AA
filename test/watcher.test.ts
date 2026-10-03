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
    name: "ALEX MORGAN",
    textExcerpt: "NATIONAL IDENTIFICATION DOCUMENT NAME: ALEX MORGAN ID NUMBER: 23456789 DATE OF ISSUE",
    ...over,
  };
}

describe("heuristic watcher (the pre-auto-send sanity check)", () => {
  it("passes a clean record", () => {
    const res = heuristicWatcher(
      input([
        doc(),
        doc({ document_type: "request_form", textExcerpt: "SERVICE REQUEST FORM NAME: ALEX MORGAN CONSENT: YES REFERENCE 2026-114" }),
      ])
    );
    expect(res.flagged).toBe(false);
    expect(res.concerns).toEqual([]);
  });

  it("flags specimen/sample markings", () => {
    const res = heuristicWatcher(
      input([doc({ document_type: "request_form", textExcerpt: "SERVICE REQUEST FORM NAME ALEX SPECIMEN - SAMPLE COPY NOT VALID" })])
    );
    expect(res.flagged).toBe(true);
    expect(res.concerns.join(" ")).toMatch(/specimen/i);
  });

  it("flags the same content submitted as two different document types", () => {
    const same = "NATIONAL IDENTIFICATION DOCUMENT NAME: ALEX MORGAN DOCUMENT NUMBER: 12345678 ISSUED 2017";
    const res = heuristicWatcher(
      input([
        doc({ document_type: "id", textExcerpt: same }),
        doc({ document_type: "request_form", textExcerpt: same }),
      ])
    );
    expect(res.flagged).toBe(true);
    expect(res.concerns.join(" ")).toMatch(/identical content/i);
  });

  it("flags disagreeing names across documents", () => {
    const res = heuristicWatcher(
      input([doc(), doc({ document_type: "supporting_document", name: "ALICE WAMBUI OTIENO", textExcerpt: "SUPPORTING DOCUMENT NAME ALICE WAMBUI OTIENO ISSUED 2021 REFERENCE" })])
    );
    expect(res.flagged).toBe(true);
  });
});
