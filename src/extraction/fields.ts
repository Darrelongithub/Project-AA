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

  const grade = text.match(MEAN_GRADE_RE);
  if (grade) fields.meanGrade = grade[1].toUpperCase();
  const gradeWord = text.match(MEAN_GRADE_WORD_RE);
  if (gradeWord && !fields.meanGrade) fields.meanGrade = normalizeGradeLetter(gradeWord[1], gradeWord[2]);

  // Per-subject grades → the map the grade rules are checked against.
  const subjects: Record<string, string> = {};
  SUBJECT_RE.lastIndex = 0;
  for (const m of text.matchAll(SUBJECT_RE)) {
    const subject = prettifySubject(m[1]);
    const g = m[2].toUpperCase();
    if (!subjects[subject]) subjects[subject] = g;
  }
  const gradeWords = text.matchAll(/\b(ENGLISH|KISWAHILI|MATHEMATICS|BIOLOGY|CHEMISTRY|PHYSICS|HISTORY|GEOGRAPHY|CRE|AGRICULTURE)\b\s*[:\-\u2013]?\s*([A-E])\s*\(\s*(plus|minus|plain)\s*\)/gi);
  for (const m of gradeWords) {
    const subject = prettifySubject(m[1]);
    if (!subjects[subject]) subjects[subject] = normalizeGradeLetter(m[2], m[3]);
  }
  if (Object.keys(subjects).length) fields.subjectGrades = subjects;

  const idNo = text.match(ID_NO_RE);
  if (idNo) fields.idNumber = idNo[1];

  // Exam index number (document intelligence field, v3 feature 6).
  const indexNo = text.match(/INDEX\s*(?:NO|NUMBER)\.?\s*[:\-]?\s*([0-9][0-9A-Z\/\-]{3,})/i);
  if (indexNo) fields.indexNumber = indexNo[1].toUpperCase().trim();

  const year = text.match(YEAR_RE);
  if (year) fields.examYear = year[0].match(/(19|20)\d{2}/)![0];

  return fields;
}
