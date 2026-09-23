/**
 * Simulation scenarios v2 — the corpus the system is scored against.
 *
 * Attachments are REAL PDFs generated at runtime:
 *   - text PDFs exercise the embedded-text tier
 *   - Grace's KCPE certificate is a genuine image-only scan (OCR tier)
 *   - Kevin resends a byte-identical ID (duplicate detection)
 */
import type { Attachment, Classification, DocType, EmailCategory, IncomingEmail, LifecycleStage, Priority, VisionExtraction } from "../types";
import type { Repo } from "../db/repo";
import { docLines, makeScannedPdf, makeTextPdf } from "./pdfFactory";

export interface Expected {
  finalStatus: Classification;
  lifecycle: LifecycleStage;
  autoSent: boolean;
  autoKind: "ack" | "missing_docs" | "docs_request" | "status_answer" | null;
  flagTypes: string[]; // active blocking flag types after the last email
  superseded: number;
  duplicates: number;
  missing: DocType[];
  category: EmailCategory; // category of the last processed email
  priority: Priority;
  /** v3: audit events that MUST exist for the applicant (one extra check each). */
  audited?: string[];
}

export interface Fixture {
  name: string;
  description: string;
  /** Static list, or a builder receiving the repo (e.g. to quote a generated ref). */
  emails: IncomingEmail[] | ((repo: Repo) => IncomingEmail[] | Promise<IncomingEmail[]>);
  expected: Expected;
  /** v3: run before the fixture's first email (e.g. configure a deadline). */
  before?: (repo: Repo) => void;
  /** v3: run before the Nth email (e.g. mark the case completed mid-scenario). */
  beforeEmail?: (repo: Repo, index: number) => void;
  /** v3: cleanup after scoring (e.g. reset a category back to auto mode). */
  after?: (repo: Repo) => void;
}

interface AttSpec {
  filename: string;
  docType?: string;
  name?: string;
  spec?: Record<string, unknown>;
  scanned?: boolean;
  mockVision?: VisionExtraction;
  customLines?: string[];
  content?: Buffer; // reuse exact bytes (duplicate testing)
}

async function att(s: AttSpec): Promise<Attachment> {
  if (s.content) {
    return { filename: s.filename, mimeType: "application/pdf", content: s.content, mockVision: s.mockVision ?? null };
  }
  const lines = s.customLines ?? docLines(s.docType!, { name: s.name ?? "X", ...(s.spec ?? {}) });
  const content = s.scanned ? await makeScannedPdf(lines) : await makeTextPdf(lines);
  return { filename: s.filename, mimeType: "application/pdf", content, mockVision: s.mockVision ?? null };
}

function email(p: IncomingEmail): IncomingEmail {
  return p;
}

/** OR-5: the official application-form checklist documents that accompany a
 * file. School-leaver academic evidence (leaving certificate) applies to
 * certificate/diploma/degree entry; postgraduate files carry prior-degree
 * paperwork instead. Everyone provides a passport photo and birth certificate. */
function checklistDocs(prefix: string, name: string, opts: { birth?: boolean; school?: boolean } = {}): Promise<Attachment>[] {
  const specs: AttSpec[] = [];
  if (opts.school !== false) specs.push({ filename: `${prefix}-leaving.pdf`, docType: "leaving_certificate", name });
  specs.push({ filename: `${prefix}-photo.pdf`, docType: "passport_photo", name });
  if (opts.birth !== false) specs.push({ filename: `${prefix}-birth.pdf`, docType: "birth_cert", name });
  return specs.map((sp) => att(sp));
}

export async function buildFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];

  // ── 1. Alice: complete clean set → Green, auto-ack ──────────────────────
  {
    const name = "ALICE WANJIKU KAMAU";
    fixtures.push({
      name: "alice-clean",
      description: "Complete clean set in one email → Green, auto acknowledgement.",
      emails: [
        email({
          id: "email-alice-1", threadId: "thread-alice", from: "alice.kamau@student.example.org", fromName: "Alice Kamau",
          subject: "Application documents — Alice Kamau",
          body: "Hello, please find attached all my application documents for BSc Computer Science, September 2026 intake. Thank you.",
          receivedAt: "2026-09-14T09:00:00Z",
          attachments: await Promise.all([
            att({ filename: "alice-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B-" } }),
            att({ filename: "alice-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 312, meanGrade: "B", year: "2017" } }),
            att({ filename: "alice-id.pdf", docType: "id", name, spec: { idNumber: "23456789" } }),
            att({ filename: "alice-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "alice-form.pdf", docType: "application_form", name, spec: { programme: "BSC COMPUTER SCIENCE" } }),
            ...checklistDocs("alice", name, { birth: false }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 2. Brian: grades below floor → Orange flag, never auto-rejected ─────
  {
    const name = "BRIAN KIPROTICH RUTO";
    fixtures.push({
      name: "brian-grades-below",
      description: "Applying for BSc Computer Science with a C in Mathematics — below the published C+ in Mathematics/Physics → flag + human review (never auto-rejected).",
      emails: [
        email({
          id: "email-brian-1", threadId: "thread-brian", from: "brian.ruto@student.example.org", fromName: "Brian Ruto",
          subject: "My application documents",
          body: "Attached are my documents for the September intake.",
          receivedAt: "2026-09-14T10:00:00Z",
          attachments: await Promise.all([
            att({ filename: "brian-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "C", subjects: { ENGLISH: "B", KISWAHILI: "B", MATHEMATICS: "C", PHYSICS: "C", CHEMISTRY: "C-", BIOLOGY: "C" } } }),
            att({ filename: "brian-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 240, meanGrade: "C", year: "2016" } }),
            att({ filename: "brian-id.pdf", docType: "id", name, spec: { idNumber: "30112233" } }),
            att({ filename: "brian-form.pdf", docType: "application_form", name, spec: { programme: "BSC COMPUTER SCIENCE" } }),
            ...checklistDocs("brian", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["grade_below_requirement"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 3. Carol: missing ID → automatic missing-documents notice (feature 13)
  {
    const name = "CAROL NJERI MAINA";
    fixtures.push({
      name: "carol-missing-id",
      description: "Missing National ID → factual auto notice listing exactly what's missing.",
      emails: [
        email({
          id: "email-carol-1", threadId: "thread-carol", from: "carol.maina@student.example.org", fromName: "Carol Maina",
          subject: "Documents",
          body: "Please find my attached documents.",
          receivedAt: "2026-09-14T11:00:00Z",
          attachments: await Promise.all([
            att({ filename: "carol-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "carol-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 298, year: "2015" } }),
            att({ filename: "carol-form.pdf", docType: "application_form", name }),
            ...checklistDocs("carol", name),
          ]),
        }),
      ],
      // Qualification gate: the missing-docs reply is held as a staff suggestion, not auto-sent.
      expected: { finalStatus: "Red", lifecycle: "documents_received", autoSent: false, autoKind: "missing_docs", flagTypes: [], superseded: 0, duplicates: 0, missing: ["id"], category: "document_submission", priority: "normal" },
    });
  }

  // ── 4. Daniel: two emails — later email completes the file ──────────────
  {
    const name = "DANIEL OTIENO AYIERO";
    fixtures.push({
      name: "daniel-two-emails",
      description: "Incomplete first email (auto missing-docs notice), ID arrives later → Green auto-ack.",
      emails: [
        email({
          id: "email-daniel-1", threadId: "thread-daniel", from: "daniel.ayiero@student.example.org", fromName: "Daniel Ayiero",
          subject: "Application documents (part 1)",
          body: "Sending my certificates now; my ID copy will follow shortly.",
          receivedAt: "2026-09-14T12:00:00Z",
          attachments: await Promise.all([
            att({ filename: "daniel-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "daniel-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 355, year: "2014" } }),
            att({ filename: "daniel-form.pdf", docType: "application_form", name }),
            ...checklistDocs("daniel", name),
          ]),
        }),
        email({
          id: "email-daniel-2", threadId: "thread-daniel", from: "daniel.ayiero@student.example.org", fromName: "Daniel Ayiero",
          subject: "Re: Application documents (part 1)",
          body: "As promised, here is my national ID.",
          receivedAt: "2026-09-15T08:30:00Z",
          attachments: await Promise.all([
            att({ filename: "daniel-id.pdf", docType: "id", name, spec: { idNumber: "28776655" } }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 5. Esther: corrected form supersedes the original, fixes Orange ─────
  {
    fixtures.push({
      name: "esther-correction",
      description: "Name mismatch → Orange; corrected form supersedes the old one → Green.",
      emails: [
        email({
          id: "email-esther-1", threadId: "thread-esther", from: "esther.mutua@student.example.org", fromName: "Esther Mutua",
          subject: "Application documents",
          body: "All my documents are attached.",
          receivedAt: "2026-09-14T13:00:00Z",
          attachments: await Promise.all([
            att({ filename: "esther-academic.pdf", docType: "academic_cert", name: "ESTHER WAIRIMU MUTUA" }),
            att({ filename: "esther-kcpe.pdf", docType: "kcpe_cert", name: "ESTHER WAIRIMU MUTUA", spec: { kcpePoints: 330, year: "2016" } }),
            att({ filename: "esther-id.pdf", docType: "id", name: "ESTHER WAIRIMU MUTUA", spec: { idNumber: "31224466" } }),
            att({ filename: "esther-birth.pdf", docType: "birth_cert", name: "ESTHER WAIRIMU MUTUA" }),
            att({ filename: "esther-form.pdf", docType: "application_form", name: "ESTHER MUTUA" }),
            ...checklistDocs("esther", "ESTHER WAIRIMU MUTUA", { birth: false }),
          ]),
        }),
        email({
          id: "email-esther-2", threadId: "thread-esther", from: "esther.mutua@student.example.org", fromName: "Esther Mutua",
          subject: "Re: Application documents",
          body: "So sorry — I noticed my middle name was missing on the form. Please use this corrected version instead.",
          receivedAt: "2026-09-15T09:15:00Z",
          attachments: await Promise.all([
            att({ filename: "esther-form-v2.pdf", docType: "application_form", name: "ESTHER WAIRIMU MUTUA" }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 1, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 6. Frank: names disagree across documents → Orange ──────────────────
  {
    fixtures.push({
      name: "frank-name-mismatch",
      description: "Names disagree across documents → Orange + name_mismatch flag; the contradicting document is capped below the auto-pass line (low_confidence reason code).",
      emails: [
        email({
          id: "email-frank-1", threadId: "thread-frank", from: "frank.ochieng@student.example.org", fromName: "Frank Ochieng",
          subject: "Documents for admission",
          body: "Attached please.",
          receivedAt: "2026-09-14T14:00:00Z",
          attachments: await Promise.all([
            att({ filename: "frank-academic.pdf", docType: "academic_cert", name: "FRANK OCHIENG" }),
            att({ filename: "frank-kcpe.pdf", docType: "kcpe_cert", name: "FRANK OCHIENG", spec: { kcpePoints: 276, year: "2015" } }),
            att({ filename: "frank-id.pdf", docType: "id", name: "FRANK ODHIAMBO", spec: { idNumber: "27654321" } }),
            att({ filename: "frank-form.pdf", docType: "application_form", name: "FRANK OCHIENG" }),
            ...checklistDocs("frank", "FRANK OCHIENG"),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["low_confidence", "name_mismatch"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 7. Grace: scanned KCPE → OCR reads cleanly → confidence v2 trusts it ─
  {
    const name = "GRACE AKINYI OTIENO";
    const kcpeLines = docLines("kcpe_cert", { name, kcpePoints: 289, year: "2019" });
    fixtures.push({
      name: "grace-scanned-kcpe",
      description: "Scanned (image-only) KCPE certificate → OCR reads every critical field; confidence v2 (good fields + consistent names + mechanical read) trusts it → auto-admitted.",
      emails: [
        email({
          id: "email-grace-1", threadId: "thread-grace", from: "grace.otieno@student.example.org", fromName: "Grace Otieno",
          subject: "Application attachments",
          body: "My documents are attached. The KCPE certificate is a scan, apologies for the quality.",
          receivedAt: "2026-09-14T15:00:00Z",
          attachments: await Promise.all([
            att({ filename: "grace-academic.pdf", docType: "academic_cert", name }),
            att({
              filename: "grace-kcpe.pdf", scanned: true, customLines: kcpeLines,
              mockVision: { document_type: "kcpe_cert", text: kcpeLines.join("\n"), fields: { name, gradePoints: 289, meanGrade: "B" }, confidence: "medium" },
            }),
            att({ filename: "grace-id.pdf", docType: "id", name, spec: { idNumber: "33445566" } }),
            att({ filename: "grace-form.pdf", docType: "application_form", name }),
            ...checklistDocs("grace", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 8. Henry: plain inquiry → automatic document request ────────────────
  {
    fixtures.push({
      name: "henry-inquiry",
      description: "Inquiry with no attachments → factual auto document-request (never a decision).",
      emails: [
        email({
          id: "email-henry-1", threadId: "thread-henry", from: "henry.kalu@student.example.org", fromName: "Henry Kalu",
          subject: "Admission enquiry",
          body: "Hi, I would like to apply for the September intake. What documents do you need from me?",
          receivedAt: "2026-09-14T16:00:00Z",
          attachments: [],
        }),
      ],
      expected: { finalStatus: "Red", lifecycle: "application_received", autoSent: false, autoKind: "docs_request", flagTypes: [], superseded: 0, duplicates: 0, missing: ["application_form", "birth_cert", "exam_result_slip", "id", "leaving_certificate", "passport_photo"], category: "application", priority: "normal" }, // qualification gate: held suggestion — OR-5 checklist
    });
  }

  // ── 9. Ivy: looks Green but a doc is a SPECIMEN → watcher downgrade ─────
  {
    const name = "IVY CHEBET KOSGEI";
    fixtures.push({
      name: "ivy-specimen",
      description: "Passes the rules engine, but a document is a specimen → watcher downgrades to Red.",
      emails: [
        email({
          id: "email-ivy-1", threadId: "thread-ivy", from: "ivy.kosgei@student.example.org", fromName: "Ivy Kosgei",
          subject: "Application documents",
          body: "Please find attached my complete set of documents.",
          receivedAt: "2026-09-14T17:00:00Z",
          attachments: await Promise.all([
            att({ filename: "ivy-academic.pdf", docType: "academic_cert", name, spec: { extraLines: ["SPECIMEN - SAMPLE COPY NOT VALID"] } }),
            att({ filename: "ivy-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 342, year: "2018" } }),
            att({ filename: "ivy-id.pdf", docType: "id", name, spec: { idNumber: "35566778" } }),
            att({ filename: "ivy-form.pdf", docType: "application_form", name }),
            ...checklistDocs("ivy", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Red", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["watcher_flag"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 10. Judy: complete set + unrecognized attachment → Orange ───────────
  {
    const name = "JUDY WAMBUI NYAGA";
    fixtures.push({
      name: "judy-unknown-attachment",
      description: "Complete set plus an unrecognized PDF (a shopping list) → Orange with a wrong_document flag, a human looks at the odd file.",
      emails: [
        email({
          id: "email-judy-1", threadId: "thread-judy", from: "judy.nyaga@student.example.org", fromName: "Judy Nyaga",
          subject: "Application documents + oops",
          body: "Documents attached. Oops, I think I also attached my shopping list by mistake.",
          receivedAt: "2026-09-14T18:00:00Z",
          attachments: await Promise.all([
            att({ filename: "judy-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "judy-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 301, year: "2017" } }),
            att({ filename: "judy-id.pdf", docType: "id", name, spec: { idNumber: "29887766" } }),
            att({ filename: "judy-form.pdf", docType: "application_form", name }),
            att({ filename: "judy-shopping-list.pdf", customLines: ["WEEKLY MARKET LIST", "TOMATOES, ONIONS, SUKUMA WIKI", "MILK, BREAD, EGGS", "COOKING OIL, RICE FLOUR"] }),
            ...checklistDocs("judy", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["low_confidence", "wrong_document"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 11. Kevin: resends the exact same ID → duplicate detected (feature 22)
  {
    const name = "KEVIN MWANGI NJOROGE";
    const idPdf = await makeTextPdf(docLines("id", { name, idNumber: "26677889" }));
    fixtures.push({
      name: "kevin-duplicate",
      description: "Same ID file sent twice → recognised as a duplicate, file stays Green.",
      emails: [
        email({
          id: "email-kevin-1", threadId: "thread-kevin", from: "kevin.njoroge@student.example.org", fromName: "Kevin Njoroge",
          subject: "Application documents",
          body: "All documents attached.",
          receivedAt: "2026-09-14T19:00:00Z",
          attachments: await Promise.all([
            att({ filename: "kevin-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "kevin-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 298, year: "2016" } }),
            att({ filename: "kevin-id.pdf", docType: "id", name, spec: { idNumber: "26677889" }, content: idPdf }),
            att({ filename: "kevin-form.pdf", docType: "application_form", name }),
            ...checklistDocs("kevin", name),
          ]),
        }),
        email({
          id: "email-kevin-2", threadId: "thread-kevin", from: "kevin.njoroge@student.example.org", fromName: "Kevin Njoroge",
          subject: "Re: Application documents",
          body: "Sorry, sending my ID again in case it did not go through the first time.",
          receivedAt: "2026-09-15T07:45:00Z",
          attachments: [await att({ filename: "kevin-id-again.pdf", docType: "id", name, content: idPdf })],
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "documents_checked", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 1, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 12. Lucy: one-letter typo across docs → fuzzy name mismatch (feature 23)
  {
    fixtures.push({
      name: "lucy-fuzzy-name",
      description: "OCHIMI vs OCHIEMI — a one-letter typo variant → fuzzy name_mismatch → human confirms.",
      emails: [
        email({
          id: "email-lucy-1", threadId: "thread-lucy", from: "lucy.ochimi@student.example.org", fromName: "Lucy Ochimi",
          subject: "Documents attached",
          body: "Please see my attached documents.",
          receivedAt: "2026-09-14T20:00:00Z",
          attachments: await Promise.all([
            att({ filename: "lucy-academic.pdf", docType: "academic_cert", name: "LUCY OCHIMI" }),
            att({ filename: "lucy-kcpe.pdf", docType: "kcpe_cert", name: "LUCY OCHIMI", spec: { kcpePoints: 305, year: "2017" } }),
            att({ filename: "lucy-id.pdf", docType: "id", name: "LUCY OCHIEMI", spec: { idNumber: "30998877" } }),
            att({ filename: "lucy-form.pdf", docType: "application_form", name: "LUCY OCHIMI" }),
            ...checklistDocs("lucy", "LUCY OCHIMI"),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["low_confidence", "name_mismatch"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 13. Mary: complaint → high priority (features 26, 27) ───────────────
  {
    fixtures.push({
      name: "mary-complaint",
      description: "Complaint email → categorised, priority raised, factual document request sent.",
      emails: [
        email({
          id: "email-mary-1", threadId: "thread-mary", from: "mary.adhiambo@student.example.org", fromName: "Mary Adhiambo",
          subject: "Nobody is responding to me",
          body: "I have been trying to reach your office for weeks and nobody responds. This is unacceptable. I want to apply for BCS in the September 2026 intake. My phone is 0712 345 678.",
          receivedAt: "2026-09-15T10:00:00Z",
          attachments: [],
        }),
      ],
      expected: { finalStatus: "Red", lifecycle: "application_received", autoSent: false, autoKind: "docs_request", flagTypes: [], superseded: 0, duplicates: 0, missing: ["application_form", "birth_cert", "exam_result_slip", "id", "leaving_certificate", "passport_photo"], category: "complaint", priority: "high" }, // qualification gate: held suggestion — OR-5 checklist
    });
  }

  // ═══════════════════════════ v3 scenarios ══════════════════════════════

  // ── 14. Peter: conversation reconstruction (v3 feature 4) ──────────────
  // Same sender, brand-new thread & subject → SAME case, never fragmented.
  {
    const name = "PETER MWANGI NJOROGE";
    fixtures.push({
      name: "peter-crossthread",
      description: "Same sender starts a NEW thread with the remaining document → attaches to the same case, Green.",
      emails: [
        email({
          id: "email-peter-1", threadId: "thread-peter-a", from: "peter.njoroge@student.example.org", fromName: "Peter Njoroge",
          subject: "My application documents",
          body: "Please find attached my documents for the September 2026 intake.",
          receivedAt: "2026-09-15T11:00:00Z",
          attachments: await Promise.all([
            att({ filename: "peter-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B" } }),
            att({ filename: "peter-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 330, meanGrade: "B+", year: "2016" } }),
            att({ filename: "peter-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "peter-form.pdf", docType: "application_form", name }),
            ...checklistDocs("peter", name, { birth: false }),
          ]),
        }),
        email({
          id: "email-peter-2", threadId: "thread-peter-b", from: "peter.njoroge@student.example.org", fromName: "Peter Njoroge",
          subject: "Forgot my ID — here it is",
          body: "So sorry, I forgot to attach my national ID yesterday. It is attached here.",
          receivedAt: "2026-09-16T08:00:00Z",
          attachments: await Promise.all([
            att({ filename: "peter-id.pdf", docType: "id", name, spec: { idNumber: "28811334" } }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 15. Quinn: ref quoted by a DIFFERENT sender (v3 feature 5) ─────────
  // Ref number is the strongest signal, but sender ≠ owner → the documents
  // land on the right case AND an identity_check flag forces verification.
  {
    const name = "QUINN ACHIENG OTIENO";
    const ownerEmail = "quinn.otieno@student.example.org";
    fixtures.push({
      name: "quinn-ref-crosssender",
      description: "A third party quotes the ref number → attached to the right case, but flagged for identity verification.",
      before: (repo) => {
        // Quinn applied earlier; her case (and ref) already exist.
        repo.getOrCreateApplicant(ownerEmail, "thread-quinn-1", { fullName: "Quinn Otieno" });
      },
      emails: async (repo) => {
        const ref = repo.findByEmailAny(ownerEmail)!.ref_number;
        return [
          email({
            id: "email-quinn-1", threadId: "thread-quinn-1", from: ownerEmail, fromName: "Quinn Otieno",
            subject: "Application documents",
            body: "Please find attached my application documents.",
            receivedAt: "2026-09-15T12:00:00Z",
            attachments: await Promise.all([
              att({ filename: "quinn-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B" } }),
              att({ filename: "quinn-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 340, meanGrade: "A-", year: "2016" } }),
              att({ filename: "quinn-id.pdf", docType: "id", name, spec: { idNumber: "31002244" } }),
              att({ filename: "quinn-form.pdf", docType: "application_form", name }),
              ...checklistDocs("quinn", name, { birth: false }),
            ]),
          }),
          email({
            id: "email-quinn-2", threadId: "thread-quinn-aunt", from: "quinn.aunt@example.org", fromName: "Quinn's Aunt",
            subject: `Documents for ${ref}`,
            body: `I am sending the remaining certificate on behalf of my niece, reference ${ref}.`,
            receivedAt: "2026-09-15T15:00:00Z",
            attachments: await Promise.all([
              att({ filename: "quinn-birth.pdf", docType: "birth_cert", name }),
            ]),
          }),
        ];
      },
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["identity_check"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal", audited: ["identity_concern", "identity_matched"] },
    });
  }

  // ── 16. Rosa: submission after the intake deadline (v3 features 20, 21) ─
  // Complete set, but late → flag for a human. Never auto-rejected.
  {
    const name = "ROSA WAMBUI GITHINJI";
    fixtures.push({
      name: "rosa-late-deadline",
      description: "Complete set arrives AFTER the intake deadline → late_submission flag, human decides.",
      before: (repo) => repo.setIntakeDeadline("September 2026", "2026-08-31"),
      after: (repo) => repo.setIntakeDeadline("September 2026", null),
      emails: [
        email({
          id: "email-rosa-1", threadId: "thread-rosa", from: "rosa.githinji@student.example.org", fromName: "Rosa Githinji",
          subject: "Application documents",
          body: "Please accept my documents for the September 2026 intake. I know the deadline has passed — I beg you to consider me.",
          receivedAt: "2026-09-15T13:00:00Z",
          attachments: await Promise.all([
            att({ filename: "rosa-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B+" } }),
            att({ filename: "rosa-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 355, meanGrade: "A-", year: "2016" } }),
            att({ filename: "rosa-id.pdf", docType: "id", name, spec: { idNumber: "29775511" } }),
            att({ filename: "rosa-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "rosa-form.pdf", docType: "application_form", name }),
            ...checklistDocs("rosa", name, { birth: false }),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["late_submission"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 17. Sam: cross-document date anomaly (v3 feature 7) ─────────────────
  // KCPE dated AFTER KCSE → flag as potential anomaly → human verification.
  {
    const name = "SAM KIPKOECH CHERUIYOT";
    fixtures.push({
      name: "sam-date-anomaly",
      description: "KCPE certificate dated after the KCSE certificate → anomaly flag, human verification (never an auto-verdict).",
      emails: [
        email({
          id: "email-sam-1", threadId: "thread-sam", from: "sam.cheruiyot@student.example.org", fromName: "Sam Cheruiyot",
          subject: "Application documents",
          body: "Please find attached all my documents.",
          receivedAt: "2026-09-15T14:00:00Z",
          attachments: await Promise.all([
            att({ filename: "sam-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B", year: "2021" } }),
            att({ filename: "sam-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 320, meanGrade: "B+", year: "2022" } }),
            att({ filename: "sam-id.pdf", docType: "id", name, spec: { idNumber: "30554421" } }),
            att({ filename: "sam-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "sam-form.pdf", docType: "application_form", name }),
            ...checklistDocs("sam", name, { birth: false }),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["anomaly"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── 18. Tina: draft-first mode (v3 feature 17) ──────────────────────────
  // Category set to "draft" → even a clean Green auto-reply is held for a
  // human to approve. The verdict stays Green; only the send is withheld.
  {
    const name = "TINA NYAMBURA KARIUKI";
    fixtures.push({
      name: "tina-draft-first",
      description: "Draft-for-approval mode on document_submission → Green verdict but the reply is held for staff approval.",
      before: (repo) => repo.setAutomationMode("document_submission", "draft"),
      after: (repo) => repo.setAutomationMode("document_submission", "auto"),
      emails: [
        email({
          id: "email-tina-1", threadId: "thread-tina", from: "tina.kariuki@student.example.org", fromName: "Tina Kariuki",
          subject: "Application documents",
          body: "Please find attached my complete application documents.",
          receivedAt: "2026-09-15T15:00:00Z",
          attachments: await Promise.all([
            att({ filename: "tina-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "A-" } }),
            att({ filename: "tina-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 380, meanGrade: "A", year: "2016" } }),
            att({ filename: "tina-id.pdf", docType: "id", name, spec: { idNumber: "31220099" } }),
            att({ filename: "tina-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "tina-form.pdf", docType: "application_form", name }),
            ...checklistDocs("tina", name, { birth: false }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "documents_received", autoSent: false, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal", audited: ["automation_held"] },
    });
  }

  // ── 19. Uma: reopen a completed case (v3 feature 34) ────────────────────
  // A completed applicant emails a corrected certificate → the SAME case is
  // reopened, never a second "Frankenstein" applicant.
  {
    const name = "UMA WANJIRU MUTURI";
    fixtures.push({
      name: "uma-reopen",
      description: "Completed applicant submits a corrected certificate from a new thread → existing case reopens (no duplicate applicant).",
      beforeEmail: (repo, i) => {
        if (i === 1) {
          const a = repo.findByEmailAny("uma.wanjiru@student.example.org")!;
          repo.setLifecycle(a.id, "completed", "manager", "simulation: staff completed the case");
        }
      },
      emails: [
        email({
          id: "email-uma-1", threadId: "thread-uma-a", from: "uma.wanjiru@student.example.org", fromName: "Uma Wanjiru",
          subject: "Application documents",
          body: "Please find attached my complete application documents.",
          receivedAt: "2026-09-15T16:00:00Z",
          attachments: await Promise.all([
            att({ filename: "uma-academic.pdf", docType: "academic_cert", name, spec: { kcseMeanGrade: "B+" } }),
            att({ filename: "uma-kcpe.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 345, meanGrade: "A-", year: "2016" } }),
            att({ filename: "uma-id.pdf", docType: "id", name, spec: { idNumber: "27664455" } }),
            att({ filename: "uma-birth.pdf", docType: "birth_cert", name }),
            att({ filename: "uma-form.pdf", docType: "application_form", name }),
            ...checklistDocs("uma", name, { birth: false }),
          ]),
        }),
        email({
          id: "email-uma-2", threadId: "thread-uma-b", from: "uma.wanjiru@student.example.org", fromName: "Uma Wanjiru",
          subject: "Correction to my certificate",
          body: "I just received a corrected copy of my KCPE certificate. Please replace the old one with this.",
          receivedAt: "2026-09-16T09:00:00Z",
          attachments: await Promise.all([
            att({ filename: "uma-kcpe-corrected.pdf", docType: "kcpe_cert", name, spec: { kcpePoints: 349, meanGrade: "A-", year: "2016" } }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "documents_checked", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 1, duplicates: 0, missing: [], category: "document_submission", priority: "normal", audited: ["case_reopened"] },
    });
  }

  // ── Qualification-system fixtures (structured entry requirements) ────────
  {
    const name = "WANJIRU IGCS APPLICANT";
    fixtures.push({
      name: "igcse-qualified-bba",
      description: "IGCSE applicant for BBA with 6 passes at C or better → meets the 5-credit route → auto-admitted (admission letter sent).",
      emails: [
        email({
          id: "email-igcse-ok-1", threadId: "thread-igcse-ok", from: "wanjiru.igcse@student.example.org", fromName: "Wanjiru Igcse",
          subject: "Application documents",
          body: "Please find attached my IGCSE results and application form.",
          receivedAt: "2026-09-15T09:00:00Z",
          attachments: await Promise.all([
            att({ filename: "igcse-ok-results.pdf", docType: "academic_cert", name, spec: { examSystem: "IGCSE", subjects: { ENGLISH: "C", MATHEMATICS: "B", BIOLOGY: "C", CHEMISTRY: "C", HISTORY: "C", ECONOMICS: "B" } } }),
            att({ filename: "igcse-ok-id.pdf", docType: "id", name, spec: { idNumber: "33110022" } }),
            att({ filename: "igcse-ok-form.pdf", docType: "application_form", name, spec: { programme: "BACHELOR OF BUSINESS ADMINISTRATION" } }),
            att({ filename: "igcse-ok-soo.pdf", docType: "business_statement_of_objective", name }),
            ...checklistDocs("igcse-ok", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }
  {
    const name = "OTIENO FEW CREDITS";
    fixtures.push({
      name: "igcse-short-credits",
      description: "IGCSE with only 4 passes at C or better — fails the 5-credit route, but the KCSE-tagged leaving certificate is unreadable → E4: an unread route beats a confirmed failure, so the case goes to verification (low-confidence flags) rather than 'does not meet requirements' (held).",
      emails: [
        email({
          id: "email-igcse-low-1", threadId: "thread-igcse-low", from: "otieno.credits@student.example.org", fromName: "Otieno Credits",
          subject: "My results",
          body: "Attached are my IGCSE statement of results and documents.",
          receivedAt: "2026-09-15T10:00:00Z",
          attachments: await Promise.all([
            att({ filename: "igcse-low-results.pdf", docType: "academic_cert", name, spec: { examSystem: "IGCSE", subjects: { ENGLISH: "C", MATHEMATICS: "C", BIOLOGY: "C", HISTORY: "C", PHYSICS: "F", CHEMISTRY: "F" } } }),
            att({ filename: "igcse-low-id.pdf", docType: "id", name, spec: { idNumber: "33445566" } }),
            att({ filename: "igcse-low-form.pdf", docType: "application_form", name }),
            ...checklistDocs("igcse-low", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["low_confidence"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }
  {
    const name = "KAMAU IB TWENTYSEVEN";
    fixtures.push({
      name: "ib-degree-route",
      description: "IB Diploma with 27 points (≥ 24) for BBIT → qualifies through the university-wide IB route → auto-admitted (admission letter sent).",
      emails: [
        email({
          id: "email-ib-1", threadId: "thread-ib", from: "kamau.ib@student.example.org", fromName: "Kamau Ib",
          subject: "IB results attached",
          body: "I completed the IB Diploma and would like to apply.",
          receivedAt: "2026-09-15T11:00:00Z",
          attachments: await Promise.all([
            att({ filename: "ib-results.pdf", docType: "academic_cert", name, spec: { examSystem: "IB", ibPoints: 27 } }),
            att({ filename: "ib-id.pdf", docType: "id", name, spec: { idNumber: "33778899" } }),
            att({ filename: "ib-form.pdf", docType: "application_form", name, spec: { programme: "BACHELOR OF BUSINESS INFORMATION TECHNOLOGY" } }),
            ...checklistDocs("ib", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }
  {
    const name = "KIPROP ONE PRINCIPAL";
    fixtures.push({
      name: "alevel-one-principal",
      description: "KACE/A-Level with only 1 principal pass — fails the 2-principal route, but the KCSE-tagged leaving certificate is unreadable → E4: an unread route beats a confirmed failure, so the case goes to verification (low-confidence flags) rather than 'does not meet requirements' (held).",
      emails: [
        email({
          id: "email-al-1", threadId: "thread-al", from: "kiprop.principal@student.example.org", fromName: "Kiprop Principal",
          subject: "A level results",
          body: "Please find my advanced level results attached.",
          receivedAt: "2026-09-15T12:00:00Z",
          attachments: await Promise.all([
            att({ filename: "al-results.pdf", docType: "academic_cert", name, spec: { examSystem: "ALEVEL", subjects: { MATHEMATICS: "B" }, subsidiaries: 1 } }),
            att({ filename: "al-id.pdf", docType: "id", name, spec: { idNumber: "33990011" } }),
            att({ filename: "al-form.pdf", docType: "application_form", name }),
            ...checklistDocs("al", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Orange", lifecycle: "awaiting_review", autoSent: false, autoKind: null, flagTypes: ["low_confidence"], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }
  {
    const name = "MWANGI SECOND UPPER";
    fixtures.push({
      name: "degree-mba-route",
      description: "MBA applicant with a Second Class Honours (Upper Division) degree → recognised degree route → auto-admitted (admission letter sent).",
      emails: [
        email({
          id: "email-mba-1", threadId: "thread-mba", from: "mwangi.mba@student.example.org", fromName: "Mwangi Mba",
          subject: "MBA application",
          body: "Attached are my degree transcript and application documents for the MBA.",
          receivedAt: "2026-09-15T13:00:00Z",
          attachments: await Promise.all([
            att({ filename: "mba-transcript.pdf", docType: "academic_cert", name, spec: { examSystem: "DEGREE", degreeTitle: "BACHELOR OF COMMERCE", classAwarded: "SECOND CLASS HONOURS (UPPER DIVISION)" } }),
            att({ filename: "mba-ug-cert.pdf", docType: "undergraduate_degree_certificate", name }),
            att({ filename: "mba-id.pdf", docType: "id", name, spec: { idNumber: "34101112" } }),
            att({ filename: "mba-form.pdf", docType: "application_form", name, spec: { programme: "MASTER OF BUSINESS ADMINISTRATION" } }),
            ...checklistDocs("mba", name, { school: false }),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }

  // ── Credit-transfer fixtures ──────────────────────────────────────────────
  {
    const name = "NAOMI TRANSFER OKONKWO";
    fixtures.push({
      name: "transfer-complete",
      description: "Applicant transferring credit includes the credit transfer form → complete file → auto-admitted (admission letter sent).",
      emails: [
        email({
          id: "email-tr-ok-1", threadId: "thread-tr-ok", from: "naomi.transfer@student.example.org", fromName: "Naomi Okonkwo",
          subject: "Credit transfer application",
          body: "I am applying for credit transfer from my previous university. Attached are my documents and the completed credit transfer form.",
          receivedAt: "2026-09-16T09:00:00Z",
          attachments: await Promise.all([
            att({ filename: "tr-ok-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "tr-ok-id.pdf", docType: "id", name, spec: { idNumber: "35221144" } }),
            att({ filename: "tr-ok-form.pdf", docType: "application_form", name }),
            att({ filename: "tr-ok-ctf.pdf", docType: "credit_transfer_form", name, spec: { previousInstitution: "STRATHMORE UNIVERSITY", programme: "BSC COMPUTER SCIENCE" } }),
            ...checklistDocs("tr-ok", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Green", lifecycle: "completed", autoSent: true, autoKind: "ack", flagTypes: [], superseded: 0, duplicates: 0, missing: [], category: "document_submission", priority: "normal" },
    });
  }
  {
    const name = "PETER TRANSFER MWANGI";
    fixtures.push({
      name: "transfer-missing-form",
      description: "Transfer applicant who forgot the credit transfer form → it appears on the missing list (held request).",
      emails: [
        email({
          id: "email-tr-miss-1", threadId: "thread-tr-miss", from: "peter.transfer@student.example.org", fromName: "Peter Mwangi",
          subject: "Application for admission — transferring credits",
          body: "Please consider my application. I am transferring from another institution and would like my credits considered.",
          receivedAt: "2026-09-16T10:00:00Z",
          attachments: await Promise.all([
            att({ filename: "tr-miss-academic.pdf", docType: "academic_cert", name }),
            att({ filename: "tr-miss-id.pdf", docType: "id", name, spec: { idNumber: "35332255" } }),
            att({ filename: "tr-miss-form.pdf", docType: "application_form", name }),
            ...checklistDocs("tr-miss", name),
          ]),
        }),
      ],
      expected: { finalStatus: "Red", lifecycle: "documents_received", autoSent: false, autoKind: "missing_docs", flagTypes: [], superseded: 0, duplicates: 0, missing: ["credit_transfer_form"], category: "application", priority: "normal" },
    });
  }

  return fixtures;
}
