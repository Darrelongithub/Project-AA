import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";

let repo: Repo;

beforeEach(() => {
  repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  configureTestOrganization(repo);
});

afterEach(() => repo.db.close());

function createCase(): number {
  return repo.createCase({
    emailAddress: "decision@example.test",
    threadId: "decision-thread",
    organizationId: 1,
    caseTypeCode: "SERVICE_REQUEST",
  }).id;
}

describe("decision provenance boundary", () => {
  it("rejects direct generic outcome/provenance writes without changing the row or audit", () => {
    const id = createCase();

    // This is the exact previously successful forgery probe.
    expect(() => {
      // @ts-expect-error outcome writes are reserved for recordHumanOutcome
      repo.updateCase(id, { outcome: "approved_after_review" });
    }).toThrow(/updateCase: refusing unknown column/);

    const genericApplicantUpdate = repo.updateApplicant as unknown as (
      applicantId: number,
      patch: Record<string, unknown>
    ) => void;
    expect(() => genericApplicantUpdate(id, {
      outcome: "approved_after_review",
      outcome_route: "human",
      decision_by: "forged-actor",
      decision_reason: "unreviewed direct write",
      decision_at: new Date().toISOString(),
    })).toThrow(/updateApplicant: refusing unknown column/);

    expect(repo.getCase(id)).toMatchObject({
      outcome: "undecided",
      outcome_route: null,
      decision_by: null,
      decision_reason: null,
      decision_at: null,
    });
    expect(repo.auditForApplicant(id).some((entry) => entry.event === "human_outcome_recorded")).toBe(false);
  });

  it("records an outcome and all required provenance atomically through the typed path", () => {
    const id = createCase();
    repo.recordHumanOutcome(id, {
      outcome: "approved_after_review",
      actor: "officer",
      reason: "Identity and supporting evidence verified",
    });

    expect(repo.getCase(id)).toMatchObject({
      outcome: "approved_after_review",
      outcome_route: "human",
      decision_by: "officer",
      decision_reason: "Identity and supporting evidence verified",
      lifecycle: "completed",
    });
    expect(repo.getCase(id)!.decision_at).toBeTruthy();
    expect(repo.auditForApplicant(id).filter((entry) => entry.event === "human_outcome_recorded")).toHaveLength(1);
    expect(repo.statusHistory(id).at(-1)).toMatchObject({
      to_status: "completed",
      actor: "officer",
      reason: "Identity and supporting evidence verified",
    });
  });
});
