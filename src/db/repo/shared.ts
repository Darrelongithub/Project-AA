/**
 * /db/repo — shared helpers and data (no Repo dependency). Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */

/** PPR P0-1: the only keys that may live in the secrets store. */
export const SECRET_KEYS: readonly string[] = ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"];

/** PPR P1-2: the current six lifecycle stages / five queues are the EDUCATION
 * preset — data now, not a core assumption. Stage ids stay stable (they are
 * the values the lifecycle column has always stored). */
export const EDUCATION_STAGE_PRESET: Array<{ id: string; label: string }> = [
  { id: "application_received", label: "Application Received" },
  { id: "documents_received", label: "Documents Received" },
  { id: "documents_checked", label: "Documents Checked" },
  { id: "awaiting_review", label: "Awaiting Review" },
  { id: "verification", label: "Verification" },
  { id: "completed", label: "Completed" },
];
export const GENERIC_STAGE_PRESET: Array<{ id: string; label: string }> = [
  { id: "application_received", label: "Received" },
  { id: "documents_received", label: "Information received" },
  { id: "awaiting_review", label: "In review" },
  { id: "completed", label: "Completed" },
];
export const EDUCATION_QUEUE_PRESET: Array<{ id: string; label: string }> = [
  { id: "completed", label: "Completed / Verification" },
  { id: "waiting_documents", label: "Waiting for Documents" },
  { id: "human_review", label: "Human Review Required" },
  { id: "decision", label: "Admissions / Decision" },
  { id: "enquiries", label: "Enquiries & Communication" },
];
export const GENERIC_QUEUE_PRESET: Array<{ id: string; label: string }> = [
  { id: "new", label: "New" },
  { id: "in_progress", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

export const nowIso = () => new Date().toISOString();

export type ScopeTag = string[] & { organizationId?: number; allSchools?: boolean };
/** A tagged scope meaning "every school, but only in this organization". */
export function isAllSchools(s: string[] | null | undefined): boolean { return Boolean(s && (s as ScopeTag).allSchools); }
/** An explicit empty scope = deliberately no access. */
export function isNoAccess(s: string[] | null | undefined): boolean { return Boolean(s && s.length === 0 && !isAllSchools(s)); }


export function scopePred(alias: string, schools?: string[] | null): { sql: string; params: string[] } {
  if (schools === undefined || schools === null) return { sql: "", params: [] };
  const org = (schools as ScopeTag).organizationId;
  const orgSql = org !== undefined ? ` AND COALESCE(${alias}.organization_id, 1) = ${Number(org)}` : "";
  if (isAllSchools(schools)) return { sql: orgSql, params: [] };
  if (schools.length === 0) return { sql: " AND 0 = 1", params: [] };
  const marks = schools.map(() => "?").join(",");
  return {
    sql: `${orgSql} AND EXISTS (SELECT 1 FROM programmes p WHERE p.code = ${alias}.programme AND p.school IN (${marks}))`,
    params: [...schools],
  };
}
