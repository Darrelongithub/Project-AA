/** Real extraction/persistence/pipeline checks against an explicit generic configuration. */
import * as path from "path";
import { openDb } from "../db/db";
import { loadConfig, type AppConfig } from "../config";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { MockSender, buildAdapters, type PipelineContext } from "../pipeline/adapters";
import { processEmail } from "../pipeline";
import { buildFixtures, type Fixture } from "./fixtures";
import { seedGenericTestConfig } from "./config";
import type { ProcessResult } from "../types";

export interface FixtureReport {
  fixture: Fixture;
  checks: Array<{ field: string; pass: boolean; expected: string; actual: string }>;
  passed: boolean;
}
export interface SimulationResult { reports: FixtureReport[]; totalChecks: number; passedChecks: number; allPassed: boolean }

export async function runSimulation(opts: { disableOcr?: boolean; dbPath?: string } = {}): Promise<SimulationResult> {
  const dbPath = opts.dbPath ?? ":memory:";
  if (dbPath !== ":memory:" && path.resolve(dbPath) === path.resolve(loadConfig().dbPath)) {
    throw new Error(`refusing to run the simulation against the server database (${dbPath}) — use SIM_DB_PATH with a separate throwaway file`);
  }
  const cfg: AppConfig = { mode: "mock", dbPath, port: 0, geminiModel: "mock", ingestLookbackDays: 1,
    disableOcr: opts.disableOcr ?? false, logToFile: false, autoMissingDocsEmails: true, autoStatusAnswers: true };
  const repo = new Repo(openDb(dbPath));
  try {
    if (repo.listCases().length > 0) throw new Error("Simulation requires a fresh throwaway database");
    seedDefaults(repo);
    const config = seedGenericTestConfig(repo);
    const sender = new MockSender();
    const ctx: PipelineContext = { repo, adapters: buildAdapters(cfg, sender, repo) };
    const reports: FixtureReport[] = [];
    for (const fixture of await buildFixtures(config)) {
      fixture.before?.(repo);
      const messages = typeof fixture.emails === "function" ? await fixture.emails(repo) : fixture.emails;
      let result: ProcessResult | undefined;
      for (let index = 0; index < messages.length; index++) {
        fixture.beforeEmail?.(repo, index);
        result = await processEmail(messages[index], ctx);
      }
      const checks: FixtureReport["checks"] = [];
      const check = (field: string, actual: unknown, expected: unknown) => checks.push({ field, pass: JSON.stringify(actual) === JSON.stringify(expected), actual: JSON.stringify(actual) ?? "undefined", expected: JSON.stringify(expected) ?? "undefined" });
      if (fixture.expected.parked) {
        check("parked", result?.skipped, true);
        check("no-case", repo.listCases(config.organizationId).some((row) => row.email_address === messages[0].from), false);
        check("mail-retained", Boolean(repo.db.prepare("SELECT 1 FROM emails WHERE message_id = ? AND applicant_id IS NULL").get(messages[0].id)), true);
      } else {
        check("processed", Boolean(result && !result.skipped), true);
        const row = result && !result.skipped ? repo.getCase(result.applicantId) : undefined;
        check("case-exists", Boolean(row), true);
        if (row && result) {
          const active = repo.listDocuments(row.id, { activeOnly: true });
          check("organization", row.organization_id, config.organizationId);
          check("case-type", repo.caseTypeForCase(row.id)?.code, messages[0].caseTypeCode);
          check("reference", /^SIM-\d{4}-\d{6}$/.test(row.ref_number), true);
          check("outcome", row.outcome, "undecided");
          check("no-auto-send", result.autoSent, false);
          check("documents", active.length, fixture.expected.documents);
          check("missing", [...result.missing].sort(), [...fixture.expected.missing].sort());
          check("superseded", repo.countSuperseded(row.id), fixture.expected.superseded ?? 0);
          check("duplicates", repo.countDuplicates(row.id), fixture.expected.duplicates ?? 0);
          check("priority", row.priority, fixture.expected.priority ?? "normal");
          check("draft-or-human-note", Boolean(repo.latestOutbox(row.id)), true);
          check("watcher-flag", repo.activeFlags(row.id).some((flag) => flag.type === "watcher_flag"), fixture.expected.watcherFlagged ?? false);
          check("frozen-config", Boolean(repo.caseConfigFrozen(row)), true);
          check("inbound-history", repo.emailsForApplicant(row.id).filter((mail) => mail.direction === "in").length, messages.length);
          const events = repo.auditForApplicant(row.id).map((event) => event.event);
          for (const event of fixture.expected.audited ?? []) check(`audit:${event}`, events.includes(event), true);
        }
      }
      reports.push({ fixture, checks, passed: checks.every((c) => c.pass) });
      fixture.after?.(repo);
    }
    const totalChecks = reports.reduce((count, report) => count + report.checks.length, 0);
    const passedChecks = reports.reduce((count, report) => count + report.checks.filter((c) => c.pass).length, 0);
    return { reports, totalChecks, passedChecks, allPassed: passedChecks === totalChecks };
  } finally { repo.db.close(); }
}

export function printReport(result: SimulationResult): void {
  console.log("\nGENERIC INTAKE SIMULATION\n");
  for (const report of result.reports) {
    console.log(`${report.passed ? "PASS" : "FAIL"} ${report.fixture.name} — ${report.fixture.description}`);
    for (const check of report.checks.filter((c) => !c.pass)) console.log(`  ${check.field}: expected ${check.expected}, got ${check.actual}`);
  }
  console.log(`\n${result.passedChecks}/${result.totalChecks} checks passed across ${result.reports.length} scenarios — ${result.allPassed ? "ALL GREEN" : "FAILURES PRESENT"}`);
}
