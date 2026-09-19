/**
 * OR-review fix — retention date math lives in ONE pure function.
 *
 * The database stores `updated_at` as SQLite `datetime('now')`
 * ("YYYY-MM-DD HH:MM:SS") while cutoffs are JS ISO strings
 * ("YYYY-MM-DDTHH:MM:SS.sssZ"). A raw string compare between the two
 * formats breaks on the boundary day (a space sorts before 'T'), archiving
 * cases up to 24 hours early. Normalise both sides to the same shape before
 * comparing.
 */

function toComparable(iso: string): string | null {
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** true when `updatedAt` is STRICTLY before `cutoffIso` (both instants). */
export function retentionDue(updatedAt: string, cutoffIso: string): boolean {
  const u = toComparable(updatedAt);
  const c = toComparable(cutoffIso);
  if (!u || !c) return false; // unparseable dates are NEVER deleted
  return u < c;
}
