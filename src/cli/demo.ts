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

  // ── Demo accounts — separate from the real ones ─────────────────────────
  // demo_admin / demo_user belong to the mock dataset (demo flag = 1).
  // The plain `admin` account created by seedDefaults is the REAL
  // administrator: same database, no demo flag, no mock ownership.
  repo.createStaff("demo_admin", "Darrel", hashPassword("demo123"), "admin", true);
  repo.createStaff("demo_user", "Jane Wairimu", hashPassword("demo123"), "officer", true);

  console.log(`demo: running simulation against ${dbPath} …`);
  const result = await runSimulation({ dbPath, disableOcr: process.env.DISABLE_OCR === "1" });
  console.log(`demo: simulation finished — ${result.passedChecks}/${result.totalChecks} checks passed`);

  // ── Manual touches so the demo feels like a working office ──────────────
  const queued = repo.queueView();
  const demoUser = repo.getStaffByUsername("demo_user");

  if (queued.length > 0 && demoUser) {
    const first = queued[0];
    repo.updateApplicant(first.id, { assigned_to: demoUser.id });
    repo.addNote(first.id, demoUser.id, "Applicant called. Waiting for the original certificate.");
    // v3: cases carry work items, not just statuses.
    repo.addTask(first.id, "Verify KCSE certificate with KNEC", demoUser.id);
    repo.addTask(first.id, "Contact applicant about the ID copy", demoUser.id);
    repo.audit(first.id, "demo_user", "case_assigned", "assigned during demo seeding");
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

  // Marks this database as the demo dataset. The web console shows the
  // "Demo workspace" banner ONLY while this flag is set — a database you
  // start fresh (production) never shows it.
  repo.setSetting("demo_dataset", "1");

  // Course ownership in the demo: the demo user handles two courses; the
  // other two stay unassigned so the assignment flow is visible.
  const ownerFor: Record<string, string> = { BCS: "demo_user", BBIT: "demo_user" };
  for (const [code, username] of Object.entries(ownerFor)) {
    const member = repo.getStaffByUsername(username);
    if (member) {
      repo.assignProgrammeOwner(code, member.id);
      repo.audit(null, "demo_admin", "course_owner_changed", `${code} → ${member.display_name} (demo seeding)`);
    }
  }

  console.log("\ndemo: done. Now run:\n\n  npm run serve\n");
  console.log("Demo accounts (mock data):  demo_admin / demo123  ·  demo_user / demo123");
  console.log("Real administrator (same database, no demo flag):  admin / admin123");
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
