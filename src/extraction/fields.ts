/**
 * Structured-field extraction from document text. Plain regex — code reads
 * the facts; AI is never needed for this step on well-formed documents.
 */
import type { ExtractedFields } from "../types";

const NAME_RE =
  /^(?:NAME(?:\s+OF\s+(?:APPLICANT|STUDENT|HOLDER))?|APPLICANT(?:\s+NAME)?|FULL\s+NAME)\s*[:\-]\s*(.+)$/im;

const POINTS_RE = [
  /(?:KCPE|KCSE)\s*(?:TOTAL|POINTS|MARKS)?\s*[:\-]?\s*(\d{2,3})\s*(?:POINTS|MARKS)?/i,
  /(\d{3})\s*(?:KCPE\s*)?(?:POINTS|MARKS)/i,
];

const MEAN_GRADE_RE = /MEAN\s+GRADE\s*[:\-]?\s*([A-E][+-]?)/i;
const MEAN_GRADE_WORD_RE = /MEAN\s+GRADE\s*[:\-]?\s*([A-E])\s*\(\s*(plus|minus|plain)\s*\)/i;

// Subject lines on KNEC slips: "ENGLISH  B-", "Mathematics: C+", "BIO B".
const SUBJECT_RE =
  /\b(ENGLISH|KISWAHILI|KIS|MATHEMATICS|MATHS|MATH|BIOLOGY|BIO|CHEMISTRY|CHEM|PHYSICS|PHY|GEOGRAPHY|GEO|HISTORY\s*(?:AND\s*GOVERNMENT)?|HIST|C\.?R\.?E|IRE|HRE|AGRICULTURE|AGRI|BUSINESS\s+STUDIES|COMPUTER\s+STUDIES|COMPUTER|FRENCH|GERMAN|MUSIC|ART\s*(?:AND\s*DESIGN)?|HOME\s*SCIENCE|POWER\s*MECHANICS|AVIATION|WOODWORK|METAL\s*WORK|BUILDING\s*(?:CONSTRUCTION)?|ELECTRICITY|DRAWING\s*(?:AND\s*DESIGN)?|ARABIC|SIGN\s*LANGUAGE)\b\s*[:\-\u2013]?\s*(?:GRADE\s*)?\(?([A-E][+-]?)\)?/g;

const SUBJECT_NAMES: Record<string, string> = {
  KIS: "Kiswahili", MATHEMATICS: "Mathematics", MATHS: "Mathematics", MATH: "Mathematics",
  BIO: "Biology", CHEM: "Chemistry", PHY: "Physics", GEO: "Geography",
  HIST: "History", "HISTORY AND GOVERNMENT": "History", "C.R.E": "CRE", CRE: "CRE",
  IRE: "IRE", HRE: "HRE", AGRI: "Agriculture", "ART AND DESIGN": "Art & Design",
  ART: "Art & Design", "DRAWING AND DESIGN": "Drawing & Design",
  "BUILDING CONSTRUCTION": "Building Construction", "COMPUTER STUDIES": "Computer Studies",
};

function prettifySubject(raw: string): string {
  const key = raw.toUpperCase().replace(/\s+/g, " ").trim();
  if (SUBJECT_NAMES[key]) return SUBJECT_NAMES[key];
  return key
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "B (plain)" → "B", "C (plus)" → "C+" — KNEC prints the word forms. */
function normalizeGradeLetter(letter: string, word?: string): string {
  if (!word) return letter.toUpperCase();
  const w = word.toLowerCase();
  if (w === "plus") return `${letter.toUpperCase()}+`;
  if (w === "minus") return `${letter.toUpperCase()}-`;
  return letter.toUpperCase();
}
const ID_NO_RE = /(?:ID|IDENTITY)\s*(?:NO|NUMBER|CARD\s*NO)\.?\s*[:\-]?\s*(\d{6,10})/i;
const YEAR_RE = /(?:YEAR|INDEX\s+YEAR|EXAM(?:INATION)?\s+YEAR)\s*[:\-]?\s*(19|20)\d{2}/i;

export function extractFields(text: string): ExtractedFields {
  const fields: ExtractedFields = {};
  if (!text) return fields;

  const name = text.match(NAME_RE);
  if (name) {
    const cleaned = name[1].trim().replace(/\s+/g, " ");
    if (cleaned.length >= 3 && cleaned.length <= 80) fields.name = cleaned;
  }

  for (const re of POINTS_RE) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 100 && n <= 500) {
        fields.gradePoints = n;
        break;
      }
    }
  }

  // Word forms first: "MEAN GRADE: C (plus)" carries more information than
  // the plain-letter match, so it must not be shadowed by it.
  const gradeWord = text.match(MEAN_GRADE_WORD_RE);
  if (gradeWord) fields.meanGrade = normalizeGradeLetter(gradeWord[1], gradeWord[2]);
  else {
    const grade = text.match(MEAN_GRADE_RE);
    if (grade) fields.meanGrade = grade[1].toUpperCase();
  }

  // Per-subject grades → the map the grade rules are checked against.
  const subjects: Record<string, string> = {};
  SUBJECT_RE.lastIndex = 0;
  for (const m of text.matchAll(SUBJECT_RE)) {
    const subject = prettifySubject(m[1]);
    const g = m[2].toUpperCase();
    if (!subjects[subject]) subjects[subject] = g;
  }
  // Word forms ("ENGLISH C (plus)") OVERRIDE the plainer capture — "C" alone
  // would silently drop the plus and understate the applicant's grade.
  const gradeWords = text.matchAll(/\b(ENGLISH|KISWAHILI|MATHEMATICS|BIOLOGY|CHEMISTRY|PHYSICS|HISTORY|GEOGRAPHY|CRE|AGRICULTURE)\b\s*[:\-\u2013]?\s*([A-E])\s*\(\s*(plus|minus|plain)\s*\)/gi);
  for (const m of gradeWords) {
    const subject = prettifySubject(m[1]);
    subjects[subject] = normalizeGradeLetter(m[2], m[3]);
  }
  if (Object.keys(subjects).length) fields.subjectGrades = subjects;

  const idNo = text.match(ID_NO_RE);
  if (idNo) fields.idNumber = idNo[1];

  // Exam index number (document intelligence field, v3 feature 6).
  const indexNo = text.match(/INDEX\s*(?:NO|NUMBER)\.?\s*[:\-]?\s*([0-9][0-9A-Z\/\-]{3,})/i);
  if (indexNo) fields.indexNumber = indexNo[1].toUpperCase().trim();

  const year = text.match(YEAR_RE);
  if (year) fields.examYear = year[0].match(/(19|20)\d{2}/)![0];

  // ── Qualification system detection + system-specific readings ────────────
  // KCSE keeps its native readings above (mean grade + KNEC subject lines);
  // the other systems carry different marks entirely, so each gets its own
  // parser. Detection is keyword-driven and conservative: when nothing is
  // recognised, examSystem stays unset and a human decides the route.
  const up = text.toUpperCase();
  if (/KENYA\s+CERTIFICATE\s+OF\s+SECONDARY|\bKCSE\b/.test(up)) {
    fields.examSystem = "KCSE";
  } else if (/INTERNATIONAL\s+BACCALAUREATE|\bIB\s+DIPLOMA\b/.test(up)) {
    fields.examSystem = "IB";
    const pts = up.match(/(?:TOTAL\s+POINTS?|IB\s+POINTS?|DIPLOMA\s+POINTS?)\s*[:\-]?\s*(\d{1,2})/);
    if (pts) {
      const n = parseInt(pts[1], 10);
      if (n >= 0 && n <= 45) fields.ibPoints = n;
    }
    // Subject scores 1–7 ("MATHEMATICS HL: 6").
    const ibSubjects: Record<string, string> = {};
    for (const m of up.matchAll(/\b(ENGLISH|KISWAHILI|MATHEMATICS|BIOLOGY|CHEMISTRY|PHYSICS|HISTORY|GEOGRAPHY|ECONOMICS|BUSINESS(?:\s+MANAGEMENT)?|COMPUTER(?:\s+SCIENCE)?|FRENCH|SPANISH|LITERATURE)\s*(?:HL|SL)?\s*[:\-]\s*([1-7])\b/g)) {
      ibSubjects[prettifySubject(m[1])] = m[2];
    }
    if (Object.keys(ibSubjects).length) fields.subjectGrades = { ...(fields.subjectGrades ?? {}), ...ibSubjects };
  } else if (/GCE\s+ADVANCED\s+LEVEL|ADVANCED\s+LEVEL\s+EXAMINATION|\bKACE\b|\bEAACE\b|A-LEVEL/.test(up)) {
    fields.examSystem = "ALEVEL";
    // Principal passes: subjects listed with a grade A–E. Subsidiary passes
    // are marked explicitly on the slip.
    let principals = 0;
    let subsidiaries = 0;
    const principalSubjects: Record<string, string> = {};
    for (const m of up.matchAll(/\b(ENGLISH|KISWAHILI|MATHEMATICS|BIOLOGY|CHEMISTRY|PHYSICS|HISTORY|GEOGRAPHY|ECONOMICS|COMPUTER(?:\s+SCIENCE)?|FRENCH|LITERATURE|DIVINITY|AGRICULTURE)\s*[:\-]\s*([A-E])\b/g)) {
      principals++;
      principalSubjects[prettifySubject(m[1])] = m[2];
    }
    for (const m of up.matchAll(/SUBSIDIARY\s*[:\-]?\s*(\d)/g)) subsidiaries += parseInt(m[1], 10);
    const subWord = up.match(/SUBSIDIARY\s+(?:PASS(?:ES)?|SUBJECTS?)\s*[:\-]?\s*(\d)/);
    if (subWord) subsidiaries = Math.max(subsidiaries, parseInt(subWord[1], 10));
    if (principals > 0) {
      fields.principals = principals;
      fields.subsidiaries = subsidiaries;
      fields.subjectGrades = { ...(fields.subjectGrades ?? {}), ...principalSubjects };
    }
  } else if (/\bIGCSE\b|CAMBRIDGE\s+INTERNATIONAL|GCE\s+ORDINARY\s+LEVEL|INTERNATIONAL\s+GCSE/.test(up)) {
    fields.examSystem = "IGCSE";
    // Subject grades A*–G; a "credit" is any pass at C or better.
    const igSubjects: Record<string, string> = {};
    for (const m of up.matchAll(/\b(ENGLISH(?:\s+LANGUAGE)?|KISWAHILI|MATHEMATICS|BIOLOGY|CHEMISTRY|PHYSICS|HISTORY|GEOGRAPHY|ECONOMICS|BUSINESS\s+STUDIES|COMPUTER(?:\s+SCIENCE)?|FRENCH|SPANISH|LITERATURE|ACCOUNTING)\s*[:\-]\s*(A\*|[A-G])\b/g)) {
      igSubjects[prettifySubject(m[1])] = m[2];
    }
    if (Object.keys(igSubjects).length) {
      fields.subjectGrades = { ...(fields.subjectGrades ?? {}), ...igSubjects };
      fields.credits = Object.values(igSubjects).filter((g) => ["A*", "A", "B", "C"].includes(g)).length;
    }
  } else if (/PRE-?UNIVERSITY|BRIDGING\s+(?:PROGRAMME|CERTIFICATE)/.test(up)) {
    fields.examSystem = "PREUNI";
  } else if (/\bDIPLOMA\b/.test(up) && /TRANSCRIPT|RESULT|GRADE|CERTIFICATE/.test(up)) {
    fields.examSystem = "DIPLOMA";
  } else if (/\bDEGREE\b|BACHELOR|MASTER\s+OF|POSTGRADUATE/.test(up)) {
    fields.examSystem = "DEGREE";
  }

  // GPA (Pre-University, diplomas, IB Grade 12…) — any system.
  const gpa = up.match(/\bGPA\s*[:\-]?\s*([0-4](?:\.\d{1,2})?)\b/);
  if (gpa) fields.gpa = parseFloat(gpa[1]);

  // Award class: degree classifications and diploma grades.
  if (/FIRST\s+CLASS\s+HONOU?RS/.test(up)) fields.classAwarded = "First Class Honours";
  else if (/SECOND\s+CLASS\s+HONOU?RS?\s*\(?\s*(UPPER\s+DIVISION|UPPER)\s*\)?/.test(up)) fields.classAwarded = "Second Class Honours (Upper Division)";
  else if (/SECOND\s+CLASS\s+HONOU?RS?\s*\(?\s*(LOWER\s+DIVISION|LOWER)\s*\)?/.test(up)) fields.classAwarded = "Second Class Honours (Lower Division)";
  else if (/SECOND\s+CLASS\s+(UPPER|UPPER\s+DIVISION)/.test(up)) fields.classAwarded = "Second Class Honours (Upper Division)";
  else if (/SECOND\s+CLASS\s+(LOWER|LOWER\s+DIVISION)/.test(up)) fields.classAwarded = "Second Class Honours (Lower Division)";
  else {
    const cls = up.match(/(?:OVERALL\s+(?:GRADE|RESULT)|CLASSIFICATION|AWARD)\s*[:\-]\s*(DISTINCTION|CREDIT|MERIT|PASS)/);
    if (cls) fields.classAwarded = cls[1][0] + cls[1].slice(1).toLowerCase();
  }

  return fields;
}
