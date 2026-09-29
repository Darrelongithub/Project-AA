/**
 * /db — all queries live here. Nothing else in the codebase writes SQL.
 * v2: case management (ref numbers, email history, status history, audit
 * log, notes, staff/sessions, templates, settings, SLAs, notifications,
 * programme/intake-scoped requirements, search, dashboard stats).
 */
import { VisionCacheStore } from "../extraction/gemini";
import { WorkflowRule } from "../rules/workflow";
import { AdmissionRuleSet, AdmissionSystem, ApplicantRow, AttachmentSet, CaseConfigFrozen, CaseType, Confidence, CourseLevel, DeadLetter, DecisionLogEntry, DerivedFlag, DocType, DocumentDefinition, DocumentRecord, EmailCategory, EmailRecord, ExtractedFields, ExtractionMethod, Flag, LifecycleStage, Organization, OrganizationTheme, Permission, Programme, RequirementRule, RequirementSetEntry, RuleNode, StaffUser, SystemBlock, VisionExtraction } from "../types";
import { Database } from "better-sqlite3";
import type { Decision } from "../decisions";
import * as organizations from "./repo/organizations";
import * as casetypes from "./repo/casetypes";
import * as orgassets from "./repo/orgassets";
import * as cases from "./repo/cases";
import * as programmes from "./repo/programmes";
import * as requirements from "./repo/requirements";
import * as documents from "./repo/documents";
import * as mail from "./repo/mail";
import * as staff from "./repo/staff";
import * as templates from "./repo/templates";
import * as settings from "./repo/settings";
import * as notifications from "./repo/notifications";
import * as ingest from "./repo/ingest";
import * as stats from "./repo/stats";
import * as automation from "./repo/automation";
import * as scopes from "./repo/scopes";
import * as rulesets from "./repo/rulesets";
import * as vision from "./repo/vision";
import * as deadletters from "./repo/deadletters";
import * as metrics from "./repo/metrics";
import * as consoleq from "./repo/console";
export { SECRET_KEYS, EDUCATION_STAGE_PRESET, GENERIC_STAGE_PRESET, EDUCATION_QUEUE_PRESET, GENERIC_QUEUE_PRESET } from "./repo/shared";

/** Query shape for {@link Repo.searchApplicants} — shared with the web layer. */
export interface ApplicantSearchQuery {
  q?: string;
  filter?: "all" | "awaiting_docs" | "human_review" | "complete" | "overdue";
  programme?: string;
  intake?: string;
  limit?: number;
  /** Realm scope: 0 = live only, 1 = demo only, undefined = all. */
  demo?: number;
  /** OR-8: school visibility scope. null/undefined = unscoped; an empty
   * list matches nothing. */
  schools?: string[] | null;
}

/** Per-staff workload + responsiveness metrics for the Team page. */
export interface StaffStatsRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  active: number;
  demo: number;
  assignedCases: number;
  emailsReceived: number;
  emailsSent: number;
  avgResponseMinutes: number | null;
  admissionsCompleted: number;
}

export class Repo {
  constructor(public db: Database) {}

  static threadKeySql(alias: string): string {
    return mail.threadKeySql(alias);
  }

  static MAIL_PAGE_SIZE = mail.MAIL_PAGE_SIZE;

  static MAIL_FOLDER_WHERE: Record<string, string> = mail.MAIL_FOLDER_WHERE;

  // ── organizations ──
  getOrganization(id: number): Organization | undefined {
    return organizations.getOrganization(this, id);
  }

  createOrganization(input: { name: string; logo?: string | null; refPrefix?: string; theme?: Partial<OrganizationTheme> }): Organization {
    return organizations.createOrganization(this, input);
  }

  listOrganizations(): Organization[] {
    return organizations.listOrganizations(this);
  }

  organizationRefPrefix(organizationId = 1): string {
    return organizations.organizationRefPrefix(this, organizationId);
  }

  updateOrganization(id: number, patch: { name?: string; logo?: string | Buffer | null; refPrefix?: string; theme?: Partial<OrganizationTheme>; fromName?: string | null; replyTo?: string | null; locale?: string | null; timezone?: string | null }): void {
    return organizations.updateOrganization(this, id, patch);
  }

  // ── case types, document definitions, rule trees and workflow rules ──
  createCaseType(organizationId: number, input: {
    code: string; name: string; category?: string; config?: Record<string, unknown>;
    /** PPR P0-2/P0-4: profile flags. New profiles are draft-first, no auto-decision. */
    educationModule?: boolean; defaultReplyAction?: string; qualificationGate?: boolean; autoAdmit?: boolean;
  }): CaseType {
    return casetypes.createCaseType(this, organizationId, input);
  }

  getCaseType(code: string, organizationId = 1): CaseType | undefined {
    return casetypes.getCaseType(this, code, organizationId);
  }

  listCaseTypes(organizationId = 1): CaseType[] {
    return casetypes.listCaseTypes(this, organizationId);
  }

  caseTypeById(id: number): CaseType | undefined {
    return casetypes.caseTypeById(this, id);
  }

  caseTypeForCase(id: number): CaseType | undefined {
    return casetypes.caseTypeForCase(this, id);
  }

  listDocumentDefinitions(caseTypeId: number): DocumentDefinition[] {
    return casetypes.listDocumentDefinitions(this, caseTypeId);
  }

  upsertDocumentDefinition(caseTypeId: number, input: { key: string; label: string; required?: boolean; blocking?: boolean; position?: number }): void {
    return casetypes.upsertDocumentDefinition(this, caseTypeId, input);
  }

  deleteDocumentDefinition(caseTypeId: number, key: string): void {
    return casetypes.deleteDocumentDefinition(this, caseTypeId, key);
  }

  updateCaseTypeRules(caseTypeId: number, nodes: RuleNode[]): void {
    return casetypes.updateCaseTypeRules(this, caseTypeId, nodes);
  }

  caseTypeRules(caseType: CaseType): RuleNode[] {
    return casetypes.caseTypeRules(this, caseType);
  }

  bumpCaseTypeConfigVersion(caseTypeId: number): number {
    return casetypes.bumpCaseTypeConfigVersion(this, caseTypeId);
  }

  caseTypeConfigVersion(caseTypeId: number): number {
    return casetypes.caseTypeConfigVersion(this, caseTypeId);
  }

  freezeCaseConfig(a: ApplicantRow): void {
    return casetypes.freezeCaseConfig(this, a);
  }

  caseConfigFrozen(a: ApplicantRow): CaseConfigFrozen | null {
    return casetypes.caseConfigFrozen(this, a);
  }

  reFreezeCaseConfig(a: ApplicantRow): CaseConfigFrozen {
    return casetypes.reFreezeCaseConfig(this, a);
  }

  educationCaseFor(a: ApplicantRow): boolean {
    return casetypes.educationCaseFor(this, a);
  }

  hasEducationModule(organizationId = 1): boolean {
    return casetypes.hasEducationModule(this, organizationId);
  }

  listWorkflowRules(organizationId = 1, opts: { caseTypeId?: number | null; kind?: "intake" | "response" } = {}): WorkflowRule[] {
    return casetypes.listWorkflowRules(this, organizationId, opts);
  }

  getWorkflowRule(id: number): WorkflowRule | undefined {
    return casetypes.getWorkflowRule(this, id);
  }

  saveWorkflowRule(input: {
    id?: number; organizationId: number; caseTypeId?: number | null; kind?: "intake" | "response";
    name: string; position?: number; enabled?: boolean; conditions: WorkflowRule["conditions"]; action: WorkflowRule["action"];
  }): WorkflowRule {
    return casetypes.saveWorkflowRule(this, input);
  }

  deleteWorkflowRule(id: number, organizationId = 1): void {
    return casetypes.deleteWorkflowRule(this, id, organizationId);
  }

  updateCaseTypeProfile(id: number, patch: { default_reply_action?: "auto" | "draft"; qualification_gate?: 0 | 1; auto_admit?: 0 | 1 }): void {
    return casetypes.updateCaseTypeProfile(this, id, patch);
  }

  updateCaseTypeVocabulary(id: number, patch: {
    terminology?: Record<string, string>;
    stages?: Array<{ id: string; label: string; requires?: string[] }>;
    queues?: Array<{ id: string; label: string }>;
  }): void {
    return casetypes.updateCaseTypeVocabulary(this, id, patch);
  }

  // ── organization asset catalogs (attachment sets, axes, categories, pack slots) ──
  listAttachmentSets(organizationId = 1): Array<AttachmentSet & { file_count: number; bytes: number }> {
    return orgassets.listAttachmentSets(this, organizationId);
  }

  getAttachmentSet(id: number): AttachmentSet | undefined {
    return orgassets.getAttachmentSet(this, id);
  }

  attachmentSetByName(organizationId: number, name: string): AttachmentSet | undefined {
    return orgassets.attachmentSetByName(this, organizationId, name);
  }

  createAttachmentSet(organizationId: number, name: string, description = ""): AttachmentSet {
    return orgassets.createAttachmentSet(this, organizationId, name, description);
  }

  deleteAttachmentSet(id: number, organizationId = 1): void {
    return orgassets.deleteAttachmentSet(this, id, organizationId);
  }

  addAttachmentSetFile(setId: number, file: { filename: string; mime?: string; content: Buffer; provenance?: string }): number {
    return orgassets.addAttachmentSetFile(this, setId, file);
  }

  listAttachmentSetFiles(setId: number): Array<{ id: number; filename: string; mime: string; content: Buffer; provenance: string }> {
    return orgassets.listAttachmentSetFiles(this, setId);
  }

  deleteAttachmentSetFile(id: number): void {
    return orgassets.deleteAttachmentSetFile(this, id);
  }

  attachmentSetFiles(organizationId: number, ref: string | null | undefined): { label: string; files: Array<{ filename: string; mimeType: string; content: Buffer }>; issues: string[] } {
    return orgassets.attachmentSetFiles(this, organizationId, ref);
  }

  listOrganizationDocumentAxes(organizationId = 1): Array<{ key: string; label: string; values: string[] }> {
    return orgassets.listOrganizationDocumentAxes(this, organizationId);
  }

  replaceOrganizationDocumentAxes(organizationId: number, axes: Array<{ key: string; label: string; values: string[] }>): void {
    return orgassets.replaceOrganizationDocumentAxes(this, organizationId, axes);
  }

  replaceDocumentDefinitions(caseTypeId: number, definitions: Array<{ key: string; label: string; required: boolean; blocking: boolean }>): void {
    return orgassets.replaceDocumentDefinitions(this, caseTypeId, definitions);
  }

  listEmailCategories(organizationId = 1): Array<{ id: number; organization_id: number; key: string; label: string; active: number }> {
    return orgassets.listEmailCategories(this, organizationId);
  }

  addEmailCategory(organizationId: number, input: { key: string; label: string }): void {
    return orgassets.addEmailCategory(this, organizationId, input);
  }

  listOrganizationPackSlots(organizationId = 1): Array<{ organization_id: number; key: string; filename: string | null; mime: string | null; content: Buffer | null }> {
    return orgassets.listOrganizationPackSlots(this, organizationId);
  }

  setOrganizationPackSlot(organizationId: number, key: string, file: { filename: string; mime: string; content: Buffer }): void {
    return orgassets.setOrganizationPackSlot(this, organizationId, key, file);
  }

  // ── cases/applicants, decisions, lifecycle, audit, notes and tasks ──
  listCases(organizationId?: number): ApplicantRow[] {
    return cases.listCases(this, organizationId);
  }

  getCase(id: number): ApplicantRow | undefined {
    return cases.getCase(this, id);
  }

  listCasesForStaff(staff: { id: number; role: string; organization_id?: number | null }): ApplicantRow[] {
    return cases.listCasesForStaff(this, staff);
  }

  nextRefNumber(prefix: string, year: number): string {
    return cases.nextRefNumber(this, prefix, year);
  }

  findByRef(ref: string): ApplicantRow | undefined {
    return cases.findByRef(this, ref);
  }

  getOrCreateApplicant(
    emailAddress: string,
    threadId: string,
    opts: { fullName?: string; refPrefix?: string; organizationId?: number; caseTypeCode?: string } = {}
  ): ApplicantRow {
    return cases.getOrCreateApplicant(this, emailAddress, threadId, opts);
  }

  createCase(input: { emailAddress: string; threadId: string; organizationId?: number; caseTypeCode?: string; fullName?: string; refPrefix?: string }): ApplicantRow {
    return cases.createCase(this, input);
  }

  getApplicant(id: number): ApplicantRow | undefined {
    return cases.getApplicant(this, id);
  }

  /** getApplicant that throws ApplicantNotFoundError instead of returning undefined. */
  requireApplicant(id: number): ApplicantRow {
    return cases.requireApplicant(this, id);
  }

  updateApplicant(
    id: number,
    patch: Partial<
      Pick<
        ApplicantRow,
        | "full_name"
        | "phone"
        | "programme"
        | "intake"
        | "priority"
        | "assigned_to"
        | "lifecycle"
        | "triage"
        | "queue"
        | "sla_due_at"
        | "sla_handled_at"
        | "escalated"
        | "transfer"
        | "nationality"
        | "req_result"
        | "routing"
        | "routing_reason"
      >
    >
  ): void {
    return cases.updateApplicant(this, id, patch);
  }

  recordDecision(id: number, decision: Decision): void {
    return cases.recordDecision(this, id, decision);
  }

  updateCase(id: number, patch: { category?: string | null; outcome?: Decision; case_type_id?: number | null }): void {
    return cases.updateCase(this, id, patch);
  }

  setLifecycle(id: number, to: LifecycleStage, actor: string, reason: string): void {
    return cases.setLifecycle(this, id, to, actor, reason);
  }

  statusHistory(applicantId: number): Array<{ from_status: string; to_status: string; actor: string; reason: string; at: string }> {
    return cases.statusHistory(this, applicantId);
  }

  audit(applicantId: number | null, actor: string, event: string, detail = ""): void {
    return cases.audit(this, applicantId, actor, event, detail);
  }

  auditForApplicant(applicantId: number): Array<{ at: string; actor: string; event: string; detail: string }> {
    return cases.auditForApplicant(this, applicantId);
  }

  recentAudit(limit: number): Array<{ at: string; actor: string; event: string; detail: string; applicant_id: number | null }> {
    return cases.recentAudit(this, limit);
  }

  addNote(applicantId: number, staffId: number | null, body: string): void {
    return cases.addNote(this, applicantId, staffId, body);
  }

  notesForApplicant(applicantId: number): Array<{ id: number; body: string; at: string; display_name: string | null }> {
    return cases.notesForApplicant(this, applicantId);
  }

  escalate(id: number): void {
    return cases.escalate(this, id);
  }

  overdueCases(): ApplicantRow[] {
    return cases.overdueCases(this);
  }

  insertDecisionLog(l: {
    applicant_id: number;
    triggering_email_id: string;
    computed_status: string;
    reasoning: string;
    auto_sent: boolean;
  }): number {
    return cases.insertDecisionLog(this, l);
  }

  decisionLogs(applicantId?: number): DecisionLogEntry[] {
    return cases.decisionLogs(this, applicantId);
  }

  // ── Phase 12 admin security console (org-scoped in SQL) ────────────────
  consoleLogins(orgId: number, since?: string, until?: string): consoleq.ConsoleLoginRow[] {
    return consoleq.consoleLogins(this, orgId, since, until);
  }
  consoleLoginFailCounts(orgId: number, since?: string, until?: string): Array<{ actor: string; display_name: string; fails: number; last_at: string }> {
    return consoleq.consoleLoginFailCounts(this, orgId, since, until);
  }
  consoleRuns(orgId: number, since?: string, until?: string): consoleq.ConsoleRunRow[] {
    return consoleq.consoleRuns(this, orgId, since, until);
  }
  consoleErrors(orgId: number, since?: string, until?: string): consoleq.ConsoleErrorRow[] {
    return consoleq.consoleErrors(this, orgId, since, until);
  }
  consoleAlerts(orgId: number, since?: string, until?: string): consoleq.ConsoleAlertRow[] {
    return consoleq.consoleAlerts(this, orgId, since, until);
  }
  consoleTamperOutcomes(orgId: number): consoleq.ConsoleTamperRow[] {
    return consoleq.consoleTamperOutcomes(this, orgId);
  }
  consoleTamperActors(orgId: number): consoleq.ConsoleTamperRow[] {
    return consoleq.consoleTamperActors(this, orgId);
  }
  consoleVisionAttempts(orgId: number, since?: string, until?: string): consoleq.ConsoleVisionRow[] {
    return consoleq.consoleVisionAttempts(this, orgId, since, until);
  }
  consoleRoutings(orgId: number, since?: string, until?: string): consoleq.ConsoleRoutingRow[] {
    return consoleq.consoleRoutings(this, orgId, since, until);
  }
  consoleFallbackTriggers(orgId: number, since?: string, until?: string): consoleq.ConsoleErrorRow[] {
    return consoleq.consoleFallbackTriggers(this, orgId, since, until);
  }
  consoleOrgDuration(orgId: number, days: number): { n: number; avgMs: number } {
    return consoleq.consoleOrgDuration(this, orgId, days);
  }
  recordErrorEvent(e: consoleq.ErrorEventInput): void {
    return consoleq.recordErrorEvent(this, e);
  }
  consoleErrorEvents(orgId: number, since?: string, until?: string): consoleq.ConsoleErrorEventRow[] {
    return consoleq.consoleErrorEvents(this, orgId, since, until);
  }

  approverFor(applicantId: number): { actor: string; at: string } | undefined {
    return cases.approverFor(this, applicantId);
  }

  findByEmailAny(emailAddress: string, organizationId?: number): ApplicantRow | undefined {
    return cases.findByEmailAny(this, emailAddress, organizationId);
  }

  linkThread(applicantId: number, threadId: string): void {
    return cases.linkThread(this, applicantId, threadId);
  }

  threadsForApplicant(applicantId: number): string[] {
    return cases.threadsForApplicant(this, applicantId);
  }

  addTask(applicantId: number, title: string, staffId: number | null): void {
    return cases.addTask(this, applicantId, title, staffId);
  }

  listTasks(applicantId: number): Array<{ id: number; title: string; done: number; display_name: string | null; created_at: string; done_at: string | null }> {
    return cases.listTasks(this, applicantId);
  }

  toggleTask(taskId: number, done: boolean): void {
    return cases.toggleTask(this, taskId, done);
  }

  updateLatestEmailCategory(applicantId: number, category: EmailCategory): boolean {
    return cases.updateLatestEmailCategory(this, applicantId, category);
  }

  deleteApplicantFull(applicantId: number): void {
    return cases.deleteApplicantFull(this, applicantId);
  }

  openUnassignedCasesForProgramme(programme: string, demo: 0 | 1): ApplicantRow[] {
    return cases.openUnassignedCasesForProgramme(this, programme, demo);
  }

  openApplicantIds(): number[] {
    return cases.openApplicantIds(this);
  }

  // ── programmes and intakes ──
  listProgrammes(): Programme[] {
    return programmes.listProgrammes(this);
  }

  programmeByCode(code: string): Programme | undefined {
    return programmes.programmeByCode(this, code);
  }

  updateProgramme(code: string, fields: { name?: string; school?: string; entry_requirements?: string }): void {
    return programmes.updateProgramme(this, code, fields);
  }

  ownerOfProgramme(code: string | null): number | null {
    return programmes.ownerOfProgramme(this, code);
  }

  addProgramme(code: string, name: string, school = "", entry = "", level: CourseLevel = "degree"): void {
    return programmes.addProgramme(this, code, name, school, entry, level);
  }

  assignProgrammeOwner(code: string, staffId: number | null): void {
    return programmes.assignProgrammeOwner(this, code, staffId);
  }

  listIntakes(): string[] {
    return programmes.listIntakes(this);
  }

  addIntake(name: string): void {
    return programmes.addIntake(this, name);
  }

  // ── requirement rules, system blocks and requirement resolution ──
  seedBaseRequirements(entries: RequirementSetEntry[]): void {
    return requirements.seedBaseRequirements(this, entries);
  }

  dedupeRules(): number {
    return requirements.dedupeRules(this);
  }

  listRules(): RequirementRule[] {
    return requirements.listRules(this);
  }

  upsertRule(rule: { programme: string | null; intake: string | null; document_type: DocType; required: boolean; meanGrade?: string | null; subjectGrades?: string | null }): void {
    return requirements.upsertRule(this, rule);
  }

  deleteRule(id: number): void {
    return requirements.deleteRule(this, id);
  }

  listSystemBlocks(programme: string | null): Array<SystemBlock & { level: string }> {
    return requirements.listSystemBlocks(this, programme);
  }

  upsertSystemBlock(programme: string | null, level: CourseLevel, block: SystemBlock): void {
    return requirements.upsertSystemBlock(this, programme, level, block);
  }

  deleteSystemBlock(programme: string | null, system: string, level?: CourseLevel): void {
    return requirements.deleteSystemBlock(this, programme, system, level);
  }

  resolveBlocks(programme: string | null): SystemBlock[] {
    return requirements.resolveBlocks(this, programme);
  }

  effectiveBlocks(a: ApplicantRow): SystemBlock[] {
    return requirements.effectiveBlocks(this, a);
  }

  freezeStructuredSnapshot(a: ApplicantRow): void {
    return requirements.freezeStructuredSnapshot(this, a);
  }

  effectiveRequirements(a: ApplicantRow): RequirementSetEntry[] {
    return requirements.effectiveRequirements(this, a);
  }

  freezeRequirementsSnapshot(a: ApplicantRow): void {
    return requirements.freezeRequirementsSnapshot(this, a);
  }

  resolveRequirements(
    programme: string | null,
    _intake: string | null,
    opts?: { transfer?: boolean; nationality?: string | null }
  ): RequirementSetEntry[] {
    return requirements.resolveRequirements(this, programme, _intake, opts);
  }

  courseDocConfig(programme: string): Set<DocType> | null {
    return requirements.courseDocConfig(this, programme);
  }

  saveCourseDocConfig(programme: string, types: DocType[]): void {
    return requirements.saveCourseDocConfig(this, programme, types);
  }

  deleteCourseDocConfig(programme: string): void {
    return requirements.deleteCourseDocConfig(this, programme);
  }

  // ── documents, duplicates, supersession and flags ──
  insertDocument(d: {
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
    return documents.insertDocument(this, d);
  }

  updateDocumentConfidence(
    docId: number,
    patch: { confidence?: Confidence; confidence_score?: number; extraction_note?: string }
  ): void {
    return documents.updateDocumentConfidence(this, docId, patch);
  }

  findDuplicate(applicantId: number, sha256: string): DocumentRecord | undefined {
    return documents.findDuplicate(this, applicantId, sha256);
  }

  supersedeOlder(applicantId: number, docType: DocType, newId: number): number {
    return documents.supersedeOlder(this, applicantId, docType, newId);
  }

  listDocuments(applicantId: number, opts: { activeOnly?: boolean } = {}): DocumentRecord[] {
    return documents.listDocuments(this, applicantId, opts);
  }

  countSuperseded(applicantId: number): number {
    return documents.countSuperseded(this, applicantId);
  }

  countDuplicates(applicantId: number): number {
    return documents.countDuplicates(this, applicantId);
  }

  syncFlags(applicantId: number, derived: DerivedFlag[]): void {
    return documents.syncFlags(this, applicantId, derived);
  }

  activeFlags(applicantId: number): Flag[] {
    return documents.activeFlags(this, applicantId);
  }

  // ── emails, threads, labels and mail folders ──
  insertEmail(e: Omit<EmailRecord, "id" | "attachments"> & { channel?: string; attachments?: string[] }): number {
    return mail.insertEmail(this, e);
  }

  parseAttachmentList(raw: string | null | undefined): string[] {
    return mail.parseAttachmentList(this, raw);
  }

  documentCountsByApplicant(): Map<number, number> {
    return mail.documentCountsByApplicant(this);
  }

  activeFlagTypesByApplicant(): Map<number, string[]> {
    return mail.activeFlagTypesByApplicant(this);
  }

  emailsForApplicant(applicantId: number): EmailRecord[] {
    return mail.emailsForApplicant(this, applicantId);
  }

  mailThreads(opts: {
    schools?: string[] | null; demo?: number; q?: string; unreadOnly?: boolean; page?: number; folder?: string;
  }): Array<EmailRecord & { tkey: string; thread_n: number; unread_n: number; star_n: number; imp_n: number; a_name: string | null; a_email: string | null; ref_number: string | null; programme: string | null; lifecycle: string | null }> {
    return mail.mailThreads(this, opts);
  }

  emailsForThread(tkey: string): EmailRecord[] {
    return mail.emailsForThread(this, tkey);
  }

  markThreadRead(tkey: string): void {
    return mail.markThreadRead(this, tkey);
  }

  markThreadUnread(tkey: string): void {
    return mail.markThreadUnread(this, tkey);
  }

  mailFolderCounts(opts: { schools?: string[] | null; demo?: number }): Record<string, number> {
    return mail.mailFolderCounts(this, opts);
  }

  setThreadLabel(tkey: string, label: string, on: boolean): void {
    return mail.setThreadLabel(this, tkey, label, on);
  }

  threadLabelState(tkey: string): { starred: boolean; important: boolean; spam: boolean; bin: boolean } {
    return mail.threadLabelState(this, tkey);
  }

  // ── staff, permissions, sessions and reset codes ──
  staffCount(): number {
    return staff.staffCount(this);
  }

  createStaff(username: string, displayName: string, passwordHash: string, role: string, demo = false, organizationId = 1): void {
    return staff.createStaff(this, username, displayName, passwordHash, role, demo, organizationId);
  }

  createStaffAndReturn(
    username: string,
    displayName: string,
    passwordHash: string,
    role: "admin" | "user" = "user",
    organizationId = 1
  ): StaffUser {
    return staff.createStaffAndReturn(this, username, displayName, passwordHash, role, organizationId);
  }

  permissionsFor(staffId: number): string[] {
    return staff.permissionsFor(this, staffId);
  }

  setPermissions(staffId: number, permissions: string[]): void {
    return staff.setPermissions(this, staffId, permissions);
  }

  hasPermission(staffId: number, permission: Permission): boolean {
    return staff.hasPermission(this, staffId, permission);
  }

  setStaffDisplayName(id: number, displayName: string): void {
    return staff.setStaffDisplayName(this, id, displayName);
  }

  getStaffByUsername(username: string): (StaffUser & { password_hash: string }) | undefined {
    return staff.getStaffByUsername(this, username);
  }

  getStaff(id: number): StaffUser | undefined {
    return staff.getStaff(this, id);
  }

  listStaff(organizationId?: number): StaffUser[] {
    return staff.listStaff(this, organizationId);
  }

  staffInOrganization(staffId: number, organizationId: number): StaffUser | undefined {
    return staff.staffInOrganization(this, staffId, organizationId);
  }

  setStaffUsername(id: number, username: string): void {
    return staff.setStaffUsername(this, id, username);
  }

  setStaffPassword(id: number, passwordHash: string): void {
    return staff.setStaffPassword(this, id, passwordHash);
  }

  setStaffActive(id: number, active: boolean): void {
    return staff.setStaffActive(this, id, active);
  }

  createSession(staffId: number): { token: string; csrf: string; expiresAt: string } {
    return staff.createSession(this, staffId);
  }

  getSession(token: string): { staff: StaffUser; csrf: string } | undefined {
    return staff.getSession(this, token);
  }

  deleteSession(token: string): void {
    return staff.deleteSession(this, token);
  }

  issueResetCode(staffId: number, issuedBy: string, ttlMs = 30 * 60_000): string {
    return staff.issueResetCode(this, staffId, issuedBy, ttlMs);
  }

  consumeResetCode(code: string): number | null {
    return staff.consumeResetCode(this, code);
  }

  purgeStaffSessions(staffId: number): number {
    return staff.purgeStaffSessions(this, staffId);
  }

  purgeExpiredSessions(): void {
    return staff.purgeExpiredSessions(this);
  }

  setActiveOrganization(staffId: number, organizationId: number): void {
    return staff.setActiveOrganization(this, staffId, organizationId);
  }

  // ── message templates ──
  getTemplate(key: string, organizationId = 1, caseTypeId?: number): { key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number } | undefined {
    return templates.getTemplate(this, key, organizationId, caseTypeId);
  }

  listTemplates(organizationId = 1): Array<{ key: string; name: string; subject: string; body: string; include_banner: number; attach_pack: string; case_type_id: number }> {
    return templates.listTemplates(this, organizationId);
  }

  templateDefaultSnapshot(key: string, organizationId = 1): { name: string; subject: string; body: string; include_banner: number; attach_pack: string } | null {
    return templates.templateDefaultSnapshot(this, key, organizationId);
  }

  upsertTemplate(key: string, name: string, subject: string, body: string, includeBanner?: boolean, attachPack?: string, organizationId = 1, caseTypeId = 0): void {
    return templates.upsertTemplate(this, key, name, subject, body, includeBanner, attachPack, organizationId, caseTypeId);
  }

  setTemplateBanner(key: string, include: boolean): void {
    return templates.setTemplateBanner(this, key, include);
  }

  // ── settings and secrets ──
  getSetting(key: string, fallback: string): string {
    return settings.getSetting(this, key, fallback);
  }

  setSetting(key: string, value: string): void {
    return settings.setSetting(this, key, value);
  }

  getSecret(key: string, organizationId = 1): string {
    return settings.getSecret(this, key, organizationId);
  }

  setSecret(key: string, value: string, organizationId = 1): void {
    return settings.setSecret(this, key, value, organizationId);
  }

  deleteSecret(key: string, organizationId = 1): void {
    return settings.deleteSecret(this, key, organizationId);
  }

  hasSecret(key: string, organizationId = 1): boolean {
    return settings.hasSecret(this, key, organizationId);
  }

  allSettings(): Record<string, string> {
    return settings.allSettings(this);
  }

  // ── notifications ──
  notify(kind: string, message: string, applicantId: number | null, staffId: number | null = null): void {
    return notifications.notify(this, kind, message, applicantId, staffId);
  }

  notificationsFor(staffId: number, limit = 50, demo?: number, schools?: string[] | null): Array<{ id: number; kind: string; message: string; read: number; at: string; applicant_id: number | null }> {
    return notifications.notificationsFor(this, staffId, limit, demo, schools);
  }

  unreadCount(staffId: number, demo?: number, schools?: string[] | null): number {
    return notifications.unreadCount(this, staffId, demo, schools);
  }

  markNotificationsRead(staffId: number): void {
    return notifications.markNotificationsRead(this, staffId);
  }

  // ── ingest claims ledger and outbox ──
  isProcessed(emailId: string): boolean {
    return ingest.isProcessed(this, emailId);
  }

  markProcessed(emailId: string, threadId: string): void {
    return ingest.markProcessed(this, emailId, threadId);
  }

  claimProcessed(emailId: string, threadId: string): boolean {
    return ingest.claimProcessed(this, emailId, threadId);
  }

  unmarkProcessed(emailId: string): void {
    return ingest.unmarkProcessed(this, emailId);
  }

  addOutbox(o: { applicant_id: number; to_address: string; subject: string; body: string; mode: "auto" | "queued"; template_key?: string; needs_approval?: number }): void {
    return ingest.addOutbox(this, o);
  }

  latestOutbox(applicantId: number): { subject: string; body: string; mode: string } | undefined {
    return ingest.latestOutbox(this, applicantId);
  }

  queuedOutbox(applicantId: number): { id: number; subject: string; body: string; template_key?: string; needs_approval?: number } | undefined {
    return ingest.queuedOutbox(this, applicantId);
  }

  updateOutbox(id: number, subject: string, body: string): void {
    return ingest.updateOutbox(this, id, subject, body);
  }

  claimOutboxDraft(id: number, nowIso: string): boolean {
    return ingest.claimOutboxDraft(this, id, nowIso);
  }

  releaseOutboxDraft(id: number): void {
    return ingest.releaseOutboxDraft(this, id);
  }

  deleteOutbox(id: number): void {
    return ingest.deleteOutbox(this, id);
  }

  // ── dashboards, queues, search and statistics ──
  lastEmailDirections(ids: number[]): Map<number, "in" | "out"> {
    return stats.lastEmailDirections(this, ids);
  }

  latestEvaluationReasons(ids: number[]): Map<number, string> {
    return stats.latestEvaluationReasons(this, ids);
  }

  docCounts(ids: number[]): Map<number, number> {
    return stats.docCounts(this, ids);
  }

  enquiryApplicantIdsToday(startISO: string, schools?: string[] | null): Set<number> {
    return stats.enquiryApplicantIdsToday(this, startISO, schools);
  }

  stageCounts(demo?: number, schools?: string[] | null): {
    finished: number;
    unfinished: number;
    pending: number;
    enquiries: number;
    application_received: number;
    documents_received: number;
    documents_checked: number;
    awaiting_review: number;
    verification: number;
    completed: number;
    total: number;
  } {
    return stats.stageCounts(this, demo, schools);
  }

  todayStats(demo?: number, schools?: string[] | null): { emailsToday: number; docsToday: number; completedToday: number } {
    return stats.todayStats(this, demo, schools);
  }

  queueView(demo?: number, schools?: string[] | null): Array<ApplicantRow & { computed_status: string; reasoning: string; auto_sent: boolean; decided_at: string; flag_summary: string }> {
    return stats.queueView(this, demo, schools);
  }

  searchApplicants(opts: ApplicantSearchQuery): ApplicantRow[] {
    return stats.searchApplicants(this, opts);
  }

  dashboardStats(demo?: number, schools?: string[] | null): Record<string, number | string> {
    return stats.dashboardStats(this, demo, schools);
  }

  commonMissingDocs(demo?: number, schools?: string[] | null, limit = 5): Array<{ type: string; count: number }> {
    return stats.commonMissingDocs(this, demo, schools, limit);
  }

  allApplicants(demo?: number, schools?: string[] | null): ApplicantRow[] {
    return stats.allApplicants(this, demo, schools);
  }

  staffStats(demo?: number, organizationId?: number): StaffStatsRow[] {
    return stats.staffStats(this, demo, organizationId);
  }

  unansweredCases(schools?: string[] | null): Array<{ applicant: ApplicantRow; lastInAt: string; hours: number }> {
    return stats.unansweredCases(this, schools);
  }

  categoryCounts(schools?: string[] | null): Array<{ category: string; n: number }> {
    return stats.categoryCounts(this, schools);
  }

  triageCounts(demo?: number, schools?: string[] | null): { green: number; orange: number; red: number } {
    return stats.triageCounts(this, demo, schools);
  }

  accuracyStats(demo?: number, schools?: string[] | null): Record<string, number> {
    return stats.accuracyStats(this, demo, schools);
  }

  // ── automation posture, intake deadlines and follow-ups ──
  automationMode(category: string): "auto" | "draft" {
    return automation.automationMode(this, category);
  }

  setAutomationMode(category: string, mode: "auto" | "draft"): void {
    return automation.setAutomationMode(this, category, mode);
  }

  allAutomationConfig(): Array<{ category: string; mode: string }> {
    return automation.allAutomationConfig(this);
  }

  listIntakeRows(): Array<{ name: string; deadline: string | null }> {
    return automation.listIntakeRows(this);
  }

  addIntakeWithDeadline(name: string, deadline: string | null): void {
    return automation.addIntakeWithDeadline(this, name, deadline);
  }

  setIntakeDeadline(name: string, deadline: string | null): void {
    return automation.setIntakeDeadline(this, name, deadline);
  }

  intakeDeadline(intake: string | null): string | null {
    return automation.intakeDeadline(this, intake);
  }

  setFollowup(applicantId: number, rung: number, nextAt: string | null, baseAt?: string | null, action?: string): void {
    return automation.setFollowup(this, applicantId, rung, nextAt, baseAt, action);
  }

  claimFollowupRung(applicantId: number, expectedRung: number, nextRung: number, nextAt: string | null): boolean {
    return automation.claimFollowupRung(this, applicantId, expectedRung, nextRung, nextAt);
  }

  dueFollowUps(now: string): ApplicantRow[] {
    return automation.dueFollowUps(this, now);
  }

  // ── visibility scopes, catalogues and schools ──
  visibleSchoolsFor(staff: { id: number; role: string }): string[] | null {
    return scopes.visibleSchoolsFor(this, staff);
  }

  caseScopeFor(staff: { id: number; role: string; organization_id?: number | null }): string[] {
    return scopes.caseScopeFor(this, staff);
  }

  applicantVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    return scopes.applicantVisibleTo(this, staff, a);
  }

  listSubjectCatalogue(system?: string): Array<{ id: number; system: string; name: string; active: number }> {
    return scopes.listSubjectCatalogue(this, system);
  }

  addCatalogueSubject(system: string, name: string): boolean {
    return scopes.addCatalogueSubject(this, system, name);
  }

  renameCatalogueSubject(id: number, name: string): boolean {
    return scopes.renameCatalogueSubject(this, id, name);
  }

  setCatalogueActive(id: number, active: boolean): void {
    return scopes.setCatalogueActive(this, id, active);
  }

  seedCatalogue(entries: Array<{ system: string; name: string }>): void {
    return scopes.seedCatalogue(this, entries);
  }

  scopesFor(staffId: number): string[] {
    return scopes.scopesFor(this, staffId);
  }

  setCaseTypeScopes(staffId: number, caseTypes: string[]): void {
    return scopes.setCaseTypeScopes(this, staffId, caseTypes);
  }

  caseTypeScopesFor(staffId: number): string[] {
    return scopes.caseTypeScopesFor(this, staffId);
  }

  caseTypeVisibleTo(staff: { id: number; role: string; organization_id?: number | null }, a: ApplicantRow): boolean {
    return scopes.caseTypeVisibleTo(this, staff, a);
  }

  setScopes(staffId: number, schools: string[]): void {
    return scopes.setScopes(this, staffId, schools);
  }

  clearScopes(staffId: number): void {
    return scopes.clearScopes(this, staffId);
  }

  scopeModeFor(staffId: number): "unscoped" | "scoped" | "none" {
    return scopes.scopeModeFor(this, staffId);
  }

  listSchools(): string[] {
    return scopes.listSchools(this);
  }

  addSchool(name: string): boolean {
    return scopes.addSchool(this, name);
  }

  renameSchool(from: string, to: string): number {
    return scopes.renameSchool(this, from, to);
  }

  // ── admission rule sets and evaluation records ──
  listRuleSets(filter: { programme?: string | null; status?: string; system?: string } = {}): AdmissionRuleSet[] {
    return rulesets.listRuleSets(this, filter);
  }

  getRuleSet(id: number): AdmissionRuleSet | undefined {
    return rulesets.getRuleSet(this, id);
  }

  getRuleSetNodes(setId: number): RuleNode[] {
    return rulesets.getRuleSetNodes(this, setId);
  }

  getRuleTree(setId: number): RuleNode[] {
    return rulesets.getRuleTree(this, setId);
  }

  activeSetsForProgramme(programme: string | null): AdmissionRuleSet[] {
    return rulesets.activeSetsForProgramme(this, programme);
  }

  getDraftSet(programme: string | null, level: CourseLevel, system: string): AdmissionRuleSet | undefined {
    return rulesets.getDraftSet(this, programme, level, system);
  }

  ensureDraftSet(programme: string | null, level: CourseLevel, system: AdmissionSystem, user: string): AdmissionRuleSet {
    return rulesets.ensureDraftSet(this, programme, level, system, user);
  }

  addRuleNode(setId: number, parentId: number | null, kind: "group" | "condition", logic?: "AND" | "OR" | "NOT"): number {
    return rulesets.addRuleNode(this, setId, parentId, kind, logic);
  }

  updateRuleNode(nodeId: number, patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>): void {
    return rulesets.updateRuleNode(this, nodeId, patch);
  }

  moveRuleNode(nodeId: number, parentId: number | null): void {
    return rulesets.moveRuleNode(this, nodeId, parentId);
  }

  deleteRuleNode(nodeId: number): void {
    return rulesets.deleteRuleNode(this, nodeId);
  }

  ruleNodeSet(nodeId: number): AdmissionRuleSet | undefined {
    return rulesets.ruleNodeSet(this, nodeId);
  }

  updateRuleNodeIfDraft(
    nodeId: number,
    programme: string | null,
    level: CourseLevel,
    system: AdmissionSystem,
    patch: Partial<Pick<RuleNode, "logic" | "field" | "subject" | "comparator" | "value">>
  ): boolean {
    return rulesets.updateRuleNodeIfDraft(this, nodeId, programme, level, system, patch);
  }

  deleteRuleNodeIfDraft(nodeId: number, programme: string | null, level: CourseLevel, system: AdmissionSystem): boolean {
    return rulesets.deleteRuleNodeIfDraft(this, nodeId, programme, level, system);
  }

  activateDraftSet(setId: number): AdmissionRuleSet | undefined {
    return rulesets.activateDraftSet(this, setId);
  }

  discardDraftSet(setId: number): void {
    return rulesets.discardDraftSet(this, setId);
  }

  freezeAdmissionSets(a: ApplicantRow): AdmissionRuleSet[] {
    return rulesets.freezeAdmissionSets(this, a);
  }

  insertEvaluation(row: {
    applicant_id: number;
    set_id: number | null;
    programme: string | null;
    system: string | null;
    set_version: number | null;
    result: string;
    routing: string;
    reason: string;
    reason_code: string;
    detail: string;
    rule_snapshot: string;
  }): number {
    return rulesets.insertEvaluation(this, row);
  }

  latestEvaluation(applicantId: number): (import("../types").EvaluationReport & { id: number }) | null {
    return rulesets.latestEvaluation(this, applicantId);
  }

  evaluationsForApplicant(applicantId: number): Array<{ id: number; result: string; routing: string; reason: string; evaluated_at: string; set_version: number | null; system: string | null }> {
    return rulesets.evaluationsForApplicant(this, applicantId);
  }

  // ── vision cache and usage ledger ──
  visionCacheGet(sha256: string): VisionExtraction | null {
    return vision.visionCacheGet(this, sha256);
  }

  visionCacheSet(sha256: string, result: VisionExtraction): void {
    return vision.visionCacheSet(this, sha256, result);
  }

  visionCallsToday(): number {
    return vision.visionCallsToday(this);
  }

  noteVisionCall(): void {
    return vision.noteVisionCall(this);
  }

  visionCacheStore(): VisionCacheStore {
    return vision.visionCacheStore(this);
  }

  // ── dead letters ──
  deadLetterMaxAttempts(): number {
    return deadletters.deadLetterMaxAttempts(this);
  }

  recordDeadLetter(input: {
    message_id: string;
    subject: string;
    from_addr: string;
    error: string;
  }): { attempts: number; dead: boolean; id: number } {
    return deadletters.recordDeadLetter(this, input);
  }

  listDeadLetters(onlyDead = true): DeadLetter[] {
    return deadletters.listDeadLetters(this, onlyDead);
  }

  parkDeadLetter(input: {
    message_id: string;
    subject: string;
    from_addr: string;
    error: string;
  }): DeadLetter {
    return deadletters.parkDeadLetter(this, input);
  }

  resetDeadLetter(id: number): void {
    return deadletters.resetDeadLetter(this, id);
  }

  removeDeadLetter(id: number): void {
    return deadletters.removeDeadLetter(this, id);
  }

  getDeadLetter(id: number): DeadLetter | undefined {
    return deadletters.getDeadLetter(this, id);
  }

  clearDeadLetterByMessage(messageId: string): void {
    return deadletters.clearDeadLetterByMessage(this, messageId);
  }

  isDeadLetter(messageId: string): boolean {
    return deadletters.isDeadLetter(this, messageId);
  }

  upsertMetric(day: string, name: string, n: number, sum: number): void {
    return metrics.upsertMetric(this, day, name, n, sum);
  }

  metricDaily(days: number): metrics.MetricDayRow[] {
    return metrics.metricDaily(this, days);
  }
}
