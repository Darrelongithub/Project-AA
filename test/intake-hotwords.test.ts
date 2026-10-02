/**
 * Intake hotwords — which emails become cases (round 9).
 *
 * The reported defect: EVERY email landing in the inbox became a case — a
 * social-media notification was sitting "under review" next to real work.
 * Now only mail that matches a CONFIGURED intake phrase (the tenant's own
 * case-type names/codes, or an administrator's hotword list), OR a reply to a
 * contact we already know (quoted reference number or known sender), becomes a
 * case. Everything else is parked: the email is kept in the Mail window
 * without a case — visible and labelable — but no case, no queue entry, no
 * auto-reply. Nothing ships pre-configured: a fresh install has an empty
 * hotword list and only the case types its administrator created.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { processEmail } from "../src/pipeline";
import { webLogin, configureTestOrganization } from "./helpers";
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
  configureTestOrganization(repo);
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
function cases(): number {
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
    organizationId: 1,
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
    // No case was born from this mail.
    expect(cases()).toBe(0);
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

  it("creates a case when the SUBJECT carries a configured phrase", async () => {
    const res = await processEmail(
      mail({
        from: "new.contact@example.org",
        fromName: "New Contact",
        subject: "Vendor intake — our services agreement",
        body: "We would like to start working with you, please advise.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(typeof res.applicantId).toBe("number");
    expect(cases()).toBe(1);
  });

  it("creates a case when only the BODY carries a configured phrase", async () => {
    const res = await processEmail(
      mail({
        from: "quiet.contact@example.org",
        subject: "Following up",
        body: "I am writing to follow up on the service request I sent last week.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(typeof res.applicantId).toBe("number");
  });

  it("attaches a reply that QUOTES A KNOWN REFERENCE, even without any configured phrase", async () => {
    const known = repo.createCase({ emailAddress: "real.contact@example.org", threadId: "thread-orig", organizationId: 1, fullName: "Real Contact" });
    const ref = repo.getApplicant(known.id)!.ref_number;
    expect(ref).toMatch(/^[A-Z][A-Z0-9]{0,7}-\d{4}-\d{6}$/);
    const res = await processEmail(
      mail({
        from: "other-box@example.org",
        subject: "The scans",
        body: `Please find the documents you requested. Reference ${ref}.`,
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBe(known.id);
    // No duplicate case was created.
    expect(cases()).toBe(1);
  });

  it("continues a case for mail FROM A KNOWN CONTACT, even without any configured phrase", async () => {
    const known = repo.createCase({ emailAddress: "real.contact@example.org", threadId: "thread-orig", organizationId: 1, fullName: "Real Contact" });
    const res = await processEmail(
      mail({
        from: "real.contact@example.org",
        subject: "Just checking in",
        body: "Just wanted to make sure you got everything.",
      }),
      ctx
    );
    expect(res.skipped).toBeFalsy();
    expect(res.applicantId).toBe(known.id);
    expect(cases()).toBe(1);
  });

  it("ships no bundled vocabulary: a fresh install's hotword list is empty", () => {
    // The signals are the tenant's OWN case types — configured, not shipped.
    expect(repo.getSetting("intake_hotwords", "")).toBe("");
    expect(repo.listCaseTypes(1).map((t) => t.code)).toEqual(
      expect.arrayContaining(["SERVICE_REQUEST", "VENDOR_INTAKE", "ACCESS_REQUEST"])
    );
  });

  it("lets an admin edit the hotword list on the Settings page, and the gate follows it immediately", async () => {
    admin = await webLogin(base, "admin", "admin123");

    const page = await (await fetch(`${base}/settings`, { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain('name="intake_hotwords"');

    const body = new URLSearchParams({
      _csrf: admin.csrf,
      intake_hotwords: "zombieland",
      from_name: "Operations Desk",
    });
    const saved = await fetch(`${base}/settings/general`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    expect(saved.status).toBe(302);
    expect(repo.getSetting("intake_hotwords", "")).toBe("zombieland");

    // A phrase nobody configured is parked…
    const parked = await processEmail(mail({ from: "a@b.example", subject: "Application for something", body: "hello" }), ctx);
    expect(parked.skipped).toBe(true);
    // …and the administrator's own word qualifies immediately.
    const took = await processEmail(mail({ from: "c@d.example", subject: "zombieland rules", body: "hi" }), ctx);
    expect(took.skipped).toBeFalsy();
  });
});
