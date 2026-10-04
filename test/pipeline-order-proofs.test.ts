/**
 * Pipeline-order proofs at the real adapter boundaries.
 *
 * Email classification goes through the authenticated Settings routes, the
 * adapter rebuilt from the saved credential, and the real
 * classifyWithConfiguredCategories implementation. Only Google's HTTP
 * boundary is intercepted; unexpected external network access is blocked.
 *
 * PDF extraction uses real pdf.js and the shipped offline Tesseract model.
 * The Gemini SDK is real; only its outbound HTTP response is simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { GeminiVisionAdapter } from "../src/extraction/gemini";
import { extractAttachment } from "../src/extraction/extract";
import { ocrImage, shutdownOcr } from "../src/extraction/ocr";
import { makeScannedPdf, makeTextPdf } from "../src/simulation/pdfFactory";
import { configureTestOrganization, webLogin } from "./helpers";
import type { IncomingEmail } from "../src/types";

const TEST_GEMINI_KEY = "AIzaSyDUMMY0123456789FakeProofOnly987654321";
const TEST_MODEL = "gemini-3.8-flash";

type GeminiReplyMode = "probe" | "complaint" | "http_failure" | "off_list" | "vision";
interface GeminiHttpCall {
  url: string;
  apiKey: string | null;
  prompt: string;
}

let replyMode: GeminiReplyMode = "probe";
let geminiCalls: GeminiHttpCall[] = [];
let executionOrder: string[] = [];
let ocrResults: Array<string | null> = [];
let originalGeminiEnv: string | undefined;
let originalGeminiModelEnv: string | undefined;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | null = null;
let base = "";
let repo: Repo;
let ctx: PipelineContext;
let admin: { cookie: string; csrf: string; status: number };

function responseWithText(text: string, status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", index: 0 }],
  }), { status, headers: { "content-type": "application/json" } });
}

/** Intercept only the actual Gemini SDK's HTTP request. Local Express login
 *  requests pass through; every other external request is rejected. */
function installGeminiHttpBoundary(): void {
  const networkFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (async (input: any, init?: any) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    if (url.hostname === "generativelanguage.googleapis.com") {
      let body: any = {};
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      } catch {
        body = {};
      }
      const prompt = (body.contents ?? [])
        .flatMap((content: any) => content.parts ?? [])
        .map((part: any) => typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
      const headers = new Headers(init?.headers);
      geminiCalls.push({ url: url.toString(), apiKey: headers.get("x-goog-api-key"), prompt });
      executionOrder.push("gemini:http");

      if (/Reply with the single word OK/i.test(prompt) || replyMode === "probe") {
        return responseWithText("OK");
      }
      if (replyMode === "http_failure") {
        return new Response(JSON.stringify({ error: { code: 503, message: "synthetic Gemini outage", status: "UNAVAILABLE" } }), {
          status: 503, statusText: "Service Unavailable", headers: { "content-type": "application/json" },
        });
      }
      if (replyMode === "off_list") {
        return responseWithText(JSON.stringify({ label: "approve_everything", confidence: 0.99 }));
      }
      if (replyMode === "vision") {
        return responseWithText(JSON.stringify({
          document_type: "request_form",
          text: "SERVICE REQUEST FORM\nNAME: GEMINI READER",
          fields: { name: "GEMINI READER" },
          confidence: "medium",
        }));
      }
      return responseWithText(JSON.stringify({ label: "complaint", confidence: 0.92 }));
    }
    if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      return networkFetch(input, init);
    }
    throw new Error(`Blocked unexpected external network request in proof test: ${url.origin}`);
  }) as typeof fetch);
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: admin.csrf, ...body }).toString(),
    redirect: "manual",
  });
}

async function createAuthenticatedSettingsApp(): Promise<void> {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("proof-admin", "Proof Admin", hashPassword("proof-admin-pass-1"), "admin");
  ctx = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  server = createApp({ repo, ctx }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await webLogin(base, "proof-admin", "proof-admin-pass-1");
  expect(admin.status).toBe(302);
}

async function configureThroughSettings(): Promise<void> {
  for (const [key, label] of [
    ["general_enquiry", "General enquiry"],
    ["complaint", "Complaint"],
    ["other", "Other"],
  ]) {
    const result = await post("/settings/categories/create", { key, label });
    expect(result.status).toBe(302);
  }
  const saved = await post("/settings/gemini", { gemini_api_key: TEST_GEMINI_KEY, gemini_model: TEST_MODEL });
  expect(saved.status).toBe(302);
  expect(decodeURIComponent(saved.headers.get("location") ?? "")).toMatch(/Gemini is live/i);
  expect(repo.getSecret("gemini_api_key")).toBe(TEST_GEMINI_KEY);
  expect(ctx.adapters.categorizer).toBeTypeOf("function");
  expect(geminiCalls).toHaveLength(1); // the Settings key probe, through the SDK HTTP boundary
}

function addComplaintIntakeRule(decision: "create" | "ignore", auditCode: string): void {
  const service = repo.getCaseType("SERVICE_REQUEST", 1)!;
  repo.saveWorkflowRule({
    organizationId: 1,
    caseTypeId: service.id,
    kind: "intake",
    name: `Proof ${auditCode}`,
    position: 0,
    conditions: [{ field: "category", op: "in", values: ["complaint"] }],
    action: { decision, audit_code: auditCode },
  });
}

function testMail(id: string, subject = "Service request about our account"): IncomingEmail {
  return {
    id,
    threadId: `thread-${id}`,
    from: `${id}@example.test`,
    fromName: "Proof Sender",
    subject,
    body: "Please advise on our service request.",
    receivedAt: "2026-10-03T00:00:00.000Z",
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
    attachments: [],
  };
}

function chronologicalCaseAudit(applicantId: number) {
  return repo.auditForApplicant(applicantId).reverse();
}

beforeEach(() => {
  originalGeminiEnv = process.env.GEMINI_API_KEY;
  originalGeminiModelEnv = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  replyMode = "probe";
  geminiCalls = [];
  executionOrder = [];
  ocrResults = [];
  installGeminiHttpBoundary();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await shutdownOcr();
  if (originalGeminiEnv === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiEnv;
  if (originalGeminiModelEnv === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = originalGeminiModelEnv;
});

describe("Gemini-first email categorization through authenticated Settings", () => {
  it("uses the saved real adapter before intake matching; audit records the model result", async () => {
    await createAuthenticatedSettingsApp();
    await configureThroughSettings();
    addComplaintIntakeRule("create", "proof_gemini_complaint_route");
    replyMode = "complaint";

    const result = await processEmail(testMail("proof-category-success"), ctx);
    expect(result.skipped).toBeFalsy();
    expect(result.category).toBe("complaint");
    const categoryCalls = geminiCalls.filter((call) => !/Reply with the single word OK/i.test(call.prompt));
    expect(categoryCalls).toHaveLength(1);
    expect(categoryCalls[0].apiKey).toBe(TEST_GEMINI_KEY);
    expect(categoryCalls[0].url).toContain("/models/gemini-3.8-flash:generateContent");
    expect(categoryCalls[0].prompt).toContain('["general_enquiry","complaint","other"]');

    const audit = chronologicalCaseAudit(result.applicantId!);
    const classifierAt = audit.findIndex((row) => row.event === "email_classifier_gemini" && row.detail.includes("message_id=proof-category-success"));
    const ruleAt = audit.findIndex((row) => row.event === "proof_gemini_complaint_route");
    expect(classifierAt).toBeGreaterThanOrEqual(0);
    expect(audit[classifierAt].detail).toContain("outcome=returned; label=complaint; confidence=0.92");
    expect(ruleAt).toBeGreaterThan(classifierAt); // rule selected using Gemini's complaint label
    expect(audit.some((row) => row.event === "email_classifier_fallback" && row.detail.includes("message_id=proof-category-success"))).toBe(false);
    expect(audit.find((row) => row.event === "email_labelled")!.detail).toContain("source=gemini");
  });

  it.each([
    ["http_failure", "outcome=failed", "label=general_enquiry"],
    ["off_list", "outcome=rejected; label=approve_everything; confidence=0.99", "label=general_enquiry"],
  ] as const)("runs the regex fallback only after Gemini %s", async (mode, geminiAudit, fallbackAudit) => {
    await createAuthenticatedSettingsApp();
    await configureThroughSettings();
    addComplaintIntakeRule("create", "proof_gemini_complaint_route");
    replyMode = mode;

    const messageId = `proof-category-${mode}`;
    const result = await processEmail(testMail(messageId), ctx);
    expect(result.skipped).toBeFalsy();
    expect(result.category).toBe("general_enquiry");
    const audit = chronologicalCaseAudit(result.applicantId!);
    const geminiAt = audit.findIndex((row) => row.event === "email_classifier_gemini" && row.detail.includes(`message_id=${messageId}`));
    const fallbackAt = audit.findIndex((row) => row.event === "email_classifier_fallback" && row.detail.includes(`message_id=${messageId}`));
    const routeAt = audit.findIndex((row) => row.event === "proof_gemini_complaint_route");
    expect(geminiAt).toBeGreaterThanOrEqual(0);
    expect(audit[geminiAt].detail).toContain(geminiAudit);
    expect(fallbackAt).toBeGreaterThan(geminiAt);
    expect(audit[fallbackAt].detail).toContain(fallbackAudit);
    expect(routeAt).toBe(-1); // fallback category did not match the complaint rule
  });

  it("classifies before an intake rule is allowed to park the message", async () => {
    await createAuthenticatedSettingsApp();
    await configureThroughSettings();
    addComplaintIntakeRule("ignore", "proof_gemini_complaint_park");
    replyMode = "complaint";

    const messageId = "proof-classify-before-park";
    const result = await processEmail(testMail(messageId, "Park only after Gemini classifies me"), ctx);
    expect(result.skipped).toBe(true);
    const audit = repo.recentAudit(100).reverse();
    const geminiAt = audit.findIndex((row) => row.event === "email_classifier_gemini" && row.detail.includes(`message_id=${messageId}`));
    const parkAt = audit.findIndex((row) => row.event === "proof_gemini_complaint_park");
    expect(geminiCalls.filter((call) => !/Reply with the single word OK/i.test(call.prompt))).toHaveLength(1);
    expect(geminiAt).toBeGreaterThanOrEqual(0);
    expect(audit[geminiAt].detail).toContain("outcome=returned; label=complaint");
    expect(parkAt).toBeGreaterThan(geminiAt);
  });
});

describe("PDF text, real offline OCR, then Gemini HTTP fallback", () => {
  const localVision = () => new GeminiVisionAdapter(TEST_GEMINI_KEY, TEST_MODEL);
  const trackedRealOcr = async (image: Buffer, ext?: "png" | "jpg"): Promise<string | null> => {
    executionOrder.push("ocr:start");
    const text = await ocrImage(image, ext);
    ocrResults.push(text);
    executionOrder.push("ocr:complete");
    return text;
  };

  it("accepts good embedded PDF text without invoking OCR or Gemini", async () => {
    replyMode = "vision";
    const pdf = await makeTextPdf(["SERVICE REQUEST FORM", "NAME: ALICE EXAMPLE", "CONSENT: YES"]);
    const result = await extractAttachment(
      { filename: "digital.pdf", mimeType: "application/pdf", content: pdf },
      { vision: localVision(), ocr: trackedRealOcr }
    );
    expect(result.method).toBe("pdf_text");
    expect(result.text).toContain("ALICE EXAMPLE");
    expect(executionOrder).toEqual([]);
    expect(ocrResults).toEqual([]);
    expect(geminiCalls).toEqual([]);
  });

  it("reads a scanned, image-only PDF with the actual local Tesseract OCR before Gemini", async () => {
    replyMode = "vision";
    const pdf = await makeScannedPdf(["SERVICE REQUEST FORM", "NAME: ALICE EXAMPLE", "CONSENT: YES"]);
    const result = await extractAttachment(
      { filename: "scanned.pdf", mimeType: "application/pdf", content: pdf },
      { vision: localVision(), ocr: trackedRealOcr }
    );
    expect(result.method).toBe("ocr");
    expect(result.text).toContain("SERVICE REQUEST FORM");
    expect(result.text).toContain("ALICE EXAMPLE");
    expect(executionOrder).toContain("ocr:start");
    expect(executionOrder.at(-1)).toBe("ocr:complete");
    expect(ocrResults.some((text) => text?.includes("ALICE EXAMPLE"))).toBe(true);
    expect(geminiCalls).toEqual([]); // good OCR ends the chain before Gemini
  });

  it("runs real OCR on an unreadable scan, then makes the Gemini SDK HTTP call last", async () => {
    replyMode = "vision";
    const pdf = await makeScannedPdf([]); // blank scanned page: real Tesseract returns no usable text
    const result = await extractAttachment(
      { filename: "unreadable-scan.pdf", mimeType: "application/pdf", content: pdf },
      { vision: localVision(), ocr: trackedRealOcr }
    );
    expect(executionOrder.filter((event) => event === "ocr:start").length).toBeGreaterThan(0);
    expect(executionOrder.filter((event) => event === "ocr:complete").length).toBeGreaterThan(0);
    expect(ocrResults.every((text) => !text?.trim())).toBe(true); // actual local OCR found no usable text
    expect(geminiCalls).toHaveLength(1);
    const geminiAt = executionOrder.indexOf("gemini:http");
    const lastOcrAt = executionOrder.lastIndexOf("ocr:complete");
    expect(geminiAt).toBeGreaterThan(lastOcrAt);
    expect(result.method).toBe("gemini_vision");
    expect(result.text).toContain("GEMINI READER");
    expect(geminiCalls[0].apiKey).toBe(TEST_GEMINI_KEY);
    expect(geminiCalls[0].prompt).toContain("Transcribe the visible text faithfully");
  });
});
