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

  const idNo = text.match(ID_NO_RE);
  if (idNo) fields.idNumber = idNo[1];

  // Exam index number (document intelligence field, v3 feature 6).
  const indexNo = text.match(/INDEX\s*(?:NO|NUMBER)\.?\s*[:\-]?\s*([0-9][0-9A-Z\/\-]{3,})/i);
  if (indexNo) fields.indexNumber = indexNo[1].toUpperCase().trim();

  const year = text.match(YEAR_RE);
  if (year) fields.examYear = year[0].match(/(19|20)\d{2}/)![0];

  return fields;
}
