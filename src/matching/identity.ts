/**
 * Applicant identity matching (features 4, 5, 34).
 *
 * We never rely on a single signal. In order of strength:
 *   1. A reference number quoted in the subject/body ([RU-2026-000123])
 *   2. A known sender address — across ANY thread (applicants email from
 *      phones, start new threads, forward old conversations; all of it must
 *      land on the same case, not fragment across Gmail threads)
 *   3. Otherwise a new applicant is created.
 *
 * Low-confidence attachments (e.g. the quoted ref belongs to someone else's
 * sender address) are allowed through BUT flagged for human verification —
 * we never silently attach documents to the wrong applicant.
 */
import type { Repo } from "../db/repo";
import type { ApplicantRow, IncomingEmail } from "../types";

export interface IdentityResolution {
  applicant: ApplicantRow;
  isNew: boolean;
  matchedBy: "ref" | "sender" | "created";
  /** Present when a human should verify the match. */
  concern?: string;
}

const REF_RE = /\b([A-Z]{2}-\d{4}-\d{6})\b/i;

export function resolveIdentity(
  repo: Repo,
  email: IncomingEmail,
  opts: { refPrefix?: string } = {}
): IdentityResolution {
  // ── Signal 1: a reference number is quoted in the message ──────────────
  // SYNTHETIC channels are exempt: a portal upload builds a message whose
  // subject contains the uploaded FILENAME. Trusting a ref there would let a
  // filename like "RU-2026-000099.pdf" move a document into someone else's
  // case. The portal session already proves case ownership.
  const refMatch =
    email.channel && email.channel !== "email"
      ? null
      : `${email.subject}\n${email.body}`.match(REF_RE);
  if (refMatch) {
    const byRef = repo.findByRef(refMatch[1].toUpperCase());
    if (byRef) {
      repo.linkThread(byRef.id, email.threadId);
      const senderMatches = byRef.email_address === email.from.trim().toLowerCase();
      return {
        applicant: byRef,
        isNew: false,
        matchedBy: "ref",
        concern: senderMatches
          ? undefined
          : `message cites ${byRef.ref_number} but arrives from ${email.from}; the address on file is ${byRef.email_address} — verify before trusting the attachments`,
      };
    }
  }

  // ── Signal 2: known sender, any thread (conversation reconstruction) ───
  const bySender = repo.findByEmailAny(email.from);
  if (bySender) {
    repo.linkThread(bySender.id, email.threadId);
    return { applicant: bySender, isNew: false, matchedBy: "sender" };
  }

  // ── Signal 3: nobody we know → create ───────────────────────────────────
  const applicant = repo.getOrCreateApplicant(email.from, email.threadId, {
    fullName: email.fromName,
    refPrefix: opts.refPrefix,
  });
  repo.linkThread(applicant.id, email.threadId);
  return { applicant, isNew: true, matchedBy: "created" };
}
