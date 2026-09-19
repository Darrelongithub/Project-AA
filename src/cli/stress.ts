/**
 * `npm run stress` — 1,000 synthetic applicant cases through the REAL
 * pipeline (mock external adapters, real extraction/rules/matrix/evaluation).
 *
 * Purpose: prove at volume what the fixture matrix proves by construction —
 *   • no case ever crashes the pipeline;
 *   • a file is only auto-admitted when NOTHING blocking is missing and no
 *     blocking flag is active (the no-wrong-applicant guarantee);
 *   • missing lists are exactly the deterministic matrix minus what arrived;
 *   • KCPE is never demanded; banned umbrella labels never appear;
 *   • the whole thing is deterministic (sampled cases re-run identically).
 *
 * Deterministic: a fixed seed drives every choice, so a failure is
 * reproducible (`stress: case 0421 degree ... FAILED: ...`).
 */
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { DEFAULT_PROGRAMMES } from "../config";
import { MockSender, buildAdapters, type PipelineContext } from "../pipeline/adapters";
import { processEmail } from "../pipeline";
import { makeTextPdf, docLines } from "../simulation/pdfFactory";
import { documentRequirementsFor, fillSlots, KENYAN_REQUIRES_KCPE, type ProgrammeLevel } from "../documents/matrix";
import type { AppConfig } from "../config";
import type { Attachment, DocType, IncomingEmail } from "../types";

// ── Deterministic PRNG ─────────────────────────────────────────────────────
const SEED = 20260919;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number): boolean => rnd() < p;
const someOf = <T,>(xs: T[], n: number): T[] => [...xs].sort(() => rnd() - 0.5).slice(0, n);

const TOTAL = Number(process.env.STRESS_N ?? 1000);
const BATCH = 100;

// ── Case generation ────────────────────────────────────────────────────────

interface StressCase {
  id: string;
  profile: "degree" | "masters" | "transfer" | "adversarial";
  programme: { code: string; name: string; level: string } | null;
  route: "fresh" | "transfer";
  docs: Array<{ filename: string; docType?: string; customLines?: string[]; spec: Record<string, unknown> }>;
  body: string;
  /** Exact expected missing slots — only for faithful profiles. */
  expectedMissing?: DocType[];
  /** Set when grades are deliberately below the floor (must NOT auto-admit). */
  lowGrades?: boolean;
  resendOf?: string; // duplicate-email adversarial case
  junk?: boolean;
}

const SCHOOL_LEVELS = new Set(["degree", "diploma", "certificate"]);
const schoolProgrammes = DEFAULT_PROGRAMMES.filter((p) => SCHOOL_LEVELS.has(p.level));
const mastersProgrammes = DEFAULT_PROGRAMMES.filter((p) => p.level === "masters" || p.level === "phd");
/** The email id actually used by each previous case (resends reuse an id). */
const effectiveIds: string[] = [];

const FIRST = ["AMINA", "BRIAN", "CWALUSO", "DAVID", "ESTHER", "FARAH", "GRACE", "HASSAN", "IRENE", "JABARI", "FAITH", "KEVIN", "LUCY", "MOHAMED", "NAOMI", "OSCAR", "PURITY", "QUINCEY", "RUTH", "SAMUEL"];
const LAST = ["KAMAU", "OTIENO", "WANJIRU", "KIPKORIR", "ACHELI", "MWANGI", "BARAKA", "NYAMBURA", "ODHIAMBO", "CHEBET"];

function registerCase(c: StressCase): StressCase {
  effectiveIds.push(c.resendOf ?? c.id);
  return c;
}

function makeCase(i: number): StressCase {
  const name = `${pick(FIRST)} ${pick(LAST)} ${String(1000 + i)}`;
  const roll = rnd();

  // ── Adversarial (25%): empty files, junk, duplicates ──
  if (roll < 0.25) {
    const kind = rnd();
    if (kind < 0.34) {
      return {
        id: `stress-${i}`, profile: "adversarial", programme: null, route: "fresh",
        docs: [], body: "Hello, I would like to apply. Documents will follow soon.",
      };
    }
    if (kind < 0.67) {
      return {
        id: `stress-${i}`, profile: "adversarial", programme: null, route: "fresh", junk: true,
        docs: [
          { filename: `junk-${i}-a.pdf`, customLines: ["LOREM IPSUM DOLOR", "sit amet consectetur", String(i * 7)], spec: {} },
          { filename: `junk-${i}-b.pdf`, customLines: ["UNRELATED RECEIPT", `serial ${i}`], spec: {} },
        ],
        body: "Please find my papers attached.",
      };
    }
    // duplicate of the id the previous case ACTUALLY used (never a dangling id)
    if (!effectiveIds.length) {
      // very first case has nothing to duplicate — be an empty file instead
      return {
        id: `stress-${i}`, profile: "adversarial", programme: null, route: "fresh",
        docs: [], body: "Hello, I would like to apply. Documents will follow soon.",
      };
    }
    return {
      id: `stress-${i}`, profile: "adversarial", programme: null, route: "fresh",
      resendOf: effectiveIds[effectiveIds.length - 1],
      docs: [], body: "Resending my earlier email.",
    };
  }

  // ── Master's / PhD (15%): prior-degree paperwork, no school-leaver docs ──
  if (roll < 0.40) {
    const prog = pick(mastersProgrammes);
    const docs: StressCase["docs"] = [
      { filename: `s${i}-ug-transcript.pdf`, docType: "undergraduate_transcript", spec: { name, degreeTitle: "BACHELOR OF COMMERCE" } },
      { filename: `s${i}-ug-cert.pdf`, docType: "undergraduate_degree_certificate", spec: { name, degreeTitle: "BACHELOR OF COMMERCE" } },
      { filename: `s${i}-photo.pdf`, docType: "passport_photo", spec: { name } },
      { filename: `s${i}-birth.pdf`, docType: "birth_cert", spec: { name } },
      { filename: `s${i}-id.pdf`, docType: "id", spec: { name, idNumber: String(20000000 + i) } },
      { filename: `s${i}-form.pdf`, docType: "application_form", spec: { name, programme: prog.name.toUpperCase() } },
    ];
    // Drop 0–2 slots at random → expected missing is exactly those slots.
    const drops = someOf([0, 1, 2, 3, 4, 5], rnd() < 0.55 ? Math.floor(rnd() * 3) : 0);
    const supplied = docs.filter((_, idx) => !drops.includes(idx));
    const suppliedTypes = supplied.map((d) => d.docType as DocType);
    const gen = documentRequirementsFor({ level: (prog.level === "phd" ? "phd" : "masters") as ProgrammeLevel, route: "fresh", nationality: "unknown", curriculum: null, programmeCode: prog.code });
    return {
      id: `stress-${i}`, profile: "masters", programme: { code: prog.code, name: prog.name, level: prog.level }, route: "fresh",
      docs: supplied,
      body: `Dear Admissions, attached are my documents for the ${prog.code} programme (${prog.name}), September 2026 intake.`,
      expectedMissing: fillSlots(gen, suppliedTypes).missing.map((m) => m.document_type),
    };
  }

  // ── Transfer (10%): school-leaver file + the credit transfer form ──
  if (roll < 0.50) {
    const prog = pick(schoolProgrammes);
    const docs: StressCase["docs"] = [
      { filename: `s${i}-academic.pdf`, docType: "academic_cert", spec: { name, kcseMeanGrade: "B", subjects: { ENGLISH: "B", KISWAHILI: "B", MATHEMATICS: "B", PHYSICS: "B", CHEMISTRY: "B", BIOLOGY: "B" } } },
      { filename: `s${i}-leaving.pdf`, docType: "leaving_certificate", spec: { name } },
      { filename: `s${i}-photo.pdf`, docType: "passport_photo", spec: { name } },
      { filename: `s${i}-birth.pdf`, docType: "birth_cert", spec: { name } },
      { filename: `s${i}-id.pdf`, docType: "id", spec: { name, idNumber: String(30000000 + i) } },
      { filename: `s${i}-form.pdf`, docType: "application_form", spec: { name, programme: prog.name.toUpperCase() } },
      { filename: `s${i}-ctf.pdf`, docType: "credit_transfer_form", spec: { name, programme: prog.name.toUpperCase() } },
    ];
    const drops = rnd() < 0.5 ? someOf([0, 1, 2, 3, 4, 5], Math.floor(rnd() * 2)) : [];
    const supplied = docs.filter((_, idx) => !drops.includes(idx));
    const suppliedTypes = supplied.map((d) => d.docType as DocType);
    const gen = documentRequirementsFor({ level: prog.level as ProgrammeLevel, route: "transfer", nationality: "unknown", curriculum: "KCSE", programmeCode: prog.code });
    return {
      id: `stress-${i}`, profile: "transfer", programme: { code: prog.code, name: prog.name, level: prog.level }, route: "transfer",
      docs: supplied,
      body: `I wish to transfer into ${prog.code} (${prog.name}). My transfer letter and documents are attached for the September 2026 intake.`,
      expectedMissing: fillSlots(gen, suppliedTypes).missing.map((m) => m.document_type),
    };
  }

  // ── School-leaver degree/diploma/certificate (50%) ──
  const prog = pick(schoolProgrammes);
  const lowGrades = chance(0.18);
  // Below-floor grades must sit under the university-wide KCSE floor FOR THE
  // LEVEL: degree C+, diploma C, certificate D+. (A D+ "failure" would be a
  // legitimate pass for certificate entry — the floor is data, not a guess.)
  const lowMean = prog.level === "degree" ? "D+" : prog.level === "diploma" ? "D-" : "E";
  const docs: StressCase["docs"] = [
    {
      filename: `s${i}-academic.pdf`, docType: "academic_cert",
      spec: lowGrades
        ? { name, kcseMeanGrade: lowMean, subjects: { ENGLISH: "E", KISWAHILI: "E", MATHEMATICS: "E", PHYSICS: "E", CHEMISTRY: "E", BIOLOGY: "E" } }
        : { name, kcseMeanGrade: "B", subjects: { ENGLISH: "B", KISWAHILI: "B", MATHEMATICS: "B", PHYSICS: "B", CHEMISTRY: "B", BIOLOGY: "B" } },
    },
    { filename: `s${i}-leaving.pdf`, docType: "leaving_certificate", spec: { name } },
    { filename: `s${i}-photo.pdf`, docType: "passport_photo", spec: { name } },
    { filename: `s${i}-birth.pdf`, docType: "birth_cert", spec: { name } },
    { filename: `s${i}-id.pdf`, docType: "id", spec: { name, idNumber: String(40000000 + i) } },
    { filename: `s${i}-form.pdf`, docType: "application_form", spec: { name, programme: prog.name.toUpperCase() } },
  ];
  // Conditional statements: provided most of the time, omitted sometimes.
  if (prog.code === "LLB" && chance(0.8)) docs.push({ filename: `s${i}-ps.pdf`, docType: "law_personal_statement", spec: { name } });
  if (prog.code === "BBA" && chance(0.8)) docs.push({ filename: `s${i}-soo.pdf`, docType: "business_statement_of_objective", spec: { name } });
  const drops = rnd() < 0.6 ? someOf([0, 1, 2, 3, 4, 5], Math.floor(rnd() * 3)) : [];
  const supplied = docs.filter((_, idx) => !drops.includes(idx));
  const suppliedTypes = supplied.map((d) => d.docType as DocType);
  const gen = documentRequirementsFor({ level: prog.level as ProgrammeLevel, route: "fresh", nationality: "unknown", curriculum: "KCSE", programmeCode: prog.code });
  return {
    id: `stress-${i}`, profile: "degree", programme: { code: prog.code, name: prog.name, level: prog.level }, route: "fresh",
    docs: supplied, lowGrades,
    body: `Dear Admissions Office, please find attached my application documents for ${prog.code} (${prog.name}), September 2026 intake. Thank you.`,
    expectedMissing: fillSlots(gen, suppliedTypes).missing.map((m) => m.document_type),
  };
}

// ── Runner ─────────────────────────────────────────────────────────────────

interface CaseOutcome {
  idx: number;
  case: StressCase;
  ok: boolean;
  failures: string[];
  finalStatus?: string;
  missing?: DocType[];
  decision?: string;
  skipped?: boolean;
}

const ctxFor = (repo: Repo): PipelineContext => {
  const cfg: AppConfig = {
    mode: "mock", dbPath: ":memory:", port: 0, geminiModel: "mock",
    ingestLookbackDays: 1, disableOcr: true, logToFile: false,
    autoMissingDocsEmails: true, autoStatusAnswers: true,
  };
  return { repo, adapters: buildAdapters(cfg, new MockSender(), repo) };
};

async function buildAttachments(c: StressCase): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const d of c.docs) {
    const lines = d.customLines ?? docLines(d.docType!, { name: "APPLICANT", ...(d.spec ?? {}) });
    out.push({ filename: d.filename, mimeType: "application/pdf", content: await makeTextPdf(lines), mockVision: null });
  }
  return out;
}

async function runCase(i: number, c: StressCase, ctx: PipelineContext, repo: Repo, outcomes: CaseOutcome[]): Promise<void> {
  const failures: string[] = [];
  const email: IncomingEmail = {
    id: c.resendOf ?? c.id,
    threadId: `thread-${c.id}`,
    from: `stress.${i}@applicant.example.org`,
    fromName: `Stress ${i}`,
    subject: c.resendOf ? "Resending my documents" : `Application documents — ${c.programme?.code ?? "enquiry"}`,
    body: c.body,
    receivedAt: new Date(Date.UTC(2026, 8, 1 + (i % 18), 9, i % 60)).toISOString(),
    attachments: await buildAttachments(c),
  };

  let result;
  try {
    result = await processEmail(email, ctx);
  } catch (e) {
    outcomes.push({ idx: i, case: c, ok: false, failures: [`PIPELINE CRASH: ${(e as Error).message}`] });
    return;
  }

  if (result.skipped) {
    if (!c.resendOf) failures.push("email skipped but was not a resend");
    outcomes.push({ idx: i, case: c, ok: failures.length === 0, failures, skipped: true });
    return;
  }
  if (c.resendOf) failures.push("resend was not detected as a duplicate");

  const applicant = repo.getApplicant(result.applicantId)!;

  // 1. Reference format always valid.
  if (!/^[A-Z]{1,4}-\d{4}-\d{6}$/.test(applicant.ref_number)) failures.push(`bad ref format: ${applicant.ref_number}`);

  // 2. KCPE is never demanded; banned umbrella labels never appear.
  if (result.missing.includes("kcpe_cert")) failures.push("kcpe_cert demanded despite KENYAN_REQUIRES_KCPE=false");
  if (!KENYAN_REQUIRES_KCPE && result.missing.includes("kcpe_cert")) failures.push("kcpe in missing");
  const genForCheck = documentRequirementsFor({
    level: (applicant.programme ? (repo.programmeByCode(applicant.programme)?.level ?? "degree") : "degree") as ProgrammeLevel,
    route: applicant.transfer ? "transfer" : "fresh",
    nationality: "unknown", curriculum: "KCSE", programmeCode: applicant.programme ?? null,
  });
  for (const spec of genForCheck) {
    if (/academic certificate/i.test(spec.label)) failures.push(`banned umbrella label: "${spec.label}"`);
  }

  // 3. The no-wrong-applicant guarantee, both directions.
  const activeBlocking = repo.activeFlags(applicant.id).filter((f) => f.active && f.type !== "duplicate_submission").length;
  if (applicant.admission_decision === "auto_admitted") {
    if (result.missing.length > 0) failures.push(`AUTO-ADMITTED with missing docs: ${result.missing.join(",")}`);
    if (activeBlocking > 0) failures.push(`AUTO-ADMITTED with ${activeBlocking} active blocking flag(s)`);
  }
  if (c.expectedMissing && c.expectedMissing.length > 0 && applicant.admission_decision === "auto_admitted") {
    failures.push("AUTO-ADMITTED despite an incomplete file");
  }
  if (c.lowGrades && applicant.admission_decision === "auto_admitted") {
    failures.push("AUTO-ADMITTED despite grades below the published floor");
  }

  // 4. Exact missing slots for faithful profiles.
  if (c.expectedMissing) {
    const exp = [...c.expectedMissing].sort().join(",");
    const act = [...result.missing].sort().join(",");
    if (exp !== act) failures.push(`missing mismatch — expected [${exp}] got [${act}]`);
  } else {
    // adversarial: missing must only ever contain real requirement slots
    const gen = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "unknown", curriculum: "KCSE", programmeCode: null });
    const valid = new Set(gen.map((g) => g.document_type));
    for (const m of result.missing) if (!valid.has(m)) failures.push(`missing contains non-slot type: ${m}`);
  }

  // 5. Every auto-sent reply carries the reference in the subject.
  const outs = repo.emailsForApplicant(applicant.id).filter((e) => e.direction === "out");
  for (const o of outs) {
    if (!o.subject.startsWith(`[${applicant.ref_number}]`)) failures.push(`outgoing subject missing ref prefix: "${o.subject}"`);
  }

  outcomes.push({ idx: i, case: c, ok: failures.length === 0, failures, finalStatus: result.finalStatus, missing: result.missing, decision: applicant.admission_decision });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cases = Array.from({ length: TOTAL }, (_, i) => {
    // each batch runs on a FRESH database — a resend can only duplicate an
    // email sent inside the same batch
    if (i % BATCH === 0) effectiveIds.length = 0;
    return registerCase(makeCase(i));
  });
  const outcomes: CaseOutcome[] = [];

  for (let b = 0; b < TOTAL; b += BATCH) {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    const ctx = ctxFor(repo);
    for (let i = b; i < Math.min(b + BATCH, TOTAL); i++) {
      await runCase(i, cases[i], ctx, repo, outcomes);
    }
    const done = Math.min(b + BATCH, TOTAL);
    const failing = outcomes.filter((o) => !o.ok).length;
    console.log(`stress: ${done}/${TOTAL} processed (${failing} failing so far)`);
  }

  // ── Determinism sample: 25 cases re-run on fresh databases must match ──
  let determinismFailures = 0;
  for (const idx of [3, 42, 77, 120, 233, 300, 411, 500, 618, 702, 808, 913, 999]) {
    if (idx >= TOTAL) continue;
    const c = cases[idx];
    const runs: Array<{ status: string; missing: string }> = [];
    for (let r = 0; r < 2; r++) {
      const repo = new Repo(openDb(":memory:"));
      seedDefaults(repo);
      const ctx = ctxFor(repo);
      const local: CaseOutcome[] = [];
      await runCase(idx, { ...c, id: `det-${idx}-${r}` }, ctx, repo, local);
      const o = local[0];
      runs.push({ status: o.finalStatus ?? "skipped", missing: [...(o.missing ?? [])].sort().join(",") });
    }
    if (runs[0].status !== runs[1].status || runs[0].missing !== runs[1].missing) {
      determinismFailures++;
      console.log(`stress: DETERMINISM FAILURE case ${idx}: ${JSON.stringify(runs)}`);
    }
  }

  // ── Report ──
  const failed = outcomes.filter((o) => !o.ok);
  const byProfile = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const o of outcomes) {
    byProfile.set(o.case.profile, (byProfile.get(o.case.profile) ?? 0) + 1);
    const k = o.skipped ? "skipped(duplicate)" : o.finalStatus ?? "?";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }

  console.log("\n══════════════════════════ STRESS REPORT ══════════════════════════\n");
  console.log(`Cases:        ${TOTAL} (seed ${SEED})`);
  console.log(`Profiles:     ${[...byProfile.entries()].map(([k, n]) => `${k}=${n}`).join("  ")}`);
  console.log(`Outcomes:     ${[...byStatus.entries()].map(([k, n]) => `${k}=${n}`).join("  ")}`);
  console.log(`Determinism:  ${determinismFailures === 0 ? "13/13 sampled cases re-ran identically" : `${determinismFailures} MISMATCHES`}`);
  console.log(`Duration:     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (failed.length) {
    console.log(`\nFAILED CASES (${failed.length}):`);
    for (const f of failed.slice(0, 25)) {
      console.log(`  case ${f.idx} [${f.case.profile}${f.case.programme ? ` ${f.case.programme.code}` : ""}] — ${f.failures.join(" | ")}`);
    }
    if (failed.length > 25) console.log(`  … and ${failed.length - 25} more`);
    console.log(`\nRESULT: ${TOTAL - failed.length}/${TOTAL} cases clean — FAILURES PRESENT`);
    process.exit(1);
  }
  console.log(`\nRESULT: ${TOTAL}/${TOTAL} cases clean — ALL GREEN`);
  process.exit(0);
}

main().catch((e) => {
  console.error("stress harness crashed:", e);
  process.exit(1);
});
