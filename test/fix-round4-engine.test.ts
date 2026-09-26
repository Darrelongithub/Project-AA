/**
 * Round 4 — admissions engine hardening (security audit items 1–5):
 *
 *  E1  frozenAt must record a REAL freeze time (dead `? null : null` line).
 *  E2  An EMPTY rule tree (zero conditions) must never auto-admit — a
 *      staff edit that empties a tree by mistake must not let applicants
 *      pass with zero academic checks.
 *  E3  Unknown / never-inferred programme must NOT silently apply the
 *      degree-level floors — human decides the ladder.
 *  E4  Multi-system ranking must not prefer "failed" over "undetermined":
 *      an unread route that might be the applicant's real system beats a
 *      confirmed failure on another route.
 *  E5  A second academic document with no identifiable system must force
 *      human review (documented companion files like the KCPE certificate
 *      are exempt).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { DEFAULT_REQUIREMENTS } from "../src/config";
import { evaluateAdmission } from "../src/admissions/evaluate";
import type { DocType, ExtractedFields } from "../src/types";

let repo: Repo;
let seq = 0;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
});

function mkApplicant(programme: string | null): number {
  seq += 1;
  const res = repo.db
    .prepare(
      `INSERT INTO applicants (ref_number, email_address, thread_id, full_name, programme)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(`RT4-2026-${String(seq).padStart(6, "0")}`, `rt4${seq}@example.org`, `thr-rt4-${seq}`, `RT4 Test ${seq}`, programme);
  return Number(res.lastInsertRowid);
}

function mkDocs(id: number, specs: Array<{ type: DocType; fields?: Partial<ExtractedFields>; score?: number }>): void {
  specs.forEach((s, i) => {
    const score = s.score ?? 98;
    repo.insertDocument({
      applicant_id: id,
      document_type: s.type,
      source_email_id: `e-rt4-${id}-${i}`,
      extraction_method: "pdf_text",
      extracted_text: `${s.type} text`,
      extracted_fields: (s.fields ?? {}) as ExtractedFields,
      confidence: score >= 75 ? "high" : "low",
      confidence_score: score,
      received_at: new Date().toISOString(),
    });
  });
}

/** The seeded BSc Computer Science KCSE route: mean ≥ C+ AND (Maths ∨ Physics ∨ Physical Sciences ≥ C+). */
const QUALIFIED = { name: "RT4 X", examSystem: "KCSE" as const, meanGrade: "B", subjectGrades: { Mathematics: "C+", Physics: "B", English: "B" } };

/** Complete core file (official checklist) — the academic cert carries the fields. */
function completeFile(id: number, fields: Partial<ExtractedFields>, extra: Array<{ type: DocType; fields?: Partial<ExtractedFields>; score?: number }> = []): void {
  mkDocs(id, [
    { type: "academic_cert", fields },
    { type: "leaving_certificate" },
    { type: "passport_photo" },
    { type: "birth_cert" },
    { type: "id" },
    { type: "application_form" },
    ...extra,
  ]);
}

describe("E1 — the freeze time is actually recorded", () => {
  it("the report carries the real freeze timestamp, stable across re-evaluations", () => {
    const id = mkApplicant("BCS");
    completeFile(id, QUALIFIED);
    const first = evaluateAdmission(repo, id).report;
    expect(first.frozenAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(first.frozenAt!))).toBe(false);
    // it matches what was stored on the applicant row
    const row = repo.getApplicant(id) as unknown as { admission_rules_frozen_at: string | null };
    expect(row.admission_rules_frozen_at).toBe(first.frozenAt);

    // Change the LIVE rules after the freeze — the freeze time must not move.
    const draft = repo.ensureDraftSet("BCS", "degree", "KCSE", "system");
    const node = repo.getRuleSetNodes(draft.id).find((n) => n.kind === "condition" && n.field === "mean_grade")!;
    repo.updateRuleNode(node.id!, { value: "B" });
    repo.activateDraftSet(draft.id)!;
    const again = evaluateAdmission(repo, id).report;
    expect(again.frozenAt).toBe(first.frozenAt);
  });
});

describe("E2 — an empty rule tree never auto-admits", () => {
  it("a route whose active set has zero conditions routes to a human, with the reason recorded", () => {
    // The seeded university-wide degree-level DEGREE set has no conditions —
    // a recognised-degree entry into a degree course.
    const id = mkApplicant("BCS");
    completeFile(id, { name: "RT4 DEG", examSystem: "DEGREE", degreeTitle: "BSc PHYSICS", classAwarded: "FIRST CLASS" });
    const { report } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("empty_rule_set");
    expect(report.rulesTotal).toBe(0);
    expect((repo.getApplicant(id) as { admission_decision?: string }).admission_decision ?? "undecided").not.toBe("auto_admitted");
  });

  it("a staff edit that empties a previously-checked tree cannot open a zero-check auto-admission", () => {
    // Empty the MBA degree route (1 condition) by mistake…
    const draft = repo.ensureDraftSet("MBA", "masters", "DEGREE", "system");
    repo.db.prepare("DELETE FROM admission_rule_nodes WHERE set_id = ?").run(draft.id);
    repo.activateDraftSet(draft.id)!;
    const id = mkApplicant("MBA");
    mkDocs(id, [
      { type: "academic_cert", fields: { name: "RT4 MBA", examSystem: "DEGREE", degreeTitle: "BCom", classAwarded: "SECOND CLASS HONOURS (UPPER DIVISION)" } },
      { type: "undergraduate_degree_certificate" },
      { type: "passport_photo" },
      { type: "birth_cert" },
      { type: "id" },
      { type: "application_form" },
    ]);
    const { report, derivedFlags } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("empty_rule_set");
    expect(derivedFlags.length).toBeGreaterThan(0); // visible in the queue, not silent
  });
});

describe("E3 — unknown programme is human territory, not degree-floor territory", () => {
  it("a never-inferred programme is judged against NO ladder and not frozen", () => {
    const id = mkApplicant(null);
    completeFile(id, QUALIFIED);
    const { report } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("programme_unidentified");
    // the degree-default ladder must not have been frozen as the goalposts
    expect(repo.getApplicant(id)!.admission_rules_frozen).toBeNull();
  });

  it("an unknown programme CODE is refused the same way; fixing the programme recovers", () => {
    const id = mkApplicant("NOPE");
    completeFile(id, QUALIFIED);
    const before = evaluateAdmission(repo, id).report;
    expect(before.reasonCode).toBe("programme_unidentified");

    repo.updateApplicant(id, { programme: "BCS" });
    const after = evaluateAdmission(repo, id).report;
    expect(after.routing).toBe("human_review");
    expect(after.frozenAt).toBeTruthy();
  });
});

describe("E4 — an unread route beats a confirmed failure", () => {
  it("failed(KCSE) + undetermined(IGCSE) → needs verification, not 'does not meet requirements'", () => {
    // A course with two active routes, built from scratch so the trees are
    // exactly one condition each: KCSE (mean ≥ A) and IGCSE (English ≥ A*).
    repo.addProgramme("ENGX", "BEng X", "School of Computing Sciences", "", "degree");
    const insSet = (system: string): number => {
      const r = repo.db
        .prepare("INSERT INTO admission_rules (programme, level, system, version, status, created_by) VALUES ('ENGX','degree',?,1,'active','test')")
        .run(system);
      return Number(r.lastInsertRowid);
    };
    const insNode = (setId: number, field: string, subject: string | null, value: string): void => {
      repo.db
        .prepare("INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, subject, comparator, value, position) VALUES (?,?, 'condition', NULL, ?, ?, '>=', ?, 0)")
        .run(setId, null, field, subject, value);
    };
    const kcseId = insSet("KCSE");
    insNode(kcseId, "mean_grade", null, "A");
    const igcseId = insSet("IGCSE");
    insNode(igcseId, "subject", "English", "A*");

    const id = mkApplicant("ENGX");
    mkDocs(id, [
      { type: "academic_cert", fields: { name: "RT4 RANK", examSystem: "KCSE", meanGrade: "B" } }, // fails KCSE (needs A)
      { type: "academic_cert", fields: { name: "RT4 RANK", examSystem: "IGCSE" } }, // English unreadable → undetermined
      { type: "leaving_certificate" },
      { type: "passport_photo" },
      { type: "birth_cert" },
      { type: "id" },
      { type: "application_form" },
    ]);
    const { report } = evaluateAdmission(repo, id);
    expect(report.result).toBe("needs_verification");
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).not.toBe("requirement_not_satisfied");
  });
});

describe("E5 — an unread academic document forces review", () => {
  it("a second certificate with no identifiable system withholds auto-admission", () => {
    const id = mkApplicant("BCS");
    completeFile(
      id,
      QUALIFIED,
      [{ type: "academic_cert", fields: { name: "RT4 SECOND" } }] // no examSystem — extraction failed
    );
    const { report, derivedFlags } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");
    expect(report.reasonCode).toBe("system_unidentified_partial");
    expect(derivedFlags.some((f) => f.type === "low_confidence")).toBe(true);
  });

  it("the KCPE companion certificate (never an entry route) does NOT block", () => {
    const id = mkApplicant("BCS");
    completeFile(
      id,
      QUALIFIED,
      [{ type: "kcpe_cert", fields: { name: "RT4 KCPE" } }]
    );
    const { report } = evaluateAdmission(repo, id);
    expect(report.routing).toBe("human_review");
  });
});
