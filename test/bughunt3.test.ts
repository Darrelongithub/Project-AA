/**
 * Bug hunt 3 — three bugs found by the post-round-4 scan, each reproduced
 * against the running code before the fix:
 *
 *  B1  The "most requested missing documents" tile counted missing docs with
 *      a literal type-set difference, while the pipeline judges missingness
 *      by SLOT semantics (fillSlots over the case's frozen checklist). A file
 *      the pipeline considered COMPLETE was shown on the dashboard as missing
 *      exactly the document the contact sent.
 *
 *  B2  Configuration edits reached cases that had already been judged: a
 *      published checklist or rule tree was applied retroactively to frozen
 *      cases, and a foreign case-type id could be written through the admin
 *      routes. Configuration is now versioned per case type, frozen onto each
 *      case at first triage, and upgraded only by an explicit human action.
 *
 *  B3  inferIntake matched a month and a year anywhere in the text. A DOB
 *      month on a birth certificate ("12 JANUARY 1990") paired with an
 *      application year elsewhere ("2026 intake") fabricated an intake
 *      ("January 2026") the applicant never mentioned together.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureTestOrganization } from "./helpers";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { fillSlots } from "../src/documents/matrix";
import { inferIntake } from "../src/enrich";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, type PipelineContext } from "../src/pipeline/adapters";
import { webLogin } from "./helpers";
import type { DocType, ExtractedFields } from "../src/types";

let repo: Repo;
let seq = 0;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base = "";

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
});

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer(): Promise<{ base: string; cookie: string; csrf: string }> {
  const ctx: PipelineContext = { repo, adapters: { vision: null as never, watcher: null as never, sender: new MockSender() } };
  const app = createApp({ repo, ctx });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { cookie, csrf } = await webLogin(base, "admin", "admin123");
  return { base, cookie, csrf };
}

function mkCase(caseTypeCode: string, email: string): number {
  seq += 1;
  return repo.createCase({
    emailAddress: email, threadId: `thr-bh3-${seq}`, organizationId: 1, caseTypeCode, fullName: `Contact ${seq}`,
  }).id;
}

function mkDocs(id: number, specs: Array<{ type: DocType; fields?: Partial<ExtractedFields> }>): void {
  specs.forEach((s, i) => {
    repo.insertDocument({
      applicant_id: id,
      document_type: s.type,
      source_email_id: `e-bh3-${id}-${i}`,
      extraction_method: "pdf_text",
      extracted_text: `${s.type} text`,
      extracted_fields: (s.fields ?? {}) as ExtractedFields,
      confidence: "high",
      confidence_score: 98,
      received_at: new Date().toISOString(),
    });
  });
}

describe("B1 — the missing-documents tile uses the pipeline's slot semantics", () => {
  it("a complete file is NOT 'missing' anything to the tile", () => {
    const id = mkCase("SERVICE_REQUEST", "bh3-b1@example.test");
    mkDocs(id, [{ type: "request_form" }, { type: "id" }, { type: "supporting_document" }]);
    const row = repo.getCase(id)!;
    const present = repo.listDocuments(id, { activeOnly: true }).map((doc) => doc.document_type);
    const { missing } = fillSlots(repo.effectiveRequirements(row), present);
    expect(missing).toEqual([]); // what the pipeline sees
    const tile = repo.commonMissingDocs(0, null, 10).map((entry) => entry.type);
    expect(tile).not.toContain("request_form");
    expect(tile).not.toContain("id");
  });

  it("a genuinely missing slot is still counted (control)", () => {
    const id = mkCase("VENDOR_INTAKE", "bh3-b1b@example.test");
    mkDocs(id, [{ type: "services_agreement" }]);
    const tile = repo.commonMissingDocs(0, null, 10).map((entry) => entry.type);
    expect(tile).toContain("insurance_certificate");
    expect(tile).not.toContain("services_agreement");
  });

  it("an unconfigured case contributes no invented missing slots", () => {
    const organization = repo.createOrganization({ name: "Blank Tenant", refPrefix: "BLK" });
    const id = repo.createCase({ emailAddress: "bh3-blank@example.test", threadId: "thr-bh3-blank", organizationId: organization.id }).id;
    expect(repo.effectiveRequirements(repo.getCase(id)!)).toEqual([]);
    expect(repo.commonMissingDocs(0, null, 10).map((entry) => entry.type)).not.toContain("request_form");
  });
});

describe("B2 — published configuration never reaches a case retroactively", () => {
  it("a frozen case keeps the checklist and rule tree it was opened with", () => {
    const id = mkCase("SERVICE_REQUEST", "bh3-b2@example.test");
    repo.freezeCaseConfig(repo.getCase(id)!);
    repo.freezeRequirementsSnapshot(repo.getCase(id)!);
    const frozenVersion = repo.caseConfigFrozen(repo.getCase(id)!)!.config_version;

    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.upsertDocumentDefinition(type.id, { key: "site_survey", label: "Site survey", required: true, blocking: true });
    repo.updateCaseTypeRules(type.id, [{ kind: "condition", field: "consent", comparator: "=", value: "no" }]);

    const row = repo.getCase(id)!;
    expect(repo.effectiveRequirements(row).map((entry) => entry.document_type)).not.toContain("site_survey");
    expect(repo.caseConfigFrozen(row)!.config_version).toBe(frozenVersion);
    expect(repo.caseTypeConfigVersion(type.id)).toBeGreaterThan(frozenVersion);
  });

  it("an explicit upgrade adopts the current configuration for that case only", () => {
    const upgraded = mkCase("SERVICE_REQUEST", "bh3-b2a@example.test");
    const untouched = mkCase("SERVICE_REQUEST", "bh3-b2b@example.test");
    for (const id of [upgraded, untouched]) {
      repo.freezeCaseConfig(repo.getCase(id)!);
      repo.freezeRequirementsSnapshot(repo.getCase(id)!);
    }
    const type = repo.getCaseType("SERVICE_REQUEST", 1)!;
    repo.upsertDocumentDefinition(type.id, { key: "site_survey", label: "Site survey", required: true, blocking: true });

    repo.reFreezeCaseConfig(repo.getCase(upgraded)!);
    expect(repo.effectiveRequirements(repo.getCase(upgraded)!).map((entry) => entry.document_type)).toContain("site_survey");
    expect(repo.effectiveRequirements(repo.getCase(untouched)!).map((entry) => entry.document_type)).not.toContain("site_survey");
    expect(repo.caseConfigFrozen(repo.getCase(upgraded)!)!.config_version).toBe(repo.caseTypeConfigVersion(type.id));
  });

  it("corrupt frozen configuration is refused loudly instead of silently re-judged", () => {
    const id = mkCase("SERVICE_REQUEST", "bh3-b2c@example.test");
    repo.db.prepare("UPDATE applicants SET case_config_frozen = '{not json' WHERE id = ?").run(id);
    expect(() => repo.effectiveRequirements(repo.getCase(id)!)).toThrow(/corrupt/i);
    // Repair is an explicit human action, and it succeeds.
    repo.reFreezeCaseConfig(repo.getCase(id)!);
    expect(repo.effectiveRequirements(repo.getCase(id)!).map((entry) => entry.document_type)).toContain("request_form");
  });

  it("the admin route refuses a case type belonging to another organization", async () => {
    const { base, cookie, csrf } = await startServer();
    const foreign = repo.createOrganization({ name: "Foreign Tenant", refPrefix: "FOR" });
    const foreignType = repo.createCaseType(foreign.id, { code: "SERVICE_REQUEST", name: "Service request", category: "services" });
    repo.updateCaseTypeRules(foreignType.id, [{ kind: "condition", field: "consent", comparator: "=", value: "yes" }]);

    const res = await fetch(`${base}/config/case-types/rules`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      // The acting admin works in organization 1 but names another tenant's type.
      body: `_csrf=${csrf}&organization_id=${foreign.id}&case_type_id=${foreignType.id}&rules_json=${encodeURIComponent("[]")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(String(res.headers.get("location")))).toContain("another organization");
    expect(repo.caseTypeRules(repo.getCaseType("SERVICE_REQUEST", foreign.id)!)).toHaveLength(1);
  });
});

describe("B3 — intake inference never pairs a month and a year from different contexts", () => {
  const INTAKES = ["January 2026", "September 2026"];

  it("a DOB month + an application year elsewhere never fabricates an intake", () => {
    const text = "Born 12 JANUARY 1990. I am writing to apply for the 2026 intake.";
    expect(inferIntake(text, INTAKES)).toBeNull();
  });

  it("an adjacent MONTH YEAR still matches", () => {
    expect(inferIntake("for the JANUARY 2026 intake", INTAKES)).toBe("January 2026");
    expect(inferIntake("registered for January, 2026", INTAKES)).toBe("January 2026");
    expect(inferIntake("JANUARY INTAKE 2026 please", INTAKES)).toBe("January 2026");
  });

  it("the exact phrase and the month-only wording still match", () => {
    expect(inferIntake("joining the September 2026 intake", INTAKES)).toBe("September 2026");
    expect(inferIntake("which month is the September intake", INTAKES)).toBe("September 2026");
  });
});
