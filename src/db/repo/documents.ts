/**
 * /db/repo — documents, duplicates, supersession and flags. Extracted verbatim from the Repo god class;
 * every function takes the Repo as its first argument and the Repo
 * facade in ../repo.ts delegates to it (same API, same behaviour).
 */
import { Confidence, DerivedFlag, DocType, DocumentRecord, ExtractedFields, ExtractionMethod, Flag } from "../../types";
import type { Repo } from "../repo";

// ── Documents (features 5, 6, 9, 22) ─────────────────────────────────────
export function insertDocument(repo: Repo, d: {
  applicant_id: number;
  document_type: DocType;
  source_email_id: string;
  extraction_method: ExtractionMethod;
  extracted_text: string;
  extracted_fields: ExtractedFields;
  confidence: Confidence;
  confidence_score?: number;
  received_at: string;
  sha256?: string;
  is_duplicate?: boolean;
  duplicate_of?: number | null;
  extraction_note?: string;
}): number {
  const res = repo.db
    .prepare(
      `INSERT INTO documents
         (applicant_id, document_type, source_email_id, extraction_method,
          extracted_text, extracted_fields, confidence, confidence_score, received_at,
          sha256, is_duplicate, duplicate_of, extraction_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.applicant_id,
      d.document_type,
      d.source_email_id,
      d.extraction_method,
      d.extracted_text,
      JSON.stringify(d.extracted_fields ?? {}),
      d.confidence,
      d.confidence_score ?? 0,
      d.received_at,
      d.sha256 ?? null,
      d.is_duplicate ? 1 : 0,
      d.duplicate_of ?? null,
      d.extraction_note ?? ""
    );
  return Number(res.lastInsertRowid);
}


/**
 * Re-score a document after cross-document consistency checks (confidence
 * v2): the score, tier and the human-readable note travel together.
 */
export function updateDocumentConfidence(repo: Repo,
  docId: number,
  patch: { confidence?: Confidence; confidence_score?: number; extraction_note?: string }
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.confidence !== undefined) { sets.push("confidence = ?"); args.push(patch.confidence); }
  if (patch.confidence_score !== undefined) { sets.push("confidence_score = ?"); args.push(patch.confidence_score); }
  if (patch.extraction_note !== undefined) { sets.push("extraction_note = ?"); args.push(patch.extraction_note); }
  if (!sets.length) return;
  repo.db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...args, docId);
}


/** Active (non-superseded, non-duplicate) documents for an applicant. */
export function findDuplicate(repo: Repo, applicantId: number, sha256: string): DocumentRecord | undefined {
  return repo.db
    .prepare(
      `SELECT * FROM documents
       WHERE applicant_id = ? AND sha256 = ? AND is_duplicate = 0
       ORDER BY id LIMIT 1`
    )
    .get(applicantId, sha256) as DocumentRecord | undefined;
}


export function supersedeOlder(repo: Repo, applicantId: number, docType: DocType, newId: number): number {
  const res = repo.db
    .prepare(
      `UPDATE documents
       SET superseded_by = ?
       WHERE applicant_id = ? AND document_type = ? AND id <> ?
         AND superseded_by IS NULL AND is_duplicate = 0`
    )
    .run(newId, applicantId, docType, newId);
  return res.changes;
}


function rowToDocument(_repo: Repo, r: any): DocumentRecord {
  // The row's JSON is OURS, but a corrupt DB must degrade one document —
  // never take down every listDocuments() call in the system.
  let extractedFields: Record<string, unknown> = {};
  try {
    extractedFields = JSON.parse(r.extracted_fields || "{}");
  } catch {
    extractedFields = {};
  }
  return {
    id: r.id,
    applicant_id: r.applicant_id,
    document_type: r.document_type,
    source_email_id: r.source_email_id,
    extraction_method: r.extraction_method,
    extracted_text: r.extracted_text,
    extracted_fields: extractedFields,
    confidence: r.confidence,
    confidence_score: r.confidence_score ?? 0,
    superseded_by: r.superseded_by,
    received_at: r.received_at,
    sha256: r.sha256 ?? undefined,
    is_duplicate: r.is_duplicate,
    duplicate_of: r.duplicate_of,
    extraction_note: r.extraction_note ?? "",
  };
}


export function listDocuments(repo: Repo, applicantId: number, opts: { activeOnly?: boolean } = {}): DocumentRecord[] {
  const { activeOnly = true } = opts;
  const sql = activeOnly
    ? "SELECT * FROM documents WHERE applicant_id = ? AND superseded_by IS NULL AND is_duplicate = 0 ORDER BY id"
    : "SELECT * FROM documents WHERE applicant_id = ? ORDER BY id";
  return (repo.db.prepare(sql).all(applicantId) as any[]).map((r) => rowToDocument(repo, r));
}


export function countSuperseded(repo: Repo, applicantId: number): number {
  return (
    repo.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE applicant_id = ? AND superseded_by IS NOT NULL")
      .get(applicantId) as { n: number }
  ).n;
}


export function countDuplicates(repo: Repo, applicantId: number): number {
  return (
    repo.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE applicant_id = ? AND is_duplicate = 1")
      .get(applicantId) as { n: number }
  ).n;
}


// ── Flags ────────────────────────────────────────────────────────────────
export function syncFlags(repo: Repo, applicantId: number, derived: DerivedFlag[]): void {
  const key = (t: string, d: string) => `${t}::${d}`;
  const tx = repo.db.transaction(() => {
    const existing = repo.db
      .prepare("SELECT id, type, detail FROM flags WHERE applicant_id = ? AND active = 1")
      .all(applicantId) as Array<{ id: number; type: string; detail: string }>;
    const derivedKeys = new Set(derived.map((f) => key(f.type, f.detail)));
    const existingKeys = new Set(existing.map((r) => key(r.type, r.detail)));
    const deactivate = repo.db.prepare("UPDATE flags SET active = 0 WHERE id = ?");
    const insert = repo.db.prepare("INSERT INTO flags (applicant_id, type, detail, active) VALUES (?, ?, ?, 1)");
    for (const row of existing) {
      if (!derivedKeys.has(key(row.type, row.detail))) deactivate.run(row.id);
    }
    for (const f of derived) {
      if (!existingKeys.has(key(f.type, f.detail))) insert.run(applicantId, f.type, f.detail);
    }
  });
  tx();
}


export function activeFlags(repo: Repo, applicantId: number): Flag[] {
  return repo.db
    .prepare("SELECT * FROM flags WHERE applicant_id = ? AND active = 1 ORDER BY id")
    .all(applicantId) as Flag[];
}
