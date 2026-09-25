/**
 * Intake hotwords — which emails become application cases (round 9).
 *
 * The reported defect: EVERY email landing in the inbox became an application
 * case — a Snapchat promo was sitting "under review" next to real applicants.
 * Now only mail that matches a configured intake hotword (in subject or body),
 * OR a reply to an applicant we already know (quoted reference number or known
 * sender), becomes a case. Everything else is parked: the email is kept in the
 * Mail window without an applicant — visible and labelable — but no case, no
 * queue entry, no auto-reply.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { processEmail } from "../src/pipeline";
import { webLogin } from "./helpers";
import type { IncomingEmail } from "../src/types";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let admin: { cookie: string; csrf: string };

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Intake Admin", hashPassword("admin123"), "admin");
  sender = new MockSender();
  ctx = { repo, adapters: { vision: null as never, watcher: null as never, sender } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => {
  server?.close();
});

let n = 0;
function applicants(): number {
  return Number((repo.db.prepare("SELECT COUNT(*) n FROM applicants").get() as { n: number }).n);
}

function mail(partial: Partial<IncomingEmail>): IncomingEmail {
  n += 1;
  return {
    id: `msg-${n}-${Math.random().toString(36).slice(2)}`,
    threadId: `t-${n}-${Math.random().toString(36).slice(2)}`,
    from: "someone@example.org",
    subject: "",
    body: "",
    receivedAt: new Date().toISOString(),
    attachments: [],
    ...partial,
  };
}

describe("intake hotwords — the case gate", () => {
  it("does NOT create a case for a non-intake email from an unknown sender (the Snapchat scenario)", async () => {
    const res = await processEmail(
      mail({
        from: "service@snapchat.com",
        fromName: "Snapchat",
        subject: "Snapchat",
        body: "Someone sent you a Snap. Open the Snapchat app to view it.",
      }),
      ctx
    );
    expect(res.skipped).toBe(true);
    expect(res.applicantId).toBeNull();
    // No applicant was born from this mail.
    expect(applicants()).toBe(0);
    // …but the email itself is kept — in Mail, not lost.
    const rows = repo.db.prepare("SELECT applicant_id, subject FROM emails").all() as Array<{ applicant_id: number | null; subject: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].applicant_id).toBeNull();
    expect(rows[0].subject).toBe("Snapchat");
    // …and nothing was sent back to a stranger.
    expect(sender.sent.length).toBe(0);
    // And the audit trail says exactly what happened.
    expect(repo.recentAudit(20).some((a) => a.event === "email_parked_non_intake")).toBe(true);
  });

  it("still creates a case when the SUBJECT carries a hotword", async () => {
    const res = await processEmail(
      mail({
        from: "new.student@gmail.com",
        fromName: "New Student",
        subject: "Application for BSc Computing",
        body: "I would like to apply for the upcoming intake, please advise.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(typeof res.applicantId).toBe("number");
    expect(applicants()).toBe(1);
  });

  it("still creates a case when only the BODY carries a hotword", async () => {
    const res = await processEmail(
      mail({
        from: "quiet.student@gmail.com",
        subject: "Quick question",
        body: "I am writing to follow up on my application for the diploma programme.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(typeof res.applicantId).toBe("number");
  });

  it("still attaches a reply that QUOTES A KNOWN REFERENCE, even without any hotword", async () => {
    const known = repo.getOrCreateApplicant("real.student@gmail.com", "thread-orig", { fullName: "Real Student" });
    const ref = repo.getApplicant(known.id)!.ref_number;
    expect(ref).toMatch(/^[A-Z]{1,4}-\d{4}-\d{6}$/);
    const res = await processEmail(
      mail({
        from: "other-box@gmail.com",
        subject: "The scans",
        body: `Please find the documents you requested. Reference ${ref}.`,
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBe(known.id);
    // No duplicate applicant was created.
    expect(applicants()).toBe(1);
  });

  it("still continues a case for mail FROM A KNOWN APPLICANT, even without any hotword", async () => {
    const known = repo.getOrCreateApplicant("real.student@gmail.com", "thread-orig", { fullName: "Real Student" });
    const res = await processEmail(
      mail({
        from: "real.student@gmail.com",
        subject: "Just checking in",
        body: "Just wanted to make sure you got everything.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBe(known.id);
    expect(applicants()).toBe(1);
  });

  it("seeds a sensible default hotword list on a fresh install", () => {
    const def = repo.getSetting("intake_hotwords", "");
    expect(def.length).toBeGreaterThan(0);
    expect(def).toMatch(/application/);
  });

  it("lets an admin edit the hotword list on the Settings page, and the gate follows it immediately", async () => {
    admin = await webLogin(base, "admin", "admin123");

    const page = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain('name="intake_hotwords"');
    // Pre-filled with the seeded default — the admin sees what is in force.
    expect(/name="intake_hotwords"[^>]*value="[^"]*application/.test(page)).toBe(true);

    const body = new URLSearchParams({
      _csrf: admin.csrf,
      intake_hotwords: "zombieland",
      ref_prefix: "RU",
      from_name: "Admissions",
    });
    const saved = await fetch(`${base}/settings/general`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(saved.status).toBe(302);
    expect(repo.getSetting("intake_hotwords", "")).toBe("zombieland");

    // "application" is no longer an intake word…
    const parked = await processEmail(mail({ from: "a@b.com", subject: "Application for something", body: "hello" }), ctx);
    expect(parked.skipped).toBe(true);
    // …and the custom word qualifies.
    const took = await processEmail(mail({ from: "c@d.com", subject: "zombieland rules", body: "hi" }), ctx);
    expect(took.skipped).toBeFalsy();
  });
});
