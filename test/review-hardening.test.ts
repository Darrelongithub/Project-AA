/**
 * Review-round hardening fixes — RED-first acceptance:
 *  one-shot pack-defaults migration · retention date boundary · shared
 *  Gmail sender forwarding extras · non-overlapping inbox poll ·
 *  regex-safe programme codes · transfer wording · export aggregates.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { GmailSender } from "../src/ingestion/sender";
import { retentionDue } from "../src/db/retention";
import { onceAtATime } from "../src/util/once";
import { inferProgramme, inferTransfer } from "../src/enrich";

describe("pack-defaults migration is one-shot", () => {
  it("a staff choice of 'none' survives a database re-open", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ru-mig-"));
    const file = path.join(dir, "mig.sqlite");
    try {
      const repo = new Repo(openDb(file));
      seedDefaults(repo);
      expect(repo.getTemplate("docs_request")?.attach_pack).toBe("application");
      // staff deliberately turns the pack OFF for the document request
      const t = repo.getTemplate("docs_request")!;
      repo.upsertTemplate(t.key, t.name, t.subject, t.body, t.include_banner === 1, "none");
      expect(repo.getTemplate("docs_request")?.attach_pack).toBe("none");
      // re-open the same database (server restart) — the choice must stand
      const repo2 = new Repo(openDb(file));
      expect(repo2.getTemplate("docs_request")?.attach_pack).toBe("none");
      const a = repo2.getTemplate("admission_letter")!;
      repo2.upsertTemplate(a.key, a.name, a.subject, a.body, a.include_banner === 1, "none");
      const repo3 = new Repo(openDb(file));
      expect(repo3.getTemplate("admission_letter")?.attach_pack).toBe("none");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retention boundary", () => {
  const cutoff = "2026-09-19T01:00:00.000Z";
  it("never archives a case updated later on the same calendar day", () => {
    // SQLite 'datetime(now)' format vs ISO cutoff: 23:00 > 01:00 same day
    expect(retentionDue("2026-09-19 23:00:00", cutoff)).toBe(false);
    expect(retentionDue("2026-09-19 01:00:01", cutoff)).toBe(false);
  });
  it("archives a case strictly older than the cutoff", () => {
    expect(retentionDue("2026-09-19 00:59:59", cutoff)).toBe(true);
    expect(retentionDue("2026-09-18 12:00:00", cutoff)).toBe(true);
    expect(retentionDue("2024-01-01 00:00:00", cutoff)).toBe(true);
  });
});

describe("GmailSender forwards extras on every path", () => {
  it("attachments and banner reach the wire", async () => {
    const calls: unknown[][] = [];
    const fakeGmail = { sendReply: async (...args: unknown[]) => { calls.push(args); } };
    const sender = new GmailSender(fakeGmail as never);
    const extras = {
      attachments: [{ filename: "RU Hostels List.pdf", mimeType: "application/pdf", content: Buffer.from("x") }],
      banner: { mime: "image/jpeg", base64: "QUJD" },
    };
    await sender.send("a@b.c", "s", "b", "t-1", extras);
    expect(calls.length).toBe(1);
    expect(calls[0][4]).toEqual(extras); // extras MUST be forwarded
  });
});

describe("the inbox poll never overlaps itself", () => {
  it("a second tick while a pass is running is skipped, not stacked", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const guarded = onceAtATime(async () => {
      calls++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
      return calls;
    });
    const results = await Promise.all([guarded(), guarded(), guarded()]);
    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r === null).length).toBe(2); // overlapped ticks skipped
  });
});

describe("inferProgramme cannot be poisoned by regex metacharacters", () => {
  it("a code with dots matches only itself", () => {
    const progs = [{ code: "B.COM", name: "Bachelor of Commerce" }];
    expect(inferProgramme("apply to B.COM please", progs)).toBe("B.COM");
    expect(inferProgramme("BXCOM is not a code", progs)).toBeNull(); // '.' must not act as wildcard
  });
});

describe("transfer wording is recognised", () => {
  it("checklist phrasing and 'transfer into a course' both count", () => {
    expect(inferTransfer("my transfer letter is attached")).toBe(true);
    expect(inferTransfer("I wish to transfer into BCS this intake")).toBe(true);
    expect(inferTransfer("credit transfer from my previous university")).toBe(true);
  });
  it("money movement does not flip the case onto the transfer track", () => {
    expect(inferTransfer("I will transfer the fee by M-Pesa")).toBe(false);
    expect(inferTransfer("bank transfer of the application fee")).toBe(false);
  });
});

describe("export aggregates", () => {
  it("document counts and flag types come back in one query each", () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const a = repo.getOrCreateApplicant("agg@example.org", "t-agg");
    const b = repo.getOrCreateApplicant("agg2@example.org", "t-agg2");
    repo.insertDocument({
      applicant_id: a.id, document_type: "id", source_email_id: "e1", extraction_method: "pdf_text",
      extracted_text: "x", extracted_fields: {}, confidence: "high", confidence_score: 90,
      received_at: new Date().toISOString(), sha256: "h1", is_duplicate: false, extraction_note: "",
    });
    repo.syncFlags(a.id, [{ type: "identity_check", detail: "d" }]);
    const counts = repo.documentCountsByApplicant();
    const flags = repo.activeFlagTypesByApplicant();
    expect(counts.get(a.id)).toBe(1);
    expect(counts.get(b.id) ?? 0).toBe(0);
    expect(flags.get(a.id)).toContain("identity_check");
  });
});
