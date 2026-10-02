/**
 * Structured-field extraction from document text. Plain regex — code reads
 * the facts; AI is never needed for this step on well-formed documents.
 */
import type { ExtractedFields } from "../types";
import { dobCanonical } from "./crosscheck";

const NAME_RE =
  /^(?:FULL\s+NAME|NAME\s+OF\s+(?:CONTACT|HOLDER|EMPLOYEE|DECEASED|CHILD)|CONTACT(?:'S)?\s+NAME|CANDIDATE(?:\s+NAME)?|EMPLOYEE(?:\s+NAME)?|HOLDER(?:'S)?\s+NAME|NAME)\s*[:\-]\s*(.+)$/im;

/** Honorifics and salutations that leak into captured names. */
const NAME_TITLE_RE = /^(MR|MRS|MS|MISS|DR|PROF|REV|HON)\.?\s+/i;

/**
 * Normalise a captured name: "KAMAU, JOHN" → "JOHN KAMAU", titles stripped,
 * whitespace collapsed. Pure formatting — the identity layer still decides
 * whether names match.
 */
export function cleanExtractedName(raw: string): string | null {
  let n = (raw || "").trim().replace(/\s+/g, " ");
  n = n.replace(/[\u2013\u2014]/g, "-");
  const comma = n.match(/^([^,]{1,40}),\s*([^,]{1,40})$/);
  if (comma) n = `${comma[2]} ${comma[1]}`; // family-first → given-first
  n = n.replace(NAME_TITLE_RE, "");
  n = n.replace(/\b\d+\b/g, "").replace(/\s+/g, " ").trim();
  if (n.length < 3 || n.length > 80) return null;
  if (!/[A-Za-z]/.test(n)) return null;
  return n;
}

const ID_NO_RE = /\b(?:NATIONAL\s+ID(?:ENTITY)?(?:\s+CARD)?|IDENTIFICATION|PASSPORT|IDENTITY\s*CARD|ID\s*CARD|ID)\s*(?:NO|NUMBER|NBR|CARD\s*NO)?\.?\s*(?:[:#\-]\s*|\s+)(?=[A-Z0-9/\-]*\d)([A-Z0-9][A-Z0-9\-/]{4,14})\b/gi;
const DOB_RE = /\b(?:DATE\s+OF\s+BIRTH|DOB|BORN\s+ON|DAY\s+OF\s+BIRTH)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:19|20)\d{2}|(?:19|20)\d{2}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}(?:ST|ND|RD|TH)?\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*,?\s*(?:19|20)\d{2})/gi;

/** Scalar facts are data, never executable expressions or object prototypes. */
export function extractGenericFacts(text: string): Record<string, string> {
  const facts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const match of text.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9 _/-]{1,40}?)[ \t]*:[ \t]*(.+?)[ \t]*$/gm)) {
    const key = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    const value = match[2].trim().toLowerCase();
    if (!Object.hasOwn(facts, key)) facts[key] = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value) ? value.replace(/,/g, "") : value;
  }
  return facts;
}

export function extractFields(text: string): ExtractedFields {
  const fields: ExtractedFields = { ...extractGenericFacts(text) };
  const name = text.match(NAME_RE);
  if (name) { const cleaned = cleanExtractedName(name[1]); if (cleaned) fields.name = cleaned; }
  for (const match of text.matchAll(ID_NO_RE)) {
    const value = match[1].toUpperCase();
    if (/^\d{6,}$/.test(value) || (/\d/.test(value) && value.length >= 7)) { fields.idNumber = value; break; }
  }
  for (const match of text.matchAll(DOB_RE)) if (dobCanonical(match[1])) { fields.dateOfBirth = match[1].toUpperCase().replace(/\s+/g, " "); break; }
  return fields;
}
