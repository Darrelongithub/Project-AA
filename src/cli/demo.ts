/**
 * `npm run demo` — populate the configured database (default
 * ./data/email-sorter.sqlite — the same file `npm run serve` reads) with the
 * full simulation corpus (real PDFs through the real pipeline) plus a few
 * manual touches, so `npm run serve` has a living Admissions Command Center
 * to show.
 *
 * The demo DB is ALWAYS rebuilt from scratch (schema migrations included).
 */
import * as fs from "fs";
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { runSimulation } from "../simulation/run";
import { runEscalationSweep } from "../web/server";
import { hashPassword } from "../util/password";

async function main(): Promise<void> {
  const cfg = loadConfig();
  // SAME default path `npm run serve` reads from (loadConfig) — demo used to
  // write ./data/demo.sqlite while serve read ./data/email-sorter.sqlite, so
  // following the README produced an empty console.
  const dbPath = process.env.DB_PATH || cfg.dbPath;

  // Fresh start: remove any old demo database (and its WAL sidecars).
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix);
    } catch {
      /* didn't exist */
    }
  }

  const repo = new Repo(openDb(dbPath));
  seedDefaults(repo);

  console.log(`demo: running simulation against ${dbPath} …`);
  const result = await runSimulation({ dbPath, disableOcr: process.env.DISABLE_OCR === "1" });
  console.log(`demo: simulation finished — ${result.passedChecks}/${result.totalChecks} checks passed`);

  // ── Manual touches so the demo feels like a working office ──────────────
  const queued = repo.queueView();
  const jane = repo.getStaffByUsername("jane");

  if (queued.length > 0 && jane) {
    const first = queued[0];
    repo.updateApplicant(first.id, { assigned_to: jane.id });
    repo.addNote(first.id, jane.id, "Applicant called. Waiting for the original certificate.");
    // v3: cases carry work items, not just statuses.
    repo.addTask(first.id, "Verify KCSE certificate with KNEC", jane.id);
    repo.addTask(first.id, "Contact applicant about the ID copy", jane.id);
    repo.audit(first.id, "jane", "case_assigned", "assigned during demo seeding");
  }

  // Backdate one queued case so it's overdue, then escalate it.
  if (queued.length > 1) {
    const victim = queued[1];
    const past = new Date(Date.now() - 10 * 3600_000).toISOString();
    repo.updateApplicant(victim.id, { sla_due_at: past });
    const escalationHours = Number(repo.getSetting("escalation_hours", "8"));
    runEscalationSweep(repo, escalationHours);
  }

  // v3: an intake deadline for the NEXT round (late arrivals get flagged).
  repo.setIntakeDeadline("January 2027", "2027-01-15T23:59:59Z");

  // A couple of staff accounts always help the pitch.
  if (!repo.getStaffByUsername("admin")) {
    repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
  }

  const portalCandidate = repo.allApplicants().find((a) => a.lifecycle === "documents_received" && a.triage === "Red");

  console.log("\ndemo: done. Now run:\n\n  npm run serve\n");
  console.log("then open the printed URL and sign in as admin/admin123 (or jane/jane123, kofi/kofi123 for IT).");
  console.log(`Applicant status page: /status — try ${queued[0]?.ref_number ?? "a reference"} with its email.`);
  if (portalCandidate) {
    console.log(`Applicant portal: /portal — try ${portalCandidate.ref_number} with ${portalCandidate.email_address} (demo mode shows the code on screen).`);
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
