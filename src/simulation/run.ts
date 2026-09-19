/**
 * Simulation runner + scorer v2.
 *
 * Runs every fixture's emails through the REAL pipeline (mock external
 * adapters, real extraction/rules/watcher/categorize/dedup logic) and scores
 * the resulting database state against the answer key. Exit code is non-zero
 * on failure → usable as CI.
 */
import * as path from "path";
import { openDb } from "../db/db";
import { loadConfig } from "../config";
import { Repo } from "../db/repo";
import { type AppConfig } from "../config";
import { seedDefaults } from "../db/seed";
import { MockSender, buildAdapters, type PipelineContext } from "../pipeline/adapters";
import { processEmail } from "../pipeline";
import { buildFixtures, type Expected, type Fixture } from "./fixtures";
import type { DocType, ProcessResult } from "../types";
import { log } from "../util/log";

export interface Actual {
  finalStatus: string;
  lifecycle: string;
  autoSent: boolean;
  autoKind: string;
  flagTypes: string[];
  superseded: number;
  duplicates: number;
  missing: DocType[];
  category: string;
  priority: string;
  refOk: boolean;
  subjectRefOk: boolean;
}

export interface FixtureReport {
  fixture: Fixture;
  actual: Actual;
  checks: Array<{ field: string; pass: boolean; expected: string; actual: string }>;
  passed: boolean;
}

export interface SimulationResult {
  reports: FixtureReport[];
  totalChecks: number;
  passedChecks: number;
  allPassed: boolean;
}

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort().join(",");
const sorted = (xs: string[]) => [...xs].sort().join(",");

function compare(expected: Expected, actual: Actual, ref: string, auditedEvents: string[] = []): FixtureReport["checks"] {
  const checks: FixtureReport["checks"] = [
    { field: "finalStatus", pass: expected.finalStatus === actual.finalStatus, expected: expected.finalStatus, actual: actual.finalStatus },
    { field: "lifecycle", pass: expected.lifecycle === actual.lifecycle, expected: expected.lifecycle, actual: actual.lifecycle },
    { field: "autoSent", pass: expected.autoSent === actual.autoSent, expected: String(expected.autoSent), actual: String(actual.autoSent) },
    { field: "autoKind", pass: (expected.autoKind ?? "none") === actual.autoKind, expected: expected.autoKind ?? "none", actual: actual.autoKind },
    { field: "flags", pass: uniqSorted(expected.flagTypes) === uniqSorted(actual.flagTypes), expected: uniqSorted(expected.flagTypes) || "(none)", actual: uniqSorted(actual.flagTypes) || "(none)" },
    { field: "superseded", pass: expected.superseded === actual.superseded, expected: String(expected.superseded), actual: String(actual.superseded) },
    { field: "duplicates", pass: expected.duplicates === actual.duplicates, expected: String(expected.duplicates), actual: String(actual.duplicates) },
    { field: "missing", pass: sorted(expected.missing) === sorted(actual.missing), expected: sorted(expected.missing) || "(none)", actual: sorted(actual.missing) || "(none)" },
    { field: "category", pass: expected.category === actual.category, expected: expected.category, actual: actual.category },
    { field: "priority", pass: expected.priority === actual.priority, expected: expected.priority, actual: actual.priority },
    { field: "refFormat", pass: actual.refOk, expected: "RU-YYYY-NNNNNN", actual: ref },
    { field: "subjectHasRef", pass: actual.subjectRefOk, expected: `[${ref}] prefix`, actual: actual.subjectRefOk ? "ok" : "missing" },
  ];
  // v3: specific audit events that must have fired for this applicant.
  for (const ev of expected.audited ?? []) {
    checks.push({
      field: `audit:${ev}`,
      pass: auditedEvents.includes(ev),
      expected: `audit event "${ev}" present`,
      actual: auditedEvents.includes(ev) ? "present" : "missing",
    });
  }
  return checks;
}

export async function runSimulation(
  opts: { disableOcr?: boolean; dbPath?: string } = {}
): Promise<SimulationResult> {
  const dbPath = opts.dbPath ?? ":memory:";
  // OR-1: the simulation corpus is developer tooling. It must NEVER write the
  // database the live server reads — refuse loudly instead of contaminating.
  if (dbPath !== ":memory:" && path.resolve(dbPath) === path.resolve(loadConfig().dbPath)) {
    throw new Error(
      `refusing to run the simulation against the server database (${dbPath}) — use SIM_DB_PATH with a separate throwaway file`
    );
  }
  const cfg: AppConfig = {
    mode: "mock",
    dbPath,
    port: 0,
    geminiModel: "mock",
    ingestLookbackDays: 1,
    disableOcr: opts.disableOcr ?? false,
    logToFile: false,
    autoMissingDocsEmails: true,
    autoStatusAnswers: true,
  };

  const repo = new Repo(openDb(dbPath));
  seedDefaults(repo);
  // Base set = the published application basics incl. the general minimum
  // (KCSE mean grade C+ on the secondary certificate); programme overrides
  // for diplomas/certificates/postgrad come from seedDefaults.
  // OR-5: requirements come from the deterministic matrix — nothing to seed.
  const sender = new MockSender();
  const adapters = buildAdapters(cfg, sender, repo);
  const ctx: PipelineContext = { repo, adapters };

  const fixtures = await buildFixtures();
  const reports: FixtureReport[] = [];

  for (const fixture of fixtures) {
    log(`simulate: ── ${fixture.name}: ${fixture.description}`);
    fixture.before?.(repo);
    const emails = typeof fixture.emails === "function" ? await fixture.emails(repo) : fixture.emails;
    let last: ProcessResult | null = null;
    for (let i = 0; i < emails.length; i++) {
      fixture.beforeEmail?.(repo, i);
      last = await processEmail(emails[i], ctx);
      log(`simulate:    ${emails[i].id} → ${last.finalStatus} (auto=${last.autoKind ?? "none"}, lifecycle=${last.lifecycle})`);
    }

    // A skipped result carries the sentinel applicantId -1 — dereferencing it
    // used to crash the whole simulation with a useless error instead of
    // producing a scored failure.
    if (!last || last.skipped) {
      reports.push({
        fixture,
        actual: {
          finalStatus: "skipped", lifecycle: "application_received", autoSent: false, autoKind: "none",
          flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "other", priority: "normal",
          refOk: false, subjectRefOk: false,
        },
        checks: [{ field: "processed", pass: false, expected: "fixture emails processed", actual: "last email was skipped (already processed)" }],
        passed: false,
      });
      continue;
    }
    const applicant = repo.getApplicant(last.applicantId)!;
    const lastOutbox = repo.latestOutbox(applicant.id);
    const actual: Actual = {
      finalStatus: last!.finalStatus,
      lifecycle: applicant.lifecycle,
      autoSent: last!.autoSent,
      autoKind: last!.autoKind ?? "none",
      flagTypes: repo.activeFlags(applicant.id).map((f) => f.type).filter((t) => t !== "duplicate_submission"),
      superseded: repo.countSuperseded(applicant.id),
      duplicates: repo.countDuplicates(applicant.id),
      missing: last!.missing,
      category: last!.category,
      priority: applicant.priority,
      refOk: /^[A-Z]{1,4}-\d{4}-\d{6}$/.test(applicant.ref_number),
      subjectRefOk: lastOutbox ? lastOutbox.subject.startsWith(`[${applicant.ref_number}]`) : false,
    };

    const auditedEvents = repo.auditForApplicant(applicant.id).map((e) => e.event);
    const checks = compare(fixture.expected, actual, applicant.ref_number, auditedEvents);
    reports.push({ fixture, actual, checks, passed: checks.every((c) => c.pass) });
    fixture.after?.(repo);
  }

  const totalChecks = reports.reduce((n, r) => n + r.checks.length, 0);
  const passedChecks = reports.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0);
  return { reports, totalChecks, passedChecks, allPassed: passedChecks === totalChecks };
}

export function printReport(result: SimulationResult): void {
  console.log("\n══════════════════════════ SIMULATION SCORECARD (v2) ══════════════════════════\n");
  for (const r of result.reports) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.fixture.name} — ${r.fixture.description}`);
    for (const c of r.checks) {
      if (!c.pass) {
        console.log(`     [FAIL] ${c.field.padEnd(15)} expected "${c.expected}", got "${c.actual}"`);
      }
    }
  }
  const failed = result.reports.filter((r) => !r.passed).length;
  console.log(
    `\n${result.passedChecks}/${result.totalChecks} checks passed across ${result.reports.length} scenarios (${failed} scenario(s) with failures) — ${
      result.allPassed ? "ALL GREEN" : "FAILURES PRESENT"
    }\n`
  );
}
