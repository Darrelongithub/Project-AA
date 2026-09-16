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
  const home = await fetch(`${base}/applicants`, { headers: { cookie } });
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

  it("logs in and renders the Admissions Command Center", async () => {
    const { cookie } = await login();
    const res = await fetch(`${base}/`, { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Needs attention");
    expect(html).toContain("Emails today");
    expect(html).toContain("Automation accuracy");
    expect(html).toContain("Where applicants get stuck");
  });

  it("search finds the applicant by reference number", async () => {
    const { cookie } = await login();
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

  it("public status page verifies ref + email (feature 20, 21)", async () => {
    const landing = await fetch(`${base}/status`);
    expect(landing.status).toBe(200);

    const wrong = await fetch(`${base}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `ref=${ref}&email=wrong@example.org`,
    });
    expect(await wrong.text()).toContain("No application matches");

    const right = await fetch(`${base}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `ref=${ref}&email=${applicantEmail}`,
    });
    const html = await right.text();
    expect(html).toContain(ref);
    expect(html).toContain("document checklist");
    expect(html).toContain("✓");
  });

  it("v4 UI: splash, sidebar shell, command palette and dark-mode toggle", async () => {
    const { cookie, csrf } = await login();
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('id="splash"');
    expect(home).toContain('class="sidebar"');
    expect(home).toContain('id="palette"');
    expect(home).toContain("Riara University");
    expect(home).toContain("Nurturing Innovators");
    expect(home).toContain('data-theme="light"');

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
    const { cookie } = await login();
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

  it("portal: OTP sign-in then upload flows through the pipeline as channel=portal (features 12, 35, 40)", async () => {
    // An incomplete applicant who needs to upload something.
    const res = await processEmail(
      {
        id: "web-portal-1", threadId: "web-portal-t", from: "portaluser@example.org", fromName: "Portal User",
        subject: "Application documents", body: "Attached.",
        receivedAt: new Date().toISOString(),
        attachments: [
          { filename: "p-academic.pdf", mimeType: "application/pdf", content: await makeTextPdf(docLines("academic_cert", { name: "PORTAL USER APPLICANT" })) },
        ],
      },
      ctx
    );
    const a = repo.getApplicant(res.applicantId)!;

    // Wrong email → generic message, no code shown.
    const nomatch = await fetch(`${base}/portal/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `ref=${a.ref_number}&email=intruder@example.org`,
    });
    const nomatchHtml = await nomatch.text();
    expect(nomatchHtml).not.toContain('<div class="otpbox">');

    // Right credentials → demo mode shows the code.
    const start = await fetch(`${base}/portal/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `ref=${a.ref_number}&email=portaluser@example.org`,
    });
    const startHtml = await start.text();
    const code = (startHtml.match(/<div class="otpbox">(\d{6})<\/div>/) || [])[1];
    expect(code).toBeTruthy();

    const verify = await fetch(`${base}/portal/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `ref=${a.ref_number}&code=${code}`,
      redirect: "manual",
    });
    expect(verify.status).toBe(302);
    const psid = (verify.headers.get("set-cookie") || "").split(";")[0];
    expect(psid).toContain("psid=");

    const home = await fetch(`${base}/portal/home`, { headers: { cookie: psid } });
    const homeHtml = await home.text();
    expect(homeHtml).toContain(a.ref_number);
    expect(homeHtml).toContain("Upload a missing document");

    // Upload the missing KCPE certificate via the portal.
    const pdf = await makeTextPdf(docLines("kcpe_cert", { name: "PORTAL USER APPLICANT", kcpePoints: 300, year: "2017" }));
    const up = await fetch(`${base}/portal/upload`, {
      method: "POST",
      headers: { cookie: psid, "content-type": "application/json" },
      body: JSON.stringify({ filename: "my-kcpe.pdf", mimeType: "application/pdf", data: pdf.toString("base64") }),
    });
    expect(await up.json()).toEqual({ ok: true });

    const emails = repo.emailsForApplicant(a.id);
    expect(emails.some((e) => e.channel === "portal" && e.direction === "in")).toBe(true);
    expect(repo.auditForApplicant(a.id).some((e) => e.event === "portal_upload")).toBe(true);
    // The pipeline triaged it: KCPE is now on file.
    expect(repo.listDocuments(a.id).some((d) => d.document_type === "kcpe_cert")).toBe(true);
  });

  it("portal home requires a session", async () => {
    const res = await fetch(`${base}/portal/home`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/portal");
  });
});

describe("production-readiness pass", () => {
  it("applicants page shows symmetrical filter tabs with live counts", async () => {
    const { cookie } = await login();
    const page = await (await fetch(`${base}/applicants`, { headers: { cookie } })).text();
    expect(page).toContain('class="tabs"');
    for (const label of ["All applicants", "Awaiting documents", "Needs human review", "Complete", "Overdue"]) {
      expect(page).toContain(label);
    }
    // Tabs are real links to filtered views and keep working with counts.
    expect(page).toContain("/applicants?filter=human_review");
    const filtered = await (await fetch(`${base}/applicants?filter=human_review`, { headers: { cookie } })).text();
    expect(filtered).toContain('class="tabs"');
    expect(filtered).toContain("filtered");
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

  it("team page shows per-staff listener stats", async () => {
    const { cookie } = await login();
    const stats = repo.staffStats();
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.some((s) => s.username === "admin")).toBe(true);
    const page = await (await fetch(`${base}/team`, { headers: { cookie } })).text();
    expect(page).toContain("Team performance");
    expect(page).toContain("Avg response time");
    expect(page).toContain("Admissions completed");
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

  it("institution name comes from Settings everywhere", async () => {
    const { cookie } = await login();
    repo.setSetting("institution_name", "Test College");
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain("Test College");
    const loginHtml = await (await fetch(`${base}/login`)).text();
    expect(loginHtml).toContain("Test College");
    repo.setSetting("institution_name", "Riara University");
  });

  it("settings page offers the Gmail connection card", async () => {
    const { cookie } = await login();
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Gmail connection");
    expect(page).toContain("not connected");
    expect(page).toContain('action="/settings/gmail/credentials"');
  });
});
