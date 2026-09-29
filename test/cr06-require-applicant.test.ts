/**
 * Phase 11 (CR-06): every `repo.getApplicant(id)!` non-null assertion is gone.
 * Non-route code uses `repo.requireApplicant(id)` (throws typed
 * ApplicantNotFoundError); the two route handlers 404 like their middleware.
 *
 * Site → test map (17 sites):
 * - src/admissions/evaluate.ts ×3 (evaluateAdmission) → "evaluateAdmission…"
 * - src/db/repo/cases.ts (getOrCreateApplicant re-read) → "getOrCreateApplicant…"
 * - src/db/repo/casetypes.ts (reFreezeCaseConfig) → "reFreezeCaseConfig…"
 * - src/pipeline/index.ts (processEmailInner tail) → helper contract only:
 *   needs the row deleted mid-run, untriggerable without hooks; the helper
 *   tests below pin the throw it now delegates to.
 * - src/pipeline/stages/closeout.ts ×3 → runProvisional/ReviewQueue/Lifecycle
 * - src/pipeline/stages/evaluation.ts ×3 → runEnrich/Requirements (×2 in one fn)
 * - src/pipeline/stages/intake.ts (runStoreStage) → helper contract only:
 *   insertEmail's FK fires before the re-read for a bogus id, and the sync
 *   body admits no mid-run deletion hook; delegates to requireApplicant.
 * - src/pipeline/stages/reply.ts → runAdmitSafetyStage
 * - src/web/routes/case.ts ×3 (assign, reevaluate ×2) → HTTP tests: the
 *   /case/:id middleware refuses unknown ids first, so the in-handler 404s
 *   are unreachable-but-safe; these pin the outer refusal holding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { ApplicantNotFoundError } from "../src/db/repo/cases";
import { seedDefaults } from "../src/db/seed";
import { createApp } from "../src/web/server";
import { hashPassword } from "../src/util/password";
import { webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { evaluateAdmission } from "../src/admissions/evaluate";
import { runProvisionalStage, runReviewQueueStage, runLifecycleStage } from "../src/pipeline/stages/closeout";
import { runEnrichStage, runRequirementsStage } from "../src/pipeline/stages/evaluation";
import { runAdmitSafetyStage } from "../src/pipeline/stages/reply";
import type { ApplicantRow } from "../src/types";
import type { RulesOutput } from "../src/rules";

let repo: Repo;
let sender: MockSender;
let ctx: PipelineContext;
let server: Server;
let base = "";
let admin: { cookie: string; csrf: string };
let n = 0;

const BOGUS = 999999;
const bogusRow = { id: BOGUS } as ApplicantRow;

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.createStaff("admin", "Admin", hashPassword("adminpass99"), "admin");
  repo.createStaff("agent", "Agent", hashPassword("agentpass99"), "user");
  sender = new MockSender();
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const l = await webLogin(base, "admin", "adminpass99");
  expect(l.status).toBe(302);
  admin = { cookie: l.cookie, csrf: l.csrf };
});

afterAll(() => {
  server?.close();
});

async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ _csrf: admin.csrf, ...fields });
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
    body: body.toString(),
    redirect: "manual",
  });
}

function mkApplicant(): ApplicantRow {
  n += 1;
  return repo.getOrCreateApplicant(`cr06-${n}@example.org`, `cr06-thread-${n}`);
}

describe("CR-06: requireApplicant", () => {
  it("returns the row when the applicant exists", () => {
    const a = mkApplicant();
    expect(repo.requireApplicant(a.id).id).toBe(a.id);
  });

  it("throws typed ApplicantNotFoundError naming the id when missing", () => {
    try {
      repo.requireApplicant(BOGUS);
      expect.unreachable("expected ApplicantNotFoundError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApplicantNotFoundError);
      expect((e as Error).name).toBe("ApplicantNotFoundError");
      expect((e as Error).message).toContain(String(BOGUS));
      expect((e as ApplicantNotFoundError).applicantId).toBe(BOGUS);
    }
  });

  it("evaluateAdmission on a missing applicant throws (evaluate.ts ×3)", () => {
    expect(() => evaluateAdmission(repo, BOGUS, [])).toThrowError(ApplicantNotFoundError);
  });

  it("getOrCreateApplicant re-reads after backfilling org/case-type (cases.ts)", () => {
    repo.db.prepare("INSERT INTO applicants (ref_number, email_address, thread_id, lifecycle) VALUES (?,?,?,?)")
      .run("CR06-1", "cr06-bare@example.org", "cr06-bare-thread", "new");
    const a = repo.getOrCreateApplicant("cr06-bare@example.org", "cr06-bare-thread");
    expect(a.organization_id).toBeTruthy();
    expect(a.case_type_id).toBeTruthy();
  });

  it("reFreezeCaseConfig on a missing applicant throws (casetypes.ts)", () => {
    expect(() => repo.reFreezeCaseConfig(bogusRow)).toThrowError(ApplicantNotFoundError);
  });

  it("runProvisionalStage with a sent letter but missing applicant throws (closeout)", () => {
    const a = mkApplicant();
    expect(() => runProvisionalStage({
      ctx, applicant: bogusRow, applicantNow: a, genericCaseType: undefined, admissionLetterSent: true,
    })).toThrowError(ApplicantNotFoundError);
  });

  it("runReviewQueueStage for a queued-but-missing applicant throws (closeout)", () => {
    const a = mkApplicant();
    expect(() => runReviewQueueStage({
      ctx, applicant: bogusRow, applicantNow: a, category: "application",
      enquiryOnly: false, humanTriageOnly: false, heldForQualification: false,
      heldForApproval: false, finalStatus: "Green", watcherFlagged: false,
      rulesOut: {} as RulesOutput, replyAction: null, queueForHuman: true,
    })).toThrowError(ApplicantNotFoundError);
  });

  it("runLifecycleStage for a missing applicant throws (closeout)", () => {
    expect(() => runLifecycleStage({
      ctx, applicant: bogusRow, admitNow: false, autoAdmitted: false,
      lifecycleAfter: "awaiting_review", autoKind: null, finalStatus: "Green",
    })).toThrowError(ApplicantNotFoundError);
  });

  it("runEnrichStage for a missing applicant throws (evaluation)", () => {
    expect(() => runEnrichStage({
      ctx, email: {} as never, applicant: bogusRow, activeDocs: [],
    })).toThrowError(ApplicantNotFoundError);
  });

  it("runRequirementsStage for a missing applicant throws (evaluation ×2)", () => {
    expect(() => runRequirementsStage({ ctx, applicant: bogusRow, educationCase: false }))
      .toThrowError(ApplicantNotFoundError);
  });

  it("runAdmitSafetyStage for a missing applicant throws (reply)", () => {
    const a = mkApplicant();
    expect(() => runAdmitSafetyStage({
      ctx, applicant: bogusRow, applicantNow: a, genericCaseType: undefined,
      autoAdmitEligible: true, finalStatus: "Green", watcherFlagged: false,
      activeBlockingFlags: [], humanTriageOnly: false, heldForApproval: false,
      heldForQualification: false, queueForHuman: false,
    })).toThrowError(ApplicantNotFoundError);
  });

  it("POST /case/:id/assign on an unknown case is refused before the handler (case.ts)", async () => {
    const agent = repo.getStaffByUsername("agent")!;
    const res = await postForm(`/case/${BOGUS}/assign`, { staff_id: String(agent.id) });
    expect([403, 404]).toContain(res.status);
  });

  it("POST /case/:id/reevaluate on an unknown case is refused before the handler (case.ts ×2)", async () => {
    const res = await postForm(`/case/${BOGUS}/reevaluate`, {});
    expect([403, 404]).toContain(res.status);
  });
});
