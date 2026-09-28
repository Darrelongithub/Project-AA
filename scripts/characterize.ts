/**
 * Phase-0 characterization harness.
 *
 * Runs the fixed simulation corpus (src/simulation/fixtures.ts) through the
 * REAL pipeline with mock external adapters and records, per fixture:
 *   category, decision, outcome source, reply chosen, checklist result,
 *   lifecycle, flags, audit events, decision-log entries.
 *
 * Usage:
 *   npx tsx scripts/characterize.ts          # (re)generate the golden file
 *   npx tsx scripts/characterize.ts --check  # compare current behaviour; exit 1 on diff
 *
 * Each fixture runs in an ISOLATED :memory: database (fresh seed) so golden
 * entries are independent of corpus order. OCR is disabled (the scanned-pdf
 * fixture carries a mockVision sidecar, exactly like the unit tests) so the
 * output is fully deterministic — no network, no clock, no native deps.
 */
import * as fs from "fs";
import * as path from "path";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import type { AppConfig } from "../src/config";
import { MockSender, buildAdapters, type PipelineContext } from "../src/pipeline/adapters";
import { processEmail } from "../src/pipeline";
import { buildFixtures } from "../src/simulation/fixtures";
import type { ProcessResult } from "../src/types";

const GOLDEN_PATH = path.resolve(__dirname, "../test/characterize.golden.json");

function makeCtx(repo: Repo): { ctx: PipelineContext; sender: MockSender } {
  const cfg: AppConfig = {
    mode: "mock",
    dbPath: ":memory:",
    port: 0,
    geminiModel: "mock",
    ingestLookbackDays: 1,
    disableOcr: true, // deterministic: scanned fixture uses its mockVision sidecar
    logToFile: false,
    autoMissingDocsEmails: true,
    autoStatusAnswers: true,
  };
  const sender = new MockSender();
  const adapters = buildAdapters(cfg, sender, repo);
  return { ctx: { repo, adapters }, sender };
}

function summarizeResult(r: ProcessResult): Record<string, unknown> {
  return {
    skipped: r.skipped ?? false,
    applicantId: r.applicantId,
    finalStatus: r.finalStatus,
    lifecycle: r.lifecycle,
    autoSent: r.autoSent,
    autoKind: r.autoKind ?? null,
    category: r.category,
    reasoning: r.reasoning,
    flags: r.flags,
    missing: r.missing,
    refNumber: (r as { refNumber?: string }).refNumber ?? null,
  };
}

/** Normalize clock- and sequence-dependent values so goldens are stable. */
export function normalize(value: unknown): unknown {
  const json = JSON.stringify(value);
  return JSON.parse(
    json
      // Case reference numbers: RU-2026-000001 etc.
      .replace(/[A-Z]{1,4}-\d{4}-\d{6}/g, "<REF>")
      // ISO timestamps (decision logs, audit rows, status history).
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TS>")
      // SQLite datetime() stamps ("YYYY-MM-DD HH:MM:SS").
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TS>")
  );
}

export async function characterize(): Promise<Array<Record<string, unknown>>> {
  const fixtures = await buildFixtures();
  const out: Array<Record<string, unknown>> = [];
  for (const fixture of fixtures) {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const { ctx, sender } = makeCtx(repo);
    fixture.before?.(repo);
    const emails = typeof fixture.emails === "function" ? await fixture.emails(repo) : fixture.emails;
    const results: Array<Record<string, unknown>> = [];
    let last: ProcessResult | null = null;
    for (let i = 0; i < emails.length; i++) {
      fixture.beforeEmail?.(repo, i);
      last = await processEmail(emails[i], ctx);
      results.push({ emailId: emails[i].id, ...summarizeResult(last) });
    }
    fixture.after?.(repo);
    const applicantId = last && !last.skipped ? last.applicantId : null;
    const a = applicantId !== null ? repo.getApplicant(applicantId) : null;
    const evaluation = applicantId !== null ? repo.latestEvaluation(applicantId) : null;
    out.push(
      normalize({
        name: fixture.name,
        emails: results,
        applicant: a
          ? {
              id: a.id,
              lifecycle: a.lifecycle,
              priority: a.priority,
              ref_number: a.ref_number,
              admission_decision: (a as Record<string, unknown>).admission_decision ?? null,
              admission_route: (a as Record<string, unknown>).admission_route ?? null,
              decision_by: (a as Record<string, unknown>).decision_by ?? null,
              req_result: (a as Record<string, unknown>).req_result ?? null,
              routing: (a as Record<string, unknown>).routing ?? null,
              routing_reason: (a as Record<string, unknown>).routing_reason ?? null,
            }
          : null,
        activeFlags:
          applicantId !== null
            ? repo.activeFlags(applicantId).map((f) => ({ type: f.type, reason: (f as { reason?: string }).reason ?? null }))
            : [],
        superseded: applicantId !== null ? repo.countSuperseded(applicantId) : 0,
        duplicates: applicantId !== null ? repo.countDuplicates(applicantId) : 0,
        evaluation: evaluation ? { result: evaluation.result, reason: evaluation.reason } : null,
        sent: sender.sent.map((s) => ({ to: s.to, subject: s.subject, body: s.body, attachments: s.attachments })),
        heldOutbox: applicantId !== null ? (repo.queuedOutbox(applicantId) ?? null) : null,
        audit: applicantId !== null ? repo.auditForApplicant(applicantId).map((e) => ({ actor: e.actor, event: e.event, detail: e.detail })) : [],
        decisionLogs: applicantId !== null ? repo.decisionLogs(applicantId).map((d) => ({ email: d.triggering_email_id, status: d.computed_status, reasoning: d.reasoning, auto_sent: d.auto_sent })) : [],
        statusHistory: applicantId !== null ? repo.statusHistory(applicantId) : [],
      }) as Record<string, unknown>
    );
    repo.close?.();
  }
  return out;
}

function diffGolden(golden: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const byName = new Map(golden.map((g) => [g.name as string, g]));
  for (const c of current) {
    const g = byName.get(c.name as string);
    if (!g) {
      problems.push(`fixture "${c.name}": NEW (not in golden)`);
      continue;
    }
    const gs = JSON.stringify(g);
    const cs = JSON.stringify(c);
    if (gs !== cs) {
      problems.push(`fixture "${c.name}": DIFFERS`);
      // Field-level summary to keep the report readable.
      const gk = g as Record<string, unknown>;
      const ck = c as Record<string, unknown>;
      for (const key of Object.keys(gk)) {
        if (JSON.stringify(gk[key]) !== JSON.stringify(ck[key])) {
          const a = JSON.stringify(gk[key]);
          const b = JSON.stringify(ck[key]);
          const clip = (s: string) => (s.length > 600 ? s.slice(0, 600) + "…" : s);
          problems.push(`  field "${key}":\n    golden:  ${clip(a)}\n    current: ${clip(b)}`);
        }
      }
    }
  }
  for (const g of golden) {
    if (!current.some((c) => c.name === g.name)) problems.push(`fixture "${g.name}": MISSING from current run`);
  }
  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const current = await characterize();
  if (!check) {
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(current, null, 2) + "\n");
    console.log(`characterize: wrote ${current.length} fixtures → ${path.relative(process.cwd(), GOLDEN_PATH)}`);
    return;
  }
  if (!fs.existsSync(GOLDEN_PATH)) {
    console.error(`characterize: no golden file at ${GOLDEN_PATH} — run without --check first`);
    process.exit(2);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as Array<Record<string, unknown>>;
  const problems = diffGolden(golden, current);
  if (problems.length === 0) {
    console.log(`characterize: ${current.length} fixtures match golden — no behaviour change`);
    return;
  }
  console.log(`characterize: ${problems.length} difference(s) vs golden:\n`);
  for (const p of problems) console.log(p);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
