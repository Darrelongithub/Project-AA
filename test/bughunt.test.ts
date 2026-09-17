/**
 * Regression tests for the bug-hunt fixes. One describe block per defect —
 * each test FAILS against the pre-fix code.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { extractPhone } from "../src/enrich";
import { resolveIdentity } from "../src/matching/identity";
import { parseCookies } from "../src/web/auth";
import { sanitizeHeaders } from "../src/ingestion/gmailClient";
import { runFollowUpSweep } from "../src/followups";
import { MockSender, MockVisionAdapter } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { IncomingEmail } from "../src/types";

function freshRepo(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  return repo;
}

describe("bug: requirement-rule upsert duplicated every base rule (NULLs in UNIQUE)", () => {
  it("re-seeding base requirements never duplicates rows", () => {
    const repo = freshRepo();
    repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
    const baseRules = repo.listRules().filter((r) => r.programme === null && r.intake === null);
    expect(baseRules.length).toBe(DEFAULT_REQUIREMENTS.length);
  });

  it("upsertRule on an All-programmes/All-intakes rule is idempotent", () => {
    const repo = freshRepo();
    const rule = { programme: null, intake: null, document_type: "academic_cert" as const, required: true, meanGrade: null };
    repo.upsertRule(rule);
    repo.upsertRule({ ...rule, required: false });
    const rows = repo.listRules().filter((r) => r.programme === null && r.intake === null && r.document_type === "academic_cert");
    expect(rows.length).toBe(1);
    expect(rows[0].required).toBe(false);
  });

  it("seedDefaults cleans up legacy duplicate rows", () => {
    const repo = freshRepo();
    // Simulate the old corruption: raw duplicate inserts.
    repo.db
      .prepare("INSERT INTO requirement_rules (programme, intake, document_type, required) VALUES (NULL, NULL, 'id', 1)")
      .run();
    expect(repo.listRules().filter((r) => r.document_type === "id").length).toBeGreaterThan(1);
    seedDefaults(repo);
    expect(repo.listRules().filter((r) => r.document_type === "id").length).toBe(1);
  });
});

describe("bug: getOrCreateApplicant race (check-then-insert)", () => {
  it("is idempotent and never throws on repeated creation", () => {
    const repo = freshRepo();
    const a = repo.getOrCreateApplicant("x@example.org", "t1");
    const b = repo.getOrCreateApplicant("x@example.org", "t1");
    expect(a.id).toBe(b.id);
    const n = (repo.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("bug: updateApplicant interpolated arbitrary column names into SQL", () => {
  it("refuses unknown columns instead of injecting them", () => {
    const repo = freshRepo();
    const a = repo.getOrCreateApplicant("y@example.org", "t1");
    expect(() =>
      (repo as any).updateApplicant(a.id, { "lifecycle = 'completed' WHERE 1; --": "x" })
    ).toThrow(/refusing unknown column/);
  });
});

describe("bug: todayStats used UTC date('now')", () => {
  it("counts a just-now email and excludes one from 25h ago", () => {
    const repo = freshRepo();
    const a = repo.getOrCreateApplicant("z@example.org", "t1");
    const now = new Date();
    repo.insertEmail({
      applicant_id: a.id, message_id: "m1", thread_id: "t1", direction: "in",
      from_addr: "z@example.org", to_addr: "", subject: "s", body: "b",
      category: null, auto: 0, at: now.toISOString(),
    });
    repo.insertEmail({
      applicant_id: a.id, message_id: "m2", thread_id: "t1", direction: "in",
      from_addr: "z@example.org", to_addr: "", subject: "s", body: "b",
      category: null, auto: 0, at: new Date(now.getTime() - 25 * 3600_000).toISOString(),
    });
    expect(repo.todayStats().emailsToday).toBe(1);
  });
});

describe("bug: searchApplicants did not escape LIKE wildcards", () => {
  it("a literal '%' query does not match the whole table", () => {
    const repo = freshRepo();
    repo.getOrCreateApplicant("p1@example.org", "t1", { fullName: "Alice One" });
    repo.getOrCreateApplicant("p2@example.org", "t2", { fullName: "Bob Two" });
    expect(repo.searchApplicants({ q: "%" }).length).toBe(0);
    expect(repo.searchApplicants({ q: "Alice" }).length).toBe(1);
  });
});

describe("bug: OTP used Math.random and never burned on wrong guesses", () => {
  it("creates 6-digit codes and burns after 5 wrong attempts", () => {
    const repo = freshRepo();
    const a = repo.getOrCreateApplicant("otp@example.org", "t1");
    const code = repo.createOtp(a.id);
    expect(code).toMatch(/^\d{6}$/);
    for (let i = 0; i < 5; i++) {
      expect(repo.consumeOtp(a.id, "000000" === code ? "111111" : "000000")).toBe(false);
    }
    // Even the CORRECT code must fail now — the code is dead.
    expect(repo.consumeOtp(a.id, code)).toBe(false);
  });

  it("still accepts the correct code before the attempt limit", () => {
    const repo = freshRepo();
    const a = repo.getOrCreateApplicant("otp2@example.org", "t1");
    const code = repo.createOtp(a.id);
    expect(repo.consumeOtp(a.id, "999999")).toBe(false);
    expect(repo.consumeOtp(a.id, code)).toBe(true);
  });
});

describe("bug: extractPhone matched inside longer digit runs", () => {
  it("rejects a phone-shaped substring of a longer number", () => {
    // 15-digit run containing what looks like 0712345678 inside.
    expect(extractPhone("ID 9990712345678999")).toBeNull();
  });
  it("accepts a properly delimited number", () => {
    expect(extractPhone("call me on 0712 345 678 thanks")).toBe("+254712345678");
    expect(extractPhone("tel: +254712345678.")).toBe("+254712345678");
  });
});

describe("bug: portal filename could inject another applicant's ref", () => {
  it("synthetic (non-email) channels never use quoted refs for identity", () => {
    const repo = freshRepo();
    const victim = repo.getOrCreateApplicant("victim@example.org", "tv");
    const email: IncomingEmail = {
      id: "pu-1",
      threadId: "t-attacker",
      from: "attacker@example.org",
      subject: `Portal upload: ${victim.ref_number}.pdf`,
      body: "",
      receivedAt: new Date().toISOString(),
      attachments: [],
      channel: "portal",
    };
    const res = resolveIdentity(repo, email);
    expect(res.applicant.id).not.toBe(victim.id);
    expect(res.applicant.email_address).toBe("attacker@example.org");
  });

  it("real emails still resolve via quoted refs", () => {
    const repo = freshRepo();
    const victim = repo.getOrCreateApplicant("victim@example.org", "tv");
    const email: IncomingEmail = {
      id: "em-1",
      threadId: "t-new",
      from: "victim@example.org",
      subject: `Re: your application ${victim.ref_number}`,
      body: "",
      receivedAt: new Date().toISOString(),
      attachments: [],
    };
    const res = resolveIdentity(repo, email);
    expect(res.applicant.id).toBe(victim.id);
    expect(res.matchedBy).toBe("ref");
    expect(res.concern).toBeUndefined();
  });
});

describe("bug: parseCookies threw URIError on malformed cookies", () => {
  it("returns the raw value instead of throwing", () => {
    expect(() => parseCookies("sid=%zz; theme=dark")).not.toThrow();
    expect(parseCookies("theme=dark").theme).toBe("dark");
  });
});

describe("bug: outgoing MIME headers were injectable", () => {
  it("strips CRLF from subject/to and RFC2047-encodes non-ASCII subjects", () => {
    const h = sanitizeHeaders("a@b.org", "Hello\r\nBcc: evil@x.org");
    expect(h.subject).not.toMatch(/[\r\n]/);
    // The injected header survives only as literal TEXT inside the Subject
    // value — single-line, so MIME parsers treat it as subject content.
    expect(h.subject).toBe("Hello Bcc: evil@x.org");
    const utf = sanitizeHeaders("a@b.org", "Karibu — your file");
    expect(utf.subject.startsWith("=?UTF-8?B?")).toBe(true);
  });
});

describe("bug: follow-up ladder stacked intervals instead of absolute days", () => {
  it("schedules the next rung relative to the ladder base date", async () => {
    const repo = freshRepo();
    const sender = new MockSender();
    const ctx = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender },
    };
    const a = repo.getOrCreateApplicant("ladder@example.org", "t1");
    // Armed 8 days ago with ladder 3,7,10 → rung 1 fired at day 3 (past due),
    // and the NEXT rung must be base+7d (≈ 1 day ago), NOT now+7d.
    const base = new Date(Date.now() - 8 * 24 * 3600_000);
    repo.setFollowup(a.id, 0, new Date(Date.now() - 5 * 24 * 3600_000).toISOString(), base.toISOString());
    const sent = await runFollowUpSweep(repo, ctx);
    expect(sent).toBe(1);
    expect(sender.sent.length).toBe(1);
    const row = repo.getApplicant(a.id)!;
    expect(row.followup_rung).toBe(1);
    const expected = base.getTime() + 7 * 24 * 3600_000;
    const actual = new Date(row.followup_next_at!).getTime();
    expect(Math.abs(actual - expected)).toBeLessThan(60_000);
  });
});

describe("bug: unreadable attachments were logged as gemini_vision", () => {
  it("total extraction failure records method 'none'", async () => {
    const { extractAttachment } = await import("../src/extraction/extract");
    const res = await extractAttachment(
      { filename: "x.bin", mimeType: "application/octet-stream", content: Buffer.from([1, 2, 3]) },
      { vision: new MockVisionAdapter() }
    );
    expect(res.method).toBe("none");
    expect(res.document_type).toBe("unknown");
    expect(res.confidence).toBe("low");
  });

  it("oversized attachments are rejected before any heavy tier", async () => {
    const { extractAttachment, MAX_ATTACHMENT_BYTES } = await import("../src/extraction/extract");
    const res = await extractAttachment(
      { filename: "big.pdf", mimeType: "application/pdf", content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
      { vision: new MockVisionAdapter() }
    );
    expect(res.method).toBe("none");
    expect(res.document_type).toBe("unknown");
  });
});

describe("bug: /theme was an open redirect via the Referer header", () => {
  it("only redirects to same-origin relative paths", async () => {
    const { createApp } = await import("../src/web/server");
    const repo = freshRepo();
    const sender = new MockSender();
    const ctx = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender },
    };
    const app = createApp({ repo, ctx });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // Hostile referer → stay on "/".
      const evil = await fetch(`${base}/theme`, {
        method: "POST",
        redirect: "manual",
        headers: { referer: "https://evil.example.com/phish" },
      });
      expect(evil.headers.get("location")).toBe("/");
      // Same-origin referer → back to that path.
      const good = await fetch(`${base}/theme`, {
        method: "POST",
        redirect: "manual",
        headers: { referer: `${base}/queue` },
      });
      expect(good.headers.get("location")).toBe("/queue");
      // Protocol-relative trap ("//evil.com") must not pass as a path.
      const tricky = await fetch(`${base}/theme`, {
        method: "POST",
        redirect: "manual",
        headers: { referer: `${base}//evil.example.com` },
      });
      expect(tricky.headers.get("location")).toBe("/");
    } finally {
      server.close();
    }
  });
});

describe("bug: sessions were never purged after boot", () => {
  it("creating a session purges expired rows", () => {
    const repo = freshRepo();
    const staff = repo.getStaffByUsername("admin")!;
    repo.db
      .prepare("INSERT INTO sessions (token, staff_id, csrf, expires_at) VALUES (?,?,?,?)")
      .run("dead-token", staff.id, "c", new Date(Date.now() - 1000).toISOString());
    repo.createSession(staff.id);
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token = 'dead-token'").get()).toMatchObject({ n: 0 });
  });
});
