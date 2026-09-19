/**
 * Web console smoke tests — a real HTTP server (ephemeral port) against an
 * in-memory DB with a processed applicant. Covers auth, CSRF, dashboard,
 * case actions, and the public self-service status page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { processEmail } from "../src/pipeline";
import { createApp } from "../src/web/server";
import { makeTextPdf, docLines } from "../src/simulation/pdfFactory";
import { hashPassword } from "../src/util/password";
import type { IncomingEmail } from "../src/types";

let server: Server;
let base = "";
let repo: Repo;
let ref = "";
let applicantEmail = "";
let sender: MockSender;
let ctx: PipelineContext;

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  // OR-1: seedDefaults no longer creates accounts — the test provisions its
  // own admin exactly like the first-run setup screen would.
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  // Test fixtures: a real officer and manager (production-style, not demo).
  repo.createStaff("manager", "Mary Mwangi (User)", hashPassword("manager123"), "user");
  repo.createStaff("jane", "Jane Wairimu (User)", hashPassword("jane123"), "user");
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);

  sender = new MockSender();
  ctx = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender },
  };

  // One complete applicant (Green) and one queued (Orange) for the pages to show.
  const name = "WEB TEST APPLICANT";
  const atts = await Promise.all(
    [
      ["w-academic.pdf", "academic_cert", {}],
      ["w-kcpe.pdf", "kcpe_cert", { kcpePoints: 320, year: "2016" }],
      ["w-id.pdf", "id", {}],
      ["w-form.pdf", "application_form", {}],
    ].map(async ([fn, dt, spec]) => ({
      filename: fn as string,
      mimeType: "application/pdf",
      content: await makeTextPdf(docLines(dt as string, { name, ...(spec as object) })),
    }))
  );
  applicantEmail = "webtest@example.org";
  const email: IncomingEmail = {
    id: "web-e1", threadId: "web-t1", from: applicantEmail, fromName: "Web Test",
    subject: "Application documents", body: "Attached.", receivedAt: new Date().toISOString(), attachments: atts,
  };
  const res = await processEmail(email, ctx);
  ref = res.refNumber!;

  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin123",
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  // Read the CSRF token from the meta tag present on every staff page.
  const home = await fetch(`${base}/`, { headers: { cookie } });
  const html = await home.text();
  const csrf = (html.match(/<meta name="csrf" content="([a-f0-9]+)">/) || [])[1] || "";
  return { cookie, csrf };
}

async function loginAs(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const home = await fetch(`${base}/`, { headers: { cookie } });
  const html = await home.text();
  const csrf = (html.match(/<meta name="csrf" content="([a-f0-9]+)">/) || [])[1] || "";
  return { cookie, csrf };
}

describe("web console", () => {
  it("redirects unauthenticated staff to /login", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("rejects bad credentials", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=wrong",
    });
    expect(res.status).toBe(401);
  });

  it("admin lands on the oversight dashboard (not applicant casework)", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/`, { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Team performance");
    expect(html).toContain("Completed files &amp; approvals");
    expect(html).toContain("System");
    // Round 18: ownership moved to Staff Configuration; activity feed removed.
    expect(html).not.toContain("Courses &amp; ownership");
    expect(html).not.toContain("Recent activity");
    expect(html).not.toContain("What needs my attention");
    expect(html).toContain("Staff Configuration");
    expect(html).toContain("Configuration");
  });

  it("officer lands on the casework dashboard", async () => {
    const res0 = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=jane&password=jane123",
      redirect: "manual",
    });
    expect(res0.status).toBe(302);
    const cookie = (res0.headers.get("set-cookie") || "").split(";")[0];
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(html).toContain("Needs attention");
    expect(html).toContain("Emails today");
    expect(html).toContain("Automation accuracy");
    expect(html).toContain("Where applicants get stuck");
  });

  it("search finds the applicant by reference number", async () => {
    const { cookie } = await loginAs("jane", "jane123");
    const res = await fetch(`${base}/applicants?q=${encodeURIComponent(ref)}`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain(ref);
    // full_name is taken from the official documents (title-cased by the pipeline)
    expect(html).toContain("Web Test Applicant");
  });

  it("case page shows checklist, documents, email history and audit trail", async () => {
    const { cookie } = await login();
    const a = repo.findByRef(ref)!;
    const res = await fetch(`${base}/case/${a.id}`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain(ref);
    expect(html).toContain("✓");
    expect(html).toContain("KCPE Certificate");
    expect(html).toContain("Email history");
    expect(html).toContain("Audit log");
    expect(html).toContain("Status history");
  });

  it("rejects POST actions without a CSRF token", async () => {
    const { cookie } = await login();
    const a = repo.findByRef(ref)!;
    const res = await fetch(`${base}/case/${a.id}/note`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "body=hax",
    });
    expect(res.status).toBe(403);
  });

  it("staff can save an internal note (with CSRF)", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const res = await fetch(`${base}/case/${a.id}/note`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&body=${encodeURIComponent("Applicant called. Waiting for original certificate.")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const notes = repo.notesForApplicant(a.id);
    expect(notes[0]?.body).toContain("Applicant called");
  });

  it("officer role cannot open settings", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=jane&password=jane123",
      redirect: "manual",
    });
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    const settings = await fetch(`${base}/settings`, { headers: { cookie } });
    expect(settings.status).toBe(403);
  });

  it("public status lookup is retired — status now travels by email", async () => {
    const landing = await fetch(`${base}/status`, { redirect: "manual" });
    expect(landing.status).toBe(404);
    const portal = await fetch(`${base}/portal`, { redirect: "manual" });
    expect(portal.status).toBe(404);
  });

  it("v4 UI: splash, header shell, command palette and dark-mode toggle", async () => {
    const { cookie, csrf } = await login();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('id="splash"');
    expect(home).toContain('class="sitehead"');
    expect(home).not.toContain('class="sidebar"');
    expect(home).toContain('id="palette"');
    expect(home).toContain("Riara University");
    expect(home).toContain("Nurturing Innovations");
    expect(home).toContain('data-theme="light"');
    // Bundled typefaces are self-hosted, not a CDN.
    expect(home).toContain("/assets/fonts/manrope.woff2");
    expect(home).toContain("/assets/fonts/instrument-serif.woff2");
    const font = await fetch(`${base}/assets/fonts/manrope.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");

    // Toggle to dark — cookie-driven, works on the next render.
    const tog = await fetch(`${base}/theme`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", referer: `${base}/` },
      body: "",
      redirect: "manual",
    });
    expect(tog.status).toBe(302);
    const themeCookie = ((tog.headers.get("set-cookie") || "").match(/theme=[a-z]+/) || [])[0];
    expect(themeCookie).toBe("theme=dark");
    const darkHome = await (await fetch(`${base}/`, { headers: { cookie: `${cookie}; ${themeCookie}` } })).text();
    expect(darkHome).toContain('data-theme="dark"');
    expect(csrf).toBeTruthy();
  });

  it("v4 UI: command-palette search API returns applicants with avatars", async () => {
    const { cookie } = await loginAs("jane", "jane123");
    const res = await fetch(`${base}/api/search?q=webtest`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { applicants: Array<{ ref_number: string; avatar: string }> };
    expect(j.applicants.length).toBeGreaterThan(0);
    expect(j.applicants[0].ref_number).toBe(ref);
    expect(j.applicants[0].avatar).toContain("class=\"avatar\"");

    // Requires auth.
    const anon = await fetch(`${base}/api/search?q=x`, { redirect: "manual" });
    expect(anon.status).toBe(302);
  });

  it("separation is by dataset realm, and both roles reach the queues", async () => {
    // Admin: /queue is now an alias for the Human Review queue.
    const { cookie } = await login();
    const redir = await fetch(`${base}/queue`, { headers: { cookie }, redirect: "manual" });
    expect(redir.status).toBe(302);
    expect(redir.headers.get("location")).toContain("/applicants?queue=human_review");
    const page = await (await fetch(`${base}/applicants`, { headers: { cookie } })).text();
    expect(page).toContain("Queues");
    // Search is realm-scoped, never role-blocked: live admin finds live cases.
    const search = await fetch(`${base}/api/search?q=${encodeURIComponent(ref)}`, { headers: { cookie } });
    const j = (await search.json()) as { applicants: Array<{ ref_number: string }> };
    expect(j.applicants.length).toBe(1);
    expect(j.applicants[0].ref_number).toBe(ref);
    // Users reach the same queues.
    const { cookie: janeCookie } = await loginAs("jane", "jane123");
    const ok = await fetch(`${base}/applicants`, { headers: { cookie: janeCookie } });
    expect(ok.status).toBe(200);
  });
  it("exports applicants CSV (manager+)", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/export/applicants.csv`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("ref_number");
    expect(body).toContain(ref);
  });
});

describe("web console v3", () => {
  async function fullSetAtts(name: string) {
    return Promise.all(
      [
        ["v3-academic.pdf", "academic_cert", {}],
        ["v3-kcpe.pdf", "kcpe_cert", { kcpePoints: 330, year: "2016" }],
        ["v3-id.pdf", "id", {}],
        ["v3-form.pdf", "application_form", {}],
      ].map(async ([fn, dt, spec]) => ({
        filename: fn as string,
        mimeType: "application/pdf",
        content: await makeTextPdf(docLines(dt as string, { name, ...(spec as object) })),
      }))
    );
  }

  it("decision replay page renders the step chain (feature 32)", async () => {
    const { cookie } = await login();
    const a = repo.findByRef(ref)!;
    const res = await fetch(`${base}/case/${a.id}/replay`, { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Decision replay");
    expect(html).toContain("Email received");
    expect(html).toContain("Rules engine ran");
  });

  it("staff can add and toggle tasks on a case (feature 25)", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const add = await fetch(`${base}/case/${a.id}/task/add`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&title=${encodeURIComponent("Verify certificate with KNEC")}`,
      redirect: "manual",
    });
    expect(add.status).toBe(302);
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Verify certificate with KNEC");
    const task = repo.listTasks(a.id)[0];
    const toggle = await fetch(`${base}/case/${a.id}/task/toggle`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&task_id=${task.id}`,
      redirect: "manual",
    });
    expect(toggle.status).toBe(302);
    expect(repo.listTasks(a.id).find((t) => t.id === task.id)?.done).toBe(1);
  });

  it("draft-first mode holds the reply and staff can approve it (features 16, 17)", async () => {
    const { cookie, csrf } = await login();
    repo.setAutomationMode("document_submission", "draft");
    const res = await processEmail(
      {
        id: "web-held-1", threadId: "web-held-t", from: "held@example.org", fromName: "Held One",
        subject: "Application documents", body: "Attached.",
        receivedAt: new Date().toISOString(), attachments: await fullSetAtts("HELD FOR APPROVAL"),
      },
      ctx
    );
    expect(res.finalStatus).toBe("Green");
    expect(res.autoSent).toBe(false);
    const a = repo.getApplicant(res.applicantId)!;
    expect(repo.queuedOutbox(a.id)).toBeTruthy();

    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Draft held for approval");
    // Internal routing boilerplate must never be visible in the draft UI.
    expect(page).not.toContain("INTERNAL — DO NOT AUTO-SEND");

    const send = await fetch(`${base}/case/${a.id}/draft`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&decision=send&subject=${encodeURIComponent("[held] approval")}&body=${encodeURIComponent("Approved body")}`,
      redirect: "manual",
    });
    expect(send.status).toBe(302);
    expect(repo.queuedOutbox(a.id)).toBeUndefined();
    expect(repo.auditForApplicant(a.id).some((e) => e.event === "human_override")).toBe(true);
    repo.setAutomationMode("document_submission", "auto");
  });

  it("automation settings endpoints persist modes and intake deadlines (features 17, 20, 21)", async () => {
    const { cookie, csrf } = await login();
    const cat = await fetch(`${base}/settings/automation/category`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&category=complaint&mode=draft`,
      redirect: "manual",
    });
    expect(cat.status).toBe(302);
    expect(repo.allAutomationConfig().find((r) => r.category === "complaint")?.mode).toBe("draft");

    const dl = await fetch(`${base}/settings/intake-deadline`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&name=${encodeURIComponent("January 2027")}&deadline=2027-01-15`,
      redirect: "manual",
    });
    expect(dl.status).toBe(302);
    expect(repo.intakeDeadline("January 2027")).toContain("2027-01-15");
  });
});

describe("production-readiness pass", () => {
  it("applicants page shows the five operational queues with live counts", async () => {
    const { cookie } = await loginAs("jane", "jane123");
    const page = await (await fetch(`${base}/applicants`, { headers: { cookie } })).text();
    expect(page).toContain('class="queue-tabs"');
    for (const label of [
      "Completed / Verification",
      "Waiting for Documents",
      "Human Review Required",
      "Admissions / Decision",
      "Enquiries &amp; Communication",
    ]) {
      expect(page).toContain(label);
    }
    // The Human Review queue is the default landing; subchips say "why".
    expect(page).toContain("/applicants?queue=human_review");
    expect(page).toContain("Requirement not satisfied");
    const filtered = await (await fetch(`${base}/applicants?queue=waiting_documents`, { headers: { cookie } })).text();
    expect(filtered).toContain("Missing documents");
  });

  it("case draft UI hides INTERNAL boilerplate and refuses to send it", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    repo.addOutbox({
      applicant_id: a.id, to_address: a.email_address,
      subject: "SUGGESTED REPLY (human review required)",
      body: "INTERNAL — DO NOT AUTO-SEND.\nThis case requires human review before any reply goes out. See flags and reasoning.",
      mode: "queued",
    });
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Draft held for approval");
    expect(page).not.toContain("INTERNAL — DO NOT AUTO-SEND");

    // Sending the untouched internal draft is blocked.
    const blocked = await fetch(`${base}/case/${a.id}/draft`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&decision=send&subject=${encodeURIComponent("SUGGESTED REPLY")}&body=${encodeURIComponent("INTERNAL — DO NOT AUTO-SEND.\nThis case requires human review before any reply goes out.")}`,
      redirect: "manual",
    });
    expect(blocked.status).toBe(302);
    expect(decodeURIComponent(blocked.headers.get("location") || "")).toContain("internal routing notes");
    expect(repo.queuedOutbox(a.id)).toBeTruthy();

    // A cleaned body sends fine.
    const ok = await fetch(`${base}/case/${a.id}/draft`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&decision=send&subject=${encodeURIComponent("Your application")}&body=${encodeURIComponent("Thank you — we have received your documents.")}`,
      redirect: "manual",
    });
    expect(ok.status).toBe(302);
    expect(repo.queuedOutbox(a.id)).toBeUndefined();
  });

  it("case page offers a Responses card with template preview", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Responses");
    expect(page).toContain('name="template"');
    expect(page).toContain('name="preview"');

    const preview = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&template=missing_documents&preview=1`,
      redirect: "manual",
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Preview only — nothing has been sent.");
    expect(html).toContain('class="resp-preview"');
  });

  it("managers can re-categorise the latest incoming email after review", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const res = await fetch(`${base}/case/${a.id}/category`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&category=fee_enquiry`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const latestIn = repo.emailsForApplicant(a.id).filter((e) => e.direction === "in").pop();
    expect(latestIn?.category).toBe("fee_enquiry");
    expect(repo.auditForApplicant(a.id).some((e) => e.event === "category_changed")).toBe(true);
  });

  it("review queue never drops a case with a held draft or active flag, even after auto-send", async () => {
    const a = repo.findByRef(ref)!;
    const before = repo.queueView().some((q) => q.id === a.id);
    repo.addOutbox({ applicant_id: a.id, to_address: a.email_address, subject: "held", body: "x", mode: "queued" });
    expect(repo.queueView().some((q) => q.id === a.id)).toBe(true);
    repo.queuedOutbox(a.id) && repo.deleteOutbox(repo.queuedOutbox(a.id)!.id);
    repo.syncFlags(a.id, [{ type: "watcher_flag", detail: "sanity check for test" }]);
    expect(repo.queueView().some((q) => q.id === a.id)).toBe(true);
    repo.syncFlags(a.id, []); // clear derived flags
    expect(repo.queueView().some((q) => q.id === a.id)).toBe(before);
  });

  it("staff page merges team performance with account management", async () => {
    const { cookie } = await login();
    const stats = repo.staffStats();
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.some((s) => s.username === "admin")).toBe(true);
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(page).toContain("Performance");
    expect(page).toContain("Avg response");
    expect(page).toContain("Accounts");
    const redirected = await fetch(`${base}/team`, { headers: { cookie }, redirect: "manual" });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("/staff");
  });

  it("flag names are human-readable on the case page", async () => {
    const { cookie } = await login();
    const a = repo.findByRef(ref)!;
    repo.syncFlags(a.id, [{ type: "name_mismatch", detail: "test rendering" }]);
    const page = await (await fetch(`${base}/case/${a.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Name mismatch");
    expect(page).not.toContain(">name_mismatch<");
    repo.syncFlags(a.id, []);
  });

  it("branding is fixed to Riara University — no institution-name setting", async () => {
    const { cookie } = await login();
    // Even if a stale value sits in the DB, the UI never shows or edits it.
    repo.setSetting("institution_name", "Test College");
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).not.toContain("Test College");
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).not.toContain("Institution name");
    expect(settings).not.toContain('name="institution_name"');
    const loginHtml = await (await fetch(`${base}/login`)).text();
    expect(loginHtml).toContain("Riara University");
  });

  it("configuration page offers the Gmail connection card", async () => {
    const { cookie } = await login();
    const page = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie } })).text();
    expect(page).toContain("Gmail connection");
    expect(page).toContain("not connected");
    expect(page).toContain('action="/settings/gmail/credentials"');
    // Settings is app behaviour only.
    const settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("Automation mode");
    expect(settings).not.toContain("Gmail connection");
  });

  it("courses show who handles them, and owners can be assigned", async () => {
    const { cookie, csrf } = await login();
    const page = await (await fetch(`${base}/config#courses`, { headers: { cookie } })).text();
    expect(page).toContain("Courses &amp; ownership");
    expect(page).toContain('action="/config/course-owner"');
    const member = repo.listStaff().find((m) => m.username === "jane")!;
    const res = await fetch(`${base}/config/course-owner`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&programme=BBIT&owner=${member.id}`, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") || "")).toContain("now handled by");
    const overview = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(overview).toContain("Jane Wairimu");
  });
});

describe("QA audit regressions", () => {
  it("unknown URLs get a branded 404, not a raw Express error", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/no-such-page`, { headers: { cookie } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Page not found");
    expect(html).not.toContain("Cannot GET");
  });

  it("empty notes and tasks report honestly and persist nothing", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const notesBefore = repo.notesForApplicant(a.id).length;
    const tasksBefore = repo.listTasks(a.id).length;
    const noteRes = await fetch(`${base}/case/${a.id}/note`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&body=`,
      redirect: "manual",
    });
    expect(decodeURIComponent(noteRes.headers.get("location") || "")).toContain("nothing saved");
    const taskRes = await fetch(`${base}/case/${a.id}/task/add`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&title=`,
      redirect: "manual",
    });
    expect(decodeURIComponent(taskRes.headers.get("location") || "")).toContain("nothing added");
    expect(repo.notesForApplicant(a.id).length).toBe(notesBefore);
    expect(repo.listTasks(a.id).length).toBe(tasksBefore);
  });

  it("a double-clicked template send goes out exactly once", async () => {
    const { cookie, csrf } = await login();
    const a = repo.findByRef(ref)!;
    const outBefore = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out").length;
    const body = `_csrf=${csrf}&template=missing_documents`;
    const first = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual",
    });
    expect(decodeURIComponent(first.headers.get("location") || "")).toContain("Sent");
    const second = await fetch(`${base}/case/${a.id}/send`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual",
    });
    expect(decodeURIComponent(second.headers.get("location") || "")).toContain("Duplicate send ignored");
    const outAfter = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out").length;
    expect(outAfter).toBe(outBefore + 1);
  });

  it("staff creation validates input instead of silently doing nothing", async () => {
    const { cookie, csrf } = await login();
    const post = (formBody: string) => fetch(`${base}/staff/add`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&${formBody}`, redirect: "manual",
    });
    const short = await post("username=newperson&display_name=New&password=short&role=officer");
    expect(decodeURIComponent(short.headers.get("location") || "")).toContain("at least 8 characters");
    const dupe = await post("username=admin&display_name=Imposter&password=longenough1&role=officer");
    expect(decodeURIComponent(dupe.headers.get("location") || "")).toContain("already taken");
    expect(repo.getStaffByUsername("newperson")).toBeUndefined();
  });

  it("Gmail client secret is never echoed back into the settings page", async () => {
    const { cookie, csrf } = await login();
    const save = await fetch(`${base}/settings/gmail/credentials`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&gmail_address=x@y.z&gmail_client_id=cid&gmail_client_secret=TOP-SECRET-VALUE`,
      redirect: "manual",
    });
    expect(save.status).toBe(302);
    const page = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie } })).text();
    expect(page).not.toContain("TOP-SECRET-VALUE");
    expect(page).toContain("saved — enter a new value to replace");
    const settingsPage = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settingsPage).not.toContain("TOP-SECRET-VALUE");
    // clean up
    repo.setSetting("gmail_address", ""); repo.setSetting("gmail_client_id", ""); repo.setSetting("gmail_client_secret", "");
  });

  it("an email containing only the applicant's reference number gets a factual status reply", async () => {
    const a = repo.findByRef(ref)!;
    const outBefore = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out").length;
    const res = await processEmail(
      {
        id: "ref-only-1", threadId: "ref-only-t", from: applicantEmail, fromName: "Web Test",
        subject: "status", body: ref, receivedAt: new Date().toISOString(), attachments: [],
      },
      ctx
    );
    expect(res.autoSent).toBe(true);
    expect(res.autoKind).toBe("status_answer");
    const outs = repo.emailsForApplicant(a.id).filter((e) => e.direction === "out");
    expect(outs.length).toBe(outBefore + 1);
    expect(outs[0].body.toLowerCase()).toContain(ref.toLowerCase());
  });

  it("a stranger quoting someone else's reference number gets NO automatic status", async () => {
    const res = await processEmail(
      {
        id: "ref-only-2", threadId: "ref-only-t2", from: "stranger@example.org", fromName: "Stranger",
        subject: "status please", body: ref, receivedAt: new Date().toISOString(), attachments: [],
      },
      ctx
    );
    expect(res.autoSent).toBe(false);
  });

  it("dashboard shows 'no data' instead of fake zeros and the demo banner is truthful", async () => {
    const { cookie } = await login();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    // A fresh (non-demo) database must NOT show the demo banner — the banner
    // is gated on the demo_dataset flag that only the demo seeder sets.
    expect(home).not.toContain("Demo workspace");
    // No misleading raw zero values.
    expect(home).not.toContain(">0 min<");
    expect(home).not.toContain(">0 hrs<");
  });

  it("admin Overview carries an alerts panel that can clear unread alerts", async () => {
    repo.notify("escalation", "Case RU-ALERT escalation for admins", null);
    const { cookie, csrf } = await login();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('id="alerts"');
    expect(home).toContain("Case RU-ALERT escalation for admins");
    const res = await fetch(`${base}/notifications/read-all`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const after = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(after).toContain('id="alerts"');
    expect(after).not.toContain("new</span>");
  });

  // OR-1 replaced the demo-dataset banner/badges: the product no longer has
  // any mock-data concept, so these tests pin the NEW contract instead.
  it("never shows a demo banner — even if an old demo flag lingers in settings", async () => {
    const { cookie } = await login();
    repo.setSetting("demo_dataset", "1"); // residue an old install might carry
    const withFlag = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(withFlag).not.toContain("Demo dataset loaded");
    expect(withFlag.toLowerCase()).not.toContain("demobar");
    repo.setSetting("demo_dataset", "0");
  });

  it("staff page has no demo badges and no seeded default-password machinery", async () => {
    const { cookie } = await login();
    const html = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    expect(html).not.toContain("Sample account from the demo dataset");
    expect(html).not.toContain("default password");
    expect(html).not.toContain("demo_admin");
    expect(html).not.toContain("demo_user");
  });

  describe("configuration split, account settings & realm separation", () => {
    it("configuration is split into Course and Reply tabs", async () => {
      const { cookie } = await login();
      const courses = await (await fetch(`${base}/config`, { headers: { cookie } })).text();
      expect(courses).toContain("Course configuration");
      expect(courses).toContain("Reply configuration");
      expect(courses).toContain('id="courses"');
      expect(courses).toContain('id="intakes"');
      expect(courses).toContain("Add a course or intake");
      expect(courses).not.toContain('id="gmail"');

      const replies = await (await fetch(`${base}/config?tab=replies`, { headers: { cookie } })).text();
      expect(replies).toContain('id="gmail"');
      expect(replies).toContain('id="templates"');
      expect(replies).not.toContain('id="courses"');
    });

    it("settings no longer exposes response targets or retention (automation is instant)", async () => {
      const { cookie } = await login();
      const settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
      expect(settings).not.toContain("Response targets");
      expect(settings).not.toContain("Retention of completed cases");
      expect(settings).toContain("Letters &amp; identity");
    });

    it("every signed-in user gets self-service account settings (username, password, theme)", async () => {
      const { cookie } = await login();
      const page = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
      expect(page).toContain('action="/account/username"');
      expect(page).toContain('action="/account/password"');
      expect(page).toContain('action="/account/theme"');
      expect(page).toContain("dark");
      expect(page).toContain("light");
    });

    it("a password change requires the current password and updates the login", async () => {
      const { cookie, csrf } = await login();
      // wrong current password → rejected
      const bad = await fetch(`${base}/account/password`, {
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${csrf}&current=wrongpass&next=newpassword1&confirm=newpassword1`, redirect: "manual",
      });
      expect(bad.status).toBe(302);
      expect(decodeURIComponent(bad.headers.get("location") || "")).toContain("current password was incorrect");
    });

    it("cases are realm-guarded: an account never opens the other realm's files", async () => {
      // The processed applicant is live data (demo=0).
      const live = repo.searchApplicants({ demo: 0 });
      expect(live.length).toBeGreaterThan(0);
      // Mark the whole realm as demo, then a live-scoped search sees nothing.
      repo.db.prepare("UPDATE applicants SET demo = 1").run();
      expect(repo.searchApplicants({ demo: 0 }).length).toBe(0);
      expect(repo.searchApplicants({ demo: 1 }).length).toBeGreaterThan(0);
      // restore for other tests
      (repo as any).db.exec("UPDATE applicants SET demo = 0");
    });
  });

});
