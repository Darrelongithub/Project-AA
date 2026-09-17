/**
 * Matching + persistence behaviour: applicant resolution by (sender, thread),
 * supersede chains for corrected documents, and flag reconciliation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { recordDocuments, resolveApplicant } from "../src/matching";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import type { ExtractionResult, IncomingEmail } from "../src/types";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});

function mkEmail(id: string, threadId: string, from: string): IncomingEmail {
  return {
    id,
    threadId,
    from,
    subject: "s",
    body: "b",
    receivedAt: "2026-09-14T00:00:00Z",
    attachments: [],
  };
}

it("matches a quoted reference number even with a non-default prefix length", () => {
  // ref_prefix is configurable (1–4 letters); identity matching must not
  // assume the default two-letter "RU" shape.
  const a = repo.getOrCreateApplicant("longprefix@example.com", "t-prefix", { refPrefix: "ABC" });
  expect(a.ref_number).toMatch(/^ABC-\d{4}-\d{6}$/);
  const email = mkEmail("m-prefix", "another-thread", "someone-else@example.com");
  email.body = `Please add this to my file, my reference is ${a.ref_number}`;
  const resolved = resolveApplicant(repo, email, { refPrefix: "ABC" });
  expect(resolved.id).toBe(a.id);
});

let hashCounter = 0;
function mkExtraction(filename: string, type: ExtractionResult["document_type"]): ExtractionResult {
  return {
    filename,
    document_type: type,
    method: "pdf_text",
    text: `${type} text`,
    fields: {},
    confidence: "high",
    sha256: `hash-${++hashCounter}`,
  };
}

describe("applicant resolution", () => {
  it("resolves the same sender+thread to the same applicant", () => {
    const a1 = resolveApplicant(repo, mkEmail("e1", "t1", "A@Example.ORG"));
    const a2 = resolveApplicant(repo, mkEmail("e2", "t1", "a@example.org"));
    expect(a1.id).toBe(a2.id);
  });

  it("different thread from same sender → SAME case (cross-thread reconstruction)", () => {
    // v3 identity semantics: applicants email from phones, start new threads,
    // forward old conversations — everything must land on the same case, not
    // fragment per Gmail thread. Both threads get linked to the applicant.
    const a1 = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    const a2 = resolveApplicant(repo, mkEmail("e2", "t2", "a@example.org"));
    expect(a1.id).toBe(a2.id);
    expect(repo.threadsForApplicant(a1.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("supersede chain (corrections)", () => {
  it("a re-submitted document supersedes the earlier one of the same type", () => {
    const applicant = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    recordDocuments(repo, applicant.id, mkEmail("e1", "t1", "a@example.org"), [
      mkExtraction("form-v1.pdf", "application_form"),
    ]);
    recordDocuments(repo, applicant.id, mkEmail("e2", "t1", "a@example.org"), [
      mkExtraction("form-v2.pdf", "application_form"),
    ]);

    const active = repo.listDocuments(applicant.id);
    expect(active.length).toBe(1);
    expect(repo.listDocuments(applicant.id, { activeOnly: false }).length).toBe(2);
    expect(repo.countSuperseded(applicant.id)).toBe(1);
  });

  it("chains of three versions keep only the newest active", () => {
    const applicant = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    for (const [i, file] of ["v1", "v2", "v3"].entries()) {
      recordDocuments(repo, applicant.id, mkEmail(`e${i}`, "t1", "a@example.org"), [
        mkExtraction(`${file}.pdf`, "application_form"),
      ]);
    }
    const active = repo.listDocuments(applicant.id);
    expect(active.length).toBe(1);
    expect(repo.countSuperseded(applicant.id)).toBe(2);
  });

  it("unknown-type documents never supersede anything", () => {
    const applicant = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    recordDocuments(repo, applicant.id, mkEmail("e1", "t1", "a@example.org"), [
      mkExtraction("a.pdf", "id"),
      mkExtraction("b.pdf", "unknown"),
    ]);
    expect(repo.listDocuments(applicant.id).length).toBe(2);
    expect(repo.countSuperseded(applicant.id)).toBe(0);
  });
});

describe("flag reconciliation", () => {
  it("syncFlags deactivates stale flags and keeps an audit trail", () => {
    const applicant = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    repo.syncFlags(applicant.id, [{ type: "name_mismatch", detail: "X vs Y" }]);
    expect(repo.activeFlags(applicant.id).map((f) => f.type)).toEqual(["name_mismatch"]);

    // Correction arrives → the mismatch is gone; the old flag is deactivated, not deleted.
    repo.syncFlags(applicant.id, []);
    expect(repo.activeFlags(applicant.id)).toEqual([]);
    const all = repo.db.prepare("SELECT * FROM flags WHERE applicant_id = ?").all(applicant.id) as any[];
    expect(all.length).toBe(1);
    expect(all[0].active).toBe(0);
  });

  it("syncFlags is idempotent for the same derived set", () => {
    const applicant = resolveApplicant(repo, mkEmail("e1", "t1", "a@example.org"));
    const flags = [{ type: "low_confidence" as const, detail: "d" }];
    repo.syncFlags(applicant.id, flags);
    repo.syncFlags(applicant.id, flags);
    expect(repo.activeFlags(applicant.id).length).toBe(1);
  });
});

describe("idempotency", () => {
  it("marks emails processed and reports them", () => {
    expect(repo.isProcessed("e1")).toBe(false);
    repo.markProcessed("e1", "t1");
    expect(repo.isProcessed("e1")).toBe(true);
  });
});
