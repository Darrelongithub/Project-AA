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
// The archive holds full PII in plain JSON — lock the DIRECTORY to the
// owning user too (files are written 0o600 just below).
fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });

// Realm: retention defaults to the LIVE realm (demo=0). Seeded demo data is
// mock — sweeping it silently would destroy the demo environment. Pass
// --all-realms (or RETAIN_ALL_REALMS=1) to include the demo realm too.
const allRealms = process.argv.includes("--all-realms") || process.env.RETAIN_ALL_REALMS === "1";
const realm: number | undefined = allRealms ? undefined : 0;

// retentionDue normalises the two date formats before comparing — a raw
// string compare archives cases up to 24 h early on the boundary day.
const candidates = repo.allApplicants(realm).filter(
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
  `retain: ${archived} completed case(s) older than ${retentionDays} day(s) archived and removed (realm: ${allRealms ? "live + demo" : "live only"}).`
);
