/**
 * Shared contracts for the email pipeline stages.
 *
 * `processEmailInner` in ../index.ts is a pure orchestrator: it threads these
 * typed intermediate results from one stage to the next and owns NO business
 * logic itself. Each stage lives in intake.ts / evaluation.ts / reply.ts /
 * closeout.ts, takes exactly one `*StageInput`, and returns exactly one
 * `*StageResult` (or void when it only performs side effects).
 *
 * Naming rule: every interface here ends in `Stage` so it can never collide
 * with the domain types it wraps (e.g. `RulesOutput` stays the rules-module
 * decision; `RulesStageResult` is the stage envelope that carries it).
 *
 * Shared mutable state, made explicit: `preFlags` is a single array that
 * stages 3, 8, 11 and 12 append to (the orchestrator re-threads the same
 * reference); `queueForHuman` / `humanTriageOnly` are booleans stages only
 * ever set to true. Everything else is computed fresh per stage.
 */
import type { PipelineContext } from "../adapters";
import type { Draft } from "../../drafting";
import type {
  CaseTypeRuleEvaluation,
} from "../../admissions/evaluate";
import type {
  GateDecision,
} from "../../gate";
import type {
  classifyIntakeEmail,
} from "../../intake";
import type {
  RulesOutput as RulesDecision,
} from "../../rules";
import type {
  RuleAction,
  RuleMatchInput,
  WorkflowRule,
} from "../../rules/workflow";
import type {
  ApplicantRow,
  CaseType,
  Classification,
  DerivedFlag,
  DocumentRecord,
  EmailCategory,
  ExtractionResult,
  Flag,
  IncomingEmail,
  LifecycleStage,
  ProcessResult,
  ProfileReplyAction,
  RequirementSetEntry,
} from "../../types";

export type IntakeVerdict = ReturnType<typeof classifyIntakeEmail>;
/** The auto-reply flavours the pipeline can send (null means "no auto-reply"). */
export type AutoKind = NonNullable<ProcessResult["autoKind"]>;

/* ------------------------------------------------------------------ */
/* Stage 1 — intake gate (organization scoping + intake rules)         */
/* ------------------------------------------------------------------ */

export interface IntakeStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
}

export interface IntakeStageResult {
  /** A complete result when the email is parked (no case). Null otherwise. */
  parked: ProcessResult | null;
  intakeOrganizationId: number;
  verdict: IntakeVerdict;
  senderState: "known" | "unknown";
  fallbackCategory: EmailCategory;
  intakeInput: RuleMatchInput;
  bodyIsRefShape: boolean;
  intakeRule: WorkflowRule | null;
  scopedResponseRules: WorkflowRule[];
}

/* ------------------------------------------------------------------ */
/* Stage 2 — categorize                                               */
/* ------------------------------------------------------------------ */

export interface CategorizeStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  intakeOrganizationId: number;
  fallbackCategory: EmailCategory;
  intakeInput: RuleMatchInput;
  bodyIsRefShape: boolean;
  scopedResponseRules: WorkflowRule[];
}

export interface CategorizeStageResult {
  category: EmailCategory;
  enquiryOnly: boolean;
  humanTriageOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 3 — resolve applicant                                        */
/* ------------------------------------------------------------------ */

export interface ResolveStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  category: EmailCategory;
  intakeOrganizationId: number;
  intakeRule: WorkflowRule | null;
  scopedResponseRules: WorkflowRule[];
  humanTriageOnly: boolean;
}

export interface ResolveStageResult {
  applicant: ApplicantRow;
  educationCase: boolean;
  genericCaseType: CaseType | undefined;
  profileReplyMode: ProfileReplyAction | undefined;
  autoAdmitEligible: boolean;
  humanTriageOnly: boolean;
  preFlags: DerivedFlag[];
}

/* ------------------------------------------------------------------ */
/* Stage 4 — reopen + sender tracking (side effects only)             */
/* ------------------------------------------------------------------ */

export interface ReopenStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  category: EmailCategory;
  humanTriageOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 5 — store the email                                          */
/* ------------------------------------------------------------------ */

export interface StoreStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  category: EmailCategory;
}

export interface StoreStageResult {
  freshApplicant: ApplicantRow;
}

/* ------------------------------------------------------------------ */
/* Stage 6 — extract attachments                                      */
/* ------------------------------------------------------------------ */

export interface ExtractStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  genericCaseType: CaseType | undefined;
  educationCase: boolean;
}

export interface ExtractStageResult {
  extractions: ExtractionResult[];
  duplicateFlags: DerivedFlag[];
}

/* ------------------------------------------------------------------ */
/* Stage 7 — persist the accepted documents                           */
/* ------------------------------------------------------------------ */

export interface PersistStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  extractions: ExtractionResult[];
}

export interface PersistStageResult {
  activeDocs: DocumentRecord[];
}

/* ------------------------------------------------------------------ */
/* Stage 8 — cross-document consistency                               */
/* ------------------------------------------------------------------ */

export interface ConsistencyStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  activeDocs: DocumentRecord[];
  preFlags: DerivedFlag[];
}

export interface ConsistencyStageResult {
  activeDocs: DocumentRecord[];
  preFlags: DerivedFlag[];
}

/* ------------------------------------------------------------------ */
/* Stage 9 — enrichment (side effects only)                           */
/* ------------------------------------------------------------------ */

export interface EnrichStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  activeDocs: DocumentRecord[];
}

/* ------------------------------------------------------------------ */
/* Stage 10 — requirements snapshot                                 */
/* ------------------------------------------------------------------ */

export interface RequirementsStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  educationCase: boolean;
}

export interface RequirementsStageResult {
  applicantNow: ApplicantRow;
  requirements: RequirementSetEntry[];
}

/* ------------------------------------------------------------------ */
/* Stage 11 — deadline / staleness watch (appends preFlags)           */
/* ------------------------------------------------------------------ */

export interface DeadlineStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  preFlags: DerivedFlag[];
}

export interface DeadlineStageResult {
  preFlags: DerivedFlag[];
}

/* ------------------------------------------------------------------ */
/* Stage 12 — case-type rule engine                                   */
/* ------------------------------------------------------------------ */

export interface CaseTypeStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  genericCaseType: CaseType | undefined;
  educationCase: boolean;
  activeDocs: DocumentRecord[];
  requirements: RequirementSetEntry[];
  preFlags: DerivedFlag[];
  autoAdmitEligible: boolean;
}

export interface CaseTypeStageResult {
  genericRuleResult: CaseTypeRuleEvaluation | null;
  preFlags: DerivedFlag[];
}

/* ------------------------------------------------------------------ */
/* Stage 13 — rules decision (pure: no repo access)                   */
/* ------------------------------------------------------------------ */

export interface RulesStageInput {
  ctx: PipelineContext;
  genericRuleResult: CaseTypeRuleEvaluation | null;
  educationCase: boolean;
  requirements: RequirementSetEntry[];
  activeDocs: DocumentRecord[];
  preFlags: DerivedFlag[];
}

export interface RulesStageResult {
  rulesOut: RulesDecision;
}

/* ------------------------------------------------------------------ */
/* Stage 14 — watcher                                                 */
/* ------------------------------------------------------------------ */

export interface WatcherStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  category: EmailCategory;
  enquiryOnly: boolean;
  humanTriageOnly: boolean;
  rulesOut: RulesDecision;
  activeDocs: DocumentRecord[];
  preFlags: DerivedFlag[];
  duplicateFlags: DerivedFlag[];
}

export interface WatcherStageResult {
  finalStatus: Classification;
  reasoning: string;
  watcherFlagged: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 15 — gate v2 (auto-send readiness + reply preamble)          */
/* ------------------------------------------------------------------ */

export interface GateStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  activeDocs: DocumentRecord[];
  humanTriageOnly: boolean;
  finalStatus: Classification;
  rulesOut: RulesDecision;
  watcherFlagged: boolean;
}

export interface GateStageResult {
  gateDecision: GateDecision;
  activeBlockingFlags: Flag[];
  cleanMissingCase: boolean;
  refOnlyOwnCase: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 16 — reply selection                                         */
/* ------------------------------------------------------------------ */

export interface ReplySelectStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  category: EmailCategory;
  senderState: "known" | "unknown";
  verdict: IntakeVerdict;
  intakeRule: WorkflowRule | null;
  scopedResponseRules: WorkflowRule[];
  finalStatus: Classification;
  watcherFlagged: boolean;
  cleanMissingCase: boolean;
  refOnlyOwnCase: boolean;
  gateDecision: GateDecision;
  activeBlockingFlags: Flag[];
  activeDocs: DocumentRecord[];
  humanTriageOnly: boolean;
  opts: { autoStatusAnswers: boolean; autoMissingDocsEmails: boolean };
}

export interface ReplySelectStageResult {
  autoKind: AutoKind | null;
  queueForHuman: boolean;
  humanTriageOnly: boolean;
  ruleTemplateKey: string | null;
  draftNeedsApproval: boolean;
  fullyQualified: boolean;
  replyRule: WorkflowRule | null;
  replyAction: RuleAction | null;
}

/* ------------------------------------------------------------------ */
/* Stage 17 — hard draft-first overrides                              */
/* ------------------------------------------------------------------ */

export interface DraftFirstStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  category: EmailCategory;
  profileReplyMode: ProfileReplyAction | undefined;
  autoKind: AutoKind | null;
  ruleTemplateKey: string | null;
  queueForHuman: boolean;
}

export interface DraftFirstStageResult {
  queueForHuman: boolean;
  replyAttempted: boolean;
  heldForApproval: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 18 — qualification gate for auto                             */
/* ------------------------------------------------------------------ */

export interface QualGateStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  genericCaseType: CaseType | undefined;
  replyAttempted: boolean;
  fullyQualified: boolean;
  finalStatus: Classification;
  queueForHuman: boolean;
}

export interface QualGateStageResult {
  queueForHuman: boolean;
  heldForQualification: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 19 — admission safety check                                  */
/* ------------------------------------------------------------------ */

export interface AdmitSafetyStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  genericCaseType: CaseType | undefined;
  autoAdmitEligible: boolean;
  finalStatus: Classification;
  watcherFlagged: boolean;
  activeBlockingFlags: Flag[];
  humanTriageOnly: boolean;
  heldForApproval: boolean;
  heldForQualification: boolean;
  queueForHuman: boolean;
}

export interface AdmitSafetyStageResult {
  admitNow: boolean;
  organizationId: number;
  caseTypeId: number | undefined;
}

/* ------------------------------------------------------------------ */
/* Stage 20 — drafting                                                */
/* ------------------------------------------------------------------ */

export interface DraftingStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  freshApplicant: ApplicantRow;
  requirements: RequirementSetEntry[];
  activeDocs: DocumentRecord[];
  activeBlockingFlags: Flag[];
  rulesOut: RulesDecision;
  finalStatus: Classification;
  watcherFlagged: boolean;
  admitNow: boolean;
  humanTriageOnly: boolean;
  heldForApproval: boolean;
  heldForQualification: boolean;
  autoKind: AutoKind | null;
  ruleTemplateKey: string | null;
  queueForHuman: boolean;
  replyAction: RuleAction | null;
  replyRule: WorkflowRule | null;
  scopedResponseRules: WorkflowRule[];
  intakeRule: WorkflowRule | null;
  genericCaseType: CaseType | undefined;
  organizationId: number;
  caseTypeId: number | undefined;
}

export interface DraftingStageResult {
  draft: Draft | null;
  queueForHuman: boolean;
  lifecycleAfter: LifecycleStage;
  templateKey: string | null;
}

/* ------------------------------------------------------------------ */
/* Stage 21 — send or queue                                           */
/* ------------------------------------------------------------------ */

export interface SendStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  autoKind: AutoKind | null;
  draft: Draft | null;
  templateKey: string | null;
  organizationId: number;
  caseTypeId: number | undefined;
  draftNeedsApproval: boolean;
  replyAction: RuleAction | null;
  replyAttempted: boolean;
  queueForHuman: boolean;
}

export interface SendStageResult {
  autoSent: boolean;
  admissionLetterSent: boolean;
  autoKind: AutoKind | null;
  queueForHuman: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 22 — provisional admit                                       */
/* ------------------------------------------------------------------ */

export interface ProvisionalStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  genericCaseType: CaseType | undefined;
  admissionLetterSent: boolean;
}

export interface ProvisionalStageResult {
  autoAdmitted: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 23 — follow-up ladder (side effects only)                    */
/* ------------------------------------------------------------------ */

export interface LadderStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  finalStatus: Classification;
  autoSent: boolean;
  heldForQualification: boolean;
  heldForApproval: boolean;
  replyRule: WorkflowRule | null;
  autoKind: AutoKind | null;
  replyAction: RuleAction | null;
}

/* ------------------------------------------------------------------ */
/* Stage 24 — SLA + queue-for-human (side effects only)               */
/* ------------------------------------------------------------------ */

export interface ReviewQueueStageInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  applicantNow: ApplicantRow;
  category: EmailCategory;
  enquiryOnly: boolean;
  humanTriageOnly: boolean;
  heldForQualification: boolean;
  heldForApproval: boolean;
  finalStatus: Classification;
  watcherFlagged: boolean;
  rulesOut: RulesDecision;
  replyAction: RuleAction | null;
  queueForHuman: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 25 — lifecycle transitions (side effects only)                */
/* ------------------------------------------------------------------ */

export interface LifecycleStageTransitionInput {
  ctx: PipelineContext;
  applicant: ApplicantRow;
  admitNow: boolean;
  autoAdmitted: boolean;
  lifecycleAfter: LifecycleStage;
  autoKind: AutoKind | null;
  finalStatus: Classification;
}

/* ------------------------------------------------------------------ */
/* Stage 26 — decision log (side effects only)                        */
/* ------------------------------------------------------------------ */

export interface LogStageInput {
  ctx: PipelineContext;
  email: IncomingEmail;
  applicant: ApplicantRow;
  finalStatus: Classification;
  reasoning: string;
  autoSent: boolean;
}
