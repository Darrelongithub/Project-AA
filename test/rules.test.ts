/**
 * Exhaustive unit tests for the pure rules engine.
 * No I/O anywhere near this — fake data only, by design.
 */
import { describe, expect, it } from "vitest";
import { decide, deriveFlags, normalizeName } from "../src/rules";
import { completeDocs, mkDoc, REQS } from "./helpers";

describe("rules: verdicts", () => {
  it("complete high-confidence set with no flags → Green", () => {
    const out = decide({ requirements: REQS, docs: completeDocs(), flags: [] });
    expect(out.status).toBe("Green");
    expect(out.missing).toEqual([]);
    expect(out.derivedFlags).toEqual([]);
  });

  it("missing one required document → Red, and it is named", () => {
    const docs = completeDocs().filter((d) => d.document_type !== "id");
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing).toEqual(["id"]);
    expect(out.reasoning).toContain("National ID");
  });

  it("missing ONLY the optional birth certificate → still Green", () => {
    const docs = completeDocs().filter((d) => d.document_type !== "birth_cert");
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Green");
    expect(out.missing).toEqual([]);
  });

  it("zero documents → Red with every required doc listed missing", () => {
    const out = decide({ requirements: REQS, docs: [], flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing.sort()).toEqual(["academic_cert", "application_form", "id", "kcpe_cert"]);
  });

  it("an unrecognized-only submission never satisfies requirements → Red", () => {
    const out = decide({ requirements: REQS, docs: [mkDoc("unknown")], flags: [] });
    expect(out.status).toBe("Red");
    expect(out.missing.length).toBe(4);
  });

  it("complete set + active watcher_flag → Red (watcher downgrades stand)", () => {
    const out = decide({
      requirements: REQS,
      docs: completeDocs(),
      flags: [{ type: "watcher_flag", detail: "specimen watermark" }],
    });
    expect(out.status).toBe("Red");
  });

  it("Red wins over Orange: missing doc + flag together → Red", () => {
    const docs = completeDocs().filter((d) => d.document_type !== "application_form");
    docs[0] = { ...docs[0], confidence: "low" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Red");
  });
});

describe("rules: grade requirement is ALWAYS a flag, never an auto decision", () => {
  it("grade below the floor → Orange + grade_below_requirement flag (never auto-rejected)", () => {
    const docs = completeDocs();
    const kcpe = docs.find((d) => d.document_type === "kcpe_cert")!;
    kcpe.extracted_fields = { ...kcpe.extracted_fields, meanGrade: "D", subjectGrades: { English: "D" } };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((f) => f.type)).toContain("grade_below_requirement");
    expect(out.status).not.toBe("Red"); // borderline ≠ auto-fail
  });

  it("grade exactly at the floor → not below → Green", () => {
    const docs = completeDocs();
    const kcpe = docs.find((d) => d.document_type === "kcpe_cert")!;
    kcpe.extracted_fields = { ...kcpe.extracted_fields, meanGrade: "C-", subjectGrades: { English: "C-" } };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Green");
    expect(out.derivedFlags.find((f) => f.type === "grade_below_requirement")).toBeUndefined();
  });

  it("grade above the floor → Green", () => {
    const docs = completeDocs();
    const kcpe = docs.find((d) => d.document_type === "kcpe_cert")!;
    kcpe.extracted_fields = { ...kcpe.extracted_fields, meanGrade: "A", subjectGrades: { English: "A" } };
    expect(decide({ requirements: REQS, docs, flags: [] }).status).toBe("Green");
  });

  it("subject below the required subject grade → grade_below_requirement flag", () => {
    const docs = completeDocs();
    const kcpe = docs.find((d) => d.document_type === "kcpe_cert")!;
    kcpe.extracted_fields = { ...kcpe.extracted_fields, meanGrade: "B", subjectGrades: { English: "D" } };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.derivedFlags.map((f) => f.type)).toContain("grade_below_requirement");
    expect(out.status).toBe("Orange");
  });

  it("doc with a grade floor but unreadable grade → Orange + low_confidence (human verifies)", () => {
    const docs = completeDocs();
    const kcpe = docs.find((d) => d.document_type === "kcpe_cert")!;
    kcpe.extracted_fields = { name: "ALICE WANJIKU KAMAU" }; // no gradePoints
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.some((f) => f.type === "low_confidence")).toBe(true);
  });
});

describe("rules: name matching", () => {
  it("different names across documents → Orange + name_mismatch", () => {
    const docs = completeDocs();
    docs.find((d) => d.document_type === "id")!.extracted_fields = { name: "ALICE WAMBUI OTIENO" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((f) => f.type)).toContain("name_mismatch");
  });

  it("same name with different casing/spacing → normalized → Green", () => {
    const docs = completeDocs();
    docs.find((d) => d.document_type === "id")!.extracted_fields = { name: "alice   wanjiku kamau" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.derivedFlags.find((f) => f.type === "name_mismatch")).toBeUndefined();
    expect(out.status).toBe("Green");
  });

  it("normalizeName strips punctuation and case", () => {
    expect(normalizeName("Mary-Anne Wanjiku  Kamau.")).toBe("MARY ANNE WANJIKU KAMAU");
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("rules: confidence discipline", () => {
  it("a low-confidence document → Orange + low_confidence flag", () => {
    const docs = completeDocs();
    docs[0] = { ...docs[0], confidence: "low", extraction_method: "gemini_vision" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.map((f) => f.type)).toContain("low_confidence");
  });

  it("a medium-confidence document (e.g. OCR) also blocks Green → Orange", () => {
    const docs = completeDocs();
    docs[1] = { ...docs[1], confidence: "medium", extraction_method: "ocr" };
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
  });

  it("an extra unrecognized attachment raises low_confidence → Orange even with a complete set", () => {
    const docs = [...completeDocs(), mkDoc("unknown", { text: "market list tomatoes" })];
    const out = decide({ requirements: REQS, docs, flags: [] });
    expect(out.status).toBe("Orange");
    expect(out.derivedFlags.some((f) => f.detail.includes("unrecognized attachment"))).toBe(true);
  });
});

describe("rules: purity and determinism", () => {
  it("deriveFlags is a pure function of its inputs", () => {
    const docs = completeDocs();
    const a = JSON.stringify(deriveFlags(REQS, docs));
    const b = JSON.stringify(deriveFlags(REQS, docs));
    expect(a).toBe(b);
  });

  it("decide does not mutate its inputs", () => {
    const docs = completeDocs();
    const snapshot = JSON.stringify(docs);
    decide({ requirements: REQS, docs, flags: [{ type: "watcher_flag", detail: "x" }] });
    expect(JSON.stringify(docs)).toBe(snapshot);
  });

  it("reasoning names every required doc and the verdict", () => {
    const out = decide({ requirements: REQS, docs: completeDocs(), flags: [] });
    for (const t of ["academic_cert", "kcpe_cert", "id", "application_form", "birth_cert"]) {
      expect(out.reasoning).toContain(t);
    }
    expect(out.reasoning).toContain("Verdict: Green");
  });
});
