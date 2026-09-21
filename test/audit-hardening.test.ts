/**
 * Hostile audit hardening — regression tests for this round's findings
 * (each lands RED first, then GREEN with its fix):
 *
 *  1. HIGH  — GeminiWatcher had no timeout: a hung Gemini call would
 *             live-lock the pipeline silently. It must time out and FAIL
 *             CLOSED (flagged) within a bounded time.
 *  2. HIGH  — processed-emails were claimed at the END of the pipeline:
 *             two concurrent runs of the same email passed the isProcessed
 *             gate and double-processed (double inbound record, double
 *             auto-actions). Claims must be atomic at the START, with
 *             unclaim-on-failure so dead-letter retry still works.
 *  3. MEDIUM — skipped pipeline results carried `applicantId: -1`. A
 *             sentinel one wrong null-check away from an FK crash. The
 *             discriminated union must make a skipped result carry NO id.
 *  4. LOW   — POST /logout had no CSRF: a forged cross-site form could
 *             sign staff out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import { GeminiWatcher } from "../src/watcher";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import type { Attachment, IncomingEmail, WatcherInput } from "../src/types";
import { webLogin } from "./helpers";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
});

afterEach(() => { server?.close(); });

const mkEmail = (id: string, from: string, attachments: Attachment[]): IncomingEmail => ({
  id, threadId: `thread-${from}`, from, subject: "Application documents", body: "Please find attached.",
  receivedAt: "2026-09-18T09:00:00Z", attachments,
});

async function mkAtt(filename: string, docType: string, name: string): Promise<Attachment> {
  return { filename, mimeType: "application/pdf", content: await makeTextPdf(docLines(docType, { name })) };
}

describe("finding 1 — gemini watcher timeout", () => {
  it("a hung model times out and fails closed instead of live-locking the pipeline", { timeout: 5000 }, async () => {
    // A model whose promise NEVER settles: today's watcher awaits it forever.
    const hangingModel = { generateContent: () => new Promise(() => { /* hangs */ }) };
    const watcher = new GeminiWatcher("fake-key", "test-model", hangingModel as never, 50);
    const input: WatcherInput = { applicantEmail: "hang@example.org", subject: "Hello", docs: [] };
    const result = await watcher.watch(input);
    expect(result.flagged).toBe(true); // fail closed
    expect(result.concerns.join(" ")).toMatch(/timed out/i);
  });
});

describe("finding 2 — processed-claim race", () => {
  it("two concurrent runs of the same email process it EXACTLY ONCE", async () => {
    const att = await mkAtt("a.pdf", "academic_cert", "Race Person");
    const email = mkEmail("race-email-1", "race@example.org", [att]);
    const [r1, r2] = await Promise.all([processEmail(email, ctx), processEmail(email, ctx)]);
    const processed = [r1, r2].filter((r) => !r.skipped);
    expect(processed.length).toBe(1);

    const inj = repo.findByEmailAny("race@example.org")!;
    expect(repo.emailsForApplicant(inj.id).filter((e) => e.direction === "in").length).toBe(1);
  });

  it("a mid-pipeline crash releases the claim so the dead-letter retry sees it again", async () => {
    // Sabotage one of the pipeline's documented write points: ANY exception
    // after the claim must release it, or the dead-letter machinery would
    // retry a message the pipeline now invisibly skips as "processed".
    const original = repo.insertEmail.bind(repo);
    void original;
    (repo as unknown as { insertEmail: typeof original }).insertEmail = () => {
      throw new Error("disk exploded mid-pipeline");
    };
    const att = await mkAtt("a.pdf", "academic_cert", "Crash Person");
    const email = mkEmail("crash-email-1", "crash@example.org", [att]);
    await expect(processEmail(email, ctx)).rejects.toThrow("disk exploded mid-pipeline");
    expect(repo.isProcessed("crash-email-1")).toBe(false); // claim released → next poll retries
  });
});

describe("finding 3 — no -1 sentinel", () => {
  it("a skipped result carries NO applicant handle at all", async () => {
    const att = await mkAtt("a.pdf", "academic_cert", "Skip Person");
    const email = mkEmail("skip-email-1", "skip@example.org", [att]);
    const first = await processEmail(email, ctx);
    expect(first.skipped ?? false).toBe(false); // processed; the union says skipped is absent on success
    const second = await processEmail(email, ctx);
    expect(second.skipped).toBe(true);
    expect(second.applicantId).toBeNull(); // not -1, not undefined — no handle to misuse
  });
});

describe("finding 4 — logout CSRF", () => {
  it("a forged logout POST is 403 and the session survives; a real logout works", async () => {
    repo.createStaff("admin", "Audit Admin", hashPassword("admin123"), "admin");
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie, csrf } = await webLogin(base, "admin", "admin123");

    const forged = await fetch(`${base}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(forged.status).toBe(403);
    const stillIn = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    expect(stillIn.status).toBe(200); // forged attempt did NOT sign us out

    const ok = await fetch(`${base}/logout`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(ok.status).toBe(302);
    const after = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    expect(after.status).toBe(302); // genuinely signed out → bounced to login
  });

  it("the nav logout form ships a CSRF token so signing out actually works", async () => {
    repo.createStaff("admin", "Audit Admin", hashPassword("admin123"), "admin");
    const app = createApp({ repo, ctx });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { cookie } = await webLogin(base, "admin", "admin123");
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const logoutForm = home.match(/<form method="post" action="\/logout"[\s\S]*?<\/form>/);
    expect(logoutForm).toBeTruthy();
    expect(logoutForm![0]).toContain('name="_csrf"');
  });
});
