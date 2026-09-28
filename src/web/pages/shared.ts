/**
 * Page renderers — shared page builders (shell, badges, formatting, Ctx). Extracted verbatim from pages.ts;
 * pages.ts re-exports the page API unchanged.
 */
import { organizationName } from "../../branding";
import { Repo } from "../../db/repo";
import { StaffUser } from "../../types";
import { Theme, esc, layout } from "../views";

export interface Ctx {
  repo: Repo;
  user: StaffUser;
  unread: number;
  csrf: string;
  theme?: Theme;
  /** Organization-owned name and theme; admissions remains a configuration, not a code identity. */
  institution: string;
  brand?: { primary: string; accent: string; logo?: string | null; tagline?: string };
  /** The running server may have env-only Gmail credentials. */
  gmailConfigured?: boolean;
  gmailAddress?: string;
}


export function head(c: Ctx, title: string, active: string, content: string): string {
  return layout({
    title, content, user: c.user, unread: c.unread, active, csrf: c.csrf, theme: c.theme,
    institution: c.institution, brand: c.brand,
    // PPR P0-2: the Admissions entry appears only for organizations that
    // actually run an education-module profile.
    educationNav: c.repo.hasEducationModule(c.user.organization_id ?? 1),
    organizations: c.user.role === "admin" && c.user.can_switch_org ? c.repo.listOrganizations().map((o) => ({ id: o.id, name: organizationName(c.repo, o.id) })) : undefined,
    activeOrganizationId: c.user.organization_id ?? 1,
  });
}


/** "it" → "IT", else first-letter title: polite, readable labels. */
export function capFirst(s: string): string {
  if (s.toLowerCase() === "it") return "IT";
  return s.charAt(0).toUpperCase() + s.slice(1);
}


export function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}


// ── Applicants (features 2, 18, 19) ────────────────────────────────────────
// ── Operational queues (round 18) ──────────────────────────────────────────
const RESULT_BADGES: Record<string, [string, string]> = {
  passed: ["Passed", "b-green"],
  failed: ["Failed", "b-red"],
  missing_data: ["Missing data", "b-blue"],
  needs_verification: ["Needs verification", "b-orange"],
  undetermined: ["Pending", "b-gray"],
};


export const DECISION_BADGES: Record<string, [string, string]> = {
  undecided: ["Not yet decided", "b-gray"],
  auto_admitted: ["Auto-admitted", "b-green"],
  admitted_after_review: ["Admitted after human review", "b-purple"],
  not_admitted: ["Not admitted", "b-red"],
};


export function resultBadge(result: string | null): string {
  const [label, cls] = RESULT_BADGES[result ?? ""] ?? [result ?? "—", "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}


export function decisionBadge(decision: string): string {
  const [label, cls] = DECISION_BADGES[decision] ?? [decision, "b-gray"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}


/** 195 → "3h 15m", 3000 → "2d 2h", 42 → "42m". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.round((minutes % 1440) / 60)}h`;
}
