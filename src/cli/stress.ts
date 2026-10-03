/** Deterministic volume/regression gate on fresh, generic, in-memory databases. */
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { processEmail } from "../pipeline";
import { buildAdapters, MockSender, type PipelineContext } from "../pipeline/adapters";
import { TEST_CASE_TYPES, seedGenericTestConfig, type TestConfiguration } from "../simulation/config";
import { genericAttachment } from "../simulation/fixtures";
import type { IncomingEmail } from "../types";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000) throw new Error(`${name} must be an integer between 1 and 100000`);
  return value;
}
const TOTAL = positiveInteger("STRESS_N", 1000);
const BATCH = positiveInteger("STRESS_BATCH", 100);
const SEED = positiveInteger("STRESS_SEED", 7331);
let state = SEED;
function random(): number { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }

interface StressCase { index: number; type: number; keys: string[]; missing: string[]; facts: Record<string, string | number>; invalid: boolean; duplicate?: number }
interface Outcome { ok: boolean; failures: string[]; status: string; missing: string[] }

function makeCase(index: number): StressCase {
  const type = Math.floor(random() * TEST_CASE_TYPES.length);
  const definition = TEST_CASE_TYPES[type];
  const keys = definition.documents.filter((d) => d.required && random() > 0.22).map((d) => d.key);
  const invalid = random() < 0.15;
  const facts: Record<string, string | number> = type === 0 ? { consent: invalid ? "no" : "yes" }
    : type === 1 ? { coverage: invalid ? 10 : 1500000, duration: 6, restricted: "no" }
    : { manager_approved: invalid ? "no" : "yes", revoked: "no" };
  return { index, type, keys, missing: definition.documents.filter((d) => d.blocking && !keys.includes(d.key)).map((d) => d.key), facts,
    invalid, duplicate: index % BATCH > 0 && random() < 0.08 ? index - 1 : undefined };
}
function context(repo: Repo): PipelineContext {
  return { repo, adapters: buildAdapters({ mode: "mock", dbPath: ":memory:", port: 0, geminiModel: "mock", ingestLookbackDays: 1,
    disableOcr: true, logToFile: false, autoMissingDocsEmails: true, autoStatusAnswers: true }, new MockSender(), repo) };
}
async function runCase(item: StressCase, config: TestConfiguration, ctx: PipelineContext, duplicateId?: string): Promise<Outcome> {
  const failures: string[] = [];
  const id = duplicateId ?? `stress-${item.index}`;
  const message: IncomingEmail = { id, threadId: `thread-${item.index}`, from: `contact${item.index}@example.test`, fromName: "Alex Morgan",
    subject: "Request documents", body: Object.entries(item.facts).map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`).join("\n"),
    receivedAt: "2026-09-14T09:00:00Z", organizationId: config.organizationId, caseTypeCode: TEST_CASE_TYPES[item.type].code,
    attachments: duplicateId ? [] : await Promise.all(item.keys.map((key) => genericAttachment(key, item.facts))) };
  try {
    const result = await processEmail(message, ctx);
    if (duplicateId) {
      if (!result.skipped) failures.push("repeated message was processed twice");
      return { ok: failures.length === 0, failures, status: "duplicate", missing: [] };
    }
    if (result.skipped) return { ok: false, failures: ["new request was skipped"], status: "skipped", missing: [] };
    const row = ctx.repo.getCase(result.applicantId);
    if (!row) failures.push("missing persisted case");
    if (row?.organization_id !== config.organizationId) failures.push("wrong organization");
    if (row && !/^SIM-\d{4}-\d{6}$/.test(row.ref_number)) failures.push("invalid reference");
    if (row?.outcome !== "undecided") failures.push("machine recorded an outcome");
    if (result.autoSent) failures.push("draft-first workflow sent without approval");
    if ([...result.missing].sort().join(",") !== [...item.missing].sort().join(",")) failures.push("incorrect missing-slot calculation");
    if (row && !ctx.repo.latestOutbox(row.id)) failures.push("no draft/review note");
    if (row && ctx.repo.caseTypeForCase(row.id)?.code !== TEST_CASE_TYPES[item.type].code) failures.push("wrong case type");
    return { ok: failures.length === 0, failures, status: result.finalStatus, missing: result.missing };
  } catch (error) {
    return { ok: false, failures: [`pipeline error: ${(error as Error).message}`], status: "error", missing: [] };
  }
}
async function main(): Promise<void> {
  const items = Array.from({ length: TOTAL }, (_, index) => makeCase(index));
  const outcomes: Outcome[] = [];
  const effectiveIds: string[] = [];
  for (let start = 0; start < TOTAL; start += BATCH) {
    const repo = new Repo(openDb(":memory:"));
    try {
      seedDefaults(repo);
      const config = seedGenericTestConfig(repo);
      const ctx = context(repo);
      for (let index = start; index < Math.min(start + BATCH, TOTAL); index++) {
        const item = items[index];
        const duplicateId = item.duplicate === undefined ? undefined : effectiveIds[item.duplicate];
        effectiveIds[index] = duplicateId ?? `stress-${index}`;
        outcomes.push(await runCase(item, config, ctx, duplicateId));
      }
    } finally { repo.db.close(); }
  }
  let sampled = 0;
  let deterministic = 0;
  for (const index of [3, 42, 77, 120, 233, 300, 411, 500, 618, 702, 808, 913, 999]) {
    if (index >= TOTAL || items[index].duplicate !== undefined) continue;
    sampled++;
    const runs: Outcome[] = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const repo = new Repo(openDb(":memory:"));
      try { seedDefaults(repo); runs.push(await runCase(items[index], seedGenericTestConfig(repo), context(repo))); }
      finally { repo.db.close(); }
    }
    if (runs.every((run) => run.ok) && JSON.stringify(runs[0]) === JSON.stringify(runs[1])) deterministic++;
    else console.error(`DETERMINISM FAILURE at case ${index}: ${JSON.stringify(runs)}`);
  }
  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(`\nGENERIC STRESS REPORT\nCases: ${TOTAL} (seed ${SEED})\nDeterminism: ${deterministic}/${sampled} sampled cases re-ran identically`);
  for (const failure of failed.slice(0, 20)) console.error(failure.failures.join("; "));
  const clean = failed.length === 0 && deterministic === sampled;
  console.log(`RESULT: ${TOTAL - failed.length}/${TOTAL} cases clean — ${clean ? "ALL GREEN" : "FAILURES PRESENT"}`);
  process.exitCode = clean ? 0 : 1;
}
main().catch((error: unknown) => { console.error("Stress harness failed:", error); process.exitCode = 1; });
