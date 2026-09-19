/**
 * Document-type classification by plain code (keyword rules, ordered so the
 * most distinctive patterns win). Gemini's own guess is only used when this
 * classifier says "unknown" — and even then the confidence is downgraded.
 *
 * Round 19: rules now cover the wording real documents actually use —
 * foreign birth certificates ("Birth Registration", "Certificate of Live
 * Birth", "Extract from the Register of Births"), Cambridge/GCE/IB result
 * statements, WAEC and other regional examiners — instead of only the exact
 * Kenyan phrases.
 */
import type { DocType } from "../types";

interface Rule {
  type: DocType;
  pattern: RegExp;
}

// Order matters: application forms often mention "KCSE points", so they must
// be checked before the academic-certificate rules.
const RULES: Rule[] = [
  {
    type: "credit_transfer_form",
    pattern: /credit\s+transfer|transfer\s+(?:of\s+)?credit|transfer\s+(?:application|admission)\s+form|request\s+for\s+transfer/i,
  },
  {
    type: "application_form",
    pattern: /application\s+form|application\s+for\s+admission|admission\s+application/i,
  },
  {
    type: "kcpe_cert",
    pattern: /kenya\s+certificate\s+of\s+primary\s+education|\bkcpe\b/i,
  },
  {
    // Birth documents arrive in many wordings and languages; the English
    // variants used across East Africa, India and the Caribbean are covered
    // here. Non-English falls to Gemini, whose guess is downgraded.
    type: "birth_cert",
    pattern:
      /certificate\s+of\s+birth|birth\s+certificate|birth\s+registration|certificate\s+of\s+live\s+birth|live\s+birth\s+certificate|extract\s+from\s+the\s+register\s+of\s+births|registration\s+of\s+birth|register\s+of\s+births|birth\s+entry|births?\s+and\s+deaths\s+registration/i,
  },
  // OR-5: concrete checklist document types — ordered before the academic
  // catch-all so each upload lands in its own slot.
  { type: "law_personal_statement", pattern: /personal\s+statement/i },
  { type: "business_statement_of_objective", pattern: /statement\s+of\s+objective/i },
  { type: "passport_photo", pattern: /passport[\s-]?size\s+photo|passport\s+photograph|passport\s+photo\b/i },
  { type: "masters_degree_certificate", pattern: /master'?s\s+degree\s+certificate|master'?s?\s+(?:degree|graduation)\s+certificate/i },
  { type: "masters_transcript", pattern: /master'?s\s+(?:academic\s+)?transcript/i },
  { type: "undergraduate_degree_certificate", pattern: /undergraduate\s+degree\s+certificate|(?:bachelor|bachelors|b\.?sc|b\.?a|bba|llb)\s+(?:degree\s+)?certificate/i },
  { type: "undergraduate_transcript", pattern: /undergraduate\s+(?:academic\s+)?transcript/i },
  { type: "leaving_certificate", pattern: /leaving\s+certificate|school\s+leaving/i },
  // A RESULT SLIP is the specific pre-certificate printout named on the
  // application-form checklist — not a generic "statement of results", which
  // stays with the academic family that carries the grades.
  { type: "exam_result_slip", pattern: /\bresult\s+slip\b|examination\s+result\s+slip/i },
  { type: "student_pass_application", pattern: /student\s+pass(?!port)|study\s+permit/i },
  { type: "foreign_qualification_equivalence", pattern: /equivalence\s+certificate|certificate\s+of\s+equivalence/i },
  {
    type: "academic_cert",
    pattern:
      /kenya\s+certificate\s+of\s+secondary\s+education|\bkcse\b|academic\s+transcript|secondary\s+(?:school\s+)?education|secondary\s+school\s+certificate|high\s+school\s+certificate|\bigcse\b|cambridge\s+international|cambridge\s+(?:assessment|o\s?level|a\s?level)|general\s+certificate\s+of\s+(?:secondary\s+education|education)|\bgcse\b|\bgce\b|ordinary\s+levels?(?!\s+of\b)|\badvanced\s+levels?(?!\s+of\b)|\ba-levels?\b|\ba\s+levels?\s+(?:results?|certificates?|exams?|examinations?|qualifications?|grades?|awards?|passes?)\b|statement\s+of\s+results?|statement\s+of\s+grades?|\bkace\b|\beaace\b|west\s+african\s+(?:examinations?\s+council|senior\s+school\s+certificate)|\bwaec\b|international\s+baccalaureate|\bib\s+diploma\b|\bib\s+(?:results?|certificate)\b|diploma\s+programme\s+results?|(?:academic|university|official|college)\s+transcript|diploma\s+(?:results?|transcript)|degree\s+(?:certificate|transcript|classification)|university\s+transcript|professional\s+certificate\s+(?:results?|examination)/i,
  },
  {
    type: "id",
    pattern:
      /national\s+identity\s+card|national\s+id|national\s+identification|identity\s+card|identification\s+card|id\s+card|passport/i,
  },
];

export function classifyDocumentType(text: string): DocType {
  if (!text) return "unknown";
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "unknown";
}
