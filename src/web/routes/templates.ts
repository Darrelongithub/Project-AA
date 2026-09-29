/**
 * templates routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { templatesPage } from "../pages";
import { TEMPLATE_DEFAULTS } from "../../db/seed";
import { csrfCheck, requireLogin, requireRole } from "../auth";
import type { RouteCtx } from "./ctx";

export function registerTemplates(app: Express, rt: RouteCtx): void {
  // ── OR-7: Templates section — every outgoing type, one home ──────────────
  const tplBack = (key: string, m: string) =>
    `/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent(m)}#tpl-${key}`;
  const KNOWN_PLACEHOLDERS = [
    "{ref}", "{name}", "{first_name}", "{missing_docs}", "{missing_docs_section}",
    "{checklist}", "{status}", "{institution}", "{programme}", "{reg_date}",
    "{orientation_dates}", "{read_back}", "{document_issues}",
  ];
  const unknownPlaceholders = (text: string): string[] => {
    const found = text.match(/\{[a-z_]+\}/g) ?? [];
    return [...new Set(found.filter((p) => !KNOWN_PLACEHOLDERS.includes(p)))];
  };

  app.get("/templates", requireLogin, requireRole("admin"), (req, res) => {
    const key = String(req.query.template ?? "");
    const msg = req.query.msg ? String(req.query.msg) : undefined;
    res.send(templatesPage(rt.c(req), rt.repo.listTemplates(rt.organizationId(req)).some((t) => t.key === key) ? key : undefined, msg));
  });

  app.post("/templates/save", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    const existing = rt.repo.getTemplate(key, rt.organizationId(req), req.body.case_type_id ? Number(req.body.case_type_id) : undefined);
    if (!existing) return res.redirect(`/templates?msg=${encodeURIComponent("Unknown template — nothing saved.")}`);
    const name = String(req.body.name ?? "").trim();
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!name || !subject || !body) return res.redirect(tplBack(key, "Template needs a name, a subject and a body — nothing saved."));
    const packRaw = String(req.body.attach_pack ?? "none").trim() || "none";
    const caseTypeId = req.body.case_type_id !== undefined ? Number(req.body.case_type_id) || 0 : existing.case_type_id;
    try {
      // PPR P0-5 (E3 close): upsertTemplate validates the reference against
      // this organization's OWN attachment sets — unknown refs are refused.
      rt.repo.upsertTemplate(key, name, subject, body, req.body.include_banner !== undefined, packRaw, rt.organizationId(req), caseTypeId);
    } catch (e) {
      return res.redirect(tplBack(key, `Template not saved: ${(e as Error).message}`));
    }
    rt.repo.audit(null, req.staff!.username, "template_changed", `${key}${packRaw !== "none" ? ` (+${packRaw} set)` : ""}${caseTypeId ? ` [profile #${caseTypeId}]` : ""}`);
    const unknown = unknownPlaceholders(subject + " " + body);
    const warn = unknown.length
      ? ` ⚠ Unknown placeholder${unknown.length === 1 ? "" : "s"} left in the text: ${unknown.join(", ")} — it will reach applicants as literal text.`
      : "";
    res.redirect(tplBack(key, `Template “${name}” saved.${warn}`));
  });

  // PPR P0-6: templates are not a closed enum — a profile can create the
  // keys it needs. The key is a stable machine name (like a variable name).
  app.post("/templates/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const name = String(req.body.name ?? "").trim();
    const caseTypeId = Number(req.body.case_type_id ?? 0) || 0;
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(key) || !name) {
      return res.redirect(`/templates?msg=${encodeURIComponent("A template needs a machine key (letters, digits, underscores) and a display name.")}`);
    }
    if (rt.repo.getTemplate(key, rt.organizationId(req), caseTypeId || undefined)) {
      return res.redirect(`/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent("That key already exists for this organization — opening it instead.")}`);
    }
    try {
      rt.repo.upsertTemplate(key, name, `Subject for ${name}`, `Hello {name},\n\n\n\nKind regards,\n{institution}`, true, "none", rt.organizationId(req), caseTypeId);
    } catch (e) {
      return res.redirect(`/templates?msg=${encodeURIComponent(`Template not created: ${(e as Error).message}`)}`);
    }
    rt.repo.audit(null, req.staff!.username, "template_created", `${key}${caseTypeId ? ` [profile #${caseTypeId}]` : ""}`);
    res.redirect(`/templates?template=${encodeURIComponent(key)}&msg=${encodeURIComponent(`Template “${name}” created — its first version is its saved default.`)}`);
  });

  app.post("/templates/reset", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const key = String(req.body.key ?? "");
    // PPR P0-6: "Reset to default" restores the profile's OWN default —
    // the snapshot captured when the template was created — not a shared
    // global wording. Legacy rows without a snapshot fall back to the
    // migrated education profile's official defaults.
    const snap = rt.repo.templateDefaultSnapshot(key, rt.organizationId(req));
    const def = snap ?? TEMPLATE_DEFAULTS[key];
    if (!def) return res.redirect(`/templates?msg=${encodeURIComponent("No default exists for that template — nothing to reset.")}`);
    const existingRow = rt.repo.getTemplate(key, rt.organizationId(req));
    rt.repo.upsertTemplate(key, def.name, def.subject, def.body, Boolean(def.include_banner), def.attach_pack, rt.organizationId(req), existingRow?.case_type_id ?? 0);
    rt.repo.audit(null, req.staff!.username, "template_reset", `${key} → ${snap ? "profile default" : "shipped default"}`);
    res.redirect(tplBack(key, `“${def.name}” reset to ${snap ? "its own default" : "the official default"}.`));
  });
}
