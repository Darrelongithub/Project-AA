/**
 * Round 18 — admissions rules engine: the 14 mandated scenarios.
 *
 * Design principle under test: rules engine → evaluation → routing →
 * human intervention. Clearly qualified applicants are auto-admitted;
 * everything ambiguous lands with a human; missing data is NEVER failure;
 * and the word "rejected" does not exist anywhere in the flow.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { evaluateAdmission } from "../src/admissions/evaluate";
import { evaluateTree, readerFromFields } from "../src/admissions/engine";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { DocType, ExtractedFields } from "../src/types";

let repo: Repo;
let server: Server;
let base = "";
let seq = 0;

beforeAll(async () => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo); // seeds programmes, KCSE subject catalogue + ACTIVE v1 rule sets
  // OR-1: no seeded accounts — provision the admin like first-run setup does.
  repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);

  const ctx: PipelineContext = {
    repo,
    adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
  };
  const app = createApp({ repo, ctx });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

function mkApplicant(programme: string | null): number {
  seq += 1;
  const res = repo.db
    .prepare(
      `INSERT INTO applicants (ref_number, email_address, thread_id, full_name, programme)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(`AT-2026-${String(seq).padStart(6, "0")}`, `adm${seq}@example.org`, `thr-${seq}`, `Adm Test ${seq}`, programme);
  return Number(res.lastInsertRowid);
}

/** Insert a document set. The academic certificate carries the given fields. */
function mkDocs(
  id: number,
  opts: { types?: DocType[]; fields?: Partial<ExtractedFields>; score?: number; examSystem?: string } = {}
): void {
  const types = opts.types ?? ["academic_cert", "id", "application_form"];
  const score = opts.score ?? 98;
  for (const t of types) {
    const fields: ExtractedFields =
      t === "academic_cert"
        ? { name: "Adm Test", examSystem: (opts.examSystem ?? "KCSE") as ExtractedFields["examSystem"], ...opts.fields }
        : { name: "Adm Test" };
    repo.insertDocument({
      applicant_id: id,
      document_type: t,
      source_email_id: `e-${id}-${t}`,
      extraction_method: "pdf_text",
      extracted_text: `${t} text`,
      extracted_fields: fields,
      confidence: score >= 75 ? "high" : "low",
      confidence_score: score,
      received_at: new Date().toISOString(),
    });
  }
}

/** The seeded BSc Computer Science KCSE route: mean ≥ C+ AND (Maths ∨ Physics ∨ Physical Sciences ≥ C+). */
const QUALIFIED = { meanGrade: "B", subjectGrades: { Mathematics: "C+", Physics: "B", English: "B" } };

describe("admissions rules engine (round 18)", () => {
  it("1. fully qualified applicant → AUTO-ADMIT, recorded as automated", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: QUALIFIED });
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("passed");
    expect(report.routing).toBe("auto_admit");
    expect(report.reasonCode).toBe("qualified");
    expect(report.leaves.some((l) => l.label === "Mean grade" && l.status === "passed")).toBe(true);
  });

  it("2. one failed standard requirement → HUMAN REVIEW, never auto-reject", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "B", subjectGrades: { Mathematics: "D", Physics: "D" } } });
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("failed");
    expect(report.routing).toBe("human_review"); // NOT a rejection — a routing decision
    expect(report.reasonCode).toBe("requirement_not_satisfied");
    expect(report.reason).toContain("Human review required");
    const math = report.leaves.find((l) => l.label === "Mathematics")!;
    expect(math.status).toBe("failed");
    const a = repo.getApplicant(id)!;
    expect(a.admission_decision).toBe("undecided"); // nothing decided automatically
  });

  it("3. OR-condition satisfied through an alternative subject → AUTO-ADMIT", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "C+", subjectGrades: { Mathematics: "C", Physics: "C+", English: "B" } } });
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("passed");
    expect(report.routing).toBe("auto_admit");
    const math = report.leaves.find((l) => l.label === "Mathematics")!;
    expect(math.status).toBe("failed"); // failed, yet the OR group passes…
    const alt = report.groups.find((g) => g.via === "Physics") ?? report.leaves.find((l) => l.label === "Physics");
    expect(alt).toBeTruthy(); // …through Physics
  });

  it("4. missing required document → WAITING FOR DOCUMENTS, never failure", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { types: ["academic_cert", "application_form"], fields: QUALIFIED }); // no National ID
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("missing_data");
    expect(report.routing).toBe("waiting_documents");
    expect(report.missingDocuments.join(",")).toContain("National ID");
    // Absence is explicitly NOT interpreted as failure.
    expect(report.reason).toContain("never treated as failure");
  });

  it("5. missing academic result → waiting or human review BY CAUSE", () => {
    // (a) no academic document at all → waiting for documents
    const noDoc = mkApplicant("BCS");
    mkDocs(noDoc, { types: ["id", "application_form"] });
    const r1 = evaluateAdmission(repo, noDoc).report;
    expect(r1.result).toBe("missing_data");
    expect(r1.routing).toBe("waiting_documents");

    // (b) certificate present but the grade could not be read → human review
    const unread = mkApplicant("BCS");
    mkDocs(unread, { fields: { subjectGrades: { Mathematics: "C+" } } }); // no mean grade
    const r2 = evaluateAdmission(repo, unread).report;
    expect(r2.result).toBe("needs_verification");
    expect(r2.routing).toBe("human_review");
    expect(r2.reasonCode).toBe("missing_result");
  });

  it("6. low-confidence extraction → HUMAN REVIEW, never auto-admit", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: QUALIFIED, score: 52 }); // below the 75 auto-pass threshold
    const { report, derivedFlags } = evaluateAdmission(repo, id);
    expect(report.result).toBe("needs_verification");
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("low_confidence_extraction");
    expect(report.reason).toContain("requires verification");
    expect(report.routing).not.toBe("auto_admit");
    expect(derivedFlags.some((f) => f.type === "low_confidence")).toBe(true);
  });

  it("7. qualified + late-submission flag → HUMAN REVIEW despite passing academics", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: QUALIFIED });
    const { report } = evaluateAdmission(repo, id, [{ type: "late_submission", detail: "arrived after the deadline" }]);
    expect(report.result).toBe("passed"); // academics still PASSED…
    expect(report.routing).toBe("human_review"); // …but a human decides
    expect(report.reasonCode).toBe("late_submission");
    expect(report.blockingFlags).toContain("late_submission");
  });

  it("8. qualified + another blocking flag → HUMAN REVIEW", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: QUALIFIED });
    const { report } = evaluateAdmission(repo, id, [{ type: "name_mismatch", detail: "documents disagree" }]);
    expect(report.result).toBe("passed");
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("manual_decision_required");
  });

  it("9. alternative qualification route is evaluated (diploma into a degree)", () => {
    const id = mkApplicant("BCS"); // BCS has a DIPLOMA route (min class: Credit)
    mkDocs(id, { examSystem: "DIPLOMA", fields: { classAwarded: "Credit" } });
    const { report } = evaluateAdmission(repo, id);
    expect(report.system).toBe("DIPLOMA");
    expect(report.result).toBe("passed");
    expect(report.routing).toBe("auto_admit");
  });

  it("10. a human can ADMIT a standard-rule failure, audited as a human decision", async () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "B", subjectGrades: { Mathematics: "D", Physics: "D" } } });
    const { report } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");

    const { cookie, csrf } = await loginAdmin();
    const res = await fetch(`${base}/case/${id}/admission-decision`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&decision=admit&route=approved_exception&reason=${encodeURIComponent("Mature applicant with 6 years of recognised industry experience.")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const a = repo.getApplicant(id)!;
    expect(a.admission_decision).toBe("admitted_after_review");
    expect(a.admission_route).toBe("human"); // NEVER represented as automated
    expect(a.decision_by).toBe("admin");
    expect(a.decision_reason).toContain("Approved exception");
    const audit = repo.auditForApplicant(id);
    const ev = audit.find((x) => x.event === "human_admission_decision");
    expect(ev).toBeTruthy();
    expect(ev!.detail).toContain("Admitted after Human Review");
    expect(ev!.detail).toContain("reviewer: ");
    // The underlying evaluation is NOT overwritten.
    expect(repo.latestEvaluation(id)!.result).toBe("failed");
  });

  it("11. a human can DECLINE a case, audited as a human decision", async () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "B", subjectGrades: { Mathematics: "D", Physics: "D" } } });
    evaluateAdmission(repo, id);

    const { cookie, csrf } = await loginAdmin();
    const res = await fetch(`${base}/case/${id}/admission-decision`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${csrf}&decision=decline&reason=${encodeURIComponent("Does not meet the published requirement and no exception applies.")}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const a = repo.getApplicant(id)!;
    expect(a.admission_decision).toBe("not_admitted");
    expect(a.admission_route).toBe("human");
    expect(repo.auditForApplicant(id).some((x) => x.event === "human_admission_decision" && x.detail.includes("Not Admitted"))).toBe(true);
    expect(repo.latestEvaluation(id)!.result).toBe("failed"); // evaluation preserved
  });

  it("12. a frozen historical requirement set does not change when configuration changes", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "C+", subjectGrades: { Mathematics: "C+", English: "B" } } });
    const first = evaluateAdmission(repo, id).report;
    expect(first.setVersion).toBe(1);
    const frozenRules = repo.getApplicant(id)!.admission_rules_frozen;
    expect(frozenRules).toBeTruthy();

    // Admin tightens BCS/KCSE to mean ≥ A and activates the new version.
    const draft = repo.ensureDraftSet("BCS", "degree", "KCSE", "admin");
    const meanLeaf = repo.getRuleSetNodes(draft.id).find((n) => n.kind === "condition" && n.field === "mean_grade");
    expect(meanLeaf).toBeTruthy();
    repo.updateRuleNode(meanLeaf!.id!, { value: "A" });
    const activated = repo.activateDraftSet(draft.id)!;
    expect(activated.version).toBe(2);

    // A NEW applicant is judged by v2 (now failing)…
    const fresh = mkApplicant("BCS");
    mkDocs(fresh, { fields: { meanGrade: "C+", subjectGrades: { Mathematics: "C+", English: "B" } } });
    expect(evaluateAdmission(repo, fresh).report.setVersion).toBe(2);
    expect(evaluateAdmission(repo, fresh).report.result).toBe("failed");

    // …while the historical case keeps its frozen v1 verdict and rules.
    const again = evaluateAdmission(repo, id).report;
    expect(again.setVersion).toBe(1);
    expect(again.result).toBe("passed");
    expect(repo.getApplicant(id)!.admission_rules_frozen).toBe(frozenRules);

    // Restore the published BCS route (v3) for the remaining scenarios.
    const restore = repo.ensureDraftSet("BCS", "degree", "KCSE", "admin");
    const meanLeaf2 = repo.getRuleSetNodes(restore.id).find((n) => n.kind === "condition" && n.field === "mean_grade");
    repo.updateRuleNode(meanLeaf2!.id!, { value: "C+" });
    expect(repo.activateDraftSet(restore.id)!.version).toBe(3);
  });

  it("13. auto-admission and human admission are recorded separately", () => {
    // Automated path: simulate the pipeline's recorded admission.
    const autoId = mkApplicant("BCS");
    mkDocs(autoId, { fields: QUALIFIED });
    const { report } = evaluateAdmission(repo, autoId);
    expect(report.routing).toBe("auto_admit");
    repo.updateApplicant(autoId, {
      admission_decision: "auto_admitted", admission_route: "automated",
      decision_by: "system", decision_reason: "All configured requirements satisfied",
      decision_at: new Date().toISOString(),
    });
    repo.audit(autoId, "system", "auto_admission_triggered", "set v1: evaluated automatically");

    // Human path via the real endpoint.
    return (async () => {
      const humanId = mkApplicant("BCS");
      mkDocs(humanId, { fields: { meanGrade: "B", subjectGrades: { Mathematics: "D", Physics: "D" } } });
      evaluateAdmission(repo, humanId);
      const { cookie, csrf } = await loginAdmin();
      await fetch(`${base}/case/${humanId}/admission-decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `_csrf=${csrf}&decision=admit&route=special_consideration&reason=${encodeURIComponent("Special consideration granted by the admissions board.")}`,
        redirect: "manual",
      });

      const auto = repo.getApplicant(autoId)!;
      const human = repo.getApplicant(humanId)!;
      expect(auto.admission_route).toBe("automated");
      expect(auto.decision_by).toBe("system");
      expect(human.admission_route).toBe("human");
      expect(human.decision_by).toBe("admin");
      expect(auto.admission_route).not.toBe(human.admission_route);
      expect(repo.auditForApplicant(autoId).some((x) => x.event === "auto_admission_triggered")).toBe(true);
      expect(repo.auditForApplicant(humanId).some((x) => x.event === "human_admission_decision")).toBe(true);
    })();
  });

  it("14. results are reproducible from the stored rule version + applicant data", () => {
    const id = mkApplicant("BCS");
    mkDocs(id, { fields: { meanGrade: "C+", subjectGrades: { Mathematics: "C", Physics: "B+", English: "B" } } });
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("passed"); // via Physics alternative

    // Replay: stored rule snapshot + the applicant's stored extracted values.
    const row = repo.evaluationsForApplicant(id).at(-1)!;
    const stored = repo.db
      .prepare("SELECT rule_snapshot FROM evaluations WHERE id = (SELECT MAX(id) FROM evaluations WHERE applicant_id = ?)")
      .get(id) as { rule_snapshot: string };
    const snapshot = JSON.parse(stored.rule_snapshot) as { nodes: import("../src/types").RuleNode[] };
    expect(row.set_version).toBe(report.setVersion);

    const doc = repo.listDocuments(id, { activeOnly: true }).find((d) => d.document_type === "academic_cert")!;
    const fields = doc.extracted_fields as ExtractedFields;
    const replay = evaluateTree(snapshot.nodes, report.system!, readerFromFields(fields, true));
    expect(replay.result).toBe("passed");
    expect(replay.rulesSatisfied).toBe(report.rulesSatisfied);
    expect(replay.rulesTotal).toBe(report.rulesTotal);
    for (const leaf of report.leaves) {
      const twin = replay.leaves.find((l) => l.label === leaf.label);
      expect(twin?.status).toBe(leaf.status);
      expect(twin?.applicantValue).toBe(leaf.applicantValue);
    }
  });
});

async function loginAdmin(): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin123",
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  const csrf = (html.match(/<meta name="csrf" content="([a-f0-9]+)">/) || [])[1] || "";
  return { cookie, csrf };
}
