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
  { document_type: "academic_cert" as const, required: true, meanGrade: "C+" },
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
}

export const DEFAULT_PROGRAMMES: DefaultProgramme[] = [
  // ── School of Law ──
  { code: "LLB", name: "Bachelor of Laws", school: "School of Law",
    entry: "KCSE mean grade C+ (plus) with B (plain) in English or Kiswahili; or KACE with three principal passes; or a degree from a recognised university; or a CLE-accredited Diploma in Law (average B). An oral interview may be required." },
  // ── School of Business ──
  { code: "BBA", name: "Bachelor of Business Administration", school: "School of Business",
    entry: "KCSE C+ (plus) with C (plain) in English and Mathematics; or GCE A-Level with at least 2 principal passes; or other Senate-recognised certificates." },
  { code: "DBM", name: "Diploma in Business Management", school: "School of Business",
    entry: "KCSE C- (minus) with C- or above in English or Mathematics; or 3 upper-level IGCSE/IB passes; or 3 GCE O/A-Level credits." },
  { code: "CBM", name: "Certificate in Business Management", school: "School of Business",
    entry: "KCSE D+ or equivalent (confirm current details)." },
  { code: "MBA", name: "Master of Business Administration", school: "School of Business",
    entry: "Bachelor's with at least Second Class Honours (Upper Division); Lower Division with relevant experience; Pass holders need a postgraduate diploma or substantial experience." },
  // ── School of Computing Sciences ──
  { code: "BCS", name: "BSc Computer Science", school: "School of Computing Sciences",
    entry: "KCSE C+ with minimum C+ in Mathematics or Physics or Physical Sciences; or a Diploma/Professional Certificate in computing; or a science-based degree." },
  { code: "BBIT", name: "Bachelor of Business Information Technology", school: "School of Computing Sciences",
    entry: "KCSE C+ with minimum D+ in Mathematics or Physics or Physical Sciences; or a Diploma/Professional Certificate in computing; or a science-based degree." },
  { code: "DCS", name: "Diploma in Computer Science", school: "School of Computing Sciences",
    entry: "Typically KCSE C- (minus) and above; also D+ in Mathematics or Physics." },
  { code: "DCY", name: "Diploma in Information & Cyber Security", school: "School of Computing Sciences",
    entry: "Typically KCSE C- (minus) and above." },
  { code: "CIT", name: "Certificate in Information Technology", school: "School of Computing Sciences",
    entry: "KCSE D+ or equivalent." },
  // ── School of International Relations & Diplomacy ──
  { code: "BIR", name: "BA International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE minimum C+ (plus); or a Diploma in IR & Diplomacy (GPA 2.00/C); or KACE with 2 principals + 1 subsidiary; or IGCSE with 5 credits." },
  { code: "DIR", name: "Diploma in International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE C- (minus) or equivalent with C or above in English and C in any Science." },
  { code: "CCD", name: "Certificate in Corporate Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "KCSE D+ or equivalent." },
  { code: "MIR", name: "MA International Relations and Diplomacy", school: "School of International Relations & Diplomacy",
    entry: "Bachelor's with Second Class Honours Upper Division; Lower Division plus relevant experience; or other Senate-accepted qualifications with experience." },
  // ── School of Communication and Multimedia Journalism ──
  { code: "BCJ", name: "Bachelor of Communication and Multimedia Journalism", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE mean C+ with C+ in English or Kiswahili and D+ in Mathematics; or a Diploma with Credit in a relevant discipline." },
  { code: "DCJ", name: "Diploma in Communication and Multimedia Journalism", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE C- (minus) or equivalent with C or above in English or any language." },
  { code: "DPR", name: "Diploma in Corporate Public Relations", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE C- with C or above in English/Kiswahili; or D+ plus a recognised certificate." },
  { code: "CCM", name: "Certificate in Communication", school: "School of Communication and Multimedia Journalism",
    entry: "KCSE D+ or equivalent." },
  // ── School of Nursing ──
  { code: "BNS", name: "BSc Nursing", school: "School of Nursing",
    entry: "KCSE mean grade C+ (plus) — the university-wide degree minimum. Programme-specific subject requirements were not in the published details provided; confirm with the Admissions Office before relying on automated checks." },
  { code: "DNS", name: "Diploma in Nursing (Pre-Service)", school: "School of Nursing",
    entry: "KCSE mean grade C (plain) — the general diploma minimum. Programme-specific subject requirements were not in the published details provided; confirm with the Admissions Office." },
  { code: "KRCHN", name: "Certificate: Kenya Registered Community Health Nursing", school: "School of Nursing",
    entry: "KCSE mean grade D+ — the university-wide certificate minimum. Programme-specific requirements were not in the published details provided; confirm with the Admissions Office." },
  // ── School of Education ──
  { code: "BED", name: "Bachelor of Education (Arts)", school: "School of Education",
    entry: "KCSE C+ (plus) or equivalent; or a Diploma in Education with credit; or A-Level with 2 principal passes; C+ in teaching subjects commonly expected." },
  { code: "CTI", name: "Certificate in Teaching International Curricula", school: "School of Education",
    entry: "Aimed at practising teachers; specific academic thresholds vary." },
];

/**
 * Per-course grade rules seeded once (staff-editable afterwards — they are
 * stored in requirement_rules like any rule added in Configuration).
 *
 * Source: Riara University's published admission requirements (general
 * minimum entry + school pages). Grades, not points: KCSE mean grade plus
 * per-subject lines exactly as published. Subject syntax: commas/semicolons
 * separate requirements that ALL apply; a slash means EITHER/OR
 * ("B in English/Kiswahili" = one of the two is enough).
 *
 * Postgraduate rows carry no KCSE grade rule — a degree class (Second Class
 * Honours Upper Division) is verified by a human, not by this engine.
 * Nursing rows use only the university-wide minima: programme-specific
 * subject clusters were not in the published details provided, so they stay
 * blank until the Admissions Office confirms them.
 */
export const DEFAULT_PROGRAMME_REQUIREMENTS: Array<{
  programme: string;
  document_type: "academic_cert" | "kcpe_cert";
  meanGrade: string | null;
  subjectGrades?: string;
}> = [
  // ── Undergraduate degrees — general floor C+ plus published subjects ──
  // LLB: C+ mean with B plain in English OR Kiswahili (interview may follow —
  // interviews are a human step, not a document check).
  { programme: "LLB", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "B in English/Kiswahili" },
  // BBA: C+ mean with C plain in English AND Mathematics (both required).
  { programme: "BBA", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "C in English; C in Mathematics" },
  // BSc Computer Science: C+ mean with C+ in Mathematics OR Physics OR
  // Physical Sciences.
  { programme: "BCS", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "C+ in Mathematics/Physics/Physical Sciences" },
  // BBIT: C+ mean with D+ in Mathematics OR Physics OR Physical Sciences.
  { programme: "BBIT", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "D+ in Mathematics/Physics/Physical Sciences" },
  // BA International Relations & Diplomacy: minimum C+, with C+ in English
  // or Kiswahili.
  { programme: "BIR", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "C+ in English/Kiswahili" },
  // B. Communication & Multimedia Journalism: C+ mean with C+ in English or
  // Kiswahili AND D+ in Mathematics.
  { programme: "BCJ", document_type: "academic_cert", meanGrade: "C+", subjectGrades: "C+ in English/Kiswahili; D+ in Mathematics" },
  // BEd (Arts): C+ mean (C+ in teaching subjects is commonly expected — the
  // subject list varies per specialisation, so staff add it per intake).
  { programme: "BED", document_type: "academic_cert", meanGrade: "C+" },
  // ── Diplomas — C-/C floors override the general C+ degree floor ──
  // Diploma in Business Management: C- mean with C- in English OR Mathematics.
  { programme: "DBM", document_type: "academic_cert", meanGrade: "C-", subjectGrades: "C- in English/Mathematics" },
  // Diploma in Computer Science: typically C- with D+ in Mathematics or Physics.
  { programme: "DCS", document_type: "academic_cert", meanGrade: "C-", subjectGrades: "D+ in Mathematics/Physics" },
  // Diploma in Information & Cyber Security: typically C- and above.
  { programme: "DCY", document_type: "academic_cert", meanGrade: "C-" },
  // Diploma in IR & Diplomacy: C- mean with C in English AND C in any Science
  // (the science cluster is checked against the KCSE sciences).
  { programme: "DIR", document_type: "academic_cert", meanGrade: "C-", subjectGrades: "C in English; C in Biology/Chemistry/Physics" },
  // Diploma in Communication & Multimedia Journalism: C- with C in English or
  // any language (Kiswahili stands in for the second language).
  { programme: "DCJ", document_type: "academic_cert", meanGrade: "C-", subjectGrades: "C in English/Kiswahili" },
  // Diploma in Corporate Public Relations: C- with C in English/Kiswahili.
  { programme: "DPR", document_type: "academic_cert", meanGrade: "C-", subjectGrades: "C in English/Kiswahili" },
  // Diploma in Nursing: general diploma minimum (C plain) — programme-specific
  // subjects not published in the provided details; confirm with Admissions.
  { programme: "DNS", document_type: "academic_cert", meanGrade: "C" },
  // ── Certificates — general D+ minimum ──
  { programme: "CBM", document_type: "academic_cert", meanGrade: "D+" },
  { programme: "CIT", document_type: "academic_cert", meanGrade: "D+" },
  { programme: "CCD", document_type: "academic_cert", meanGrade: "D+" },
  { programme: "CCM", document_type: "academic_cert", meanGrade: "D+" },
  // KRCHN: general certificate minimum — NCK subject requirements to confirm.
  { programme: "KRCHN", document_type: "academic_cert", meanGrade: "D+" },
  // CTI (Certificate in Teaching International Curricula): no published
  // academic threshold — intentionally no rule; staff may add one.
  // ── Postgraduate — degree class is a human judgment, no KCSE rule ──
  { programme: "MBA", document_type: "academic_cert", meanGrade: null },
  { programme: "MIR", document_type: "academic_cert", meanGrade: null },
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
