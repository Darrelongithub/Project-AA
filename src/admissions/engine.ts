/**
 * /admissions/engine — the pure requirement-tree evaluator.
 *
 * HARD CONSTRAINTS (same discipline as /rules):
 *   - PURE. No I/O, no database, no AI. Exhaustively unit-testable.
 *   - It only decides PASSED / FAILED / UNDETERMINED against the data it is
 *     given. It never rejects anyone: ROUTING (in evaluate.ts) turns a
 *     failure into "Human Review Required", and missing data into
 *     "Waiting for Documents".
 */
import type { GroupOutcome, LeafOutcome, RuleNode } from "../types";
import {
  classLadderFor, compareClass, compareLadder, compareNumber, FIELD_LABELS,
  gradeLadderFor, NUMERIC_FIELDS, readValue, type CmpResult,
} from "./systems";
import type { AdmissionSystem, ExtractedFields } from "../types";

export interface TreeResult {
  result: "passed" | "failed" | "undetermined";
  leaves: LeafOutcome[];
  groups: GroupOutcome[];
  /** Leaves that decided the outcome (for "N / M rules satisfied"). */
  rulesTotal: number;
  rulesSatisfied: number;
  /** Dominant cause when undetermined. */
  causes: Array<LeafOutcome["cause"]>;
}

export interface ValueReader {
  /** Read one input value; null = not available. */
  read(field: RuleNode["field"] & string, subject: string | null): string | number | null;
  /** Is the underlying extraction reliable for this field? */
  reliable(field: RuleNode["field"] & string, subject: string | null): boolean;
}

/** Build a ValueReader over one document's extracted fields + reliability. */
export function readerFromFields(fields: ExtractedFields, reliableDoc: boolean): ValueReader {
  return {
    read: (field, subject) => readValue(fields, field as never, subject),
    reliable: () => reliableDoc,
  };
}

function conditionLabel(node: RuleNode): string {
  const field = node.field ?? "mean_grade";
  if (field === "subject") return node.subject ?? "Subject";
  return FIELD_LABELS[field];
}

/** Evaluate one leaf condition. */
export function evalLeaf(node: RuleNode, system: AdmissionSystem, values: ValueReader): LeafOutcome {
  const field = node.field ?? "mean_grade";
  const required = String(node.value ?? "").trim();
  const label = conditionLabel(node);
  const raw = values.read(field, node.subject ?? null);

  const base: LeafOutcome = {
    label,
    required: required || "—",
    applicantValue: raw === null || raw === undefined ? null : String(raw),
    status: "undetermined",
    cause: "ok",
  };

  if (raw === null || raw === undefined) {
    base.cause = values.reliable(field, node.subject ?? null) ? "missing_field" : "low_confidence";
    if (!values.reliable(field, node.subject ?? null)) base.cause = "low_confidence";
    return base;
  }
  if (!values.reliable(field, node.subject ?? null)) {
    // The value exists but we do not trust the extraction enough to act on
    // it — neither admit nor fail automatically.
    base.cause = "low_confidence";
    return base;
  }
  if (!required) {
    base.status = "passed"; // no floor configured → nothing to fail
    return base;
  }

  let cmp: CmpResult = "unknown";
  if (NUMERIC_FIELDS.includes(field)) {
    const actual = typeof raw === "number" ? raw : Number(raw);
    const req = Number(required);
    if (!Number.isFinite(req)) cmp = "unknown";
    else cmp = compareNumber(actual, req);
  } else if (field === "class") {
    const ladder = classLadderFor(system);
    cmp = ladder ? compareClass(String(raw), required, ladder) : "unknown";
  } else {
    const ladder = gradeLadderFor(system);
    cmp = ladder ? compareLadder(String(raw), required, ladder) : "unknown";
  }

  if (cmp === "ok") base.status = "passed";
  else if (cmp === "below") base.status = "failed";
  else base.cause = "missing_field"; // unknown grade format → human verifies
  return base;
}

/**
 * Evaluate a tree. Root semantics: the given nodes are AND-ed at the top
 * level (every root node must hold).
 */
export function evaluateTree(nodes: RuleNode[], system: AdmissionSystem, values: ValueReader): TreeResult {
  const leaves: LeafOutcome[] = [];
  const groups: GroupOutcome[] = [];

  type NodeResult = { status: "passed" | "failed" | "undetermined"; causes: LeafOutcome["cause"][]; via?: string };

  const walk = (node: RuleNode): NodeResult => {
    if (node.kind === "condition") {
      const leaf = evalLeaf(node, system, values);
      leaves.push(leaf);
      return { status: leaf.status, causes: leaf.status === "undetermined" ? [leaf.cause] : [], via: leaf.label };
    }
    const children = node.children ?? [];
    if (children.length === 0) return { status: "passed", causes: [] }; // empty group imposes nothing
    const results = children.map(walk);

    if (node.logic === "NOT") {
      const inner = results[0] ?? { status: "passed" as const, causes: [] };
      const status = inner.status === "passed" ? "failed" : inner.status === "failed" ? "passed" : "undetermined";
      return { status, causes: inner.causes };
    }
    if (node.logic === "OR") {
      const passed = results.find((r) => r.status === "passed");
      if (passed) return { status: "passed", causes: [], via: passed.via };
      if (results.every((r) => r.status === "failed")) return { status: "failed", causes: [] };
      // Mixed failed + undetermined: a subject that is simply ABSENT from the
      // transcript cannot satisfy the alternative, so as long as at least one
      // alternative clearly failed and nothing is merely unreadable, the group
      // fails under the standard rules. Low-confidence values stay unresolved
      // — they may be hiding a pass and need verification.
      const undet = results.filter((r) => r.status === "undetermined");
      const allAbsent = undet.every((r) => r.causes.every((ca) => ca === "missing_field"));
      if (results.some((r) => r.status === "failed") && allAbsent) {
        return { status: "failed", causes: results.flatMap((r) => r.causes) };
      }
      return { status: "undetermined", causes: results.flatMap((r) => r.causes) };
    }
    // AND (default)
    if (results.every((r) => r.status === "passed")) return { status: "passed", causes: [] };
    if (results.some((r) => r.status === "failed")) {
      return { status: "failed", causes: results.flatMap((r) => r.causes) };
    }
    return { status: "undetermined", causes: results.flatMap((r) => r.causes) };
  };

  const rootResults = nodes.map(walk);
  const allPassed = rootResults.every((r) => r.status === "passed"); // empty = nothing required
  const anyFailed = rootResults.some((r) => r.status === "failed");
  // An EMPTY rule set is a deliberate configuration: "recognised route, no
  // automated minimum" — it imposes nothing, so it is satisfied.
  const result: TreeResult["result"] = allPassed ? "passed" : anyFailed ? "failed" : "undetermined";

  // Named OR-groups get a summary outcome for the UI ("Subject alternative
  // ✓ satisfied through Physics").
  const collectGroups = (node: RuleNode, label: string) => {
    if (node.kind === "group" && node.logic === "OR" && (node.children?.length ?? 0) > 1) {
      const r = walk(node);
      groups.push({ label, status: r.status, via: r.via });
    }
    for (const ch of node.children ?? []) collectGroups(ch, label);
  };
  for (const n of nodes) {
    if (n.kind === "group" && n.logic === "OR" && (n.children?.length ?? 0) > 1) {
      const r = walk(n);
      const subjectNames = (n.children ?? []).filter((c) => c.kind === "condition").map((c) => c.subject ?? c.field ?? "");
      groups.push({ label: `Alternative: ${subjectNames.filter(Boolean).join(" OR ")}`, status: r.status, via: r.via });
    }
    for (const ch of n.children ?? []) collectGroups(ch, n.kind === "group" && n.logic === "OR" ? (n.children ?? []).map((c) => c.subject ?? "").join(" OR ") : "Group");
  }

  const rulesTotal = leaves.length;
  const rulesSatisfied = leaves.filter((l) => l.status === "passed").length;
  const causes = rootResults.flatMap((r) => r.causes);
  return { result, leaves, groups, rulesTotal, rulesSatisfied, causes: [...new Set(causes)] };
}

// ── Human-readable rendering (configuration preview) ────────────────────────

function describeNode(node: RuleNode, depth: number): string {
  if (node.kind === "condition") {
    const field = node.field ?? "mean_grade";
    const label = field === "subject" ? node.subject ?? "Subject" : FIELD_LABELS[field];
    return `${label} ${node.comparator ?? ">="} ${node.value ?? "?"}`;
  }
  const joiner = node.logic === "NOT" ? "" : ` ${node.logic ?? "AND"} `;
  const parts = (node.children ?? []).map((c) => describeNode(c, depth + 1));
  if (node.logic === "NOT") return `NOT (${parts[0] ?? ""})`;
  const inner = parts.join(joiner);
  return depth === 0 ? inner : `(${inner})`;
}

/** Symbolic preview: "Mean grade >= C+ AND (Mathematics >= C+ OR Physics >= C+)". */
export function describeRuleTree(nodes: RuleNode[]): string {
  if (nodes.length === 0) return "(no rules yet)";
  return nodes.map((n) => describeNode(n, 0)).join(" AND ");
}

/** Natural-language interpretation for staff to verify before activating. */
export function interpretRuleTree(nodes: RuleNode[], systemLabel: string): string {
  if (nodes.length === 0) return "No rules configured yet — nothing is evaluated automatically.";
  const phrase = (node: RuleNode): string => {
    if (node.kind === "condition") {
      const field = node.field ?? "mean_grade";
      const v = node.value ?? "?";
      switch (field) {
        case "mean_grade": return `a mean grade of ${v} or higher`;
        case "subject": return `${v} or higher in ${node.subject ?? "the subject"}`;
        case "credits": return `at least ${v} subjects passed at grade C or better`;
        case "principals": return `at least ${v} principal pass${v === "1" ? "" : "es"}`;
        case "subsidiaries": return `at least ${v} subsidiary pass${v === "1" ? "" : "es"}`;
        case "points": return `at least ${v} points in total`;
        case "gpa": return `a GPA of ${v} or higher`;
        case "class": return `an award class of ${v} or better`;
      }
    }
    const parts = (node.children ?? []).map(phrase);
    if (node.logic === "OR") {
      if (parts.length <= 1) return parts[0] ?? "";
      return `${parts.slice(0, -1).join(", or ")}${parts.length > 2 ? "," : ""} or ${parts[parts.length - 1]}`;
    }
    if (node.logic === "NOT") return `not (${parts[0] ?? ""})`;
    return parts.join(" and ");
  };
  const joined = nodes.map(phrase).join(", and ");
  return `Applicant must have ${joined} (${systemLabel} route).`;
}
