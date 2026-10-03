/**
 * Exhaustive unit tests for the pure triage rules engine.
 * No I/O anywhere near this — configured fixtures only, by design.
 *
 * The engine reports evidence (Green/Orange/Red). It never records an outcome:
 * approvals, refusals and closures belong to people.
 */
import { describe, expect, it } from "vitest";
import { decide, dedupeFlags, deriveFlags, docLabel, levenshtein, namesAreSimilar, normalizeName } from "../src/rules";
import { completeDocs, mkDoc, REQS, requiredDocs } from "./helpers";
import { DOC_TYPES } from "../src/types";

describe("rules: verdicts", () => {
  it("complete high-confidence set with no flags → Green", () => {
    const out = decide({ requirements: REQS, docs: completeDocs(), flags: [] });
    expect(out.status).toBe("Green");
    expect(out.missing).toEqual([]);
    expect(out.derivedFlags).toEqual([]);
    expect(out.reasoning).toContain("Outcomes are recorded by people");
  });

  it("missing one blocking slot → Red, and the slot is named", () => {
    const docs = completeDocs().filter((doc) => doc.document_type !== "id");
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing).toEqual(["id"]);
    expect(out.reasoning).toContain("Identity document");
  });

  it("missing ONLY the optional note → still Green", () => {
    const out = decide({ requirements: REQS, docs: requiredDocs(), flags: [] });
    expect(out.status).toBe("Green");
    expect(out.missing).toEqual([]);
  });

  it("zero documents → Red with every blocking slot listed missing", () => {
    const out = decide({ requirements: REQS, docs: [], flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing.sort()).toEqual(["id", "request_form"]);
  });

  it("an unrecognized-only submission never satisfies a checklist → Red", () => {
    const out = decide({ requirements: REQS, docs: [mkDoc("unknown")], flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing.length).toBe(2);
    expect(out.derivedFlags.map((flag) => flag.type)).toContain("wrong_document");
  });

  it("complete set + active watcher flag → Red (a watcher downgrade stands)", () => {
    const out = decide({
      requirements: REQS,
      docs: completeDocs(),
      flags: [{ type: "watcher_flag", detail: "specimen watermark" }],
    });
    expect(out.status).toBe("Red");
    expect(out.missing).toEqual([]);
  });

  it("Red wins over Orange: missing slot + weak extraction together → Red", () => {
    const docs = requiredDocs().filter((doc) => doc.document_type !== "request_form");
    docs[0] = { ...docs[0], confidence: "low", confidence_score: 30 };
    expect(decide({ requirements: REQS, docs, flags: [] }).status).toBe("Red");
  });

  it("a case with no configured checklist is never judged complete", () => {
    const out = decide({ requirements: [], docs: completeDocs(), flags: [] });
    expect(out.missing).toEqual([]);
    expect(out.status).not.toBe("Red");
    expect(out.reasoning).toContain("0 required");
  });
});

describe("rules: evidence flags are raised for people, never acted on", () => {
  it("weak extraction → Orange + low_confidence", () => {
    const docs = completeDocs();
    docs[0] = { ...docs[0], confidence: "low", confidence_score: 40, extraction_method: "gemini_vision" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((flag) => flag.type)).toContain("low_confidence");
  });

  it("medium confidence (OCR) also blocks Green → Orange", () => {
    const docs = completeDocs();
    docs[1] = { ...docs[1], confidence: "medium", confidence_score: 60, extraction_method: "ocr" };
    expect(decide({ requirements: REQS, docs, flags: [] }).status).toBe("Orange");
  });

  it("a document that could not be read at all is flagged, not trusted", () => {
    const out = decide({ requirements: REQS, docs: [...requiredDocs(), mkDoc("invoice", { method: "none", confidence: "low" })], flags: [] });
    expect(out.derivedFlags.map((flag) => flag.type)).toContain("low_confidence");
  });

  it("differing names across documents → Orange + name_mismatch", () => {
    const docs = completeDocs();
    docs.find((doc) => doc.document_type === "id")!.extracted_fields = { name: "SAM OKONKWO" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((flag) => flag.type)).toContain("name_mismatch");
  });

  it("a near-miss name is reported as a possible typo for a human to confirm", () => {
    const docs = completeDocs();
    docs.find((doc) => doc.document_type === "id")!.extracted_fields = { name: "ALEX MORGANN" };
    const detail = decide({ requirements: REQS, docs, flags: [] }).derivedFlags.find((flag) => flag.type === "name_mismatch")!.detail;
    expect(detail).toMatch(/possible typo/i);
  });

  it("the same name with different casing and spacing → normalized, no flag", () => {
    const docs = completeDocs();
    docs.find((doc) => doc.document_type === "id")!.extracted_fields = { name: "  alex   morgan " };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.derivedFlags.find((flag) => flag.type === "name_mismatch")).toBeUndefined();
    expect(out.status).toBe("Green");
  });

  it("never guesses an outcome: every verdict routes to a person", () => {
    for (const status of ["Green", "Orange", "Red"] as const) {
      const out = decide({ requirements: REQS, docs: status === "Green" ? completeDocs() : [], flags: status === "Orange" ? [{ type: "identity_check", detail: "check" }] : [] });
      expect(out.reasoning).toMatch(/Verdict: (Green|Orange|Red)/);
      expect(out.reasoning).not.toMatch(/approved|rejected|admitted/i);
    }
  });
});

describe("rules: name helpers", () => {
  it("normalizeName strips punctuation and case", () => {
    expect(normalizeName("Mary-Anne  Morgan.")).toBe("MARY ANNE MORGAN");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName(null)).toBe("");
  });

  it("levenshtein and namesAreSimilar behave on short and long inputs", () => {
    expect(levenshtein("MORGAN", "MORGAN")).toBe(0);
    expect(levenshtein("MORGAN", "MORGANN")).toBe(1);
    expect(namesAreSimilar("MORGAN", "MORGANN")).toBe(true); // one edit, both at the six-character floor
    expect(namesAreSimilar("MORG", "MORGA")).toBe(false); // below the floor: too short to trust
    expect(namesAreSimilar("ALEX MORGAN", "ALEX MORGANN")).toBe(true);
    expect(namesAreSimilar("ALEX MORGAN", "SAM OKONKWO")).toBe(false);
  });

  it("dedupeFlags collapses identical flags but keeps distinct details", () => {
    const flags = [
      { type: "low_confidence" as const, detail: "a" },
      { type: "low_confidence" as const, detail: "a" },
      { type: "low_confidence" as const, detail: "b" },
    ];
    expect(dedupeFlags(flags)).toHaveLength(2);
  });

  it("deriveFlags on a clean set is empty", () => {
    expect(deriveFlags(REQS, completeDocs())).toEqual([]);
  });
});

describe("rules: labels for configured slots", () => {
  it("every catalogued document type has a human label", () => {
    for (const type of DOC_TYPES) expect(docLabel(type).length).toBeGreaterThan(2);
  });

  it("an organization-defined slot key is labelled from its key", () => {
    expect(docLabel("services_agreement")).toBe("Services agreement");
  });
});
