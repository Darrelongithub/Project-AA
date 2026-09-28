/**
 * `npm run escalate` — one-shot escalation sweep (for cron):
 * any case past its response target becomes urgent + notifies staff.
 * The web server also runs this automatically every 5 minutes.
 */
import { loadConfig } from "../config";
import { envInt } from "../util/envnum";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { runEscalationSweep } from "../web/server";

const cfg = loadConfig();
const repo = new Repo(openDb(cfg.dbPath));
seedDefaults(repo, { live: cfg.mode === "live" });
// A corrupt setting must not poison the sweep (NaN window ≈ every case
// looks overdue or none does, depending on the comparison) — documented default.
const hours = envInt(repo.getSetting("escalation_hours", "8"), 8);
const n = runEscalationSweep(repo, hours);
console.log(`escalate: ${n} case(s) escalated past their response target.`);
