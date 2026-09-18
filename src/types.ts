/**
 * Shared types for the Email Sorter (v2 — case management system).
 * Dependency-free: every module imports from here.
 */

// ── Triage verdicts (unchanged from v1) ────────────────────────────────────

export type Classification = "Green" | "Orange" | "Red";

export type DocType =
  | "academic_cert"
  | "id"
  | "kcpe_cert"
  | "birth_cert"
  | "application_form"
  | "credit_transfer_form"
  | "unknown";

export const DOC_TYPES: DocType[] = [
  "academic_cert",
  "id",
  "kcpe_cert",
  "birth_cert",
  "application_form",
  "credit_transfer_form",
  "unknown",
];

/** "none" = every tier failed (or the attachment was rejected outright). */
export type ExtractionMethod = "pdf_text" | "ocr" | "gemini_vision" | "none";
export type Confidence = "high" | "medium" | "low";

/** Blocking flag types feed the rules engine; duplicate_submission is informational. */
export type FlagType =
  | "grade_below_requirement"
  | "name_mismatch"
  | "low_confidence"
  | "watcher_flag"
  | "duplicate_submission"
  | "identity_check"
  | "late_submission"
  | "anomaly"
  | "alternative_qualification";

export const BLOCKING_FLAG_TYPES: FlagType[] = [
  "grade_below_requirement",
  "name_mismatch",
  "low_confidence",
  "watcher_flag",
  "identity_check",
  "late_submission",
  "anomaly",
];

// ── Case management (v2) ───────────────────────────────────────────────────

/** Applicant-facing lifecycle (feature 15). Linear, human-advanceable. */
export type LifecycleStage =
  | "application_received"
  | "documents_received"
  | "documents_checked"
  | "awaiting_review"
  | "verification"
  | "completed";

export const LIFECYCLE_ORDER: LifecycleStage[] = [
  "application_received",
  "documents_received",
  "documents_checked",
  "awaiting_review",
  "verification",
  "completed",
];

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  application_received: "Application Received",
  documents_received: "Documents Received",
  documents_checked: "Documents Checked",
  awaiting_review: "Awaiting Review",
  verification: "Verification",
  completed: "Completed",
};

/** Deterministic email categorization (feature 26). */
export type EmailCategory =
  | "application"
  | "document_submission"
  | "missing_document"
  | "fee_enquiry"
  | "admission_enquiry"
  | "follow_up"
  | "complaint"
  | "other";

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  application: "Application",
  document_submission: "Document Submission",
  missing_document: "Missing Document",
  fee_enquiry: "Fee Enquiry",
  admission_enquiry: "Admission Enquiry",
  follow_up: "Follow-up",
  complaint: "Complaint",
  other: "Other",
};

export type Priority = "normal" | "high" | "urgent";

/**
 * Roles (v3): officer (cases) < it (cases + configuration) < manager < admin.
 * 'it' exists so technical staff can tune automation & retention without
 * getting staff-management powers.
 */
export type StaffRole = "admin" | "manager" | "it" | "officer";

export interface StaffUser {
  id: number;
  username: string;
  display_name: string;
  role: StaffRole;
  active: number;
  /** 1 when the account belongs to the seeded demo dataset. */
  demo?: number;
}

// ── Requirements ───────────────────────────────────────────────────────────

/**
 * RequirementSet — config: what's currently being asked for.
 * v2: rules can be scoped per programme and/or intake (features 8, 36, 37);
 * the most specific rule wins.
 * v5: rules speak GRADES, not points — `meanGrade` ("C+") and optional
 * per-subject lines ("C+ in English and Mathematics") exactly as published.
 */
/**
 * One structured subject requirement: the subject must reach `grade` — OR any
 * of `alts` may (English/Kiswahili, Mathematics/Physics). Checked subjects
 * within a block are AND-ed together.
 */
export interface SubjectRequirement {
  subject: string;
  grade: string;
  alts?: string[];
}

/**
 * One qualification-system route for a course (or the university-wide
 * defaults when programme is null). An applicant qualifies through a route
 * when its overall minimum AND every ticked subject pass the checks.
 */
export interface SystemBlock {
  system: ExamSystem;
  enabled: boolean;
  /** KCSE mean grade (grade ladder) — the overall floor for this route. */
  overall?: string | null;
  /** IGCSE/O-Level: minimum subjects at grade C or better. */
  minCredits?: number | null;
  /** GCE A-Level / KACE: minimum principal passes (+ optional subsidiaries). */
  minPrincipals?: number | null;
  minSubsidiaries?: number | null;
  /** IB diploma minimum total points. */
  minPoints?: number | null;
  /** Minimum GPA (Pre-University, IB Grade 12, some diplomas). */
  minGpa?: number | null;
  /** Minimum award class ("Credit", "Second Class Upper"…). */
  minClass?: string | null;
  subjects?: SubjectRequirement[];
}

export type CourseLevel = "degree" | "diploma" | "certificate" | "postgrad";

export interface RequirementSetEntry {
  document_type: DocType;
  required: boolean;
  /** Minimum overall mean grade, e.g. "C+". null/undefined = not graded. */
  meanGrade?: string | null;
  /** Free-form subject lines, e.g. "C+ in English and Mathematics". */
  subjectGrades?: string | null;
}

/** A course in the official catalogue, grouped by school. */
export interface Programme {
  code: string;
  name: string;
  school: string;
  /** Official minimum entry requirement (descriptive — staff reference). */
  entry_requirements: string;
  owner_id: number | null;
  owner_name: string | null;
  /** Award level — selects the university-wide default entry requirements. */
  level: CourseLevel;
}

export interface RequirementRule extends RequirementSetEntry {
  id?: number;
  programme: string | null; // null = all programmes
  intake: string | null; // null = all intakes
}

// ── Documents & extraction ─────────────────────────────────────────────────

/** Qualification systems the engine can check deterministically. */
export type ExamSystem = "KCSE" | "IGCSE" | "ALEVEL" | "IB" | "DIPLOMA" | "PREUNI" | "DEGREE";

export interface ExtractedFields {
  name?: string | null;
  gradePoints?: number | null;
  meanGrade?: string | null;
  /** Per-subject grades read off a KNEC slip, e.g. { English: "B-" }. */
  subjectGrades?: Record<string, string> | null;
  /** Qualification system detected on the document. */
  examSystem?: ExamSystem | null;
  /** IGCSE/O-Level: subjects passed at grade C or better. */
  credits?: number | null;
  /** GCE A-Level / KACE: principal passes (and subsidiaries). */
  principals?: number | null;
  subsidiaries?: number | null;
  /** IB diploma total points. */
  ibPoints?: number | null;
  /** GPA (Pre-University, diploma, IB Grade 12…). */
  gpa?: number | null;
  /** Award class, normalised ("Credit", "Second Class Upper"…). */
  classAwarded?: string | null;
  idNumber?: string | null;
  indexNumber?: string | null;
  examYear?: string | null;
  issueDate?: string | null;
  [key: string]: unknown;
}

export interface DocumentRecord {
  id: number;
  applicant_id: number;
  document_type: DocType;
  source_email_id: string;
  extraction_method: ExtractionMethod;
  extracted_text: string;
  extracted_fields: ExtractedFields;
  confidence: Confidence;
  superseded_by: number | null;
  received_at: string;
  sha256?: string;
  is_duplicate?: number;
  duplicate_of?: number | null;
}

export interface DerivedFlag {
  type: FlagType;
  detail: string;
}

export interface Flag {
  id?: number;
  applicant_id: number;
  type: FlagType;
  detail: string;
  created_at?: string;
  active?: number;
}

// ── Email ──────────────────────────────────────────────────────────────────

export interface Attachment {
  filename: string;
  mimeType: string;
  content: Buffer;
  /** Simulation-only sidecar for the mock Gemini tier. */
  mockVision?: VisionExtraction | null;
}

/**
 * Delivery channel (v3 feature 40): every channel — Gmail, the applicant
 * portal, WhatsApp/SMS bridges — feeds the same case history.
 */
export type Channel = "email" | "portal" | "whatsapp" | "sms" | "other";

export interface IncomingEmail {
  id: string;
  threadId: string;
  from: string;
  fromName?: string;
  subject: string;
  body: string;
  receivedAt: string;
  attachments: Attachment[];
  channel?: Channel;
}

export interface EmailRecord {
  id?: number;
  applicant_id: number | null;
  message_id: string;
  thread_id: string;
  direction: "in" | "out";
  from_addr: string;
  to_addr: string;
  subject: string;
  body: string;
  category: EmailCategory | null;
  auto: number; // 1 = sent automatically by the system
  channel?: Channel;
  at: string;
}

// ── Vision / watcher ───────────────────────────────────────────────────────

export interface VisionExtraction {
  document_type: DocType;
  text: string;
  fields: ExtractedFields;
  confidence: Confidence;
}

export interface ExtractionResult {
  filename: string;
  document_type: DocType;
  method: ExtractionMethod;
  text: string;
  fields: ExtractedFields;
  confidence: Confidence;
  sha256: string;
  duplicateOf?: number | null;
}

export interface WatcherInput {
  applicantEmail: string;
  subject: string;
  docs: Array<{
    document_type: DocType;
    extraction_method: ExtractionMethod;
    confidence: Confidence;
    name?: string | null;
    gradePoints?: number | null;
    textExcerpt: string;
  }>;
}

export interface WatcherResult {
  flagged: boolean;
  concerns: string[];
  source: "heuristic" | "gemini";
}

// ── Pipeline result ────────────────────────────────────────────────────────

export interface ApplicantRow {
  id: number;
  ref_number: string;
  email_address: string;
  thread_id: string;
  full_name: string | null;
  phone: string | null;
  programme: string | null;
  intake: string | null;
  /** Applying with prior credit from another institution (0/1). */
  transfer: number;
  priority: Priority;
  assigned_to: number | null;
  lifecycle: LifecycleStage;
  triage: Classification | null;
  sla_due_at: string | null;
  sla_handled_at: string | null;
  escalated: number;
  requirements_snapshot: string | null;
  /** Frozen structured entry-requirement blocks (JSON SystemBlock[]). */
  requirements_structured: string | null;
  followup_rung: number;
  followup_next_at: string | null;
  /** When the ladder was armed; rungs fire at base + ladder[n] days. */
  followup_base_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  applicant_id: number;
  title: string;
  done: number;
  staff_id: number | null;
  created_at: string;
  done_at: string | null;
}

export interface IntakeRow {
  name: string;
  deadline: string | null;
}

export interface ProcessResult {
  skipped?: boolean;
  applicantId: number;
  refNumber?: string;
  finalStatus: Classification;
  lifecycle: LifecycleStage;
  autoSent: boolean;
  autoKind?: "ack" | "missing_docs" | "docs_request" | "status_answer" | null;
  category: EmailCategory;
  reasoning: string;
  flags: DerivedFlag[];
  missing: DocType[];
}

export interface DecisionLogEntry {
  id?: number;
  applicant_id: number;
  triggering_email_id: string;
  computed_status: string;
  reasoning: string;
  auto_sent: boolean;
  timestamp?: string;
}
