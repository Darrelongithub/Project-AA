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
import { admissionsPreset } from "../presets/loader";

interface Rule {
  type: DocType;
  pattern: RegExp;
}

// Order matters: application forms often mention points totals, so they must
// be checked before the academic-certificate rules. The rules themselves are
// preset data (same order, types and patterns as shipped), compiled once.
const RULES: Rule[] = admissionsPreset().classification.map((r) => ({
  type: r.type,
  pattern: new RegExp(r.pattern, r.flags),
}));

export function classifyDocumentType(text: string): DocType {
  if (!text) return "unknown";
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "unknown";
}
