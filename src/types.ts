/**
 * Shared types for the Email Sorter (v2 — case management system).
 * Dependency-free: every module imports from here.
 */

// ── Triage verdicts (unchanged from v1) ────────────────────────────────────

export type Classification = "Green" | "Orange" | "Red";

/**
 * OR-5: concrete document catalogue. Vague umbrella types like "academic
 * certificate" are BANNED as requirement slots — every slot names the exact
 * document from the application-form checklist (data/pack/application-form.pdf,
 * pp. 3–4). `academic_cert` survives ONLY as a classifier fallback family
 * (one upload of unclear academic paperwork); it is never a required slot.
 */
export type DocType =
  | "application_form"
  | "exam_result_slip"
  | "leaving_certificate"
  | "passport_photo"
  | "id"
  | "birth_cert"
  | "undergraduate_transcript"
  | "undergraduate_degree_certificate"
  | "masters_transcript"
  | "masters_degree_certificate"
  | "law_personal_statement"
  | "business_statement_of_objective"
  | "credit_transfer_form"
  | "student_pass_application"
  | "foreign_qualification_equivalence"
  | "academic_cert"
  | "kcpe_cert"
  | "unknown";

export const DOC_TYPES: DocType[] = [
  "application_form",
  "exam_result_slip",
  "leaving_certificate",
  "passport_photo",
  "id",
  "birth_cert",
  "undergraduate_transcript",
  "undergraduate_degree_certificate",
  "masters_transcript",
  "masters_degree_certificate",
  "law_personal_statement",
  "business_statement_of_objective",
  "credit_transfer_form",
  "student_pass_application",
  "foreign_qualification_equivalence",
  "academic_cert",
  "kcpe_cert",
  "unknown",
];

/** "none" = every tier failed (or the attachment was rejected outright). */
export type ExtractionMethod = "pdf_text" | "ocr" | "pdf_raster" | "gemini_vision" | "none";
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
 * Roles (round 18): exactly two. `admin` administers the system
 * (configuration, staff, packs, exports); `user` works cases.
 */
export type StaffRole = "admin" | "user";

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

/** OR-6: Master's and PhD are DISTINCT levels — they enforce different
 * university-wide defaults and generate different document checklists.
 * ("postgrad" survives only as legacy data, migrated to "masters".) */
export type CourseLevel = "degree" | "diploma" | "certificate" | "masters" | "phd";

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

// ── Admissions rules engine (round 18) ─────────────────────────────────────
// Machine-evaluable requirement trees per (programme, qualification system).
// Failure of a published rule NEVER rejects — it routes to human review.

/** Qualification routes the engine can evaluate. */
export type AdmissionSystem =
  | "KCSE" | "IGCSE" | "IB" | "ALEVEL" | "KACE" | "EACE"
  | "DIPLOMA" | "PROFCERT" | "DEGREE" | "OTHER";

export const ADMISSION_SYSTEMS: AdmissionSystem[] = [
  "KCSE", "IGCSE", "IB", "ALEVEL", "KACE", "EACE",
  "DIPLOMA", "PROFCERT", "DEGREE", "OTHER",
];

/** What a condition compares. */
export type RuleField =
  | "mean_grade" | "subject" | "credits" | "principals"
  | "subsidiaries" | "points" | "gpa" | "class";

/** One node of a requirement tree. Groups combine children; conditions compare one value. */
export interface RuleNode {
  id?: number;
  set_id?: number;
  parent_id?: number | null;
  kind: "group" | "condition";
  /** Groups only: how children combine. */
  logic?: "AND" | "OR" | "NOT";
  /** Conditions only. */
  field?: RuleField;
  subject?: string | null;
  comparator?: ">=";
  value?: string | null;
  position?: number;
  children?: RuleNode[];
}

/** Versioned requirement set for one (programme, qualification system) route. */
export interface AdmissionRuleSet {
  id: number;
  programme: string | null; // null = university-wide default for `level`
  level: CourseLevel;
  system: AdmissionSystem;
  version: number;
  status: "draft" | "active" | "retired";
  created_by: string;
  created_at: string;
  nodes?: RuleNode[];
}

/** Leaf-level outcome of one condition. */
export interface LeafOutcome {
  label: string;
  required: string;
  applicantValue: string | null;
  status: "passed" | "failed" | "undetermined";
  /** Why undetermined: missing input, unreadable/low-confidence extraction… */
  cause: "ok" | "missing_field" | "low_confidence" | "no_route";
  via?: string; // OR-groups: which alternative satisfied the rule
}

/** Group-level outcome (for rendering "Subject alternative ✓ via Physics"). */
export interface GroupOutcome {
  label: string;
  status: "passed" | "failed" | "undetermined";
  via?: string;
}

export type RequirementResult = "passed" | "failed" | "missing_data" | "needs_verification";
export type AdmissionRouting = "auto_admit" | "human_review" | "waiting_documents";

/** Full, storable report of one evaluation run. */
export interface EvaluationReport {
  result: RequirementResult;
  routing: AdmissionRouting;
  reason: string;
  reasonCode: string;
  system: AdmissionSystem | null;
  setId: number | null;
  setVersion: number | null;
  leaves: LeafOutcome[];
  groups: GroupOutcome[];
  rulesSatisfied: number;
  rulesTotal: number;
  missingDocuments: string[];
  blockingFlags: string[];
  evaluatedAt: string;
  frozenAt: string | null;
}

export type AdmissionDecision = "undecided" | "auto_admitted" | "admitted_after_review" | "not_admitted";

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
  /** Date of birth as printed on the document (best-effort normalisation). */
  dateOfBirth?: string | null;
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
  /** Numeric readability/confidence score 0-100 (auto-send requires >= 75). */
  confidence_score?: number;
  superseded_by: number | null;
  received_at: string;
  sha256?: string;
  is_duplicate?: number;
  duplicate_of?: number | null;
  /** Why extraction fell short (password-protected, unreadable, partial read…). */
  extraction_note?: string;
}

/** A mail that kept failing ingestion; parked after the retry budget. */
export interface DeadLetter {
  id: number;
  message_id: string;
  subject: string;
  from_addr: string;
  error: string;
  attempts: number;
  dead: number;
  created_at: string;
  updated_at: string;
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
  /** Outgoing only: JSON array of the filenames that were attached. */
  attachments?: string;
  /** Mail window: 0 = unread incoming (arrives unread, read on open). */
  read?: number;
  /** Mail window folders: JSON array of starred | important | spam | bin. */
  labels?: string;
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
  /**
   * Confidence v2: blend of text quality + presence of the document's
   * critical fields + system identification. >=75 is required to auto-pass.
   */
  confidence_score?: number;
  /**
   * Human-facing explanation when a document could not be read well enough
   * (password-protected, corrupt, empty, screenshot-like…). Shown to staff
   * and quoted, in friendly words, in applicant replies.
   */
  failure_reason?: string | null;
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
  /** OR-5: feeds the deterministic document matrix; null = unknown. */
  nationality?: string | null;
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
  /** Realm flag: 1 = seeded demo applicant, 0 = live data (0/1). */
  demo: number;
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
  // ── Admissions engine (round 18): eligibility, routing and decision are
  //    SEPARATE concepts — never one giant status field. ──────────────────
  /** Latest evaluation result: passed|failed|missing_data|needs_verification. */
  req_result: string | null;
  /** Latest automated routing: auto_admit|human_review|waiting_documents. */
  routing: string | null;
  /** Machine-readable "why is it here" code for the queue subcategories. */
  routing_reason: string | null;
  /** Frozen rule sets this applicant is judged by (JSON AdmissionRuleSet[]). */
  admission_rules_frozen: string | null;
  admission_decision: AdmissionDecision;
  /** automated | human — how the decision came about. */
  admission_route: string | null;
  decision_by: string | null;
  decision_reason: string | null;
  decision_at: string | null;
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

export interface ProcessedCommon {
  finalStatus: Classification;
  lifecycle: LifecycleStage;
  autoSent: boolean;
  autoKind?: "ack" | "missing_docs" | "docs_request" | "status_answer" | null;
  category: EmailCategory;
  reasoning: string;
  flags: DerivedFlag[];
  missing: DocType[];
}

/**
 * Pipeline outcome. A processed email ALWAYS names its applicant; a skipped
 * one (already claimed/processed by another run) carries NO applicant handle
 * at all — the old `applicantId: -1` sentinel was one unchecked access away
 * from an FK crash, and the type system now makes that access impossible.
 */
export type ProcessResult = ProcessedCommon &
  ({ skipped?: false; applicantId: number; refNumber?: string } | { skipped: true; applicantId: null; refNumber?: string });

export interface DecisionLogEntry {
  id?: number;
  applicant_id: number;
  triggering_email_id: string;
  computed_status: string;
  reasoning: string;
  auto_sent: boolean;
  timestamp?: string;
}
