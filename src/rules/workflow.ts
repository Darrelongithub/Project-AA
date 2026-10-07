/**
 * PPR P0-4: workflow rules — intake and reply behaviour as stored data.
 *
 * A rule is conditions + actions. Rules are evaluated in `position` order;
 * the first enabled match wins. Two passes run over the same list:
 *
 *   1. INTAKE (before a case opens): the matched rule decides
 *      create / attach / ignore(park) / review.
 *   2. REPLY (after extraction, when the case state is known): the matched
 *      rule decides reply mode (send/draft/hold/none), the template (a fixed
 *      key or a state map), attachment set, follow-up, SLA and audit code.
 *
 * The built-in configured scorer can be referenced as a named signal source
 * (`signals: "configured_intake"`) — it is the configured preset's trigger,
 * not a hidden boost for every profile. Profiles without rules keep the
 * legacy pipeline behaviour; profiles with rules are fully rule-driven.
 */
import type { EmailCategory } from "../types";

/** What a condition inspects. */
export type RuleCondition =
  | { field: "always"; value: true }
  | { field: "sender_state"; value: "unknown" | "known" }
  | { field: "subject" | "body" | "text"; op: "contains_any" | "contains_all" | "not_contains"; values: string[] }
  | { field: "has_attachments"; value: boolean }
  | { field: "category"; op: "in" | "not_in"; values: string[] }
  | { field: "body_is_ref"; value: true }
  | { field: "docs_state"; value?: RuleDocsState | RuleDocsState[]; values?: RuleDocsState[] }
  | { field: "signals"; value: "configured_intake" };

/**
 * Document posture of the case at match time:
 *  - `complete`: fully qualified (Green, clean, watcher quiet)
 *  - `empty`:    no documents on file yet, checklist incomplete, no blocking flags
 *  - `missing`:  some documents on file, checklist incomplete, no blocking flags
 *  - `any`:      any documents on file (regardless of cleanliness)
 *  - `dirty`:    blocking flags, watcher flags, or otherwise not clean
 */
export type RuleDocsState = "complete" | "empty" | "missing" | "any" | "dirty";

export type RuleDecision = "create" | "attach" | "ignore" | "review";
/**
 * PPR P1-3: the four reply verbs, one per response path (missing-info,
 * status, human-review, approval, follow-up):
 *  - `send`:    attempt the automated send (subject to the gates);
 *  - `draft`:   render a draft the case officer can handle;
 *  - `approve`: render a draft that may only be released by an "Approve
 *               automation" permission holder;
 *  - `hold`:    a person writes the reply (the template is only a suggestion);
 *  - `none`:    do nothing — deliberately silent.
 */
export type RuleReplyAction = "none" | "draft" | "send" | "hold" | "approve";
export type RuleFollowupAction = "send" | "draft" | "approve" | "none";

export interface RuleTemplateMap {
  /** Fully qualified file (Green, clean). */
  green?: string;
  /** No documents on file yet. */
  empty?: string;
  /** Some documents, checklist incomplete, no blocking flags. */
  missing?: string;
}

export interface RuleAction {
  decision?: RuleDecision;
  stage?: string;
  queue?: string;
  priority?: "normal" | "high";
  assign?: "none" | number;
  reply_action?: RuleReplyAction;
  template_key?: string | null;
  template_map?: RuleTemplateMap | null;
  attachment_set?: string | null;
  request_info?: boolean;
  sla_hours?: number | null;
  followup?: "none" | "ladder";
  /** PPR P1-3: how each follow-up rung behaves (send/draft/approve/do-nothing). */
  followup_action?: RuleFollowupAction;
  /** Stable audit event code recorded when this rule fires. */
  audit_code?: string;
  /** What to do when no template resolves: internal human draft, silence, or template:<key>. */
  fallback?: "human_draft" | "none" | string;
}

export interface WorkflowRule {
  id: number;
  organization_id: number;
  case_type_id: number | null;
  kind: "intake" | "response";
  name: string;
  position: number;
  enabled: number;
  conditions: RuleCondition[];
  action: RuleAction;
}

/** Facts a rule can see about the message (and, for docs_state, the case). */
export interface RuleMatchInput {
  senderState: "known" | "unknown";
  subject: string;
  body: string;
  hasAttachments: boolean;
  category: string;
  /** The body is just this case's own reference number. */
  bodyIsRef: boolean;
  /** Result of the built-in configured scorer: "open" | "parked". */
  intakeSignals: "open" | "parked";
  /** Current document posture of the case (see RuleDocsState). */
  docsState: "complete" | "empty" | "missing" | "dirty";
  /** How many documents are on file (for `docs_state: any`). */
  docsOnFile: number;
}

function includesAny(haystack: string, values: string[]): boolean {
  return values.some((v) => haystack.includes(v.toLowerCase()));
}

/**
 * Read a condition's expected string list, whichever shape it was written in.
 *
 * Conditions reach here from three places — the flowchart panel, the raw JSON
 * box an administrator may edit by hand, and rows already stored in the
 * database. `values` is the documented shape, but a hand-written `value` is an
 * easy mistake to make, and reading `cond.values.map(...)` on it throws a
 * TypeError *inside the ingestion pipeline*, parking the message rather than
 * telling anyone why. Accepting both is cheaper than being right.
 */
function stringList(cond: { values?: unknown; value?: unknown }): string[] {
  const raw = cond.values ?? cond.value;
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter((v) => v !== "");
  if (typeof raw === "string" || typeof raw === "number") return [String(raw)];
  return [];
}

export function conditionMatches(cond: RuleCondition, input: RuleMatchInput): boolean {
  switch (cond.field) {
    case "always":
      return true;
    case "sender_state":
      return input.senderState === cond.value;
    case "subject": {
      const hay = input.subject.toLowerCase();
      const values = stringList(cond);
      return cond.op === "not_contains" ? !includesAny(hay, values) : cond.op === "contains_all" ? values.every((v) => hay.includes(v.toLowerCase())) : includesAny(hay, values);
    }
    case "body": {
      const hay = input.body.toLowerCase();
      const values = stringList(cond);
      return cond.op === "not_contains" ? !includesAny(hay, values) : cond.op === "contains_all" ? values.every((v) => hay.includes(v.toLowerCase())) : includesAny(hay, values);
    }
    case "text": {
      const hay = `${input.subject}\n${input.body}`.toLowerCase();
      const values = stringList(cond);
      return cond.op === "not_contains" ? !includesAny(hay, values) : cond.op === "contains_all" ? values.every((v) => hay.includes(v.toLowerCase())) : includesAny(hay, values);
    }
    case "has_attachments":
      return input.hasAttachments === cond.value;
    case "category": {
      const hit = stringList(cond).map((v) => v.toLowerCase()).includes(input.category.toLowerCase());
      return cond.op === "not_in" ? !hit : hit;
    }
    case "body_is_ref":
      return input.bodyIsRef;
    case "docs_state": {
      const wanted = stringList(cond);
      return wanted.some((w) => w === "any" ? input.docsOnFile > 0 : w === input.docsState);
    }
    case "signals":
      return cond.value === "configured_intake" && input.intakeSignals === "open";
    default:
      return false;
  }
}

export function ruleMatches(rule: WorkflowRule, input: RuleMatchInput): boolean {
  if (rule.enabled !== 1) return false;
  if (rule.conditions.length === 0) return false;
  try {
    return rule.conditions.every((c) => conditionMatches(c, input));
  } catch {
    // A condition this build cannot evaluate does not match — the pipeline
    // must never be brought down by one badly shaped rule.
    return false;
  }
}

/**
 * The one ordering rules are evaluated in: a rule pinned to a CaseType always
 * outranks an organization-wide rule (`case_type_id` NULL), whatever their
 * positions say; ties break on position, then id.
 *
 * Exported so the configuration UI draws the chain in *this* order rather than
 * re-deriving it (the flowchart used to render plain `ORDER BY position`, which
 * silently disagreed with the engine whenever a case-type rule and an
 * organization-wide rule coexisted — BUG-07).
 */
export function compareRuleOrder(a: WorkflowRule, b: WorkflowRule): number {
  return Number(a.case_type_id === null) - Number(b.case_type_id === null) || a.position - b.position || a.id - b.id;
}

/** First matching rule in evaluation order. */
export function firstMatchingRule(rules: WorkflowRule[], input: RuleMatchInput): WorkflowRule | null {
  const ordered = [...rules].sort(compareRuleOrder);
  for (const rule of ordered) {
    if (ruleMatches(rule, input)) return rule;
  }
  return null;
}

/** Rules that may apply to a case: its own type's rules first, then org-wide
 *  legacy-scope rules (case_type_id NULL — migrated/configured profiles). */
export function rulesForCaseScope(rules: WorkflowRule[], caseTypeId: number | null, _legacyScope?: boolean): WorkflowRule[] {
  return rules.filter((r) =>
    r.case_type_id === caseTypeId || r.case_type_id === null
  );
}

/** Which documents-on-file state the case is in right now. */
export function replyStateOf(input: {
  fullyQualified: boolean;
  blockingFlags: boolean;
  cleanMissing: boolean;
  docsOnFile: number;
}): "complete" | "empty" | "missing" | "dirty" {
  if (input.fullyQualified) return "complete";
  if (input.blockingFlags) return "dirty";
  if (input.cleanMissing) return input.docsOnFile === 0 ? "empty" : "missing";
  return "dirty";
}

/** Human-readable one-liner for admin lists. */
export function describeRule(rule: WorkflowRule): string {
  const bits: string[] = [];
  for (const c of rule.conditions) {
    if (c.field === "always") bits.push("any message");
    else if (c.field === "sender_state") bits.push(c.value === "known" ? "known contact" : "unknown sender");
    else if (c.field === "text" || c.field === "subject" || c.field === "body") {
      const where = c.field === "subject" ? "subject" : c.field === "body" ? "body" : "text";
      bits.push(`${where} ${c.op.replace(/_/g, " ")} “${stringList(c).join("”, “")}”`);
    } else if (c.field === "has_attachments") bits.push(c.value ? "has attachments" : "no attachments");
    else if (c.field === "category") bits.push(`category ${c.op.replace(/_/g, " ")} ${stringList(c).join(", ")}`);
    else if (c.field === "body_is_ref") bits.push("body is just the case reference");
    else if (c.field === "docs_state") bits.push(`documents ${stringList(c).join("|")}`);
    else if (c.field === "signals") bits.push("built-in configured intake signals");
  }
  const a = rule.action;
  const acts: string[] = [];
  if (a.decision) acts.push({ create: "open a case", attach: "continue the case", ignore: "park (no case)", review: "human review" }[a.decision]);
  if (a.reply_action && a.reply_action !== "none") {
    const tpl = a.template_key ? ` “${a.template_key}”` : a.template_map ? ` (${Object.entries(a.template_map).map(([k, v]) => `${k}→${v}`).join(", ")})` : "";
    acts.push({ send: `send${tpl}`, draft: `draft${tpl}`, hold: `hold for staff${tpl}`, approve: `draft for approval${tpl}` }[a.reply_action]);
  }
  if (a.followup === "ladder") {
    acts.push(`follow-up ladder (${a.followup_action ?? "hold"})`);
  }
  return `${bits.join(" AND ") || "any message"} → ${acts.join("; ") || "no reply"}`;
}

export type EmailCategoryLike = EmailCategory | string;
