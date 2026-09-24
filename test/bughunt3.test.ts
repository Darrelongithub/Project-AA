/**
 * Bug hunt 3 — three bugs found by the post-round-4 scan, each reproduced
 * against the running code before the fix:
 *
 *  B1  The "most requested missing documents" tile counted missing docs with
 *      a literal type-set difference, while the pipeline judges missingness
 *      by SLOT semantics (fillSlots — a generic academic upload fills an
 *      academic slot). A file the pipeline considered COMPLETE was shown on
 *      the dashboard as missing exactly the document the applicant sent.
 *
 *  B2  /config/requirements/node-save and node-delete took `node=<id>` from
 *      the form body and wrote admission_rule_nodes without verifying the
 *      node belongs to the DRAFT set for the requested target. ACTIVE
 *      (published) rule sets were directly mutable through the draft-flow
 *      routes — bypassing draft → activate versioning, and letting one
 *      course's form touch another course's rules.
 *
 *  B3  inferIntake matched a month and a year anywhere in the text. A DOB
 *      month on a birth certificate ("12 JANUARY 1990") paired with an
 *      application year elsewhere ("2026 intake") fabricated an intake
 *      ("January 2026") the applicant never mentioned together.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
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
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
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

function mkApplicant(programme: string | null, email: string): number {
  seq += 1;
  const res = repo.db
    .prepare(`INSERT INTO applicants (ref_number, email_address, thread_id, full_name, programme)
              VALUES (?, ?, ?, ?, ?)`)
    .run(`BH3-2026-${String(seq).padStart(6, "0")}`, email, `thr-bh3-${seq}`, `BH3 Applicant ${seq}`, programme);
  return Number(res.lastInsertRowid);
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
  it("a complete file whose academic upload fills a slot is NOT 'missing' to the tile", () => {
    const id = mkApplicant("BBA", "bh3-b1@e.org");
    // BBA's checklist asks for an exam result slip; the applicant sent it as
    // the generic academic upload — the pipeline (fillSlots) treats the slot
    // as filled, so the dashboard tile must agree.
    mkDocs(id, [
      { type: "academic_cert", fields: { name: "BH3 B1", examSystem: "IGCSE", credits: 5 } },
      { type: "leaving_certificate" },
      { type: "passport_photo" },
      { type: "birth_cert" },
      { type: "id" },
      { type: "application_form" },
      { type: "business_statement_of_objective" },
    ]);
    const a = repo.getApplicant(id)!;
    const present = repo.listDocuments(id, { activeOnly: true }).map((d) => d.document_type);
    const { missing } = fillSlots(repo.effectiveRequirements(a), present);
    expect(missing.map((m) => m.document_type)).toEqual([]); // what the pipeline sees
    const tile = repo.commonMissingDocs(0, null, 10).map((x) => x.type);
    expect(tile).not.toContain("exam_result_slip");
    expect(tile).not.toContain("leaving_certificate");
  });

  it("a genuinely missing document is still counted (control)", () => {
    const id = mkApplicant("BBA", "bh3-b1b@e.org");
    mkDocs(id, [
      { type: "academic_cert", fields: { name: "BH3 B1B", examSystem: "IGCSE", credits: 5 } },
      { type: "leaving_certificate" },
      { type: "passport_photo" },
      { type: "id" },
      { type: "application_form" },
      { type: "business_statement_of_objective" },
    ]);
    const tile = repo.commonMissingDocs(0, null, 10).map((x) => x.type);
    expect(tile).toContain("birth_cert");
    expect(tile).not.toContain("exam_result_slip");
  });
});

describe("B2 — draft-flow rule edits only reach the target's DRAFT set", () => {
  it("a node of an ACTIVE set is refused by the guarded mutators", () => {
    const active = repo.activeSetsForProgramme("BCS").find((s) => s.system === "KCSE")!;
    expect(active.nodes!.length).toBeGreaterThan(0);
    const nodeId = active.nodes![0].id!;
    const valueBefore = active.nodes![0].value;
    // The route's own call shape: target BCS/degree/KCSE, but the node
    // belongs to the ACTIVE set, not a draft.
    expect(repo.updateRuleNodeIfDraft(nodeId, "BCS", "degree", "KCSE", { value: "D" })).toBe(false);
    expect(repo.deleteRuleNodeIfDraft(nodeId, "BCS", "degree", "KCSE")).toBe(false);
    const after = repo.activeSetsForProgramme("BCS").find((s) => s.system === "KCSE")!;
    expect(after.nodes![0].value).toBe(valueBefore);
    expect(after.nodes!.length).toBe(active.nodes!.length);
  });

  it("a node from a DIFFERENT course's set is refused for this target", () => {
    const bcsActive = repo.activeSetsForProgramme("BCS").find((s) => s.system === "KCSE")!;
    const foreignNode = bcsActive.nodes![0].id!;
    expect(repo.updateRuleNodeIfDraft(foreignNode, "BBA", "degree", "KCSE", { value: "A" })).toBe(false);
    expect(repo.deleteRuleNodeIfDraft(foreignNode, "BBA", "degree", "KCSE")).toBe(false);
    // …and a node of the matching course's DRAFT is reachable for that target.
    const draft = repo.ensureDraftSet("BBA", "degree", "KCSE", "test");
    const node = repo.addRuleNode(draft.id, null, "condition");
    expect(repo.updateRuleNodeIfDraft(node, "BBA", "degree", "KCSE", { value: "B" })).toBe(true);
    const own = repo.getRuleSetNodes(draft.id).find((n) => n.id === node)!;
    expect(own.value).toBe("B");
    expect(repo.deleteRuleNodeIfDraft(node, "BBA", "degree", "KCSE")).toBe(true);
    expect(repo.getRuleSetNodes(draft.id).some((n) => n.id === node)).toBe(false);
  });

  it("a node of a RETIRED set is refused too (versioning is one-way)", () => {
    const bbaDraft = repo.ensureDraftSet("BBA", "degree", "KCSE", "test");
    const node = repo.addRuleNode(bbaDraft.id, null, "condition");
    repo.updateRuleNode(node, { value: "B" });
    repo.activateDraftSet(bbaDraft.id)!; // retires the previous active set
    const retired = repo
      .db.prepare("SELECT id FROM admission_rules WHERE programme = 'BBA' AND system = 'KCSE' AND status = 'retired'")
      .all() as Array<{ id: number }>;
    expect(retired.length).toBeGreaterThan(0);
    const retiredNodes = repo.getRuleSetNodes(retired[0].id);
    expect(retiredNodes.length).toBeGreaterThan(0);
    expect(repo.updateRuleNodeIfDraft(retiredNodes[0].id!, "BBA", "degree", "KCSE", { value: "A" })).toBe(false);
  });

  it("the web route refuses a foreign node id and leaves the active set intact", async () => {
    const { base, cookie, csrf } = await startServer();
    const active = repo.activeSetsForProgramme("BCS").find((s) => s.system === "KCSE")!;
    const before = JSON.stringify(active.nodes!);
    const foreignNode = active.nodes![0].id!;
    const res = await fetch(
      `${base}/config/requirements/node-save`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        // Target BBA, but the node belongs to BCS's ACTIVE KCSE set.
        body: `_csrf=${csrf}&target=BBA&system=KCSE&node=${foreignNode}&field=mean_grade&comparator=%3E%3D&value=D`,
        redirect: "manual",
      }
    );
    expect(res.status).toBe(302);
    const location = decodeURIComponent(String(res.headers.get("location")));
    expect(location).toContain("does not belong to this course's draft");
    const after = repo.activeSetsForProgramme("BCS").find((s) => s.system === "KCSE")!;
    expect(JSON.stringify(after.nodes!)).toBe(before);
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
