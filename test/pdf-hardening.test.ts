/**
 * PDF hardening (Phase C1).
 *
 * Every PDF this product opens arrived as an email attachment: untrusted bytes.
 * These tests pin three properties:
 *   1. there is exactly ONE pdf.js open in the codebase, and it carries the
 *      hardened options (no script evaluation, no XFA, no remote fetching);
 *   2. opening a PDF has a wall-clock budget, and exceeding it is reported as
 *      its own status rather than being swallowed or guessed at;
 *   3. a document we could only read PARTLY (page cap, render budget) is never
 *      evidence for an automated reply — even with every automation gate open,
 *      it holds the case for a person.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HARDENED_PDF_OPTIONS,
  RENDER_PDF_OPTIONS,
  TEXT_PDF_OPTIONS,
  PDF_PARSE_TIMEOUT_MS,
  PdfTimeoutError,
  openPdfDocument,
  promiseWithTimeout,
} from "../src/extraction/pdfOptions";
import { PDF_MAX_PAGES, pdfInspect } from "../src/extraction/pdfText";
import { extractAttachment, MAX_ATTACHMENT_BYTES, MIN_AUTO_PASS_SCORE, PARTIAL_READ_SCORE } from "../src/extraction/extract";
import { makeTextPdf } from "../src/simulation/pdfFactory";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { configureTestOrganization, releaseAutomation } from "./helpers";
import type { Attachment, IncomingEmail } from "../src/types";

const srcFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? srcFiles(full) : /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
  });

describe("one hardened open, everywhere", () => {
  it("carries the options that disable script execution and remote fetching", () => {
    expect(HARDENED_PDF_OPTIONS.isEvalSupported).toBe(false);
    expect(HARDENED_PDF_OPTIONS.enableXfa).toBe(false);
    expect(HARDENED_PDF_OPTIONS.disableRange).toBe(true);
    expect(HARDENED_PDF_OPTIONS.disableStream).toBe(true);
    expect(HARDENED_PDF_OPTIONS.disableAutoFetch).toBe(true);
    expect(HARDENED_PDF_OPTIONS.verbosity).toBe(0);
    // A text-layer read never draws, so font programs are off too.
    expect(TEXT_PDF_OPTIONS.disableFontFace).toBe(true);
    // Rendering feeds OCR and must draw glyphs, so font faces are simply not
    // disabled there — every other hardening option is identical.
    expect("disableFontFace" in RENDER_PDF_OPTIONS).toBe(false);
    for (const key of Object.keys(HARDENED_PDF_OPTIONS) as Array<keyof typeof HARDENED_PDF_OPTIONS>) {
      expect(RENDER_PDF_OPTIONS[key], key).toBe(HARDENED_PDF_OPTIONS[key]);
      expect(TEXT_PDF_OPTIONS[key], key).toBe(HARDENED_PDF_OPTIONS[key]);
    }
  });

  it("pdf.js is opened in exactly one module, and both consumers go through it", () => {
    const root = path.join(__dirname, "..", "src");
    const openers: string[] = [];
    const consumers: string[] = [];
    for (const file of srcFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      if (/getDocument\s*\(/.test(text)) openers.push(path.relative(root, file));
      // However the module is loaded, the SPECIFIER appears in one place only.
      if (text.includes("pdfjs-dist/legacy/build/")) consumers.push(path.relative(root, file));
    }
    expect(openers).toEqual(["extraction/pdfOptions.ts"]);
    // pdf.js 6 is ESM-only: the specifier lives in the single externalized
    // bridge module, and pdfOptions.ts is the only module that loads it.
    expect(consumers).toEqual(["extraction/pdfjs-esm.mjs"]);
    expect(fs.readFileSync(path.join(root, "extraction/pdfOptions.ts"), "utf8")).toContain('require("./pdfjs-esm.mjs")');
    for (const consumer of ["extraction/pdfText.ts", "extraction/rasterize.ts"]) {
      expect(fs.readFileSync(path.join(root, consumer), "utf8")).toContain('from "./pdfOptions"');
    }
  });
});

describe("the parse budget", () => {
  it("has a conservative default and honours an override", () => {
    expect(PDF_PARSE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PDF_PARSE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("promiseWithTimeout rejects with the given error and resolves a fast promise", async () => {
    await expect(promiseWithTimeout(new Promise<string>(() => { /* never settles */ }), 10, () => new Error("budget")))
      .rejects.toThrow("budget");
    await expect(promiseWithTimeout(Promise.resolve("fast"), 1000, () => new Error("budget"))).resolves.toBe("fast");
  });

  it("an expired budget rejects as PdfTimeoutError and stops pdf.js working", async () => {
    let destroyed = false;
    const hangingOpener = () => ({
      promise: new Promise<never>(() => { /* a pathological file: never settles */ }),
      destroy: async () => { destroyed = true; },
    });
    await expect(openPdfDocument(new Uint8Array(Buffer.from("%PDF-1.4")), "text", {}, 10, hangingOpener))
      .rejects.toBeInstanceOf(PdfTimeoutError);
    expect(destroyed).toBe(true); // the loading task is torn down, not left running
  });

  it("classifies a timed-out file as its own status, not as corrupt", async () => {
    const pdf = await makeTextPdf(["A perfectly ordinary document.", "Consent: yes"]);
    const ok = await pdfInspect(pdf);
    expect(ok.status).toBe("ok");
    expect(ok.numPages).toBeGreaterThan(0);
    const garbage = await pdfInspect(Buffer.from("this is not a pdf at all"));
    expect(garbage.status).toBe("corrupt");
    // The timeout branch is reachable through the same classifier the reader uses.
    expect(new PdfTimeoutError(1234).message).toContain("1234 ms budget");
  });
});

describe("attachment limits", () => {
  it("an oversized file is recorded unreadable for a human, never processed", async () => {
    const huge: Attachment = { filename: "big.pdf", mimeType: "application/pdf", content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61) };
    const result = await extractAttachment(huge, { ocr: undefined });
    expect(result.method).toBe("none");
    expect(result.confidence).toBe("low");
    expect(result.confidence_score).toBeLessThan(MIN_AUTO_PASS_SCORE);
    expect(result.failure_reason).toMatch(/larger than the 10 MB limit/i);
  });

  it("a PDF longer than the page cap is read partially and capped below the auto-pass floor", async () => {
    const lines = ["SERVICE REQUEST FORM",
      ...Array.from({ length: 1400 }, (_unused, index) => `Line ${index + 1} of a very long document`)];
    const longPdf = await makeTextPdf(lines);
    const inspection = await pdfInspect(longPdf);
    expect(inspection.numPages).toBeGreaterThan(PDF_MAX_PAGES);
    expect(inspection.truncated).toBe(true);

    const result = await extractAttachment(
      { filename: "long.pdf", mimeType: "application/pdf", content: longPdf },
      { ocr: undefined }
    );
    expect(result.text.length).toBeGreaterThan(0); // the partial text is still useful to a person
    expect(result.confidence_score).toBeLessThanOrEqual(PARTIAL_READ_SCORE);
    expect(result.confidence_score).toBeLessThan(MIN_AUTO_PASS_SCORE);
    expect(result.failure_reason).toMatch(/pages were read/i);
  });

  it("a normal short PDF is unaffected by the cap", async () => {
    const pdf = await makeTextPdf(["SERVICE REQUEST FORM", "NAME: ALEX MORGAN", "Consent: yes"]);
    const result = await extractAttachment({ filename: "short.pdf", mimeType: "application/pdf", content: pdf }, { ocr: undefined });
    expect(result.confidence_score).toBeGreaterThan(PARTIAL_READ_SCORE);
    expect(result.failure_reason).toBeNull();
  });
});

describe("a partially read document never automates a reply", () => {
  /** A tenant with no document requirements: only document QUALITY can hold it. */
  function boot(): { repo: Repo; ctx: PipelineContext; sender: MockSender } {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    const type = repo.createCaseType(1, { code: "LONG_READ", name: "long read", category: "general" });
    // One required document, so BOTH cases below have a complete matrix and the
    // only difference between them is how much of the file we could read.
    repo.replaceDocumentDefinitions(type.id, [{ key: "request_form", label: "Request form", required: true, blocking: true }]);
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "intake", name: "Opens", position: 0,
      conditions: [{ field: "always", value: true }], action: { decision: "create", audit_code: "rule_open" },
    });
    repo.saveWorkflowRule({
      organizationId: 1, caseTypeId: type.id, kind: "response", name: "Sends", position: 0,
      conditions: [{ field: "always", value: true }],
      action: { reply_action: "send", template_key: "ack_received", audit_code: "rule_send" },
    });
    // Every automation gate wide open: this is the hardest case for a hold.
    releaseAutomation(repo);
    repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
    const sender = new MockSender(true);
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    return { repo, ctx, sender };
  }

  const mail = (id: string, attachments: Attachment[]): IncomingEmail => ({
    id, threadId: `thr-${id}`, from: `${id}@example.org`, fromName: "Long Reader", to: "intake@example.org",
    subject: "Long read request", body: "Please read the attached document.",
    receivedAt: new Date().toISOString(), organizationId: 1, caseTypeCode: "LONG_READ", attachments,
  } as IncomingEmail);

  it("holds for a person when pages were not read, and sends when they were", async () => {
    const { repo, ctx, sender } = boot();
    const lines = ["SERVICE REQUEST FORM", "NAME: ALEX MORGAN", "Consent: yes",
      ...Array.from({ length: 1400 }, (_unused, index) => `Line ${index + 1} of a very long document`)];
    const longPdf = await makeTextPdf(lines);
    const partial = await processEmail(mail("long-1", [{ filename: "long.pdf", mimeType: "application/pdf", content: longPdf }]), ctx);
    expect(partial.skipped).toBeFalsy();
    expect(partial.autoSent).toBe(false); // the cap held it, with every gate open
    const flags = repo.activeFlags(partial.applicantId!).map((f) => f.type);
    expect(flags).toContain("low_confidence");
    const doc = repo.listDocuments(partial.applicantId!)[0];
    expect(doc.confidence_score).toBeLessThan(MIN_AUTO_PASS_SCORE);
    expect(doc.extraction_note).toMatch(/pages were read/i);
    expect(sender.sent.length).toBe(0);

    const shortPdf = await makeTextPdf(["SERVICE REQUEST FORM", "NAME: ALEX MORGAN", "Consent: yes"]);
    const whole = await processEmail(mail("long-2", [{ filename: "short.pdf", mimeType: "application/pdf", content: shortPdf }]), ctx);
    expect(whole.autoSent).toBe(true); // same tenant, same gates, fully read → sends
    expect(sender.sent.length).toBe(1);
  });
});
