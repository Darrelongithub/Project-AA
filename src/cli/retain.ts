/**
 * `npm run retain` — data retention for student PII (v3 feature 38).
 *
 * Completed cases older than the configured `retention_days` setting are
 * archived to ./data/archive/<ref>.json (full case record, for audit) and
 * then removed from the live database. Cases that are not completed are
 * never touched. Default retention: 730 days (2 years).
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { retentionDue } from "../db/retention";

const cfg = loadConfig();
const repo = new Repo(openDb(cfg.dbPath));
seedDefaults(repo, { live: cfg.mode === "live" });

const retentionDays = Number(repo.getSetting("retention_days", "730"));
const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();
const archiveDir = path.resolve(path.dirname(path.resolve(cfg.dbPath)), "archive");
fs.mkdirSync(archiveDir, { recursive: true });

// retentionDue normalises the two date formats before comparing — a raw
// string compare archives cases up to 24 h early on the boundary day.
const candidates = repo.allApplicants().filter(
  (a) => a.lifecycle === "completed" && retentionDue(a.updated_at, cutoff)
);

let archived = 0;
for (const a of candidates) {
  const record = {
    archived_at: new Date().toISOString(),
    retention_days: retentionDays,
    applicant: a,
    documents: repo.listDocuments(a.id, { activeOnly: false }),
    emails: repo.emailsForApplicant(a.id),
    flags: repo.activeFlags(a.id),
    notes: repo.notesForApplicant(a.id),
    status_history: repo.statusHistory(a.id),
    decision_logs: repo.decisionLogs(a.id),
    audit: repo.auditForApplicant(a.id),
  };
    const file = path.join(archiveDir, `${a.ref_number}.json`);
    // The archive contains full PII (email bodies, ID numbers). Restrict it
    // to the owning user — retention must not create a second, looser copy.
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  repo.deleteApplicantFull(a.id);
  archived++;
  console.log(`retain: archived + removed ${a.ref_number} → ${file}`);
}

console.log(
  `retain: ${archived} completed case(s) older than ${retentionDays} day(s) archived and removed.`
);
