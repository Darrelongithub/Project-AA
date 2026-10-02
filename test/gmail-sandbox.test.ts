/**
 * The Gmail wire path, exercised for real — against a local sandbox that
 * speaks the Gmail API's HTTP shape.
 *
 * Every other test in this repository hands the pipeline a `MockSender`, which
 * records a send in memory. That is why a suite can be green while no reply
 * ever leaves the building. This file drives the ACTUAL production classes
 * (`GmailClient` → `GmailSender` → the googleapis client) over HTTP and asserts
 * on the bytes Google would receive:
 *   - a plain reply arrives as valid RFC 2822 (headers, body, base64url),
 *   - the organization's From name and Reply-To shape the MIME,
 *   - attachments and the inline banner arrive as multipart with intact bytes,
 *   - a staff-edited subject cannot inject headers, and non-ASCII is encoded,
 *   - a stale thread id is retried as a new message instead of failing,
 *   - a hard API error propagates (the pipeline then queues the draft),
 *   - inbound fetching parses a real MIME message: sender, subject, text body,
 *     attachment bytes, thread id,
 *   - and end-to-end: a configured tenant's automated reply is delivered
 *     through this path by the pipeline itself.
 *
 * The sandbox is local HTTP only — no credentials, no network, no Google.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GmailClient, sanitizeHeaders } from "../src/ingestion/gmailClient";
import { GmailSender } from "../src/ingestion/sender";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { processEmail } from "../src/pipeline";
import { MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { configureTestOrganization, releaseAutomation } from "./helpers";
import type { IncomingEmail } from "../src/types";

type Recorded = { method: string; url: string; body: string };

let server: Server;
let apiUrl = "";
let requests: Recorded[] = [];
/** Per-test overrides: which request should fail, and how. */
let failNextSend: { status: number; reason: string; message: string } | null = null;
let sendCount = 0;

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\nsandbox attachment\n"), Buffer.alloc(600, 0x61)]);
const BANNER = { mime: "image/jpeg", base64: Buffer.from("banner-bytes").toString("base64") };
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const b64urlDecode = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The inbound message the sandbox serves, in Gmail's own JSON shape. */
function fullMessagePayload() {
  return {
    id: "m-1",
    threadId: "thread-1",
    labelIds: ["INBOX"],
    snippet: "We need a freight quote",
    internalDate: "1767225600000",
    sizeEstimate: "4200",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: '"Sam Okonkwo" <sam@example.org>' },
        { name: "To", value: "intake@example.org" },
        { name: "Subject", value: "Quote request for a consignment" },
        { name: "Message-ID", value: "<msg-1@example.org>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Hello,\n\nWe need a freight quote for next week.\nConsignment: machinery.\n"), size: 80 } },
        {
          mimeType: "application/pdf",
          filename: "consignment-note.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="consignment-note.pdf"' }],
          body: { attachmentId: "att-1", size: String(PDF_BYTES.length) },
        },
      ],
    },
  };
}

function respond(url: string, method: string): { status: number; body: unknown } {
  if (method === "POST" && /messages\/send/.test(url)) {
    sendCount += 1;
    if (failNextSend) {
      const failure = failNextSend;
      failNextSend = null;
      return { status: failure.status, body: { error: { code: failure.status, message: failure.message, errors: [{ reason: failure.reason }] } } };
    }
    return { status: 200, body: { id: `sent-${sendCount}`, threadId: "thread-1", labelIds: ["SENT"] } };
  }
  if (/attachments\//.test(url)) return { status: 200, body: { data: b64(PDF_BYTES), size: String(PDF_BYTES.length) } };
  if (/messages\/[^/]+$/.test(url) || /messages\/m-1/.test(url)) {
    if (url.includes("format=metadata")) return { status: 200, body: { id: "m-1", threadId: "thread-1", sizeEstimate: "4200", payload: { headers: fullMessagePayload().payload.headers } } };
    return { status: 200, body: fullMessagePayload() };
  }
  if (/users\/me\/messages/.test(url)) return { status: 200, body: { messages: [{ id: "m-1" }], resultSizeEstimate: 1 } };
  return { status: 404, body: { error: { code: 404, message: `sandbox has no route for ${url}` } } };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      const answer = respond(req.url ?? "", req.method ?? "GET");
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server?.close(); });

beforeEach(() => { requests = []; failNextSend = null; sendCount = 0; });

/** A real client pointed at the sandbox, with a live token so no refresh hop. */
function sandboxClient(): GmailClient {
  return new GmailClient({
    address: "intake@example.org",
    clientId: "sandbox-client-id",
    clientSecret: "sandbox-client-secret",
    refreshToken: "sandbox-refresh-token",
    apiUrl,
    accessToken: "ya29.sandbox-access-token",
    accessTokenExpiry: Date.now() + 3600_000,
  });
}

/** The `raw` field Google would receive, decoded back into an RFC 2822 message. */
function rawOf(requestIndex = requests.length - 1): string {
  const body = requests[requestIndex].body;
  const asJson = (() => { try { return JSON.parse(body) as { raw?: string }; } catch { return null; } })();
  const raw = asJson?.raw ?? /"raw"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (!raw) throw new Error(`no raw message in request body: ${body.slice(0, 200)}`);
  return b64urlDecode(raw).toString("utf8");
}

describe("outbound: the reply Gmail actually receives", () => {
  it("sends a plain reply as valid RFC 2822, in the right thread", async () => {
    await new GmailSender(sandboxClient()).send(
      "sam@example.org", "We received your request", "Hello Sam,\n\nYour request is with our desk.\n", "thread-1"
    );
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toMatch(/users\/me\/messages\/send/);
    const raw = rawOf();
    expect(raw).toContain("To: sam@example.org");
    expect(raw).toContain("Subject: We received your request");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Hello Sam,\n\nYour request is with our desk.");
    expect(requests[0].body).toContain("thread-1"); // threaded, not a new conversation
  });

  it("shapes the MIME with the organization's From name and Reply-To", async () => {
    await new GmailSender(sandboxClient()).send("sam@example.org", "S", "B", "thread-1", {
      fromName: "Nairobi Freight Desk", fromAddress: "intake@example.org", replyTo: "desk@example.org",
    });
    const raw = rawOf();
    expect(raw).toContain('From: "Nairobi Freight Desk" <intake@example.org>');
    expect(raw).toContain("Reply-To: desk@example.org");
  });

  it("carries attachments and the inline banner as multipart, bytes intact", async () => {
    await new GmailSender(sandboxClient()).send("sam@example.org", "Your documents", "Body text.", "thread-1", {
      attachments: [{ filename: "price-list.pdf", mimeType: "application/pdf", content: PDF_BYTES }],
      banner: BANNER,
    });
    const raw = rawOf();
    expect(raw).toContain("Content-Type: multipart/mixed");
    expect(raw).toContain("multipart/related"); // text + inline banner
    expect(raw).toContain("Content-Type: image/jpeg");
    expect(raw).toContain("Content-Type: application/pdf");
    expect(raw).toMatch(/filename="price-list\.pdf"/);
    // Decode each MIME part on its own: headers, blank line, base64 body.
    const parts = raw.split(/\r?\n--/).map((chunk) => {
      const [head, ...rest] = chunk.split("\r\n\r\n");
      return { head, body: rest.join("\r\n\r\n").replace(/\s+/g, "") };
    });
    const partWith = (mime: string) => parts.find((part) => part.head.includes(`Content-Type: ${mime}`));
    // The attachment survives base64 line-wrapping and decoding byte-for-byte.
    expect(Buffer.from(partWith("application/pdf")!.body, "base64").equals(PDF_BYTES)).toBe(true);
    // …and so does the inline banner.
    expect(Buffer.from(partWith("image/jpeg")!.body, "base64").toString("utf8")).toBe("banner-bytes");
    expect(partWith("text/plain")!.head).toContain("Content-Type: text/plain");
  });

  it("a staff-edited subject cannot inject headers, and non-ASCII is encoded", async () => {
    const hostile = "Your reply\r\nBcc: attacker@example.org\r\nX-Injected: yes";
    await new GmailSender(sandboxClient()).send("sam@example.org", hostile, "Body.", "thread-1");
    const raw = rawOf();
    const lines = raw.split("\r\n");
    // The injected text survives only as part of the SUBJECT VALUE on one line —
    // it never becomes a header of its own.
    expect(lines.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(lines.some((line) => /^X-Injected:/i.test(line))).toBe(false);
    const subjectLines = lines.filter((line) => /^Subject:/i.test(line));
    expect(subjectLines.length).toBe(1);
    expect(subjectLines[0]).toBe("Subject: Your reply Bcc: attacker@example.org X-Injected: yes");

    requests = [];
    await new GmailSender(sandboxClient()).send("sam@example.org", "Réponse — votre demande", "Body.", "thread-1");
    const encodedSubject = rawOf().split("\r\n").find((line) => line.startsWith("Subject:"))!;
    expect(encodedSubject).toMatch(/=\?UTF-8\?B\?.*\?=/); // RFC 2047, not raw bytes
    expect(sanitizeHeaders("a@b.c", "plain").subject).toBe("plain");
  });

  it("retries as a new message when the thread no longer exists", async () => {
    failNextSend = { status: 400, reason: "notFound", message: "No thread found for id thread-1" };
    await new GmailSender(sandboxClient()).send("sam@example.org", "S", "B", "thread-1");
    expect(requests.length).toBe(2);
    expect(requests[0].body).toContain("thread-1");
    expect(requests[1].body).not.toContain("thread-1"); // the contact still gets the reply
  });

  it("propagates a hard API failure instead of pretending to send", async () => {
    failNextSend = { status: 500, reason: "backendError", message: "Backend Error" };
    await expect(new GmailSender(sandboxClient()).send("sam@example.org", "S", "B", "thread-1")).rejects.toThrow();
    expect(requests.length).toBe(1); // no blind retry on a non-thread error
  });

  it("declares that it really delivers", () => {
    expect(new GmailSender(sandboxClient()).delivers).toBe(true);
  });
});

describe("inbound: fetching a real message", () => {
  it("lists recent message ids and parses one into an IncomingEmail", async () => {
    const client = sandboxClient();
    const ids = await client.listRecentMessageIds(14, { perPage: 10, maxPages: 2 });
    expect(ids).toEqual(["m-1"]);
    expect(requests[0].url).toMatch(/users\/me\/messages/);
    expect(decodeURIComponent(requests[0].url)).toContain("newer_than:14d");
    expect(decodeURIComponent(requests[0].url)).toContain("-in:spam");

    const email = await client.fetchEmail("m-1");
    expect(email.id).toBe("m-1");
    expect(email.threadId).toBe("thread-1");
    expect(email.from).toBe("sam@example.org");
    expect(email.fromName).toBe("Sam Okonkwo");
    expect(email.subject).toBe("Quote request for a consignment");
    expect(email.body).toContain("We need a freight quote for next week");
    expect(email.receivedAt).toBe(new Date(1767225600000).toISOString());
    expect(email.attachments.map((a) => a.filename)).toEqual(["consignment-note.pdf"]);
    expect(email.attachments[0].content.equals(PDF_BYTES)).toBe(true);
    expect(email.attachments[0].mimeType).toBe("application/pdf");
  });

  it("refuses to download an oversized message", async () => {
    // The metadata response carries the server's own size estimate.
    const big = { status: 200, body: { id: "m-1", threadId: "thread-1", sizeEstimate: String(60 * 1024 * 1024), payload: { headers: [] } } };
    const bigServer = createServer((_req, res) => {
      res.writeHead(big.status, { "content-type": "application/json" });
      res.end(JSON.stringify(big.body));
    });
    await new Promise<void>((resolve) => bigServer.listen(0, "127.0.0.1", () => resolve()));
    try {
      const bigClient = new GmailClient({
        address: "intake@example.org", clientId: "c", clientSecret: "s", refreshToken: "r",
        apiUrl: `http://127.0.0.1:${(bigServer.address() as AddressInfo).port}`,
        accessToken: "ya29.sandbox", accessTokenExpiry: Date.now() + 3600_000,
      });
      await expect(bigClient.fetchEmail("m-1")).rejects.toThrow(/MB/);
    } finally {
      bigServer.close();
    }
  });
});

describe("end to end: a configured tenant's automated reply is delivered", () => {
  it("pipeline → GmailSender → the wire, and the audit says delivered", async () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo); // starter templates included
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    // Open every gate the product requires: global automation, the case type's
    // own default and evidence gate, and a rule that says "send".
    releaseAutomation(repo);
    repo.updateCaseTypeProfile(type.id, { default_reply_action: "auto", evidence_gate: 0 });
    const statusRule = repo.listWorkflowRules(1, { caseTypeId: type.id, kind: "response" })
      .find((r) => r.name === "Prepare a factual status draft")!;
    repo.saveWorkflowRule({
      id: statusRule.id, organizationId: 1, caseTypeId: type.id, kind: "response",
      name: statusRule.name, position: statusRule.position, conditions: statusRule.conditions,
      action: { ...statusRule.action, reply_action: "send" },
    });

    const sender = new GmailSender(sandboxClient());
    const ctx: PipelineContext = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender },
    };
    const result = await processEmail({
      id: "live-1", threadId: "thread-1", from: "sam@example.org", fromName: "Sam Okonkwo",
      subject: "Status of our service request", body: "Please advise on our service request.",
      receivedAt: new Date().toISOString(), organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      attachments: [],
    } as IncomingEmail, ctx);

    expect(result.skipped).toBeFalsy();
    expect(result.autoSent).toBe(true);
    // The message Google would have received:
    expect(requests.filter((r) => /messages\/send/.test(r.url)).length).toBe(1);
    const raw = rawOf();
    expect(raw).toContain("To: sam@example.org");
    expect(raw).toContain("Status of your case");
    expect(raw).toContain("Example Service Cooperative"); // the tenant's own wording
    // …and the case trail records a delivery, not a fiction.
    const audit = repo.auditForApplicant(result.applicantId!).map((a) => a.event);
    expect(audit).toContain("email_sent_auto");
    expect(audit).not.toContain("email_not_delivered");
    expect(repo.emailsForApplicant(result.applicantId!).some((e) => e.direction === "out" && e.auto === 1)).toBe(true);
  });
});
