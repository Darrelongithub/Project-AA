/** Pure AND/OR/NOT evaluation of organization-defined scalar facts. Missing is not false. */
import type { Repo } from "../db/repo";
import type { GroupOutcome, LeafOutcome, RuleNode } from "../types";

export interface CaseTypeRuleEvaluation {
  result: "passed" | "failed" | "undetermined";
  routing: "human_review";
  outcome: "undecided";
  passed: number;
  total: number;
  leaves: LeafOutcome[];
  groups: GroupOutcome[];
}
type Truth = boolean | null;
function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ? (Number.isFinite(Number(text)) ? Number(text) : null) : text;
}
export function compareFacts(actual: unknown, comparator: string, expected: unknown): Truth {
  const left = scalar(actual);
  const right = scalar(expected);
  if (left === null || right === null) return null;
  if ([">", ">=", "<", "<="].includes(comparator)) {
    if (typeof left !== "number" || typeof right !== "number") return null;
    return comparator === ">" ? left > right : comparator === ">=" ? left >= right : comparator === "<" ? left < right : left <= right;
  }
  if (comparator !== "=" && comparator !== "!=") return null;
  const equal = typeof left === "boolean" && typeof right === "string" && /^(?:true|false)$/i.test(right) ? left === (right.toLowerCase() === "true")
    : typeof right === "boolean" && typeof left === "string" && /^(?:true|false)$/i.test(left) ? right === (left.toLowerCase() === "true") : left === right;
  return comparator === "=" ? equal : !equal;
}
export function validateRuleTree(value: unknown): asserts value is RuleNode[] {
  let count = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++count > 500 || depth > 20) throw new Error("Rule tree exceeds the 500-node / 20-level limit");
    if (!node || typeof node !== "object") throw new Error("Every rule must be an object");
    const item = node as Record<string, unknown>;
    if (item.kind === "condition") {
      if (typeof item.field !== "string" || !item.field.trim() || item.field.length > 100 || ["__proto__", "prototype", "constructor"].includes(item.field)) throw new Error("Condition requires a valid field");
      if (![">=", ">", "<=", "<", "=", "!="].includes(String(item.comparator ?? ">="))) throw new Error("Invalid comparator");
      if (typeof item.value !== "string" || !item.value.trim() || item.value.length > 1000) throw new Error("Condition requires a scalar value");
      if (item.children !== undefined) throw new Error("A condition cannot have children");
    } else if (item.kind === "group") {
      if (!["AND", "OR", "NOT"].includes(String(item.logic ?? "AND")) || !Array.isArray(item.children) || item.children.length === 0) throw new Error("Group requires a logic and children");
      if (item.logic === "NOT" && item.children.length !== 1) throw new Error("NOT requires exactly one child");
      item.children.forEach((child) => visit(child, depth + 1));
    } else throw new Error("Unknown rule kind");
  };
  if (!Array.isArray(value)) throw new Error("Rules must be an array");
  value.forEach((node) => visit(node, 0));
}
export function evaluateCaseTypeRules(_repo: Repo, _caseType: { id: number; code: string }, nodes: RuleNode[], facts: Record<string, unknown>): CaseTypeRuleEvaluation {
  const leaves: LeafOutcome[] = [];
  const groups: GroupOutcome[] = [];
  let visited = 0;
  const visit = (node: RuleNode, depth = 0): Truth => {
    if (++visited > 500 || depth > 20) return null;
    if (node.kind === "condition") {
      const field = node.subject ?? node.field ?? "";
      const actual = Object.hasOwn(facts, field) ? facts[field] : null;
      const value = compareFacts(actual, node.comparator ?? ">=", node.value);
      leaves.push({ label: field, required: node.value ?? "", applicantValue: scalar(actual) === null ? null : String(actual), status: value === true ? "passed" : value === false ? "failed" : "undetermined", cause: value === null ? "missing_field" : "ok" });
      return value;
    }
    if (node.kind !== "group" || !Array.isArray(node.children) || node.children.length === 0) return null;
    const children = node.children.map((child) => visit(child, depth + 1));
    const value = node.logic === "NOT" ? (children.length === 1 && children[0] !== null ? !children[0] : null)
      : node.logic === "OR" ? (children.some((child) => child === true) ? true : children.every((child) => child === false) ? false : null)
        : children.every((child) => child === true) ? true : children.some((child) => child === false) ? false : null;
    groups.push({ label: node.logic ?? "AND", status: value === true ? "passed" : value === false ? "failed" : "undetermined" });
    return value;
  };
  const roots = nodes.map((node) => visit(node));
  const value = roots.length === 0 ? null : roots.every((root) => root === true) ? true : roots.some((root) => root === false) ? false : null;
  return { result: value === true ? "passed" : value === false ? "failed" : "undetermined", routing: "human_review", outcome: "undecided", passed: leaves.filter((leaf) => leaf.status === "passed").length, total: leaves.length, leaves, groups };
}
export function describeRuleTree(nodes: RuleNode[]): string {
  const describe = (node: RuleNode, depth = 0): string => {
    if (depth > 20) return "…";
    if (node.kind === "condition") return `${node.subject ?? node.field ?? "?"} ${node.comparator ?? ">="} ${node.value ?? "?"}`;
    const children = (node.children ?? []).map((child) => describe(child, depth + 1));
    return node.logic === "NOT" ? `NOT (${children[0] ?? "?"})` : `(${children.join(` ${node.logic ?? "AND"} `)})`;
  };
  return nodes.length ? nodes.map((node) => describe(node)).join(" AND ") : "(no rules configured — human review)";
}
