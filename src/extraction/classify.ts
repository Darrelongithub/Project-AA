/**
 * Document-type classification by plain code (keyword rules, ordered so the
 * most distinctive patterns win). Gemini's own guess is only used when this
 * classifier says "unknown" — and even then the confidence is downgraded.
 */
import type { DocType } from "../types";

interface Rule {
  type: DocType;
  pattern: RegExp;
}

// Order matters: application forms often mention "KCSE points", so they must
// be checked before the academic-certificate rules.
const RULES: Rule[] = [
  { type: "application_form", pattern: /application\s+form/i },
  { type: "kcpe_cert", pattern: /kenya\s+certificate\s+of\s+primary\s+education|\bkcpe\b/i },
  { type: "birth_cert", pattern: /certificate\s+of\s+birth|birth\s+certificate/i },
  { type: "id", pattern: /national\s+identity\s+card|national\s+id|identity\s+card/i },
  {
    type: "academic_cert",
    pattern:
      /kenya\s+certificate\s+of\s+secondary\s+education|\bkcse\b|academic\s+transcript|secondary\s+education/i,
  },
];

export function classifyDocumentType(text: string): DocType {
  if (!text) return "unknown";
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "unknown";
}
