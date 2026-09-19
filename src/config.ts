/**
 * Configuration. Everything external (Gemini, Gmail) is optional: without
 * credentials the system runs in mock mode (tests, simulation, demo).
 */
import * as dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  mode: "mock" | "live";
  dbPath: string;
  port: number;
  geminiApiKey?: string;
  geminiModel: string;
  gmail?: {
    address: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Gmail label to watch instead of the inbox (optional). */
    label?: string;
  };
  ingestLookbackDays: number;
  disableOcr: boolean;
  logToFile: boolean;
  /** Factual auto-replies (receipt/missing-docs/status). Never decisions. */
  autoMissingDocsEmails: boolean;
  autoStatusAnswers: boolean;
}

export function loadConfig(): AppConfig {
  const env = process.env;
  const mode = env.MODE === "live" ? "live" : "mock";

  const gmailConfigured =
    !!env.GMAIL_ADDRESS &&
    !!env.GMAIL_OAUTH_CLIENT_ID &&
    !!env.GMAIL_OAUTH_CLIENT_SECRET &&
    !!env.GMAIL_OAUTH_REFRESH_TOKEN;

  return {
    mode,
    dbPath: env.DB_PATH || "./data/email-sorter.sqlite",
    port: Number(env.PORT || 8080),
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiModel: env.GEMINI_MODEL || "gemini-1.5-flash",
    gmail: gmailConfigured
      ? {
          address: env.GMAIL_ADDRESS!,
          clientId: env.GMAIL_OAUTH_CLIENT_ID!,
          clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET!,
          refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN!,
          label: env.GMAIL_LABEL || undefined,
        }
      : undefined,
    ingestLookbackDays: Number(env.INGEST_LOOKBACK_DAYS || 2),
    disableOcr: env.DISABLE_OCR === "1",
    logToFile: env.LOG_TO_FILE !== "0",
    autoMissingDocsEmails: env.AUTO_MISSING_DOCS_EMAILS !== "0",
    autoStatusAnswers: env.AUTO_STATUS_ANSWERS !== "0",
  };
}

/**
 * Default (base) requirement set — overridden by programme/intake rules.
 * Mirrors the university's published application basics: application form,
 * national ID/passport, academic certificates. The general minimum entry for
 * undergraduate study is a KCSE mean grade of C+ on the secondary certificate
 * (academic_cert); diploma/certificate/postgraduate courses override that
 * floor per course in Configuration. The KCPE certificate is NOT part of the
 * published requirement set — it stays a recognised document but is optional.
 */
export const DEFAULT_REQUIREMENTS = [
  // Presence only: grade checks live in the structured entry requirements.
  { document_type: "academic_cert" as const, required: true },
  { document_type: "kcpe_cert" as const, required: false },
  { document_type: "id" as const, required: true },
  { document_type: "application_form" as const, required: true },
  { document_type: "birth_cert" as const, required: false },
];

/**
 * Seed data for programmes and intakes (editable in Settings).
 * Grouped by school, with the official minimum entry requirements as
 * published by the university — shown to staff as reference text.
 */
export interface DefaultProgramme {
  code: string;
  name: string;
  school: string;
  entry: string;
  level: CourseLevel;
}

export const DEFAULT_PROGRAMMES: DefaultProgramme[] = [
  // ── School of Law ──
  { code: "LLB", name: "Bachelor of Laws", school: "School of Law",
    entry: "KCSE mean grade C+ (plus) with B (plain) in English or Kiswahili; or KACE with three principal passes; or a degree from a recognised university; or a CLE-accredited Diploma in Law (average B). An oral interview may be required.", level: "degree" },
  // ── School of Business ──
  { code: "BBA", name: "Bachelor of Business Administration", school: "School of Business",
    entry: "KCSE C+ (plus) with C (plain) in English and Mathematics; or GCE A-Level with at least 2 principal passes; or other Senate-recognised certificates.", level: "degree" },
  { code: "DBM", name: "Diploma in Business Management", school: "School of Business",
    entry: "KCSE C- (minus) with C- or above in English or Mathematics; or 3 upper-level IGCSE/IB passes; or 3 GCE O/A-Level credits.", level: "diploma" },
  { code: "CBM", name: "Certificate in Business Management", school: "School of Business",
    entry: "KCSE D+ or equivalent (confirm current details).", level: "certificate" },
  { code: "MBA", name: "Master of Business Administration", school: "School of Business",
    entry: "Bachelor's with at least Second Class Honours (Upper Division); Lower Division with relevant experience; Pass holders need a postgraduate diploma or substantial experience.", level: "masters" },
  // ── School of Computing Sciences ──
  { code: "BCS", name: "BSc Computer Science", school: "School of Computing Sciences",
    entry: "KCSE C+ with minimum C+ in Mathematics or Physics or Physical Sciences; or a Diploma/Professional Certificate in computing; or a science-based degree.", level: "degree" },
  { code: "BBIT", name: "Bachelor of Business Information Technology", school: "School of Computing Sciences",
    entry: "KCSE C+ with minimum D+ in Mathematics or Physics or Physical Sciences; or a Diploma/Professional Certificate in computing; or a science-based degree.", level: "degree" },
  { code: "DCS", name: "Diploma in Computer Science", school: "School of Computing Sciences",
    entry: "Typically KCSE C- (minus) and above; also D+ in Mathematics or Physics.", level: "diploma" },
  { code: "DCY", name: "Diploma in Information & Cyber Security", school: "School of Computing Sciences",
    entry: "Typically KCSE C- (minus) and above.", level: "diploma" },
  { code: "CIT", name: "Certificate in Information Technology", school: "School of Computing Sciences",
    entry: "KCSE D+ or equivalent.", level: "certificate" },
  // ── School of International Relations & Diplomacy ──
  { code: "BIR", name: "BA International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE minimum C+ (plus); or a Diploma in IR & Diplomacy (GPA 2.00/C); or KACE with 2 principals + 1 subsidiary; or IGCSE with 5 credits.", level: "degree" },
  { code: "DIR", name: "Diploma in International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE C- (minus) or equivalent with C or above in English and C in any Science.", level: "diploma" },
  { code: "CCD", name: "Certificate in Corporate Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE D+ or equivalent.", level: "certificate" },
  { code: "MIR", name: "MA International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "Bachelor's with Second Class Honours Upper Division; Lower Division plus relevant experience; or other Senate-accepted qualifications with experience.", level: "masters" },
  // ── School of Communication and Multimedia Journalism ──
  { code: "BCJ", name: "Bachelor of Communication and Multimedia Journalism", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE mean C+ with C+ in English or Kiswahili and D+ in Mathematics; or a Diploma with Credit in a relevant discipline.", level: "degree" },
  { code: "DCJ", name: "Diploma in Communication and Multimedia Journalism", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE C- (minus) or equivalent with C or above in English or any language.", level: "diploma" },
  { code: "DPR", name: "Diploma in Corporate Public Relations", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE C- with C or above in English/Kiswahili; or D+ plus a recognised certificate.", level: "diploma" },
  { code: "CCM", name: "Certificate in Communication", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE D+ or equivalent.", level: "certificate" },
  // ── School of Nursing ──
  { code: "BNS", name: "BSc Nursing", school: "School of Nursing",
    entry: "KCSE mean grade C+ (plus) — the university-wide degree minimum. Programme-specific subject requirements were not in the published details provided; confirm with the Admissions Office before relying on automated checks.", level: "degree" },
  { code: "DNS", name: "Diploma in Nursing (Pre-Service)", school: "School of Nursing",
    entry: "KCSE mean grade C (plain) — the general diploma minimum. Programme-specific subject requirements were not in the published details provided; confirm with the Admissions Office.", level: "diploma" },
  { code: "KRCHN", name: "Certificate: Kenya Registered Community Health Nursing", school: "School of Nursing",
    entry: "KCSE mean grade D+ — the university-wide certificate minimum. Programme-specific requirements were not in the published details provided; confirm with the Admissions Office.", level: "certificate" },
  // ── School of Education ──
  { code: "BED", name: "Bachelor of Education (Arts)", school: "School of Education",
    entry: "KCSE C+ (plus) or equivalent; or a Diploma in Education with credit; or A-Level with 2 principal passes; C+ in teaching subjects commonly expected.", level: "degree" },
  { code: "CTI", name: "Certificate in Teaching International Curricula", school: "School of Education",
    entry: "Aimed at practising teachers; specific academic thresholds vary.", level: "certificate" },
];



export const DEFAULT_INTAKES = ["September 2026", "January 2027"];

/** Default SLA / behaviour settings (editable in Settings). */
export const DEFAULT_SETTINGS: Record<string, string> = {
  ref_prefix: "RU",
  sla_target_hours: "4",
  escalation_hours: "8",
  from_name: "Riara University Admissions",
  // v3
  unanswered_target_hours: "4", // unanswered-email panel threshold
  followup_ladder_days: "3,7,10", // Day 3 reminder, Day 7 final, Day 10 → human
  retention_days: "730", // completed cases kept 2 years, then archived+removed
  automation_mode: "auto", // 'draft' holds EVERY automated reply for approval
};

// ── Structured entry requirements ───────────────────────────────────────────
// Every qualification system the university accepts, with the fields each
// system is actually marked in. Requirements are stored per (course, system)
// block; the university-wide defaults below apply wherever a course has no
// block of its own. All of it is editable in Configuration.

import type { CourseLevel, ExamSystem, SystemBlock } from "./types";

export interface SystemMeta {
  system: ExamSystem;
  label: string;
  /** Which structured fields this system's editor/checker uses. */
  fields: Array<"overall" | "minCredits" | "minPrincipals" | "minSubsidiaries" | "minPoints" | "minGpa" | "minClass">;
  /** Subject-grade choices for the matrix (null = no subject matrix). */
  gradeOptions: string[] | null;
}

export const EXAM_SYSTEMS: SystemMeta[] = [
  { system: "KCSE", label: "KCSE (Kenya Certificate of Secondary Education)", fields: ["overall"], gradeOptions: ["A","A-","B+","B","B-","C+","C","C-","D+","D","D-","E"] },
  { system: "IGCSE", label: "IGCSE / GCE O-Level", fields: ["minCredits"], gradeOptions: ["A*","A","B","C","D","E","F","G"] },
  { system: "ALEVEL", label: "GCE A-Level / KACE / EAACE", fields: ["minPrincipals", "minSubsidiaries"], gradeOptions: ["A","B","C","D","E"] },
  { system: "IB", label: "International Baccalaureate", fields: ["minPoints"], gradeOptions: ["7","6","5","4","3","2","1"] },
  { system: "DIPLOMA", label: "Diploma / Higher Diploma", fields: ["minClass", "minGpa"], gradeOptions: null },
  { system: "PREUNI", label: "Pre-University / Bridging", fields: ["minGpa"], gradeOptions: null },
  { system: "DEGREE", label: "Existing degree (advanced entry)", fields: ["minClass"], gradeOptions: null },
];

/** Subjects offered in the tick-matrix (KCSE catalogue; IGCSE/A-Level/IB share the names that apply). */
export const SUBJECT_CATALOG = [
  "English", "Kiswahili", "Mathematics", "Physics", "Chemistry", "Biology",
  "Physical Sciences", "History", "Geography", "CRE", "IRE", "Agriculture",
  "Business Studies", "Computer Studies", "Economics", "French", "German",
  "Arabic", "Literature", "Music", "Art & Design", "Home Science",
  "Building Construction", "Electricity", "Drawing & Design", "Sign Language",
];

const B = (system: ExamSystem, rest: Omit<SystemBlock, "system" | "enabled"> & { enabled?: boolean }): SystemBlock =>
  ({ system, enabled: rest.enabled ?? true, overall: null, ...rest });

/**
 * University-wide defaults per award level — the published general minima
 * (KCSE C+/C/D+, IGCSE credits, A-Level principals, IB points, diploma/
 * pre-university/degree routes). Course blocks override these per system.
 */
export const DEFAULT_STRUCTURED_BASE: Array<{ level: CourseLevel; block: SystemBlock }> = [
  // ── Degree programmes ──
  { level: "degree", block: B("KCSE", { overall: "C+" }) },
  { level: "degree", block: B("IGCSE", { minCredits: 5 }) },
  { level: "degree", block: B("ALEVEL", { minPrincipals: 2 }) },
  { level: "degree", block: B("IB", { minPoints: 24 }) },
  { level: "degree", block: B("DIPLOMA", { minClass: "Credit" }) },
  { level: "degree", block: B("PREUNI", { minGpa: 2.5 }) },
  { level: "degree", block: B("DEGREE", {}) }, // recognised-degree route: no automated minimum
  // ── Diploma programmes ──
  { level: "diploma", block: B("KCSE", { overall: "C" }) },
  { level: "diploma", block: B("IGCSE", { minCredits: 3 }) },
  { level: "diploma", block: B("ALEVEL", { minPrincipals: 1 }) },
  { level: "diploma", block: B("IB", { minGpa: 3.0 }) }, // IB Grade 12, GPA ≈ 3.00
  { level: "diploma", block: B("PREUNI", { minGpa: 2.5 }) },
  // ── Certificate programmes ──
  { level: "certificate", block: B("KCSE", { overall: "D+" }) },
  { level: "certificate", block: B("IGCSE", { minCredits: 3 }) },
  // ── Postgraduate ──
  { level: "masters", block: B("DEGREE", { minClass: "Second Class Honours (Upper Division)" }) },
];

/** Course-specific blocks — the published programme requirements. */
export const DEFAULT_STRUCTURED_COURSES: Array<{ programme: string; block: SystemBlock }> = [
  // Bachelor of Laws: KCSE C+ with B plain in English or Kiswahili; KACE/GCE
  // 3 principals; recognised degree; CLE-accredited Diploma in Law (average B).
  { programme: "LLB", block: B("KCSE", { overall: "C+", subjects: [{ subject: "English", grade: "B", alts: ["Kiswahili"] }] }) },
  { programme: "LLB", block: B("ALEVEL", { minPrincipals: 3 }) },
  { programme: "LLB", block: B("DIPLOMA", { minClass: "Credit" }) }, // Diploma in Law, average B — verified by a human
  { programme: "LLB", block: B("DEGREE", {}) },
  // BBA: C+ with C plain in English AND Mathematics.
  { programme: "BBA", block: B("KCSE", { overall: "C+", subjects: [{ subject: "English", grade: "C" }, { subject: "Mathematics", grade: "C" }] }) },
  { programme: "BBA", block: B("ALEVEL", { minPrincipals: 2 }) },
  { programme: "BBA", block: B("IGCSE", { minCredits: 5 }) },
  // BSc Computer Science: C+ with C+ in Mathematics or Physics/Physical Sciences.
  { programme: "BCS", block: B("KCSE", { overall: "C+", subjects: [{ subject: "Mathematics", grade: "C+", alts: ["Physics", "Physical Sciences"] }] }) },
  { programme: "BCS", block: B("ALEVEL", { minPrincipals: 2, subjects: [{ subject: "Mathematics", grade: "C", alts: ["Physics"] }] }) },
  { programme: "BCS", block: B("IGCSE", { minCredits: 5, subjects: [{ subject: "Mathematics", grade: "C", alts: ["Physics"] }] }) },
  { programme: "BCS", block: B("DIPLOMA", { minClass: "Credit" }) }, // computing diploma/professional certificate
  // BBIT: C+ with D+ in Mathematics or Physics/Physical Sciences.
  { programme: "BBIT", block: B("KCSE", { overall: "C+", subjects: [{ subject: "Mathematics", grade: "D+", alts: ["Physics", "Physical Sciences"] }] }) },
  { programme: "BBIT", block: B("DIPLOMA", { minClass: "Credit" }) },
  // BA International Relations & Diplomacy: C+, C+ in English or Kiswahili.
  { programme: "BIR", block: B("KCSE", { overall: "C+", subjects: [{ subject: "English", grade: "C+", alts: ["Kiswahili"] }] }) },
  { programme: "BIR", block: B("ALEVEL", { minPrincipals: 2, minSubsidiaries: 1 }) },
  { programme: "BIR", block: B("IGCSE", { minCredits: 5 }) },
  { programme: "BIR", block: B("DIPLOMA", { minGpa: 2.0 }) }, // Riara IR diploma, GPA 2.00/C
  // B. Communication & Multimedia Journalism: C+, C+ English/Kiswahili, D+ Maths.
  { programme: "BCJ", block: B("KCSE", { overall: "C+", subjects: [{ subject: "English", grade: "C+", alts: ["Kiswahili"] }, { subject: "Mathematics", grade: "D+" }] }) },
  { programme: "BCJ", block: B("DIPLOMA", { minClass: "Credit" }) },
  // BEd (Arts): C+; C+ in teaching subjects is commonly expected — the subject
  // list varies per specialisation, so staff tick them per intake.
  { programme: "BED", block: B("KCSE", { overall: "C+" }) },
  { programme: "BED", block: B("ALEVEL", { minPrincipals: 2, minSubsidiaries: 1 }) },
  { programme: "BED", block: B("IB", { minPoints: 24 }) },
  { programme: "BED", block: B("IGCSE", { minCredits: 5 }) },
  { programme: "BED", block: B("DIPLOMA", { minClass: "Credit" }) }, // Diploma in Education with credit
  // Diploma in Business Management (2026 brochure): KCSE C- with D plain in Mathematics.
  { programme: "DBM", block: B("KCSE", { overall: "C-", subjects: [{ subject: "Mathematics", grade: "D" }] }) },
  { programme: "DBM", block: B("IGCSE", { minCredits: 3 }) },
  // Diploma in Computer Science: C- with D+ in Mathematics or Physics.
  { programme: "DCS", block: B("KCSE", { overall: "C-", subjects: [{ subject: "Mathematics", grade: "D+", alts: ["Physics"] }] }) },
  // Diploma in Information & Cyber Security: C-.
  { programme: "DCY", block: B("KCSE", { overall: "C-" }) },
  // Diploma in IR & Diplomacy (2026 brochure): KCSE C- with C in English —
  // no science subject (an earlier draft was stricter than the published rule).
  { programme: "DIR", block: B("KCSE", { overall: "C-", subjects: [{ subject: "English", grade: "C" }] }) },
  // Diploma in Communication & Multimedia Journalism: C- with C in English or any language.
  { programme: "DCJ", block: B("KCSE", { overall: "C-", subjects: [{ subject: "English", grade: "C", alts: ["Kiswahili", "French", "German", "Arabic"] }] }) },
  // Diploma in Corporate Public Relations: C- with C in English/Kiswahili.
  { programme: "DPR", block: B("KCSE", { overall: "C-", subjects: [{ subject: "English", grade: "C", alts: ["Kiswahili"] }] }) },
  { programme: "DPR", block: B("IGCSE", { minCredits: 1 }) }, // D+ plus recognised certificate route — checked by a human
  // Diploma in Nursing: general diploma minimum (confirm specifics with Admissions).
  { programme: "DNS", block: B("KCSE", { overall: "C" }) },
  // MBA / MA IR: Second Class Honours Upper Division; Lower Division may be
  // admitted with relevant experience — that judgment belongs to a human.
  { programme: "MBA", block: B("DEGREE", { minClass: "Second Class Honours (Upper Division)" }) },
  { programme: "MIR", block: B("DEGREE", { minClass: "Second Class Honours (Upper Division)" }) },
];
