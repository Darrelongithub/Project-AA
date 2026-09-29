/**
 * staff routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { type DocType, type Permission, DOC_TYPES, PERMISSIONS } from "../../types";
import { staffPage } from "../pages";
import { UNKNOWN_STAFF_MEMBER, csrfCheck, requireLogin, requireRole } from "../auth";
import { hashPassword } from "../../util/password";
import { USERNAME_RE, normalizeUsername } from "../../util/username";
import type { RouteCtx } from "./ctx";

export function registerStaff(app: Express, rt: RouteCtx): void {
  // ── Staff management (admin) ─────────────────────────────────────────────

  // OR-8: save a staff member's ENTIRE school scope in one action.
  // H-3: every /staff/* route resolves its target only inside the acting
  // administrator's own organization — an org-1 admin can never act on an
  // org-2 account by guessing its id.
  app.post("/staff/scopes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const staffId = Number(req.body.staff_id);
    const member = rt.repo.staffInOrganization(staffId, rt.organizationId(req));
    if (!member) return res.redirect("/staff?msg=" + encodeURIComponent(`${UNKNOWN_STAFF_MEMBER} — nothing saved.`));
    const raw = req.body.schools;
    const schools = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).trim()).filter(Boolean);
    // Only real schools can be scoped — a typo'd school name would silently
    // hide cases forever otherwise.
    const known = new Set(rt.repo.listSchools());
    const unknown = schools.filter((x) => !known.has(x));
    if (unknown.length) {
      return res.redirect(`/staff?msg=${encodeURIComponent(`Unknown school(s): ${unknown.join(", ")} — nothing saved.`)}#scopes`);
    }
    const restoreFull = String(req.body.scope_mode ?? "") === "unscoped";
    if (restoreFull) rt.repo.clearScopes(staffId);
    else rt.repo.setScopes(staffId, schools);
    rt.repo.audit(null, req.staff!.username, "scope_changed",
      `${member.username}: ${restoreFull ? "scope cleared (full visibility)" : schools.length ? schools.join(", ") : "no access"}`);
    res.redirect(`/staff?msg=${encodeURIComponent(restoreFull
      ? `${member.display_name}'s scope cleared — they see all schools again.`
      : schools.length
        ? `${member.display_name} now sees: ${schools.join(", ")}.`
        : `${member.display_name} now has no school access until an administrator assigns one.`)}#scopes`);
  });

  app.get("/staff", requireLogin, requireRole("admin"), (req, res) =>
    res.send(staffPage(rt.c(req), req.query.msg ? String(req.query.msg) : undefined))
  );

  // PPR P1-8: grant/revoke the four automation permissions per staff member.
  // H-3: only the acting organization's staff are read or granted.
  app.post("/staff/permissions", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    for (const st of rt.repo.listStaff(rt.organizationId(req))) {
      if (st.role === "admin") continue; // admins implicitly hold all four
      const grants: Permission[] = [];
      for (const p of PERMISSIONS) {
        if (String((req.body as Record<string, string>)[`perm_${st.id}_${p}`] ?? "") === "1") grants.push(p);
      }
      rt.repo.setPermissions(st.id, grants);
    }
    rt.repo.audit(null, req.staff!.username, "staff_permissions_saved", "automation permissions updated");
    res.redirect("/staff?msg=" + encodeURIComponent("Automation permissions saved."));
  });

  // H-2: the new account belongs to the ACTING admin's organization — never
  // a hard-coded tenant. Usernames stay globally unique (the column is
  // UNIQUE), so the clash check still looks across every tenant.
  app.post("/staff/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const username = normalizeUsername(String(req.body.username ?? ""));
    const password = String(req.body.password ?? "");
    const role = String(req.body.role) === "admin" ? "admin" : "user";
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!username) return res.redirect(staffMsg("Username is required."));
    if (!USERNAME_RE.test(username)) return res.redirect(staffMsg("Username may contain letters, digits, dots, dashes and underscores (2–32 chars)."));
    if (!password || password.length < 8) return res.redirect(staffMsg(`Password for “${username}” must be at least 8 characters.`));
    if (rt.repo.getStaffByUsername(username)) return res.redirect(staffMsg(`Username “${username}” is already taken.`));
    const orgId = rt.organizationId(req);
    rt.repo.createStaff(username, String(req.body.display_name ?? username), hashPassword(password), role, false, orgId);
    rt.repo.audit(null, req.staff!.username, "staff_created", `${username} (${role}) in organization ${orgId}`);
    res.redirect(staffMsg(`Staff account “${username}” created (${role}).`));
  });

  app.post("/staff/toggle", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const s = rt.repo.staffInOrganization(Number(req.body.id), rt.organizationId(req));
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    if (!s) return res.redirect("/staff");
    if (s.id === req.staff!.id) return res.redirect(staffMsg("You cannot disable your own account."));
    rt.repo.setStaffActive(s.id, s.active !== 1);
    rt.repo.audit(null, req.staff!.username, "staff_toggled", `${s.username} → ${s.active !== 1 ? "active" : "disabled"}`);
    res.redirect(staffMsg(`${s.display_name} is now ${s.active !== 1 ? "active" : "disabled"}.`));
  });

  app.post("/staff/password", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const staffMsg = (m: string) => `/staff?msg=${encodeURIComponent(m)}`;
    const password = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const target = rt.repo.staffInOrganization(id, rt.organizationId(req));
    if (!target) return res.redirect(staffMsg(`${UNKNOWN_STAFF_MEMBER}.`));
    // Same rules as first-run setup — one rulebook for every password write.
    if (password.length < 8) return res.redirect(staffMsg(`Password for “${target.username}” must be at least 8 characters.`));
    if (password !== confirm) return res.redirect(staffMsg(`The passwords do not match — nothing changed.`));
    rt.repo.setStaffPassword(id, hashPassword(password));
    // Session hygiene: an admin reset (stolen laptop, offboarding, suspected
    // compromise) must end the member's live sessions — the self-service
    // reset-code path already purges; this path has to agree with it.
    const ended = rt.repo.purgeStaffSessions(id);
    rt.repo.audit(null, req.staff!.username, "staff_password_reset", `user #${id}; ${ended} session(s) ended`);
    res.redirect(staffMsg(`Password reset for “${target.username}” — their open sessions were ended.`));
  });

  // Forgot password: issue a one-time code for a member. Deliberately a
  // 200 re-render, NOT a redirect — the code is shown exactly once, in the
  // response body, and must never appear in a URL (history/Referer).
  app.post("/staff/reset-code", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const target = rt.repo.staffInOrganization(Number(req.body.id), rt.organizationId(req));
    if (!target) return res.send(staffPage(rt.c(req), `${UNKNOWN_STAFF_MEMBER} — no code issued.`));
    const code = rt.repo.issueResetCode(target.id, req.staff!.username);
    rt.repo.audit(null, req.staff!.username, "password_reset_code_issued", `for ${target.username}`);
    res.send(staffPage(rt.c(req), `Reset code issued for “${target.username}”.`, code));
  });

  // Round 3 — per-course document checklists (checkboxes on the staff page).
  // Saving replaces the course's configured set; a course with no rows runs
  // on the generated matrix checklist. New applicants are checked against the
  // live list; cases that already froze a requirement snapshot keep theirs.
  app.post("/staff/course-docs", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    const programme = String(req.body.programme ?? "").trim().toUpperCase();
    if (!rt.repo.programmeByCode(programme)) return res.redirect(back("Unknown course — nothing changed."));
    const raw = req.body.docs;
    const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const valid = new Set<string>(DOC_TYPES);
    const types = all.map((x) => String(x)).filter((x) => valid.has(x) && x !== "unknown");
    rt.repo.saveCourseDocConfig(programme, types as DocType[]);
    rt.repo.audit(null, req.staff!.username, "course_docs_configured",
      `${programme}: ${types.join(", ") || "none"}`);
    res.redirect(back(`Required documents saved for ${programme}. New applicants are checked against this list; cases with a frozen requirement set keep theirs.`));
  });

  app.post("/staff/course-docs/reset", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Use+CaseTypes+for+this+organization");
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    const programme = String(req.body.programme ?? "").trim().toUpperCase();
    if (!rt.repo.programmeByCode(programme)) return res.redirect(back("Unknown course — nothing changed."));
    rt.repo.deleteCourseDocConfig(programme);
    rt.repo.audit(null, req.staff!.username, "course_docs_reset", `${programme}: back to the generated checklist`);
    res.redirect(back(`${programme} is back on the generated document checklist.`));
  });
}
