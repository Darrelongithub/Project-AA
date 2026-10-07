/**
 * Shared types for the Email Sorter (v2 — case management system).
 * Dependency-free: every module imports from here.
 */

// ── Triage verdicts (unchanged from v1) ────────────────────────────────────

export type Classification = "Green" | "Orange" | "Red";

/** PPR P1-8: the four automation actions, gated as distinct permissions. */
export type Permission = "publish_rules" | "send_automated" | "approve_automation" | "record_outcome";
export const PERMISSIONS: Permission[] = ["publish_rules", "send_automated", "approve_automation", "record_outcome"];
export const PERMISSION_LABELS: Record<Permission, string> = {
  publish_rules: "Publish workflow rules",
  send_automated: "Send automated reply",
  approve_automation: "Approve automation",
  record_outcome: "Record outcome",
};

/** Built-in generic hints; organizations may define any document key. */
export type DocType = "request_form" | "id" | "birth_cert" | "passport_photo" | "supporting_document" | "unknown" | (string & {});
export const DOC_TYPES: DocType[] = ["request_form", "id", "birth_cert", "passport_photo", "supporting_document", "unknown"];

/** "none" = every tier failed (or the attachment was rejected outright). */
export type ExtractionMethod = "pdf_text" | "ocr" | "pdf_raster" | "gemini_vision" | "none";
export type Confidence = "high" | "medium" | "low";

/** Blocking flag types feed the rules engine; duplicate_submission is informational. */
export type FlagType =
  | "rule_not_satisfied"
  | "name_mismatch"
  | "low_confidence"
  | "watcher_flag"
  | "duplicate_submission"
  | "identity_check"
  | "late_submission"
  | "anomaly"
  | "unconfigured_case"
  | "wrong_document";

export const BLOCKING_FLAG_TYPES: FlagType[] = [
  "rule_not_satisfied",
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
  application_received: "Received",
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
  | "general_enquiry"
  | "follow_up"
  | "complaint"
  | "other";

/**
 * Every workflow category, in the order the console lists them.
 *
 * This array is the single list the automation allowlist table and the
 * category-editor routes iterate over; it used to be two copies of the same
 * eight strings written out by hand, so a category added to the union above
 * could be quietly missing from one of them — an allowlist row nobody can
 * switch on. `EMAIL_CATEGORY_LABELS` is a `Record` over the union, so the
 * vocabulary cannot grow a label without growing the union, and this is the one
 * remaining place that has to follow.
 */
export const EMAIL_CATEGORIES: EmailCategory[] = [
  "application",
  "document_submission",
  "missing_document",
  "fee_enquiry",
  "general_enquiry",
  "follow_up",
  "complaint",
  "other",
];

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  application: "Application",
  document_submission: "Document Submission",
  missing_document: "Missing Document",
  fee_enquiry: "Fee Enquiry",
  general_enquiry: "General enquiry",
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
  /** ACTIVE organization for this session's pages (DEMO: switchable). */
  organization_id?: number | null;
  /** DEMO: installation-owner admins (home = Organization #1) may switch the
   *  active organization from the sidebar; tenant admins never see it. */
  can_switch_org?: boolean;
}

export interface RequirementSetEntry {
  document_type: DocType;
  required: boolean;
  /** Generic CaseType slots may be visible without blocking the gate. */
  blocking?: boolean;
  label?: string;
}

/** A legacy catalogue entry (programmes), grouped by unit. */
export interface Programme {
  code: string;
  name: string;
  school: string;
  /** Official minimum entry requirement (descriptive — staff reference). */
  entry_requirements: string;
  owner_id: number | null;
  owner_name: string | null;
  /** Award level or band — selects organization-defined entry requirements when configured. */
  level: string;
}

export interface RequirementRule extends RequirementSetEntry {
  id?: number;
  programme: string | null; // null = all programmes
  intake: string | null; // null = all intakes
}

/** Organization-defined scalar inspected by a condition. */
export type RuleField = string;

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
  comparator?: ">=" | ">" | "<=" | "<" | "=" | "!=";
  value?: string | null;
  position?: number;
  children?: RuleNode[];
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

/** Full, storable report of one evaluation run. */
export interface EvaluationReport {
  result: RequirementResult;
  routing: "human_review" | "waiting_documents";
  reason: string;
  reasonCode: string;
  leaves: LeafOutcome[];
  groups: GroupOutcome[];
  rulesSatisfied: number;
  rulesTotal: number;
  missingDocuments: string[];
  blockingFlags: string[];
  evaluatedAt: string;
  frozenAt: string | null;
  configVersion: number | null;
}

export type CaseOutcome = "undecided" | "auto_approved" | "approved_after_review" | "not_approved";
export type Case = ApplicantRow;
export type CaseType = {
  id: number;
  organization_id: number;
  code: string;
  name: string;
  category: string;
  config?: Record<string, unknown> | null;
  active?: number;
  /** PPR P1-1: display labels for case/contact/category/stage/outcome. */
  terminology?: Record<string, string> | null;
  /** PPR P1-2: configurable stage and queue sets (generic defaults). */
  stages?: Array<{ id: string; label: string; requires?: string[] }> | null;
  queues?: Array<{ id: string; label: string }> | null;
  /** PPR P0-3: bumped on every publish of rules/documents for the profile. */
  config_version?: number;
  /** Automation posture for the profile's rules (PPR P0-4/P1-3). */
  default_reply_action?: "none" | "draft" | "approve" | "send" | string;
  /** Evidence safety gate: never auto-send unless the file is fully qualified. */
  evidence_gate?: number;
};
/** Frozen per-case configuration (PPR P0-3): the exact profile version a case was opened under. */
export interface CaseConfigFrozen {
  config_version: number;
  rules: RuleNode[] | null;
  documents: Array<{ key: string; label: string; required: boolean; blocking: boolean }> | null;
  frozen_at: string;
}
export interface OrganizationTheme { primary: string; accent: string; }
export interface Organization {
  id: number;
  name: string;
  logo?: string | null;
  ref_prefix: string;
  theme: OrganizationTheme;
  /** Sender identity actually applied to outgoing mail (PPR P1-5). */
  from_name?: string | null;
  reply_to?: string | null;
  locale?: string | null;
  timezone?: string | null;
  /** Mailbox address that belongs to this tenant (inbound attribution). */
  inbound_address?: string | null;
}
export interface DocumentDefinition {
  id?: number;
  case_type_id: number;
  key: string;
  label: string;
  required: boolean;
  blocking: boolean;
  position?: number;
  /**
   * Organization-defined axis this slot depends on, and the values of that
   * axis for which the slot applies. Both null (the default) means the slot
   * always applies — an organization that never defines an axis is unaffected.
   */
  axis?: string | null;
  axis_values?: string[] | null;
}

export interface ExtractedFields {
  name?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
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
 * portal, the public webhook, WhatsApp/SMS bridges — feeds the same case
 * history. A non-`email` channel is SYNTHETIC: it did not arrive in a thread,
 * so identity matching skips the quoted-reference continuity rule (see
 * src/matching/identity.ts) and nobody can address another tenant's case by
 * pasting its reference into a payload.
 */
export type Channel = "email" | "portal" | "webhook" | "whatsapp" | "sms" | "other";

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
  /** The address this message was delivered to (Delivered-To, else To). Used
   *  to decide WHICH tenant owns it — a mailbox may serve several. */
  to?: string;
  /** Tenant and configured CaseType selected by the mailbox connector/portal. */
  organizationId?: number;
  caseTypeCode?: string;
}

export interface EmailRecord {
  organization_id?: number;
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
  /**
   * True when only PART of the file could be read (pages beyond the cap, a
   * rendering time budget, pages too large to rasterise). The score is capped
   * below the auto-pass floor and STAYS capped: a later routing hint may rename
   * the document, but it cannot make a partly-read file more readable.
   */
  partial_read?: boolean;
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
  /** The case type's code. Renamed from the legacy `programme` column (C2);
   *  old databases are renamed on open by migrations/legacy-storage.json. */
  case_type_code: string | null;
  /** Submission window the case belongs to (legacy column name kept). */
  intake: string | null;
  /** Legacy transfer marker carried by migrated rows (0/1). */
  transfer: number;
  /** Realm flag: 1 = seeded demo applicant, 0 = live data (0/1). */
  demo: number;
  /** Canonical generic ownership fields; null only for pre-migration rows. */
  organization_id?: number | null;
  case_type_id?: number | null;
  /** Canonical aliases; legacy category fields remain in storage. */
  category?: string | null;
  outcome?: CaseOutcome;
  priority: Priority;
  assigned_to: number | null;
  lifecycle: LifecycleStage;
  triage: Classification | null;
  sla_due_at: string | null;
  sla_handled_at: string | null;
  escalated: number;
  requirements_snapshot: string | null;
  /** Frozen structured requirement blocks from migrated rows (JSON). */
  requirements_structured: string | null;
  followup_rung: number;
  followup_next_at: string | null;
  /** When the ladder was armed; rungs fire at base + ladder[n] days. */
  followup_base_at: string | null;
  /** PPR P0-3: frozen profile configuration (JSON CaseConfigFrozen). */
  case_config_frozen?: string | null;
  /** Axis values this case is assessed against (JSON Record<string, string>). */
  axis_selections?: string | null;
  config_version_frozen?: number | null;
  config_version_frozen_at?: string | null;
  /** PPR P0-4/P1-2: rule-assigned queue id (generic workflows). */
  queue?: string | null;
  /** Evidence and routing are separate from a human-recorded outcome. */
  req_result: string | null;
  routing: string | null;
  routing_reason: string | null;
  outcome_route: string | null;
  decision_by: string | null;
  decision_reason: string | null;
  decision_at: string | null;
  created_at: string;
  updated_at: string;
}

/** PPR P0-5: an organization-owned group of files that can ride along with replies. */
export interface AttachmentSet {
  id: number;
  organization_id: number;
  name: string;
  description: string;
  position: number;
  created_at?: string;
  updated_at?: string;
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
