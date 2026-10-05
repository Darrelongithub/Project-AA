/**
 * The `escalation_hours` setting.
 *
 * Both sweeps read it and passed it to `runEscalationSweep`, which only printed
 * the number into the audit line: case selection came exclusively from
 * `sla_due_at`, so the Settings field labelled “Escalation (hours before a case
 * is escalated)” changed nothing. The window is now what the sweep selects on —
 * measured from when the case was opened, independently of the SLA target — and
 * a case younger than the window stays unescalated however overdue its own
 * clock is.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { configureTestOrganization } from "./helpers";
import { runEscalationSweep } from "../src/web/server";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

describe("escalation window", () => {
  let repo: Repo;

  /** An unhandled case whose 4-hour response target ran out an hour ago. */
  function overdueCase(): { id: number; ref: string } {
    const a = repo.createCase({ emailAddress: `esc-${Math.random().toString(36).slice(2)}@example.test`, threadId: `t-${Math.random().toString(36).slice(2)}`, organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.setLifecycle(a.id, "awaiting_review", "system", "queued");
    repo.updateApplicant(a.id, { sla_due_at: hoursAgo(1), sla_handled_at: null });
    return { id: a.id, ref: repo.getApplicant(a.id)!.ref_number };
  }

  function ageCase(id: number, hours: number): void {
    repo.db.prepare("UPDATE applicants SET created_at = ? WHERE id = ?").run(hoursAgo(hours).replace("T", " ").slice(0, 19), id);
  }

  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    configureTestOrganization(repo);
    repo.createStaff("officer", "Olive Officer", "x", "user");
  });

  it("still escalates anything past its own clock when no window is given", () => {
    const { id } = overdueCase();
    expect(repo.overdueCases().map((r) => r.id)).toContain(id);
    expect(runEscalationSweep(repo, 0)).toBe(1);
    expect(repo.getApplicant(id)!.escalated).toBe(1);
  });

  it("holds a case back while the configured window has not run out", () => {
    const { id } = overdueCase();
    expect(repo.getApplicant(id)!.sla_due_at! < new Date().toISOString()).toBe(true);
    expect(runEscalationSweep(repo, 8)).toBe(0);
    const after = repo.getApplicant(id)!;
    expect(after.escalated).toBe(0);
    expect(after.priority).toBe("normal");
    // …and the case is still visible as overdue, so nobody loses the signal.
    expect(repo.overdueCases(0).map((r) => r.id)).toContain(id);
  });

  it("escalates once the window has run out, and only once", () => {
    const { id, ref } = overdueCase();
    ageCase(id, 9); // opened 9 h ago, past an 8-hour window
    expect(runEscalationSweep(repo, 8)).toBe(1);
    const after = repo.getApplicant(id)!;
    expect(after.escalated).toBe(1);
    expect(after.priority).toBe("urgent");
    const audit = repo.db.prepare("SELECT detail FROM audit_log WHERE applicant_id = ? AND event = 'escalated'").get(id) as { detail: string };
    expect(audit.detail).toContain("8 h");
    const notices = repo.db.prepare("SELECT message FROM notifications WHERE applicant_id = ?").all(id) as Array<{ message: string }>;
    expect(notices.some((n) => n.message.includes(ref))).toBe(true);
    // The escalated flag is the idempotency guard for the next five-minute tick.
    expect(runEscalationSweep(repo, 8)).toBe(0);
  });

  it("leaves handled and closed cases alone whatever the window", () => {
    const { id } = overdueCase();
    repo.updateApplicant(id, { sla_handled_at: new Date().toISOString() });
    ageCase(id, 30);
    expect(runEscalationSweep(repo, 8)).toBe(0);
    const other = overdueCase();
    ageCase(other.id, 30);
    repo.setLifecycle(other.id, "completed", "officer", "closed by hand");
    expect(runEscalationSweep(repo, 8)).toBe(0);
  });

  it("treats a corrupt or negative window as no window", () => {
    const { id } = overdueCase();
    ageCase(id, 1);
    expect(repo.overdueCases(Number.NaN).map((r) => r.id)).toContain(id);
    expect(repo.overdueCases(-4).map((r) => r.id)).toContain(id);
  });
});
