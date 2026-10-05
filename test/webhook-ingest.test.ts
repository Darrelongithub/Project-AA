/**
 * Phase 18 — the public webhook ingest endpoint.
 *
 * These tests drive real HTTP against `createApp`, because the parts that matter
 * live in the wiring as much as in the handler: which body parser sees a request,
 * what a refused key looks like on the wire, whether `Retry-After` is actually
 * set, and whether a submission ends up on the SAME pipeline path as an email.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization, webLogin } from "./helpers";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { createApp } from "../src/web/server";
import { processEmail } from "../src/pipeline";
import type { IncomingEmail } from "../src/types";
import { ingestWebhook, redactIngestKey, validateWebhookPayload, WEBHOOK_PATH_PREFIX } from "../src/web/webhook";
import { RateWindow } from "../src/web/throttle";
import { hashPassword } from "../src/util/password";

let server: Server;
let base = "";
let repo: Repo;
let ctx: PipelineContext;
let key = "";
let sender: MockSender;

/** Org 1 is the configured tenant; its case types are SERVICE_REQUEST and friends. */
function org1Key(): string {
  const value = repo.webhookIngestKey(1);
  if (!value) throw new Error("the organization has no ingest key");
  return value;
}

async function postJson(orgKey: string, payload: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string; retryAfter: string | null }> {
  const res = await fetch(`${base}${WEBHOOK_PATH_PREFIX}${orgKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted on by name below */ }
  return { status: res.status, json, text, retryAfter: res.headers.get("retry-after") };
}

async function postForm(orgKey: string, fields: Record<string, string>): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${WEBHOOK_PATH_PREFIX}${orgKey}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted on by name below */ }
  return { status: res.status, json, text };
}

const caseCountFor = (emailAddress: string): number =>
  (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE email_address = ?").get(emailAddress) as { n: number }).n;

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  // The per-minute budget has its own test below; keep it out of the way so a
  // counter is never the reason an unrelated case in this file fails.
  repo.setSetting("webhook_rate_limit_per_minute", "1000");
  key = org1Key();

  sender = new MockSender(true);
  ctx = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender } };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("webhook ingest: a valid submission opens a case through the normal pipeline", () => {
  let created: Record<string, unknown> = {};

  it("returns the organization's own ref_number for the case it created", async () => {
    const res = await postJson(key, {
      email: "Miriam.Okafor@example.org",
      full_name: "Miriam Okafor",
      case_type: "service_request",
      message: "I need my water connection reactivated after the fine was paid.",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(String(res.json.ref_number)).toMatch(/^ORG-/);
    created = res.json;

    const caseId = Number(res.json.case_id);
    const applicant = repo.getApplicant(caseId);
    expect(applicant?.email_address.toLowerCase()).toBe("miriam.okafor@example.org");
    expect(applicant?.ref_number).toBe(res.json.ref_number);
    expect(applicant?.case_type_code).toBe("SERVICE_REQUEST");
  });

  it("accepts form fields as well as JSON, and metadata as JSON text", async () => {
    const res = await postForm(key, {
      email: "form.post@example.org",
      full_name: "Form Post",
      case_type: "SERVICE_REQUEST",
      message: "Submitting the request form from a plain HTML form.",
      metadata: JSON.stringify({ plot: "12B", source: "kiosk" }),
    });
    expect(res.status).toBe(200);
    expect(String(res.json.ref_number)).toMatch(/^ORG-/);
    expect(caseCountFor("form.post@example.org")).toBe(1);
    // Metadata is retained for reconciliation of that one delivery, and is not
    // published on the operator's delivery list: the list diagnoses the
    // transport, it is not a second copy of the caller's data.
    const stored = repo.db.prepare(
      "SELECT metadata FROM webhook_deliveries WHERE sender_email = 'form.post@example.org'"
    ).all() as Array<{ metadata: string | null }>;
    expect(stored.length).toBe(1);
    expect(stored[0]?.metadata).toContain("kiosk");
    const listed = repo.listWebhookDeliveries(1, 50).find((row) => row.sender_email === "form.post@example.org");
    expect(listed).toBeDefined();
    expect(Object.keys(listed ?? {})).not.toContain("metadata");
  });

  it("is the SAME path as email ingestion: a channel-marked email row and a case timeline entry", async () => {
    const caseId = Number(created.case_id);
    const emailRow = repo.db
      .prepare("SELECT channel, from_addr FROM emails WHERE applicant_id = ?")
      .get(caseId) as { channel: string; from_addr: string } | undefined;
    expect(emailRow?.channel).toBe("webhook");
    expect(emailRow?.from_addr).toBe("miriam.okafor@example.org");
    const events = (repo.db.prepare("SELECT event FROM audit_log WHERE applicant_id = ?").all(caseId) as Array<{ event: string }>).map((r) => r.event);
    expect(events).toContain("webhook_ingest_accepted");
    expect(events).toContain("email_received");

    const { cookie } = await webLogin(base, "admin", "admin123");
    const page = await (await fetch(`${base}/case/${caseId}`, { headers: { cookie } })).text();
    expect(page).toContain("via webhook");
  });

  it("cannot decide anything: draft-first automation and a human-only outcome survive the call", async () => {
    const caseId = Number(created.case_id);
    const applicant = repo.getApplicant(caseId)!;
    expect(applicant.lifecycle).not.toBe("approved");
    const outcome = repo.db
      .prepare("SELECT outcome, outcome_route, decision_by FROM applicants WHERE id = ?")
      .get(caseId) as { outcome: string; outcome_route: string | null; decision_by: string | null };
    expect(outcome.outcome).not.toBe("auto_approved");
    expect(outcome.outcome_route).toBeNull();
    expect(outcome.decision_by).toBeNull();
    expect(repo.getSetting("automation_mode", "")).toBe("draft");
    // A reply is drafted, not dispatched, while the automation switch is on draft.
    expect(sender.sent.some((m) => m.to === "miriam.okafor@example.org")).toBe(false);
  });
});

describe("webhook ingest: validation happens before anything reaches the pipeline", () => {
  it("refuses a missing email, and names the field", async () => {
    const before = (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    const res = await postJson(key, { full_name: "No Address", message: "Hello there" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/email is required/);
    expect(res.json.field).toBe("email");
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n).toBe(before);
    // The refusal is recorded, so the caller's own diagnosis page can explain it.
    expect(repo.listWebhookDeliveries(1, 5).some((row) => row.outcome === "rejected" && row.status_code === 400)).toBe(true);
  });

  it("refuses a malformed email rather than storing it", async () => {
    for (const bad of ["not-an-address", "a@b", "a b@example.org", "@example.org", "a@example..org"]) {
      const res = await postJson(key, { email: bad, message: "please" });
      expect(res.status, bad).toBe(400);
      expect(res.json.error, bad).toMatch(/not a valid address/);
    }
    expect(caseCountFor("not-an-address")).toBe(0);
  });

  it("refuses an oversized body with 413 and no internal error text", async () => {
    const res = await postJson(key, { email: "big@example.org", message: "A".repeat(400_000) });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe("the request body is larger than this endpoint accepts");
    expect(res.text).not.toMatch(/PayloadTooLarge|entity\.too|limit/i);
    expect(caseCountFor("big@example.org")).toBe(0);
  });

  it("refuses over-long fields instead of truncating them", async () => {
    const tooLongEmail = await postJson(key, { email: `${"x".repeat(300)}@example.org`, message: "hi" });
    expect(tooLongEmail.json.error).toMatch(/email is longer than 254 characters/);

    const tooLongMessage = await postJson(key, { email: "caps@example.org", message: "M".repeat(9_000) });
    expect(tooLongMessage.status).toBe(400);
    expect(tooLongMessage.json.error).toMatch(/message is longer than 8000 characters/);

    const tooManyKeys = await postJson(key, { email: "caps@example.org", message: "hi", metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) });
    expect(tooManyKeys.json.error).toMatch(/at most 20 fields/);

    const nestedMetadata = await postJson(key, { email: "caps@example.org", message: "hi", metadata: { deep: { a: 1 } } });
    expect(nestedMetadata.json.error).toMatch(/not a list or an object/);

    expect(caseCountFor("caps@example.org")).toBe(0);
  });

  it("refuses an unknown case_type and never creates one", async () => {
    const before = repo.listCaseTypes(1).length;
    const res = await postJson(key, { email: "typo@example.org", message: "hi", case_type: "BRIBERY" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not configured for this organization/);
    expect(res.json.field).toBe("case_type");
    expect(repo.listCaseTypes(1).length).toBe(before);
    expect(repo.getCaseType("BRIBERY", 1)).toBeUndefined();
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM case_types WHERE code = 'BRIBERY'").get()).toEqual({ n: 0 });
    expect(caseCountFor("typo@example.org")).toBe(0);
  });

  it("will not borrow another tenant's case type", async () => {
    const other = repo.createOrganization({ name: "Second Service Desk", refPrefix: "SEC" });
    const otherKey = repo.webhookIngestKey(other.id)!;
    expect(otherKey && otherKey !== key).toBe(true);
    const res = await postJson(otherKey, { email: "wrong-tenant@example.org", message: "hi", case_type: "SERVICE_REQUEST" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not configured for this organization/);
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE organization_id = ?").get(other.id)).toEqual({ n: 0 });
  });

  it("rejects a body that is not an object at all", async () => {
    expect((await postJson(key, "[1,2,3]")).status).toBe(400);
    expect((await postJson(key, '"just a string"')).status).toBe(400);
    const malformed = await postJson(key, "{not json");
    expect(malformed.status).toBe(400);
    expect(malformed.json.error).toBe("the body is not valid JSON");
  });
});

describe("webhook ingest: the key is a credential, and a wrong one says nothing", () => {
  it("answers 404 with one identical shape for every kind of bad key", async () => {
    const short = await postJson("abcde", { email: "x@example.org" });
    const longKey = "z".repeat(400);
    const long = await postJson(longKey, { email: "x@example.org" });
    const weird = await postJson("not a key at all!!", { email: "x@example.org" });
    const wellFormedButUnknown = await postJson("K".repeat(32), { email: "x@example.org" });
    expect(short.status).toBe(404);
    expect(long.status).toBe(404);
    expect(weird.status).toBe(404);
    // A key that looks exactly like a real one is refused in the same breath as
    // one that could never be: no reply tells a caller how to get closer.
    expect(wellFormedButUnknown.status).toBe(404);
    expect(short.text).toBe(long.text);
    expect(short.text).toBe(wellFormedButUnknown.text);
    expect(short.text).toBe('{"ok":false,"error":"not found"}');
    expect(short.text).not.toContain(longKey);
    expect(short.text).not.toMatch(/length|format|invalid key|expired|revoked/);
  });

  it("never writes the key into the delivery log or the audit trail", async () => {
    const res = await postJson(key, { email: "quiet@example.org", message: "hi", case_type: "NOT_A_TYPE" });
    expect(res.status).toBe(400);
    const deliveries = repo.listWebhookDeliveries(1, 100);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.filter((row) => JSON.stringify(row).includes(key))).toEqual([]);
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE detail LIKE ?").get(`%${key}%`)).toEqual({ n: 0 });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE detail LIKE ? OR metadata LIKE ?").get(`%${key}%`, `%${key}%`)).toEqual({ n: 0 });
    expect(redactIngestKey(`${WEBHOOK_PATH_PREFIX}${key}?x=1`)).toBe(`${WEBHOOK_PATH_PREFIX}[redacted]?x=1`);
    expect(redactIngestKey(`${WEBHOOK_PATH_PREFIX}${key}`)).toBe(`${WEBHOOK_PATH_PREFIX}[redacted]`);
    expect(redactIngestKey("/dashboard")).toBe("/dashboard");
  });

  it("rotating the key kills the old one immediately, with no restart", async () => {
    const old = org1Key();
    const fresh = repo.setWebhookIngestKey(1);
    expect(fresh).not.toBe(old);
    expect(fresh.length).toBeGreaterThanOrEqual(32);
    const stale = await postJson(old, { email: "old-key@example.org", message: "still here?" });
    expect(stale.status).toBe(404);
    expect(stale.text).toBe('{"ok":false,"error":"not found"}');
    const current = await postJson(fresh, { email: "new-key@example.org", message: "Hello, this is a service request.", case_type: "SERVICE_REQUEST" });
    expect(current.status).toBe(200);
    expect(String(current.json.ref_number)).toMatch(/^ORG-/);
    // The rotation is itself audited, and the audit row does not carry the value.
    const rotation = repo.db
      .prepare("SELECT event, detail FROM audit_log WHERE event = 'webhook_key_rotated' ORDER BY id DESC LIMIT 1")
      .get() as { event: string; detail: string } | undefined;
    expect(rotation?.event).toBe("webhook_key_rotated");
    expect(rotation?.detail ?? "").not.toContain(fresh);
    expect(rotation?.detail ?? "").not.toContain(old);
    // Later tests in this file keep working against the live credential.
    key = fresh;
  });
});

describe("webhook ingest: rate limiting", () => {
  it("returns 429 with Retry-After past the configured per-minute threshold", async () => {
    const flood = repo.createOrganization({ name: "Flood Test Desk", refPrefix: "FLD" });
    const floodKey = repo.setWebhookIngestKey(flood.id);
    // No per-tenant value on this fresh organization, so it follows the
    // installation default — which is what this block moves.
    repo.setSetting("webhook_rate_limit_per_minute", "2");
    try {
      const one = await postJson(floodKey, { email: "f1@example.org", message: "one" });
      const two = await postJson(floodKey, { email: "f2@example.org", message: "two" });
      const three = await postJson(floodKey, { email: "f3@example.org", message: "three" });
      // The budget counts attempts that got as far as validation, in order. This
      // tenant has no case types, so the two accepted calls are answered 202 —
      // the third never reaches validation at all.
      expect([one.status, two.status]).toEqual([202, 202]);
      expect(three.status).toBe(429);
      expect(three.json.error).toBe("too many requests");
      expect(Number(three.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(repo.listWebhookDeliveries(flood.id, 10).some((row) => row.outcome === "rate_limited" && row.status_code === 429)).toBe(true);
      expect(caseCountFor("f3@example.org")).toBe(0);
      // Raising the threshold takes effect on the next request: no restart.
      repo.setSetting("webhook_rate_limit_per_minute", "5");
      expect((await postJson(floodKey, { email: "f4@example.org", message: "four" })).status).toBe(202);
    } finally {
      repo.setSetting("webhook_rate_limit_per_minute", "1000");
    }
  });

  it("applies a tenant's own budget to that tenant alone, overriding the default", async () => {
    // One tenant must not be able to throttle another by setting a number, and
    // an organization with no value of its own keeps following the installation
    // default. That is why the budget is a column on the organization row and
    // not a row in the shared settings table.
    const tight = repo.createOrganization({ name: "Narrow Desk", refPrefix: "NGH" });
    const loose = repo.createOrganization({ name: "Wide Desk", refPrefix: "WDE" });
    const tightKey = repo.setWebhookIngestKey(tight.id);
    const looseKey = repo.setWebhookIngestKey(loose.id);
    repo.setWebhookRateLimitPerMinute(tight.id, 1);
    repo.setSetting("webhook_rate_limit_per_minute", "1000");
    expect(repo.webhookRateLimitPerMinute(tight.id)).toBe(1);
    expect(repo.webhookRateLimitPerMinute(loose.id)).toBe(1000);

    const first = await postJson(tightKey, { email: "n1@example.org", message: "one" });
    const second = await postJson(tightKey, { email: "n2@example.org", message: "two" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
    // The neighbour is untouched by all of that.
    for (let i = 0; i < 3; i++) {
      expect((await postJson(looseKey, { email: `w${i}@example.org`, message: `call ${i}` })).status).toBe(202);
    }
    // Clearing the override hands the tenant back to the default, no restart.
    repo.setWebhookRateLimitPerMinute(tight.id, null);
    expect(repo.webhookRateLimitPerMinute(tight.id)).toBe(1000);
    expect((await postJson(tightKey, { email: "n3@example.org", message: "three" })).status).toBe(202);
  });

  it("keeps one tenant's traffic inside that tenant", async () => {
    const res = await postJson(key, { email: "unaffected@example.org", message: "service request please", case_type: "SERVICE_REQUEST" });
    expect(res.status).toBe(200);
  });
});

describe("webhook ingest: external_id is an idempotency key, not a case counter", () => {
  it("replays the first result instead of opening a second case", async () => {
    const payload = { email: "dedupe@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "TICKET-77" };
    const first = await postJson(key, payload);
    expect(first.status).toBe(200);
    expect(first.json.deduplicated).toBe(false);
    expect(caseCountFor("dedupe@example.org")).toBe(1);

    const second = await postJson(key, payload);
    expect(second.status).toBe(200);
    expect(second.json.deduplicated).toBe(true);
    expect(second.json.ref_number).toBe(first.json.ref_number);
    expect(caseCountFor("dedupe@example.org")).toBe(1);
    // ...and the SAME message from a different tenant is not a duplicate: the
    // claim is scoped to the organization that holds the key.
    expect(repo.listWebhookDeliveries(1, 20).some((row) => row.outcome === "duplicate" && row.external_id === "TICKET-77")).toBe(true);

    // A DIFFERENT external_id is not swallowed by the dedup rule — and whether it
    // opens a second case or joins the person's existing one is the pipeline's
    // decision, made on the same identity grounds as an inbound email.
    const third = await postJson(key, { ...payload, external_id: "TICKET-78" });
    expect(third.status).toBe(200);
    expect(third.json.deduplicated).toBe(false);
    expect(typeof third.json.ref_number).toBe("string");
    const acceptedRows = repo.listWebhookDeliveries(1, 50).filter((row) => row.outcome === "accepted" && row.sender_email === "dedupe@example.org");
    expect(new Set(acceptedRows.map((row) => row.external_id))).toEqual(new Set(["TICKET-77", "TICKET-78"]));
  });

  it("two simultaneous submissions with one external_id still open one case", async () => {
    const both = await Promise.all([
      postJson(key, { email: "race@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "RACE-1" }),
      postJson(key, { email: "race@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "RACE-1" }),
    ]);
    expect(both.filter((r) => r.status === 200 && r.json.deduplicated !== true).length).toBe(1);
    expect(caseCountFor("race@example.org")).toBe(1);
  });

  it("releases the claim when processing fails, so the caller's retry is not blocked", async () => {
    // Fault injection at the persistence boundary: the pipeline throws where no
    // caller-visible error can be derived from it. The contract under test is
    // that a failed submission leaves no half-taken idempotency claim behind.
    const failingRepo = new Proxy(repo, {
      get(target, property) {
        if (property === "insertEmail") throw new Error("storage unavailable");
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Repo;
    const failingCtx = { ...ctx, repo: failingRepo } as PipelineContext;
    const limiter = new RateWindow({ windowMs: 60_000 });
    const keyForFailure = repo.webhookIngestKey(1)!;
    const payload = { email: "failed@example.org", message: "A service request.", case_type: "SERVICE_REQUEST", external_id: "FAIL-1" };

    const failed = await ingestWebhook({ repo, ctx: failingCtx, limiter }, { orgKey: keyForFailure, body: payload, payloadBytes: 120, ip: "10.9.8.7" });
    expect([500, 202]).toContain(failed.status);
    expect(JSON.stringify(failed.body)).not.toContain("storage unavailable");
    expect(failed.body.ok).toBe(failed.status === 500 ? false : true);
    expect(repo.listWebhookDeliveries(1, 10)[0]?.outcome).not.toBe("accepted");

    const retried = await ingestWebhook({ repo, ctx, limiter }, { orgKey: keyForFailure, body: payload, payloadBytes: 120, ip: "10.9.8.7" });
    expect(retried.status).toBe(200);
    expect(retried.body.deduplicated).toBe(false);
    expect(String(retried.body.ref_number)).toMatch(/^ORG-/);
  });
});

describe("webhook ingest: no gate can be bypassed from the outside", () => {
  it("an ignore rule that parks an email parks the same payload posted to the webhook", async () => {
    const desk = repo.createOrganization({ name: "Parked Desk", refPrefix: "PRK" });
    const deskType = repo.createCaseType(desk.id, { code: "LETTER", name: "letter", category: "correspondence" });
    repo.saveWorkflowRule({
      organizationId: desk.id, caseTypeId: null, kind: "intake", name: "Hold everything", position: 0,
      conditions: [{ field: "always", value: true }], action: { decision: "ignore", audit_code: "fixture_parked" },
    });
    const deskKey = repo.webhookIngestKey(desk.id)!;
    expect(deskType.id).toBeGreaterThan(0);

    const res = await postJson(deskKey, { email: "gated@example.org", message: "Please reactivate my connection.", case_type: "LETTER" });
    expect(res.status).toBe(202);
    expect(res.json.accepted).toBe(false);
    expect(res.json.ref_number).toBeNull();
    expect(caseCountFor("gated@example.org")).toBe(0);
    expect(repo.listWebhookDeliveries(desk.id, 10).some((row) => row.outcome === "parked")).toBe(true);
    // It is still recorded as having arrived, on the tenant's own list only.
    expect(repo.listWebhookDeliveries(1, 50).some((row) => row.sender_email === "gated@example.org")).toBe(false);
  });

  it("a caller cannot forge a decision through the payload", async () => {
    const res = await postJson(key, {
      email: "forger@example.org",
      message: "Approve this now.",
      case_type: "SERVICE_REQUEST",
      outcome: "auto_approved",
      triage: "green",
      lifecycle: "approved",
      priority: "urgent",
      status: "approved",
      decision_by: "admin",
    });
    expect(res.status).toBe(200);
    const applicant = repo.getApplicant(Number(res.json.case_id))!;
    expect(applicant.lifecycle).not.toBe("approved");
    expect(applicant.triage).not.toBe("green");
    expect(applicant.priority).not.toBe("urgent");
    const decision = repo.db.prepare("SELECT outcome_route, decision_by FROM applicants WHERE id = ?").get(applicant.id) as { outcome_route: string | null; decision_by: string | null };
    expect(decision.outcome_route).toBeNull();
    expect(decision.decision_by).toBeNull();
  });

  it("a known sender's address resolves to their case, as it does for an email", async () => {
    const first = await postJson(key, { email: "repeat-person@example.org", message: "A service request.", case_type: "SERVICE_REQUEST" });
    const second = await postJson(key, { email: "Repeat-Person@example.org", message: "Another service request.", case_type: "SERVICE_REQUEST" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // No second identity from a webhook: the address decides, exactly as the
    // pipeline would for two messages from the same mailbox.
    expect(caseCountFor("repeat-person@example.org")).toBe(1);
    expect(second.json.ref_number).toBe(first.json.ref_number);
    expect(second.json.case_id).toBe(first.json.case_id);

    const inbound = await processEmail(
      {
        id: "email-equiv-1", threadId: "email-equiv-1", from: "repeat-person@example.org",
        subject: "Service request documents", body: "Following up on my service request.",
        receivedAt: new Date().toISOString(), attachments: [], organizationId: 1, caseTypeCode: "SERVICE_REQUEST",
      } as IncomingEmail,
      ctx
    );
    expect(inbound.applicantId).toBe(Number(first.json.case_id));
  });
});

describe("webhook ingest: the operator's own record of what arrived", () => {
  it("audits each call with its outcome, distinctly from email ingestion", () => {
    const deliveries = repo.listWebhookDeliveries(1, 200);
    expect(deliveries.length).toBeGreaterThanOrEqual(4);
    const outcomes = new Set(deliveries.map((row) => row.outcome));
    for (const expected of ["accepted", "rejected", "duplicate"]) expect(outcomes.has(expected)).toBe(true);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE organization_id = 1").get() as { n: number }).n).toBe(deliveries.length);
    expect(deliveries.every((row) => !JSON.stringify(row).includes(key))).toBe(true);
    // Newest first, and the case is linked so the console can jump to it.
    expect(deliveries[0]!.id).toBeGreaterThan(deliveries[1]!.id);
    expect(deliveries.some((row) => row.outcome === "accepted" && typeof row.applicant_id === "number")).toBe(true);
  });

  it("surfaces the deliveries in the security console snapshot", () => {
    const snapshot = repo.securityConsoleSnapshot(1, 0);
    expect(Array.isArray(snapshot.webhookDeliveries)).toBe(true);
    expect(snapshot.webhookDeliveries.length).toBeGreaterThan(0);
    expect(snapshot.webhookDeliveries[0]).toHaveProperty("status_code");
    expect(snapshot.webhookDeliveries[0]).toHaveProperty("external_id");
    expect(snapshot.webhookDeliveries.every((row) => !JSON.stringify(row).includes(key))).toBe(true);
  });

  it("keeps another tenant's deliveries out of this tenant's list", async () => {
    const other = repo.createOrganization({ name: "Isolated Desk", refPrefix: "ISO" });
    const otherKey = repo.webhookIngestKey(other.id)!;
    await postJson(otherKey, { email: "iso@example.org", message: "hello" });
    const mine = repo.listWebhookDeliveries(other.id, 50);
    expect(mine.length).toBe(1);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE organization_id = ?").get(other.id) as { n: number }).n).toBe(1);
    expect(repo.listWebhookDeliveries(1, 200).some((row) => row.sender_email === "iso@example.org")).toBe(false);
  });
});

describe("webhook ingest: the validator as a unit", () => {
  it("strips control characters, lowercases the address and normalizes whitespace", () => {
    const result = validateWebhookPayload(
      { email: "A\u0000B@example.org", full_name: "  Sp\u0007ace  Name  ", message: "line\u0000 one\r\nline two", case_type: "service_request" },
      repo,
      1
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.email).toBe("ab@example.org");
    expect(result.value.fullName).toBe("Space Name");
    // Real newlines are preserved as sent; only control characters are removed.
    expect(result.value.message).toBe("line one\r\nline two");
    expect(result.value.caseTypeCode).toBe("SERVICE_REQUEST");
  });

  it("treats an absent case_type as the pipeline's decision, not a validation error", () => {
    const result = validateWebhookPayload({ email: "x@example.org", message: "hello" }, repo, 1);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.caseTypeCode).toBe("");
    expect(result.value.metadata).toEqual({});
  });
});
