/** Generic document hints. Organization definitions are resolved separately by the pipeline. */
import type { DocType } from "../types";
const RULES: Array<{ type: DocType; pattern: RegExp }> = [
  { type: "request_form", pattern: /\b(?:request|application|intake)\s+form\b/i },
  { type: "birth_cert", pattern: /\bbirth\s+(?:certificate|registration)\b/i },
  { type: "id", pattern: /\b(?:national\s+identification|identity\s+(?:card|document)|national\s+id|passport\s+number)\b/i },
  { type: "passport_photo", pattern: /\b(?:passport[ -]?(?:sized? )?photo(?:graph)?|portrait photograph)\b/i },
];
export function classifyDocumentType(text: string): DocType {
  return RULES.find((rule) => rule.pattern.test(text))?.type ?? "unknown";
}
