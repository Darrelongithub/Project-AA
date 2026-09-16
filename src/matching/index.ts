/**
 * /matching — resolve the applicant behind an email (thread id + sender),
 * and merge new documents into their record.
 *
 * State is tracked PER APPLICANT ACROSS THE WHOLE THREAD: a later email can
 * supersede an earlier document of the same type (e.g. a corrected form),
 * and nothing gets "missed" because we only looked at the latest message.
 */
import type { Repo } from "../db/repo";
import { resolveIdentity } from "./identity";
import type { ApplicantRow, ExtractionResult, IncomingEmail } from "../types";

/**
 * Thin compatibility wrapper. Production resolves identity via
 * `resolveIdentity` (ref → known sender → create); this keeps the legacy
 * entry point — and its tests — running on the SAME code path instead of a
 * divergent second implementation.
 */
export function resolveApplicant(
  repo: Repo,
  email: IncomingEmail,
  opts: { refPrefix?: string } = {}
): ApplicantRow {
  return resolveIdentity(repo, email, opts).applicant;
}

/**
 * Persist extraction results as DocumentRecords. When a new record has the
 * same document_type as an existing active one, the older record is marked
 * superseded_by the new one.
 *
 * Returns the newly created records.
 */
export function recordDocuments(
  repo: Repo,
  applicantId: number,
  email: IncomingEmail,
  results: ExtractionResult[]
): number[] {
  const ids: number[] = [];
  for (const r of results) {
    const id = repo.insertDocument({
      applicant_id: applicantId,
      document_type: r.document_type,
      source_email_id: email.id,
      extraction_method: r.method,
      extracted_text: r.text,
      extracted_fields: r.fields,
      confidence: r.confidence,
      received_at: email.receivedAt,
      sha256: r.sha256,
    });
    if (r.document_type !== "unknown") {
      repo.supersedeOlder(applicantId, r.document_type, id);
    }
    ids.push(id);
  }
  return ids;
}
