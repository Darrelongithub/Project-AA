/**
 * The Overview "Today" panel.
 *
 * `status_history.at` (and `audit_log.at`) are written by SQLite's
 * `datetime('now')` default, which stores `2026-05-01 08:00:00`, while the
 * day boundaries come from Node as `2026-05-01T00:00:00.000Z`. Compared as
 * strings the space at position 11 sorts before the `T`, so EVERY
 * SQLite-stamped row of today compared as "older than today" and the
 * completed-today counter was permanently zero. `src/db/retention.ts` documents
 * the same trap for the retention sweep; the counters now compare instants
 * with julianday() instead of bytes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";

describe("today's counters", () => {
  let repo: Repo;

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
  });

  it("counts a completion stamped by SQLite's datetime('now')", () => {
    const a = repo.createCase({ emailAddress: "done@example.test", threadId: "t-done", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.setLifecycle(a.id, "awaiting_review", "system", "queued");
    repo.setLifecycle(a.id, "completed", "officer", "finished by hand");

    const history = repo.db.prepare("SELECT at FROM status_history WHERE applicant_id = ? AND to_status = 'completed'").get(a.id) as { at: string };
    // The row really is in the SQLite shape, which is what the bug turned on.
    expect(history.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(repo.todayStats().completedToday).toBe(1);
  });

  it("ignores a completion from before local midnight", () => {
    const a = repo.createCase({ emailAddress: "old@example.test", threadId: "t-old", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.setLifecycle(a.id, "completed", "officer", "long ago");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
    repo.db.prepare("UPDATE status_history SET at = ? WHERE applicant_id = ?").run(threeDaysAgo, a.id);
    expect(repo.todayStats().completedToday).toBe(0);
  });

  it("counts mail and documents, which are stored as ISO stamps", () => {
    const a = repo.createCase({ emailAddress: "mail@example.test", threadId: "t-mail", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.insertEmail({
      applicant_id: a.id, message_id: "m-1", thread_id: "t-mail", direction: "in",
      from_addr: "mail@example.test", to_addr: "intake@example.test", subject: "Hello",
      body: "Please advise.", category: "general_enquiry", auto: 0, at: new Date().toISOString(),
    });
    repo.insertEmail({
      applicant_id: a.id, message_id: "m-2", thread_id: "t-mail", direction: "out",
      from_addr: "desk@example.test", to_addr: "mail@example.test", subject: "Re: Hello",
      body: "Here you are.", category: null, auto: 1, at: new Date().toISOString(),
    });
    repo.db.prepare("UPDATE emails SET at = ? WHERE message_id = 'm-1'").run("2020-01-01T00:00:00.000Z");
    const stats = repo.todayStats();
    expect(stats.emailsToday).toBe(0); // the only inbound mail is years old
    repo.db.prepare("UPDATE emails SET at = ? WHERE message_id = 'm-2'").run(new Date().toISOString());
    expect(repo.todayStats().emailsToday).toBe(0); // and an outgoing reply never counted
    repo.insertEmail({
      applicant_id: a.id, message_id: "m-3", thread_id: "t-mail", direction: "in",
      from_addr: "mail@example.test", to_addr: "intake@example.test", subject: "One more",
      body: "Thanks.", category: "other", auto: 0, at: new Date().toISOString(),
    });
    expect(repo.todayStats().emailsToday).toBe(1);
  });

  it("counts documents received today", () => {
    const a = repo.createCase({ emailAddress: "docs@example.test", threadId: "t-docs", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    const insert = repo.db.prepare(
      `INSERT INTO documents (applicant_id, document_type, source_email_id, extraction_method, extracted_text, confidence, received_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    insert.run(a.id, "request_form", "m-1", "pdf_text", "text", "high", new Date().toISOString());
    insert.run(a.id, "id", "m-0", "pdf_text", "text", "high", "2020-01-01T00:00:00.000Z");
    expect(repo.todayStats().docsToday).toBe(1);
  });
});
