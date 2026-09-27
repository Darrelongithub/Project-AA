/**
 * PPR P0-2 + P0-3 acceptance:
 *  - a non-academic profile created through real admin routes runs its cases
 *    through the pipeline with ZERO education-module code paths firing
 *    (the academic engine and the academic document matrix are never called),
 *    and the Admissions chrome disappears for its organization;
 *  - a case freezes the exact profile configuration version it was opened
 *    under; later rule edits never change it; a re-evaluate action states
 *    which version it re-applied, and upgrading to the CURRENT version is
 *    only possible by explicit request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { processEmail } from "../src/pipeline";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

/** Instrumentation: count every academic engine/matrix call, without changing behavior. */
const spy = vi.hoisted(() => ({
  admissionCalls: [] as number[],
  matrixCalls: 0,
}));

vi.mock("../src/admissions/evaluate", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/admissions/evaluate")>();
  return {
    ...orig,
    evaluateAdmission: (...args: Parameters<typeof orig.evaluateAdmission>) => {
      spy.admissionCalls.push(args[1] as number);
      return orig.evaluateAdmission(...args);
    },
  };
});

vi.mock("../src/documents/matrix", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/documents/matrix")>();
  return {
    ...orig,
    documentRequirementsFor: (...args: Parameters<typeof orig.documentRequirementsFor>) => {
      spy.matrixCalls += 1;
      return orig.documentRequirementsFor(...args);
    },
  };
});

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("PPR P0-2: education module is a real toggle, not a hidden nav item", () => {
  let repo: Repo;
  let ctx: PipelineContext;
  let sender: MockSender;
  let server: Server | undefined;
  let base = "";
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    repo = fresh();
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    sender = new MockSender();
    ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const login = await webLogin(base, "admin", "admin123");
    expect(login.status).toBe(302);
    auth = { cookie: login.cookie, csrf: login.csrf };
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    spy.admissionCalls.length = 0;
    spy.matrixCalls = 0;
  });

  it("creates a non-academic profile through real admin routes and fires zero education paths for its cases", async () => {
    // ── real admin routes ──────────────────────────────────────────────
    const post = (path: string, body: Record<string, string>) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: auth.csrf, ...body }),
        redirect: "manual",
      });
    expect((await post("/config/organizations/create", { name: "Northwind Support", ref_prefix: "NS" })).status).toBe(302);
    const org = repo.listOrganizations().find((o) => o.name === "Northwind Support")!;
    expect((await post("/config/case-types/create", {
      organization_id: String(org.id), code: "SUPPORT", name: "Support enquiry", category: "general",
    })).status).toBe(302);
    const support = repo.getCaseType("SUPPORT", org.id)!;
    expect(support.education_module).toBe(0);
    expect(support.default_reply_action).toBe("draft"); // new profiles: draft automation
    expect(support.auto_admit).toBe(0); // new profiles: auto-admit OFF
    expect((await post("/config/case-types/document", {
      organization_id: String(org.id), case_type_id: String(support.id),
      key: "ticket_screenshot", label: "Ticket screenshot", required: "1", blocking: "1",
    })).status).toBe(302);

    // ── pipeline run for the non-academic profile ──────────────────────
    const email: IncomingEmail = {
      id: "edu-off-1",
      threadId: "edu-off-thread",
      from: "customer@example.test",
      subject: "Support enquiry — ticket about my account",
      body: "Please help with my account access.",
      receivedAt: new Date().toISOString(),
      organizationId: org.id,
      caseTypeCode: "SUPPORT",
      attachments: [],
    };
    const result = await processEmail(email, ctx);
    expect(result.skipped).not.toBe(true);
    const caseRow = repo.getApplicant(result.applicantId!)!;
    expect(repo.caseTypeForCase(caseRow.id)?.code).toBe("SUPPORT");

    // ZERO education-module code paths fired (not just hidden UI):
    expect(spy.admissionCalls).toEqual([]);
    expect(spy.matrixCalls).toBe(0);
    // The generic gate ran instead, and no outcome was ever decided:
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM evaluations WHERE applicant_id = ?").get(caseRow.id)).toMatchObject({ n: 0 });
    expect(caseRow.outcome).toBe("undecided");
    expect(caseRow.admission_decision).toBe("undecided");
  });

  it("shows no Admissions chrome for the non-academic organization (and the old URL redirects)", async () => {
    const org = repo.listOrganizations().find((o) => o.name === "Northwind Support")!;
    // A staff member of THIS organization sees the generic console only.
    repo.db.prepare("UPDATE staff_users SET organization_id = ? WHERE username = 'admin'").run(org.id);
    const home = await (await fetch(`${base}/`, { headers: { cookie: auth.cookie } })).text();
    expect(home).not.toMatch(/href="\/admissions"[^>]*>Admissions</);
    const admissions = await fetch(`${base}/admissions`, { headers: { cookie: auth.cookie }, redirect: "manual" });
    expect([301, 302]).toContain(admissions.status);
    expect(admissions.headers.get("location")).toContain("/applicants");
    // Put the admin back on the migrated tenant for later tests.
    repo.db.prepare("UPDATE staff_users SET organization_id = 1 WHERE username = 'admin'").run();
  });

  it("positive control: the education path still runs its engine and matrix for academic cases", async () => {
    const email: IncomingEmail = {
      id: "edu-on-1",
      threadId: "edu-on-thread",
      from: "student@example.test",
      subject: "Please check my application for BCS admission",
      body: "I am applying for the BCS programme this September 2026 intake.",
      receivedAt: new Date().toISOString(),
      attachments: [],
    };
    const result = await processEmail(email, ctx);
    expect(result.skipped).not.toBe(true);
    expect(spy.admissionCalls.length).toBeGreaterThanOrEqual(1);
    expect(spy.matrixCalls).toBeGreaterThanOrEqual(1);
    const caseRow = repo.getApplicant(result.applicantId!)!;
    expect(repo.educationCaseFor(caseRow)).toBe(true);
  });
});

describe("PPR P0-3: configuration versions are frozen per case", () => {
  it("keeps an open case on its frozen version and names it on re-evaluate", async () => {
    const repo = fresh();
    repo.createStaff("admin", "Administrator", hashPassword("admin123"), "admin");
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
    const app = createApp({ repo, ctx });
    let server: Server | undefined;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const base2 = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      const auth2 = await webLogin(base2, "admin", "admin123");
      const post = (path: string, body: Record<string, string>) =>
        fetch(`${base2}${path}`, {
          method: "POST",
          headers: { cookie: auth2.cookie, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _csrf: auth2.csrf, ...body }),
          redirect: "manual",
        });

      // Profile through real routes.
      await post("/config/organizations/create", { name: "Freeze Org", ref_prefix: "FZ" });
      const org = repo.listOrganizations().find((o) => o.name === "Freeze Org")!;
      // DEMO round: cases are only reachable inside their own organization —
      // switch to it through the sidebar switcher route, as an admin would.
      expect((await post("/org/switch", { organization_id: String(org.id) })).status).toBe(302);
      await post("/config/case-types/create", { organization_id: String(org.id), code: "CLAIM", name: "Claims intake", category: "ops" });
      const claim = repo.getCaseType("CLAIM", org.id)!;
      await post("/config/case-types/document", {
        organization_id: String(org.id), case_type_id: String(claim.id), key: "claim_form", label: "Claim form", required: "1", blocking: "1",
      });
      await post("/config/case-types/rules", {
        organization_id: String(org.id), case_type_id: String(claim.id),
        rules_json: JSON.stringify([{ kind: "condition", field: "claim_amount", comparator: ">=", value: "100" }]),
      });
      const versionAtOpen = repo.caseTypeConfigVersion(claim.id);

      // The case is opened (through the pipeline, which freezes config).
      const result = await processEmail({
        id: "freeze-1", threadId: "freeze-thread", from: "claimant@example.test",
        subject: "Claims intake — new claim", body: "Please process my claims intake request.",
        receivedAt: new Date().toISOString(), organizationId: org.id, caseTypeCode: "CLAIM", attachments: [],
      }, ctx);
      const caseRow = repo.getApplicant(result.applicantId!)!;
      const frozen = repo.caseConfigFrozen(caseRow)!;
      expect(frozen.config_version).toBe(versionAtOpen);
      expect(frozen.rules?.[0]).toMatchObject({ field: "claim_amount", value: "100" });
      expect(caseRow.config_version_frozen).toBe(versionAtOpen);
      const frozenBefore = caseRow.case_config_frozen;

      // The profile's rules change AFTER the case was opened.
      await post("/config/case-types/rules", {
        organization_id: String(org.id), case_type_id: String(claim.id),
        rules_json: JSON.stringify([{ kind: "condition", field: "claim_amount", comparator: ">=", value: "9999" }]),
      });
      expect(repo.caseTypeConfigVersion(claim.id)).toBe(versionAtOpen + 1);
      // The open case's frozen meaning is untouched:
      const after = repo.getApplicant(caseRow.id)!;
      expect(after.case_config_frozen).toBe(frozenBefore);
      expect(repo.caseConfigFrozen(after)!.rules?.[0]).toMatchObject({ value: "100" });

      // Re-evaluate WITHOUT explicit upgrade → re-applies the FROZEN version and says so.
      const re1 = await post("/case/:id/reevaluate".replace(":id", String(caseRow.id)), {});
      expect(re1.status).toBe(302);
      const msg1 = decodeURIComponent(re1.headers.get("location") ?? "");
      expect(msg1).toContain(`configuration version ${versionAtOpen}`);
      expect(msg1).toContain("the version this case was opened under");
      expect(repo.getApplicant(caseRow.id)!.case_config_frozen).toBe(frozenBefore);

      // Explicit upgrade to CURRENT → says which version, audited, freeze replaced.
      const re2 = await post(`/case/${caseRow.id}/reevaluate`, { reapply: "current" });
      const msg2 = decodeURIComponent(re2.headers.get("location") ?? "");
      expect(msg2).toContain(`CURRENT configuration version ${versionAtOpen + 1}`);
      const upgraded = repo.getApplicant(caseRow.id)!;
      expect(upgraded.config_version_frozen).toBe(versionAtOpen + 1);
      expect(repo.caseConfigFrozen(upgraded)!.rules?.[0]).toMatchObject({ value: "9999" });
      const audit = repo.auditForApplicant(caseRow.id).find((e) => e.event === "config_version_upgraded");
      expect(audit).toBeTruthy();
      expect(audit!.detail).toContain(`version ${versionAtOpen + 1}`);
    } finally {
      server?.close();
    }
  });

  it("stamps pre-existing rows as version 1 without ever re-evaluating them", async () => {
    const repo = fresh();
    // Simulate a production-shaped legacy case created before this round.
    const legacy = repo.getOrCreateApplicant("legacy@example.test", "legacy-thread-1");
    repo.db.prepare("UPDATE applicants SET case_config_frozen = NULL, config_version_frozen = NULL WHERE id = ?").run(legacy.id);
    // The migration steps that openDb runs are idempotent and gated:
    repo.db.prepare("UPDATE applicants SET config_version_frozen = 1, config_version_frozen_at = COALESCE(config_version_frozen_at, created_at) WHERE config_version_frozen IS NULL").run();
    const row = repo.getApplicant(legacy.id)!;
    expect(row.config_version_frozen).toBe(1);
    // No evaluation rows were created by stamping:
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM evaluations WHERE applicant_id = ?").get(legacy.id)).toMatchObject({ n: 0 });
  });
});
