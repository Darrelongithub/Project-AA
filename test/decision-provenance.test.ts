/**
 * Phase 2 — decision provenance: outcomes can only be produced through the
 * one typed path (src/decisions.ts) that records who decided.
 *
 * - Repo.recordDecision is the only outcome writer; it accepts only genuine
 *   Decision instances (forged plain objects / prototype hacks throw).
 * - Decision.auto can only produce auto_approved; Decision.human requires a
 *   username and can never claim auto_* provenance.
 * - Automated decisions throw unless the organization's policy flags allow
 *   them (single enforcement point: autoDecisionsAllowed). Human decisions
 *   are never gated by those flags.
 * - The generic writers reject outcomes: updateApplicant refuses decision
 *   columns, updateCase accepts only a Decision.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { Decision, autoDecisionsAllowed } from "../src/decisions";

let repo: Repo;
let n = 0;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
});

function mkApplicant(): number {
  n += 1;
  return repo.getOrCreateApplicant(`prov-${n}@example.org`, `prov-thread-${n}`).id;
}

describe("the typed decision path", () => {
  it("a genuine auto Decision lands with auto provenance (generic + legacy mirrors)", () => {
    const id = mkApplicant();
    expect(autoDecisionsAllowed(repo, id)).toBe(true); // seeded org-1 profile opts in
    repo.recordDecision(id, Decision.auto({ outcome: "auto_approved", reasoning: "qualified automatically" }));
    const a = repo.getApplicant(id)!;
    expect(a.outcome).toBe("auto_approved");
    expect(a.admission_decision).toBe("auto_admitted");
    expect(a.admission_route).toBe("auto");
    expect(a.decision_by).toBeNull();
    expect(a.decision_reason).toBe("qualified automatically");
    expect(a.decision_at).toBeTruthy();
  });

  it("a genuine human Decision lands with human provenance (admit + decline)", () => {
    const admit = mkApplicant();
    repo.recordDecision(admit, Decision.human({ outcome: "approved_after_review", reasoning: "Standard review: solid file", decidedBy: "registrar" }));
    const a = repo.getApplicant(admit)!;
    expect(a.outcome).toBe("approved_after_review");
    expect(a.admission_decision).toBe("admitted_after_review");
    expect(a.admission_route).toBe("human");
    expect(a.decision_by).toBe("registrar");

    const decline = mkApplicant();
    repo.recordDecision(decline, Decision.human({ outcome: "not_approved", reasoning: "Standard review: forged certificate", decidedBy: "registrar" }));
    const d = repo.getApplicant(decline)!;
    expect(d.outcome).toBe("not_approved");
    expect(d.admission_decision).toBe("not_admitted");
    expect(d.admission_route).toBe("human");
    expect(d.decision_by).toBe("registrar");
  });

  it("human decisions are never gated by the auto-decision policy flags", () => {
    const id = mkApplicant();
    repo.setAutomationMode("normal", "draft"); // auto path now forbidden…
    expect(autoDecisionsAllowed(repo, id)).toBe(false);
    expect(() => repo.recordDecision(id, Decision.auto({ outcome: "auto_approved", reasoning: "x" }))).toThrow(/policy flags/);
    // …but the human path still records.
    repo.recordDecision(id, Decision.human({ outcome: "not_approved", reasoning: "Standard review: declined", decidedBy: "registrar" }));
    expect(repo.getApplicant(id)!.admission_decision).toBe("not_admitted");
  });
});

describe("outcomes cannot be written outside the typed path", () => {
  it("a forged plain-object outcome is refused and nothing lands", () => {
    const id = mkApplicant();
    const forged = { outcome: "auto_approved", source: "rules-auto", reasoning: "trust me", decidedBy: null };
    expect(() => repo.recordDecision(id, forged as unknown as Decision)).toThrow(/not a genuine Decision/);
    expect(repo.getApplicant(id)!.outcome).toBe("undecided");
    expect(repo.getApplicant(id)!.admission_decision).toBe("undecided");
  });

  it("a prototype forgery (Object.create) is refused", () => {
    const id = mkApplicant();
    const forged = Object.create(Decision.prototype) as Decision;
    (forged as unknown as Record<string, unknown>).outcome = "auto_approved";
    (forged as unknown as Record<string, unknown>).source = "rules-auto";
    (forged as unknown as Record<string, unknown>).reasoning = "trust me";
    (forged as unknown as Record<string, unknown>).decidedBy = null;
    expect(Decision.isGenuine(forged)).toBe(false);
    expect(() => repo.recordDecision(id, forged)).toThrow(/not a genuine Decision/);
    expect(repo.getApplicant(id)!.admission_decision).toBe("undecided");
  });

  it("direct construction is refused even through an any-cast", () => {
    expect(() => new (Decision as unknown as new () => Decision)()).toThrow(/refusing direct construction/);
  });

  it("the factories validate their inputs", () => {
    expect(() => Decision.auto({ outcome: "auto_approved", reasoning: "  " })).toThrow(/reasoning is required/);
    expect(() => Decision.auto({ outcome: "not_approved", reasoning: "x" } as unknown as { outcome: "auto_approved"; reasoning: string })).toThrow(/refusing outcome/);
    expect(() => Decision.human({ outcome: "not_approved", reasoning: "", decidedBy: "r" })).toThrow(/reasoning is required/);
    expect(() => Decision.human({ outcome: "not_approved", reasoning: "x", decidedBy: "  " })).toThrow(/decidedBy/);
    // A human can never claim automated provenance.
    expect(() => Decision.human({ outcome: "auto_approved", reasoning: "x", decidedBy: "r" } as unknown as { outcome: "not_approved"; reasoning: string; decidedBy: string })).toThrow(/refusing outcome/);
  });

  it("updateApplicant refuses decision columns (runtime) and rejects them (types)", () => {
    const id = mkApplicant();
    expect(() => repo.updateApplicant(id, { admission_decision: "not_admitted" } as never)).toThrow(/use recordDecision/);
    expect(() => repo.updateApplicant(id, { decision_by: "mallory" } as never)).toThrow(/use recordDecision/);
    expect(repo.getApplicant(id)!.admission_decision).toBe("undecided");
    // @ts-expect-error — decision columns are not part of the patch type
    expect(() => repo.updateApplicant(id, { admission_decision: "not_admitted" })).toThrow(/use recordDecision/);
  });

  it("updateCase accepts only a Decision, never a raw outcome string", () => {
    const id = mkApplicant();
    repo.updateCase(id, { outcome: Decision.human({ outcome: "not_approved", reasoning: "Standard review: no", decidedBy: "r" }) });
    expect(repo.getApplicant(id)!.outcome).toBe("not_approved");
    const id2 = mkApplicant();
    // @ts-expect-error — raw outcome strings are not accepted
    expect(() => repo.updateCase(id2, { outcome: "not_approved" })).toThrow(/not a genuine Decision/);
    expect(repo.getApplicant(id2)!.outcome).toBe("undecided");
  });
});

describe("auto-decisions are impossible unless policy flags allow", () => {
  it("draft automation forbids auto-decisions", () => {
    const id = mkApplicant();
    repo.setAutomationMode("normal", "draft");
    expect(() => repo.recordDecision(id, Decision.auto({ outcome: "auto_approved", reasoning: "x" }))).toThrow(/policy flags/);
    expect(repo.getApplicant(id)!.admission_decision).toBe("undecided");
  });

  it("a profile without the auto_admit opt-in forbids auto-decisions", () => {
    const id = mkApplicant();
    const profile = repo.caseTypeForCase(id)!;
    repo.updateCaseTypeProfile(profile.id, { auto_admit: 0 });
    expect(autoDecisionsAllowed(repo, id)).toBe(false);
    expect(() => repo.recordDecision(id, Decision.auto({ outcome: "auto_approved", reasoning: "x" }))).toThrow(/policy flags/);
    expect(repo.getApplicant(id)!.admission_decision).toBe("undecided");
  });

  it("a draft/hold reply posture forbids auto-decisions", () => {
    const id = mkApplicant();
    const profile = repo.caseTypeForCase(id)!;
    repo.updateCaseTypeProfile(profile.id, { default_reply_action: "draft" });
    expect(autoDecisionsAllowed(repo, id)).toBe(false);
    expect(() => repo.recordDecision(id, Decision.auto({ outcome: "auto_approved", reasoning: "x" }))).toThrow(/policy flags/);
  });
});
