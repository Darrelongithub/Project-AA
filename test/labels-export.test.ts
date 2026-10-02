/**
 * Phase D1 (Q6) — the labelling export: `GET /export/labels.csv`.
 *
 * This is the most sensitive file the console can produce (real subjects and
 * bodies), so the tests are about containment as much as content: admin-only,
 * one organization's mail only, capped, escaped against CSV formula injection,
 * audited, marked as personal data, and readable by the evaluation harness with
 * `true_category` deliberately blank so nobody labels from the machine's answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import { rowsFromCsv as parseLabelled } from "../scripts/eval-classifier";

/** The export is unlabelled by design, so the harness reads it in that mode. */
const rowsFromCsv = (text: string) => parseLabelled(text, { requireLabels: false });
import { configureTestOrganization, webLogin } from "./helpers";

let repo: Repo;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let org2Id = 0;

// Starts with a formula character (the injection case), and carries quotes,
// commas and newlines (the CSV structure case).
const HOSTILE_BODY = '=HYPERLINK("http://evil.example")\nPlease find attached.\n"quoted", comma and a\nnew line';
const PLAIN_BODY = "We need a quote for a consignment next week.";

function insertInbound(organizationId: number, messageId: string, subject: string, body: string, applicantId: number | null = null): void {
  repo.insertEmail({
    applicant_id: applicantId, organization_id: organizationId, message_id: messageId, thread_id: `thr-${messageId}`,
    direction: "in", from_addr: `sender-${messageId}@example.org`, to_addr: "intake@example.org",
    subject, body, category: "general_enquiry", auto: 0, at: new Date().toISOString(), attachments: [],
  });
}

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo); // organization 1
  org2Id = repo.createOrganization({ name: "Hillcrest Cooperative", refPrefix: "HLC" }).id;
  repo.createStaff("admin", "Org One Admin", hashPassword("admin123"), "admin", false, 1);
  repo.createStaff("officer", "Olive Officer", hashPassword("officer-pass-1"), "user", false, 1);
  repo.createStaff("admin2", "Hillcrest Admin", hashPassword("admin2pass99"), "admin", false, org2Id);

  const a = repo.createCase({ emailAddress: "contact@example.org", threadId: "t-1", organizationId: 1, fullName: "Alex Morgan", caseTypeCode: "SERVICE_REQUEST" });
  insertInbound(1, "org1-case-mail", "Service request documents", PLAIN_BODY, a.id);
  insertInbound(1, "org1-parked-mail", "Weekly newsletter", "Nothing to see here.", null); // parked mail counts
  insertInbound(1, "org1-hostile", "Quotation", HOSTILE_BODY, a.id);
  insertInbound(org2Id, "org2-canary", "HILLCREST-ONLY-CANARY", "This row belongs to the other tenant.", null);

  const ctx: PipelineContext = { repo, adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() } };
  server = createApp({ repo, ctx }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => { server?.close(); });

async function get(path: string, user: { username: string; password: string }): Promise<{ status: number; text: string; headers: Headers }> {
  const { cookie } = await webLogin(base, user.username, user.password);
  const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const ADMIN = { username: "admin", password: "admin123" };
const ADMIN2 = { username: "admin2", password: "admin2pass99" };

describe("GET /export/labels.csv", () => {
  it("is admin-only: an officer gets no CSV at all", async () => {
    const res = await get("/export/labels.csv", { username: "officer", password: "officer-pass-1" });
    expect([302, 403]).toContain(res.status);
    expect(res.text).not.toContain("id,subject,body,true_category");
    expect(res.text).not.toContain(PLAIN_BODY);
  });

  it("exports only the acting administrator's own organization", async () => {
    const mine = await get("/export/labels.csv", ADMIN);
    expect(mine.status).toBe(200);
    const rows = rowsFromCsv(mine.text);
    expect(rows.map((r) => r.id).sort()).toEqual(["org1-case-mail", "org1-hostile", "org1-parked-mail"]);
    expect(mine.text).not.toContain("HILLCREST-ONLY-CANARY");
    expect(mine.text).not.toContain("This row belongs to the other tenant.");

    // The other tenant sees its own row and nothing of ours.
    const theirs = await get("/export/labels.csv", ADMIN2);
    expect(rowsFromCsv(theirs.text).map((r) => r.id)).toEqual(["org2-canary"]);
    expect(theirs.text).not.toContain("org1-case-mail");

    // A hand-crafted parameter cannot widen the scope.
    const forced = await get("/export/labels.csv?organization_id=1&limit=1000", ADMIN2);
    expect(rowsFromCsv(forced.text).map((r) => r.id)).toEqual(["org2-canary"]);
  });

  it("includes parked (case-less) mail — the population a classifier must learn to refuse", async () => {
    const rows = rowsFromCsv((await get("/export/labels.csv", ADMIN)).text);
    expect(rows.map((r) => r.id)).toContain("org1-parked-mail");
  });

  it("leaves true_category blank so labelling is not anchored to the machine", async () => {
    const rows = rowsFromCsv((await get("/export/labels.csv", ADMIN)).text);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.trueCategory === "")).toBe(true);
  });

  it("escapes formula injection, quotes, commas and newlines — and still round-trips", async () => {
    const text = (await get("/export/labels.csv", ADMIN)).text;
    // The formula-prefixed cell is quoted and neutralised with a leading apostrophe.
    expect(text).toContain("\"'=HYPERLINK(");
    expect(text).not.toMatch(/\r\n=HYPERLINK/); // never a bare formula at the start of a line
    const rows = rowsFromCsv(text);
    expect(rows.length).toBe(3); // embedded newlines did not create extra rows
    const hostile = rows.find((r) => r.id === "org1-hostile")!;
    expect(hostile.body).toBe(`'${HOSTILE_BODY}`); // apostrophe prefix, otherwise byte-identical
    expect(hostile.subject).toBe("Quotation");
    const plain = rows.find((r) => r.id === "org1-case-mail")!;
    expect(plain.body).toBe(PLAIN_BODY); // untouched when there is nothing to escape
  });

  it("is audited with the row count, the tenant and the personal-data warning", async () => {
    await get("/export/labels.csv", ADMIN);
    const entries = repo.recentAudit(20).filter((a) => a.event === "labels_exported");
    expect(entries.length).toBe(1);
    expect(entries[0].actor).toBe("admin");
    expect(entries[0].detail).toContain("3 inbound message(s)");
    expect(entries[0].detail).toContain("organization 1");
    expect(entries[0].detail).toMatch(/personal data/i);
  });

  it("carries the personal-data note inside the file and in a header", async () => {
    const res = await get("/export/labels.csv", ADMIN);
    expect(res.headers.get("x-personal-data")).toMatch(/docs\/LABELLING-GUIDE\.md/);
    expect(res.headers.get("content-disposition")).toContain('filename="labels.csv"');
    const firstLine = res.text.split("\r\n")[0];
    expect(firstLine.startsWith("#")).toBe(true);
    expect(firstLine).toMatch(/PERSONAL DATA/);
    expect(firstLine).toMatch(/git-ignored/);
    // The note is a comment, not a row: the harness reads straight past it.
    expect(rowsFromCsv(res.text)[0].id).toBe("org1-hostile"); // most recent first
    // …and scoring an unlabelled file is still refused by default.
    expect(() => parseLabelled(res.text)).toThrow(/no true_category/);
  });

  it("honours the limit: default 200, explicit values, and a hard maximum of 1000", async () => {
    // 1005 more inbound messages for this tenant, in one transaction.
    repo.db.transaction(() => {
      for (let i = 0; i < 1005; i += 1) insertInbound(1, `bulk-${String(i).padStart(4, "0")}`, `Bulk ${i}`, "body");
    })();
    expect(rowsFromCsv((await get("/export/labels.csv", ADMIN)).text).length).toBe(200);           // default
    expect(rowsFromCsv((await get("/export/labels.csv?limit=3", ADMIN)).text).length).toBe(3);     // explicit
    expect(rowsFromCsv((await get("/export/labels.csv?limit=5000", ADMIN)).text).length).toBe(1000); // clamped
    expect(rowsFromCsv((await get("/export/labels.csv?limit=abc", ADMIN)).text).length).toBe(200);  // garbage → default
    expect(rowsFromCsv((await get("/export/labels.csv?limit=-5", ADMIN)).text).length).toBe(200);   // negative → default
    // Most recent first, so a capped export is still the recent population.
    const ids = rowsFromCsv((await get("/export/labels.csv?limit=2", ADMIN)).text).map((r) => r.id);
    expect(ids).toEqual(["bulk-1004", "bulk-1003"]);
  });

  it("the repository query itself is tenant-scoped, not just the route", () => {
    expect(repo.labelableMessages(1, 10).map((r) => r.id)).not.toContain("org2-canary");
    expect(repo.labelableMessages(org2Id, 10).map((r) => r.id)).toEqual(["org2-canary"]);
    expect(repo.labelableMessages(999, 10)).toEqual([]); // an unknown tenant reads nothing
  });
});
