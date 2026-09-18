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
  {
    type: "academic_cert",
    pattern:
      /kenya\s+certificate\s+of\s+secondary\s+education|\bkcse\b|academic\s+transcript|secondary\s+(?:school\s+)?education|secondary\s+school\s+certificate|high\s+school\s+certificate|\bigcse\b|cambridge\s+international|cambridge\s+(?:assessment|o\s?level|a\s?level)|general\s+certificate\s+of\s+(?:secondary\s+education|education)|\bgcse\b|\bgce\b|ordinary\s+level|advanced\s+level|a[-\s]level|statement\s+of\s+results?|statement\s+of\s+grades?|\bkace\b|\beaace\b|west\s+african\s+(?:examinations?\s+council|senior\s+school\s+certificate)|\bwaec\b|international\s+baccalaureate|\bib\s+diploma\b|\bib\s+(?:results?|certificate)\b|diploma\s+programme\s+results?|transcript|diploma\s+(?:results?|transcript)|degree\s+(?:certificate|transcript|classification)|university\s+transcript|professional\s+certificate\s+(?:results?|examination)/i,
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
