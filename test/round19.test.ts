/**
 * Round 19 — the audit punch-list, pinned in tests:
 *  - international document classification + field extraction
 *  - type-aware quality thresholds
 *  - confidence v2 (fields + method trust, not just pretty text)
 *  - cross-document name/DOB consistency
 *  - full-page rasterisation tier for image-only PDFs
 *  - classified PDF failures (encrypted / corrupt / empty / oversized)
 *  - Gemini cache + budget + circuit breaker
 *  - dead-letter queue + vision cache persistence
 */
import { describe, expect, it } from "vitest";
import { classifyDocumentType } from "../src/extraction/classify";
import { extractFields, cleanExtractedName } from "../src/extraction/fields";
import { isGoodText, assessTextQuality, thresholdsFor } from "../src/extraction/quality";
import { computeConfidence, fieldScore, extractAttachment, MAX_ATTACHMENT_BYTES } from "../src/extraction/extract";
import { namesConsistent, dobsConsistent, consistencyCheck } from "../src/extraction/crosscheck";
import { pdfRead } from "../src/extraction/pdfText";
import { rasterizePdf } from "../src/extraction/rasterize";
import {
  BudgetedVisionAdapter,
  VisionUnavailableError,
  type VisionAdapter,
  type VisionCacheStore,
} from "../src/extraction/gemini";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import type { Attachment, VisionExtraction } from "../src/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require("pdfkit");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require("sharp");

/** Build an image-only PDF (no text layer), like a phone "Scan" app export. */
async function makeImageOnlyPdf(): Promise<Buffer> {
  const w = 800;
  const h = 200;
  const pixels = Buffer.alloc(w * h * 3, 255);
  const jpeg = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .toBuffer();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.image(jpeg, 40, 40, { width: 500 });
    doc.end();
  });
}

const att = (content: Buffer, filename: string, mimeType = "application/pdf"): Attachment => ({
  filename,
  mimeType,
  content,
});

const NO_VISION: VisionAdapter = { extractDocument: async () => null };

describe("classifier: international wording (round 19)", () => {
  it("recognises foreign birth-certificate phrasings", () => {
    expect(classifyDocumentType("REPUBLIC OF UGANDA — BIRTH REGISTRATION No. 4471")).toBe("birth_cert");
    expect(classifyDocumentType("CERTIFICATE OF LIVE BIRTH — Republic of the Philippines")).toBe("birth_cert");
    expect(classifyDocumentType("Extract from the Register of Births, Registrar General")).toBe("birth_cert");
    expect(classifyDocumentType("REGISTRATION OF BIRTH — entry number 112233")).toBe("birth_cert");
  });

  it("recognises GCSE / IGCSE / A-Level / IB / WAEC results", () => {
    // Grade-bearing international statements of results stay in the academic
    // family; OR-5's result-slip slot is the specific checklist document.
    expect(classifyDocumentType("General Certificate of Secondary Education — Statement of Results")).toBe("academic_cert");
    expect(classifyDocumentType("CAMBRIDGE INTERNATIONAL AS & A LEVEL — candidate results")).toBe("academic_cert");
    expect(classifyDocumentType("INTERNATIONAL BACCALAUREATE ORGANISATION — results")).toBe("academic_cert");
    expect(classifyDocumentType("WEST AFRICAN SENIOR SCHOOL CERTIFICATE EXAMINATION")).toBe("academic_cert");
    expect(classifyDocumentType("UGANDA ADVANCED LEVEL KACE STATEMENT OF RESULTS")).toBe("academic_cert");
  });

  it("does not mistake a transcript mentioning a passport for an ID", () => {
    const text = "UNIVERSITY TRANSCRIPT — student passport P1234567A — degree classification";
    expect(classifyDocumentType(text)).toBe("academic_cert");
  });

  it("still catches the exact Kenyan wordings", () => {
    expect(classifyDocumentType("KENYA CERTIFICATE OF SECONDARY EDUCATION")).toBe("academic_cert");
    expect(classifyDocumentType("KENYA CERTIFICATE OF PRIMARY EDUCATION")).toBe("kcpe_cert");
    expect(classifyDocumentType("CERTIFICATE OF BIRTH — registration of births and deaths")).toBe("birth_cert");
  });
});

describe("fields: international extractors (round 19)", () => {
  it("normalises comma-first, ALL CAPS and titled names", () => {
    expect(cleanExtractedName("KAMAU, JOHN")).toBe("JOHN KAMAU");
    expect(cleanExtractedName("MR. JOHN   PETER KAMAU")).toBe("JOHN PETER KAMAU");
    expect(cleanExtractedName("alice wanjiku kamau")).toBe("alice wanjiku kamau");
    expect(cleanExtractedName("12345")).toBeNull();
  });

  it("reads names from candidate/student label variants", () => {
    expect(extractFields("CANDIDATE NAME: GRACE AKINYI OTIENO").name).toBe("GRACE AKINYI OTIENO");
    expect(extractFields("NAME OF CANDIDATE: KAMAU, JOHN").name).toBe("JOHN KAMAU");
    expect(extractFields("STUDENT NAME: MARY NJOKI").name).toBe("MARY NJOKI");
  });

  it("reads dates of birth", () => {
    expect(extractFields("DATE OF BIRTH: 12/03/2004").dateOfBirth).toBe("12/03/2004");
    expect(extractFields("DOB: 2003-11-05").dateOfBirth).toBe("2003-11-05");
    expect(extractFields("DATE OF BIRTH: 4TH JANUARY 2005").dateOfBirth).toMatch(/JAN/);
  });

  it("reads alphanumeric passport numbers", () => {
    expect(extractFields("PASSPORT NO: P1234567A").idNumber).toBe("P1234567A");
    expect(extractFields("ID NO: 12345678").idNumber).toBe("12345678");
  });

  it("reads IGCSE numeric grades and counts credits at 4+", () => {
    const f = extractFields(
      "CAMBRIDGE IGCSE RESULTS\nENGLISH LANGUAGE: 7\nMATHEMATICS: 5\nBIOLOGY: 3\nCHEMISTRY: A"
    );
    expect(f.examSystem).toBe("IGCSE");
    expect(f.subjectGrades).toMatchObject({ "English Language": "7", Mathematics: "5", Biology: "3", Chemistry: "A" });
    expect(f.credits).toBe(3); // 7, 5 and A
  });

  it("reads A-Level A* combos and A* grades", () => {
    const combo = extractFields("CAMBRIDGE ADVANCED LEVEL\nGRADES: A*AA");
    expect(combo.examSystem).toBe("ALEVEL");
    expect(combo.meanGrade).toBe("A*AA");
    expect(combo.principals).toBe(3);

    const lines = extractFields("ADVANCED LEVEL EXAMINATION\nMATHEMATICS: A*\nPHYSICS: A\nCHEMISTRY: B");
    expect(lines.examSystem).toBe("ALEVEL");
    expect(lines.subjectGrades).toMatchObject({ Mathematics: "A*", Physics: "A", Chemistry: "B" });
  });

  it("reads IB points as XX/45", () => {
    expect(extractFields("INTERNATIONAL BACCALAUREATE DIPLOMA\nPOINTS AWARDED: 38").ibPoints).toBe(38);
    expect(extractFields("IB DIPLOMA RESULTS — 34 / 45 POINTS").ibPoints).toBe(34);
  });

  it("reads diploma award words", () => {
    expect(extractFields("DIPLOMA IN NURSING TRANSCRIPT\nFINAL RESULT: MERIT").classAwarded).toBe("Merit");
    expect(extractFields("DIPLOMA RESULTS\nOVERALL GRADE: DISTINCTION").classAwarded).toBe("Distinction");
  });
});

describe("quality: document-type-aware thresholds (round 19)", () => {
  // A real, complete birth certificate — and still only ~40 characters.
  const SHORT_BIRTH_CERT = "BIRTH CERTIFICATE\nJOHN KAMAU\n12/03/2004";

  it("accepts a short-but-legit birth certificate", () => {
    expect(isGoodText(SHORT_BIRTH_CERT, "birth_cert")).toBe(true);
    // …which the old one-size-fits-all gate rejected.
    expect(isGoodText(SHORT_BIRTH_CERT)).toBe(false);
  });

  it("keeps the strict gate for academic results", () => {
    expect(thresholdsFor("academic_cert").minLength).toBe(40);
    expect(thresholdsFor("unknown").minLength).toBe(40);
    expect(isGoodText("NAME: A", "academic_cert")).toBe(false);
  });

  it("reports failures with reasons", () => {
    const r = assessTextQuality("###", thresholdsFor("birth_cert"));
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("confidence v2 (round 19)", () => {
  const KCSE_TEXT =
    "KENYA CERTIFICATE OF SECONDARY EDUCATION\nNAME: ALICE WANJIKU KAMAU\n" +
    "MEAN GRADE: B (plus)\nENGLISH B\nKISWAHILI B\nMATHEMATICS B\nBIOLOGY B\nCHEMISTRY B\nPHYSICS B";

  it("good fields dominate: clean KCSE from a text layer is high", () => {
    const fields = extractFields(KCSE_TEXT);
    const v = computeConfidence({ text: KCSE_TEXT, fields, docType: "academic_cert", method: "pdf_text", tier: "high" });
    expect(v.score).toBeGreaterThanOrEqual(75);
    expect(v.confidence).toBe("high");
  });

  it("pretty text without fields can NOT auto-pass", () => {
    const pretty =
      "KENYA CERTIFICATE OF SECONDARY EDUCATION — this document certifies that the candidate named herein " +
      "sat for the national examination administered by the Kenya National Examinations Council and obtained the grades recorded below.";
    const v = computeConfidence({ text: pretty, fields: {}, docType: "academic_cert", method: "pdf_text", tier: "high" });
    expect(v.score).toBeLessThan(75);
  });

  it("unknown document types are capped at 45", () => {
    const v = computeConfidence({ text: KCSE_TEXT, fields: extractFields(KCSE_TEXT), docType: "unknown", method: "pdf_text", tier: "high" });
    expect(v.score).toBeLessThanOrEqual(45);
    expect(v.confidence).not.toBe("high");
  });

  it("method trust is ordered pdf_text > ocr > vision", () => {
    const fields = extractFields(KCSE_TEXT);
    const mk = (method: "pdf_text" | "ocr" | "gemini_vision") =>
      computeConfidence({ text: KCSE_TEXT, fields, docType: "academic_cert", method, tier: "medium" }).score;
    expect(mk("pdf_text")).toBeGreaterThan(mk("ocr"));
    expect(mk("ocr")).toBeGreaterThan(mk("gemini_vision"));
  });

  it("a vision-only reading is held below the auto-pass line (human confirms first)", () => {
    const v = computeConfidence({ text: KCSE_TEXT, fields: extractFields(KCSE_TEXT), docType: "academic_cert", method: "gemini_vision", tier: "high" });
    expect(v.score).toBeLessThanOrEqual(74);
    expect(v.confidence).not.toBe("high");
  });

  it("fieldScore rewards the critical fields per document type", () => {
    expect(fieldScore({ name: "A B", dateOfBirth: "12/03/2004" }, "birth_cert")).toBe(100);
    expect(fieldScore({}, "birth_cert")).toBe(0);
    expect(fieldScore({ name: "A B", idNumber: "12345678" }, "id")).toBe(90);
    expect(fieldScore({ meanGrade: "B", subjectGrades: { English: "B", Kiswahili: "B", Mathematics: "B" }, name: "A B", examSystem: "KCSE" }, "academic_cert")).toBe(100);
  });
});

describe("cross-document consistency (round 19)", () => {
  it("matches names across order, case, initials and middle names", () => {
    expect(namesConsistent("John Kamau", "KAMAU JOHN")).toBe(true);
    expect(namesConsistent("John K Kamau", "John Kamau")).toBe(true);
    expect(namesConsistent("Alice Wanjiku Kamau", "Alice Kamau")).toBe(true);
    expect(namesConsistent("John Kamau", "Mary Wanjiru")).toBe(false);
    expect(namesConsistent(null, "John Kamau")).toBe(true); // nothing to contradict
  });

  it("matches identical DOBs and flags different ones", () => {
    expect(dobsConsistent("12/03/2004", "12-03-2004")).toBe(true);
    expect(dobsConsistent("12/03/2004", "12/03/2005")).toBe(false);
    expect(dobsConsistent(null, "12/03/2005")).toBe(true);
  });

  it("majority wins; outliers are listed", () => {
    const docs = [
      { id: 1, document_type: "academic_cert" as const, confidence_score: 90, name: "ALICE WANJIKU KAMAU", dateOfBirth: null },
      { id: 2, document_type: "kcpe_cert" as const, confidence_score: 90, name: "ALICE KAMAU", dateOfBirth: null },
      { id: 3, document_type: "birth_cert" as const, confidence_score: 90, name: "PETER OTIENO", dateOfBirth: null },
    ];
    const r = consistencyCheck(docs);
    expect(r.nameConsistent).toBe(false);
    expect(r.nameOutliers).toEqual([3]);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("extraction: PDF failure classification (round 19)", () => {
  const ENC_PDF = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [] /Count 0>> endobj
3 0 obj <</Filter /Standard /V 1 /R 2 /O (00000000000000000000000000000000) /U (00000000000000000000000000000000) /P -4>> endobj
trailer <</Size 4 /Root 1 0 R /Encrypt 3 0 R>>
%%EOF`;

  it("distinguishes encrypted vs corrupt", async () => {
    expect((await pdfRead(Buffer.from(ENC_PDF))).inspection.status).toBe("encrypted");
    expect((await pdfRead(Buffer.from("this is not a pdf"))).inspection.status).toBe("corrupt");
  });

  it("tells the applicant a password-protected PDF why it failed", async () => {
    const r = await extractAttachment(att(Buffer.from(ENC_PDF), "results.pdf"), { vision: NO_VISION, rasterize: false });
    expect(r.failure_reason).toMatch(/password/i);
    expect(r.confidence).toBe("low");
  });

  it("tells the applicant a corrupt upload why it failed", async () => {
    const r = await extractAttachment(att(Buffer.from("garbage bytes"), "results.pdf"), { vision: NO_VISION, rasterize: false });
    expect(r.failure_reason).toMatch(/damaged|incomplete/i);
  });

  it("enforces the size cap with an applicant-readable reason", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 1);
    const r = await extractAttachment(att(big, "scan.pdf"), { vision: NO_VISION, rasterize: false });
    expect(r.failure_reason).toMatch(/larger than/i);
    expect(r.method).toBe("none");
  });
});

describe("extraction: full-page rasterisation tier (round 19)", () => {
  it("renders an image-only PDF to clean PNGs (streaming)", async () => {
    const pdf = await makeImageOnlyPdf();
    const pages: { width: number; height: number; buffer: Buffer }[] = [];
    const report = await rasterizePdf(pdf, {}, (p) => {
      pages.push(p);
    });
    expect(report.rendered).toBe(1);
    expect(report.skipped).toBe(0);
    expect(pages.length).toBe(1);
    expect(pages[0].width).toBeGreaterThan(500);
    expect(pages[0].buffer.subarray(1, 4).toString()).toBe("PNG");
  });

  it("serves image-only PDFs through rasterise + OCR when embedded-image OCR fails", async () => {
    const pdf = await makeImageOnlyPdf();
    const calls: string[] = [];
    // First OCR call is the embedded XObject — simulate garbage there so the
    // rasterise tier gets its turn; rendered pages then read cleanly.
    const fakeOcr = async (_buf: Buffer, _ext?: "png" | "jpg"): Promise<string | null> => {
      calls.push("ocr");
      if (calls.length === 1) return "## !! garbage %%";
      return "REPUBLIC OF KENYA\nKENYA CERTIFICATE OF SECONDARY EDUCATION\nNAME: JOHN KAMAU\nMEAN GRADE: B (plus)\nENGLISH B\nKISWAHILI B\nMATHEMATICS B\nBIOLOGY B";
    };
    const r = await extractAttachment(att(pdf, "scan.pdf"), { vision: NO_VISION, ocr: fakeOcr });
    expect(r.method).toBe("pdf_raster");
    expect(r.document_type).toBe("academic_cert");
    expect(r.fields.meanGrade).toBe("B+");
    expect(r.confidence_score).toBeGreaterThanOrEqual(75);
  });
});

describe("gemini: cache + budget + circuit breaker (round 19)", () => {
  const shalessAtt = (n: number): Attachment =>
    ({ filename: `d${n}.pdf`, mimeType: "application/pdf", content: Buffer.from(`doc-${n}`) } as Attachment);

  function memStore(): VisionCacheStore & { calls: number; map: Map<string, VisionExtraction> } {
    const map = new Map<string, VisionExtraction>();
    const store = {
      map,
      calls: 0,
      get: (sha: string) => map.get(sha) ?? null,
      set: (sha: string, r: VisionExtraction) => {
        map.set(sha, r);
      },
      callsToday: () => store.calls,
      noteCall: () => {
        store.calls++;
      },
    };
    return store as VisionCacheStore & { calls: number; map: Map<string, VisionExtraction> };
  }

  const READING: VisionExtraction = { document_type: "academic_cert", text: "NAME: X", fields: { name: "X" }, confidence: "high" };

  it("never pays twice for the same bytes", async () => {
    const inner: VisionAdapter = { extractDocument: async () => READING };
    const store = memStore();
    const a = new BudgetedVisionAdapter(inner, store, 100);
    await a.extractDocument(shalessAtt(1));
    await a.extractDocument(shalessAtt(1));
    await a.extractDocument(shalessAtt(2));
    expect(store.calls).toBe(2); // second call for doc-1 hit the cache
  });

  it("refuses to overspend the daily budget", async () => {
    const inner: VisionAdapter = { extractDocument: async () => READING };
    const store = memStore();
    const a = new BudgetedVisionAdapter(inner, store, 2);
    await a.extractDocument(shalessAtt(1));
    await a.extractDocument(shalessAtt(2));
    await expect(a.extractDocument(shalessAtt(3))).rejects.toThrow(VisionUnavailableError);
    try {
      await a.extractDocument(shalessAtt(3));
    } catch (e) {
      expect((e as VisionUnavailableError).kind).toBe("budget");
    }
  });

  it("opens the circuit after repeated failures", async () => {
    const failing: VisionAdapter = {
      extractDocument: async () => {
        throw new VisionUnavailableError("timeout", "timed out");
      },
    };
    const store = memStore();
    const a = new BudgetedVisionAdapter(failing, store, 100, 3);
    for (let i = 1; i <= 3; i++) {
      await expect(a.extractDocument(shalessAtt(i))).rejects.toThrow(VisionUnavailableError);
    }
    expect(a.circuitState().open).toBe(true);
    // Next call fails on the CIRCUIT, not the inner adapter.
    await expect(a.extractDocument(shalessAtt(99))).rejects.toThrow(/circuit/i);
  });

  it("persists cache + daily counter in the repo", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const store = repo.visionCacheStore();
    expect(store.get("abc")).toBeNull();
    store.set("abc", READING);
    expect(store.get("abc")).toMatchObject({ document_type: "academic_cert" });
    expect(store.callsToday()).toBe(0);
    store.noteCall();
    store.noteCall();
    expect(store.callsToday()).toBe(2);
  });
});

describe("dead-letter queue (round 19)", () => {
  it("accumulates attempts, parks at the budget, resets and clears", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);

    let r = repo.recordDeadLetter({ message_id: "m1", subject: "s", from_addr: "a@b.c", error: "boom" });
    expect(r.attempts).toBe(1);
    expect(r.dead).toBe(false);
    for (let i = 0; i < 4; i++) {
      r = repo.recordDeadLetter({ message_id: "m1", subject: "s", from_addr: "a@b.c", error: "boom" });
    }
    expect(r.attempts).toBe(5);
    expect(r.dead).toBe(true);
    expect(repo.isDeadLetter("m1")).toBe(true);
    expect(repo.listDeadLetters().length).toBe(1);

    repo.resetDeadLetter(r.id);
    expect(repo.isDeadLetter("m1")).toBe(false);

    repo.parkDeadLetter({ message_id: "m2", subject: "big", from_addr: "x@y.z", error: "too big" });
    expect(repo.isDeadLetter("m2")).toBe(true);

    repo.clearDeadLetterByMessage("m1");
    expect(repo.listDeadLetters(false).every((d) => d.message_id !== "m1")).toBe(true);
  });
});

// ── Regression block: hostile-review fixes ─────────────────────────────────

describe("regression: cached-null replay must stay null (gemini cache sentinel)", () => {
  it("first read null → replay null → provenance identical", async () => {
    const map = new Map<string, VisionExtraction>();
    let storeCalls = 0;
    const store: VisionCacheStore = {
      get: (sha) => map.get(sha) ?? null,
      set: (sha, r) => {
        map.set(sha, r);
      },
      callsToday: () => storeCalls,
      noteCall: () => {
        storeCalls++;
      },
    };
    let calls = 0;
    const inner: VisionAdapter = {
      async extractDocument() {
        calls++;
        return null; // "the model read this and found nothing"
      },
    };
    const a: Attachment = { filename: "scan.pdf", mimeType: "application/pdf", content: Buffer.from("a") };
    const b = new BudgetedVisionAdapter(inner, store, 5);

    expect(await b.extractDocument(a)).toBeNull();
    expect(calls).toBe(1);
    expect(await b.extractDocument(a)).toBeNull(); // replayed from cache
    expect(calls).toBe(1); // NOT re-invoked
  });

  it("corrupt cache row is a miss, never trusted data", () => {
    const db = openDb(":memory:");
    const repo = new Repo(db);
    seedDefaults(repo);
    db.prepare("INSERT INTO gemini_cache (sha256, result_json) VALUES (?, ?)").run("abc", '{"garbage": true}');
    expect(repo.visionCacheGet("abc")).toBeNull();
    // and the poisoned row was removed
    expect(db.prepare("SELECT COUNT(*) AS n FROM gemini_cache WHERE sha256 = 'abc'").get() as any).toEqual({ n: 0 });
  });
});

describe("regression: crosscheck must not flag format differences as fraud", () => {
  it("initials cover the full name", () => {
    expect(namesConsistent("J P KAMAU", "JOHN PETER KAMAU")).toBe(true);
    expect(namesConsistent("J KAMAU", "JOHN KAMAU")).toBe(true);
    expect(namesConsistent("JOHN KAMAU", "MARY WANJIRU")).toBe(false);
  });

  it("the same date in different formats is NOT a contradiction", () => {
    expect(dobsConsistent("12/03/2004", "2004-03-12")).toBe(true);
    expect(dobsConsistent("12/03/2004", "12 MAR 2004")).toBe(true);
    expect(dobsConsistent("12/03/2004", "March 12, 2004")).toBe(true);
  });

  it("a genuinely different date still IS flagged", () => {
    expect(dobsConsistent("12/03/2004", "2004-03-13")).toBe(false);
    expect(dobsConsistent("05/06/2004", "2004-06-07")).toBe(false);
  });

  it("impossible calendar dates are ignored, not matched", () => {
    // 31/15/2004 has no valid day-first reading, and swapping order is still garbage
    expect(extractFields("DATE OF BIRTH: 31/15/2004").dateOfBirth).toBeUndefined();
    expect(dobsConsistent("31/15/2004", "2004-05-31")).toBe(true); // no overlap → true, no flag
  });
});

describe("regression: ID and DOB capture must validate the value", () => {
  it("short numeric values near an ID label are not captured", () => {
    expect(extractFields("STUDENT ID: 2026").idNumber).toBeUndefined();
    expect(extractFields("ID NO: 12345").idNumber).toBeUndefined();
  });

  it("real IDs still extract", () => {
    expect(extractFields("NATIONAL ID NO. 1234567").idNumber).toBe("1234567");
    expect(extractFields("PASSPORT NO: P1234567A").idNumber).toBe("P1234567A");
  });
});

describe("regression: classifier keywords must be word-bounded", () => {
  it("'a level of detail' in prose is not an A-level certificate", () => {
    expect(
      classifyDocumentType("This memo discusses a level of detail appropriate for the review board.")
    ).not.toBe("academic_cert");
    expect(classifyDocumentType("Please maintain an advanced level of professionalism.")).not.toBe("academic_cert");
  });

  it("genuine A-level / Advanced Level documents still classify", () => {
    expect(classifyDocumentType("CAMBRIDGE INTERNATIONAL A LEVEL RESULTS")).toBe("academic_cert");
    expect(classifyDocumentType("UGANDA ADVANCED LEVEL CERTIFICATE")).toBe("academic_cert");
  });

  it("'transcript' needs a qualifier", () => {
    expect(classifyDocumentType("Here is a transcript of our phone call.")).not.toBe("academic_cert");
    expect(classifyDocumentType("OFFICIAL ACADEMIC TRANSCRIPT")).toBe("academic_cert");
  });
});

describe("regression: case routing is realm-scoped", () => {
  it("openUnassignedCasesForProgramme never crosses the demo boundary", () => {
    const db = openDb(":memory:");
    const repo = new Repo(db);
    seedDefaults(repo);

    const live = repo.getOrCreateApplicant("live@example.com", "t-live");
    const demo = repo.getOrCreateApplicant("demo@example.com", "t-demo");
    for (const a of [live, demo]) {
      repo.updateApplicant(a.id, { programme: "BBIT", lifecycle: "application_received" });
    }
    // Everything seeded so far becomes the demo realm (flag set directly —
    // the product no longer ships a demo-marking helper)
    repo.db.prepare("UPDATE applicants SET demo = 1").run();
    // New applicant created after the mark stays live
    const live2 = repo.getOrCreateApplicant("live2@example.com", "t-live2");
    repo.updateApplicant(live2.id, { programme: "BBIT", lifecycle: "application_received" });

    const forLive = repo.openUnassignedCasesForProgramme("BBIT", 0);
    const forDemo = repo.openUnassignedCasesForProgramme("BBIT", 1);
    expect(forLive.map((r) => r.id)).toEqual([live2.id]);
    expect(forDemo.map((r) => r.id).sort()).toEqual([live.id, demo.id].sort());
  });
});
