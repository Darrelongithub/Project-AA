/**
 * config routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import express , { type Express, type Request } from "express";
import { Repo } from "../../db/repo";
import { type AdmissionSystem, type RuleField, ADMISSION_SYSTEMS } from "../../types";
import { autoAdmitPolicy, evaluateAdmission } from "../../admissions/evaluate";
import { type RuleAction, type RuleCondition, type WorkflowRule, describeRule, firstMatchingRule, ruleMatches, rulesForCaseScope } from "../../rules/workflow";
import { categorizeEmail } from "../../categorize";
import { configPage } from "../pages";
import { html, raw } from "../tpl";
import { UNKNOWN_STAFF_MEMBER, csrfCheck, requireLogin, requireRole } from "../auth";
import { PACK_DIR, PACK_SLOTS } from "../../pack";
import { EXAM_SYSTEMS } from "../../config";
import * as fs from "fs";
import * as path from "path";
import type { LegacyAcademicLevel } from "./ctx";
import type { RouteCtx } from "./ctx";

export function registerConfig(app: Express, rt: RouteCtx): void {
  /**
   * Round 19: after a rule change, re-run the evaluation across every OPEN
   * case in one click instead of opening them one by one. Cases keep the
   * requirement set they were frozen under — this simply re-applies it.
   */
  app.post("/config/reevaluate-open", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#rules`;
    const orgId = rt.organizationId(req);
    let done = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of rt.repo.openApplicantIds()) {
      const a = rt.repo.getApplicant(id);
      if (!a || !rt.sameRealm(req, a)) continue;
      // This bulk action re-runs the ACADEMIC engine: it is confined to the
      // acting org, and generic (CaseType) profiles are left to their own
      // rule trees — running degree requirements against an HR file
      // overwrote its flags with academic verdicts (the pipeline already
      // excludes non-education cases; this route did not).
      if ((a.organization_id ?? 1) !== orgId) { skipped++; continue; }
      if (!rt.repo.educationCaseFor(a)) { skipped++; continue; }
      try {
        const flags = rt.repo.activeFlags(id).filter((f) => f.type !== "duplicate_submission");
        const result = evaluateAdmission(rt.repo, id, flags, { autoAdmit: autoAdmitPolicy(rt.repo, id) });
        rt.repo.syncFlags(id, [...flags, ...result.derivedFlags]);
        rt.repo.audit(id, req.staff!.username, "evaluation_rerun", `bulk re-evaluation → ${result.report.result}/${result.report.routing}`);
        done++;
      } catch (e) {
        // One pathological case must not abort the whole batch.
        failed++;
        rt.repo.audit(id, req.staff!.username, "evaluation_rerun_failed", (e as Error).message.slice(0, 200));
      }
    }
    rt.repo.audit(null, req.staff!.username, "bulk_reevaluation", `${done} open case(s) re-evaluated${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped (other org or non-education)` : ""}`);
    res.redirect(back(
      `Re-evaluated ${done} open case(s) against their frozen rule sets.${failed ? ` ${failed} case(s) failed — see their audit trails.` : ""}${skipped ? ` ${skipped} case(s) skipped (other organization or generic profile).` : ""}`
    ));
  });

  // Dead-letter queue: retry puts a parked message back in front of the next
  // sync; drop removes it for good (the sender will have to email again).
  app.post("/config/dead-letter/retry", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#deadletters`;
    const d = rt.repo.getDeadLetter(Number(req.body.id ?? 0));
    if (!d) return res.redirect(back("That parked message no longer exists."));
    rt.repo.resetDeadLetter(d.id);
    rt.repo.unmarkProcessed(d.message_id);
    rt.repo.audit(null, req.staff!.username, "dead_letter_retry", `message ${d.message_id} ("${d.subject}") re-queued for ingestion`);
    res.redirect(back(`"${d.subject || d.message_id}" will be retried on the next sync.`));
  });

  app.post("/config/dead-letter/delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#deadletters`;
    const d = rt.repo.getDeadLetter(Number(req.body.id ?? 0));
    if (!d) return res.redirect(back("That parked message no longer exists."));
    rt.repo.removeDeadLetter(d.id);
    // "Removes it for good" must hold: a dropped letter that is still in
    // the mailbox would otherwise be re-ingested as new mail on the next
    // sync (it is not marked processed — poison fails before the claim —
    // and its dead row is gone, so neither skip gate fires) and re-parked
    // a few polls later. Bury it in processed_emails, which is keyed by
    // message id only; the thread was never captured for dead letters.
    rt.repo.markProcessed(d.message_id, "");
    rt.repo.audit(null, req.staff!.username, "dead_letter_dropped", `message ${d.message_id} ("${d.subject}") dropped by staff; buried so future syncs skip it`);
    res.redirect(back(`"${d.subject || d.message_id}" was dropped.`));
  });

  // Configuration: requirements, replies, Gmail, intakes, templates, exports.
  // Case configuration moved to the STAFF area (round 3) — one home for
  // it; the old tab redirects so bookmarks keep working.
  app.get("/config", requireLogin, requireRole("admin"), (req, res) => {
    if (req.query.tab === "courses") return res.redirect("/staff");
    if (req.query.tab === "requirements" && (req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types");
    return res.send(
      configPage(
        rt.c(req),
        req.query.template ? String(req.query.template) : undefined,
        req.query.msg ? String(req.query.msg) : undefined,
        req.query.reqs ? String(req.query.reqs) : undefined,
        req.query.tab ? String(req.query.tab) : undefined,
        req.query.system ? String(req.query.system) : undefined,
        req.query.organization ? Number(req.query.organization) : undefined,
        req.query.edit ? Number(req.query.edit) : undefined
      ));
  });

  // Generic CaseType administration. Installation-owner admins (the same
  // accounts that may /org/switch) manage every organization's catalogue
  // through the tab's org picker; tenant admins are confined to their own
  // organization — a forged organization_id outside it is refused.
  const caseTypesTargetOk = (req: Request, organizationId: number): boolean =>
    req.staff!.can_switch_org === true || organizationId === rt.organizationId(req);
  const caseTypesRefused = (organizationId: number): string =>
    `/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("That organization is outside your administration scope — nothing was changed.")}`;

  // Generic CaseType administration. These routes are organization-scoped;
  // no academic catalogue or global settings are touched.
  app.post("/config/organizations/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    // Only installation-owner admins may mint organizations; a tenant admin
    // creating orgs they cannot see would strand half-configured tenants.
    if (req.staff!.can_switch_org !== true) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("Only an installation administrator can create organizations.")}`);
    const name = String(req.body.name ?? "").trim();
    const refPrefix = String(req.body.ref_prefix ?? "").trim().toUpperCase();
    if (!name || !/^[A-Z]{1,8}$/.test(refPrefix)) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("Organization name and a 1–8 letter reference prefix are required.")}`);
    try {
      const organization = rt.repo.createOrganization({ name, refPrefix });
      rt.repo.audit(null, req.staff!.username, "organization_created", `${organization.name} (${organization.ref_prefix})`);
      return res.redirect(`/config?tab=case-types&organization=${organization.id}&msg=${encodeURIComponent(`Organization ${organization.name} created with an empty CaseType catalogue.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent(`Organization was not created: ${(e as Error).message}`)}`);
    }
  });

  // PPR P0-4: workflow rules — first-email and response behaviour as data.
  const parseRuleConditions = (body: Record<string, unknown>): RuleCondition[] => {
    const raw = String(body.conditions_json ?? "").trim();
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("conditions JSON must be an array");
      return parsed as RuleCondition[];
    }
    const out: RuleCondition[] = [];
    for (let i = 0; i < 3; i++) {
      const field = String((body as Record<string, string>)[`cond_field_${i}`] ?? "").trim();
      const value = String((body as Record<string, string>)[`cond_value_${i}`] ?? "").trim();
      if (!field) continue;
      if (field === "always") out.push({ field: "always", value: true });
      else if (field === "sender_state") out.push({ field: "sender_state", value: value.toLowerCase() === "known" ? "known" : "unknown" });
      else if (field === "has_attachments") out.push({ field: "has_attachments", value: ["yes", "true", "1"].includes(value.toLowerCase()) });
      else if (field === "body_is_ref") out.push({ field: "body_is_ref", value: true });
      else if (field === "signals") out.push({ field: "signals", value: "education_intake" });
      else if (field === "category") out.push({ field: "category", op: "in", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
      else if (field === "docs_state") {
        const values = value.split(",").map((s) => s.trim()).filter(Boolean);
        out.push({ field: "docs_state", values: (values.length ? values : ["any"]) as never });
      } else if (field === "text" || field === "subject" || field === "body") {
        out.push({ field, op: "contains_any", values: value.split(",").map((s) => s.trim()).filter(Boolean) });
      } else throw new Error(`unknown condition field '${field}'`);
    }
    return out;
  };
  const parseRuleAction = (body: Record<string, unknown>): RuleAction => {
    const b = body as Record<string, string>;
    const map = {
      green: b.map_green?.trim() || undefined,
      empty: b.map_empty?.trim() || undefined,
      missing: b.map_missing?.trim() || undefined,
    };
    const hasMap = Boolean(map.green || map.empty || map.missing);
    return {
      decision: (b.decision as RuleAction["decision"]) || undefined,
      stage: b.stage?.trim() || undefined,
      queue: b.queue?.trim() || undefined,
      priority: b.priority === "high" ? "high" : undefined,
      assign: b.assign ? Number(b.assign) : undefined,
      reply_action: (b.reply_action as RuleAction["reply_action"]) || undefined,
      template_key: b.template_key?.trim() || null,
      template_map: hasMap ? map : null,
      attachment_set: b.attachment_set?.trim() || null,
      request_info: Boolean(b.request_info),
      sla_hours: b.sla_hours ? Number(b.sla_hours) : null,
      followup: b.followup === "ladder" ? "ladder" : "none",
      followup_action: (b.followup_action as RuleAction["followup_action"]) || undefined,
      audit_code: b.audit_code?.trim() || undefined,
      fallback: b.fallback === "none" ? "none" : "human_draft",
    };
  };

  app.post("/config/workflow-rules/save", requireLogin, rt.requirePermission("publish_rules"), csrfCheck, (req, res) => {
    try {
      const name = String(req.body.name ?? "").trim();
      const kind = String(req.body.kind) === "response" ? "response" : "intake";
      const caseTypeId = req.body.case_type_id ? Number(req.body.case_type_id) : null;
      // A rule lives in its profile's organization; legacy-scope rules live in
      // the staff member's organization.
      const orgId = (caseTypeId ? rt.repo.caseTypeById(caseTypeId)?.organization_id : undefined) ?? req.staff!.organization_id ?? 1;
      // H-3 (rules): a hand-crafted POST cannot hang rules on another
      // tenant's profile — the acting admin only rules their own org.
      if (orgId !== (req.staff!.organization_id ?? 1)) {
        return res.redirect(`/config?tab=rules&msg=${encodeURIComponent("That CaseType belongs to another organization — rule not saved.")}`);
      }
      const conditions = parseRuleConditions(req.body);
      const action = parseRuleAction(req.body);
      const saved = rt.repo.saveWorkflowRule({
        id: req.body.id ? Number(req.body.id) : undefined,
        organizationId: orgId,
        caseTypeId,
        kind,
        name,
        position: req.body.position !== "" && req.body.position !== undefined ? Number(req.body.position) : undefined,
        enabled: true,
        conditions,
        action,
      });
      rt.repo.audit(null, req.staff!.username, "workflow_rule_saved", `${saved.name} (#${saved.id}, ${kind})`);
      return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Rule “${saved.name}” saved and enabled.`)}`);
    } catch (e) {
      return res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Rule was not saved: ${(e as Error).message}`)}`);
    }
  });

  // PPR P1-7: preview a sample email against the rule AS DRAFTED (form fields,
  // published or not) before anyone presses save. Nothing is written — the
  // response describes what would fire and who would win the order.
  app.post("/config/workflow-rules/preview", requireLogin, rt.requirePermission("publish_rules"), csrfCheck, (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const name = String(body.name ?? "").trim() || "(unsaved rule)";
      const kind = String(body.kind) === "response" ? "response" : "intake";
      const caseTypeId = body.case_type_id ? Number(body.case_type_id) : null;
      const orgId = (caseTypeId ? rt.repo.caseTypeById(caseTypeId)?.organization_id : undefined) ?? req.staff!.organization_id ?? 1;
      const proposed: WorkflowRule = {
        id: 0,
        organization_id: orgId,
        case_type_id: caseTypeId,
        kind,
        name,
        position: body.position !== "" && body.position !== undefined ? Number(body.position) : 9999,
        enabled: 1,
        conditions: parseRuleConditions(body),
        action: parseRuleAction(body),
      };
      // The sample message, as an applicant would send it.
      const sampleSubject = String(body.sample_subject ?? "").slice(0, 500);
      const sampleBody = String(body.sample_body ?? "").slice(0, 4000);
      const sampleFrom = String(body.sample_from ?? "").slice(0, 200);
      const docsState = (["complete", "empty", "missing", "dirty"] as const).includes(body.sample_docs_state as never)
        ? body.sample_docs_state as "complete" | "empty" | "missing" | "dirty"
        : "missing";
      const input = {
        senderState: body.sample_sender_state === "known" ? "known" as const : "unknown" as const,
        subject: sampleSubject,
        body: sampleBody,
        hasAttachments: body.sample_attachments === "1",
        category: categorizeEmail(sampleSubject, sampleBody, body.sample_attachments === "1"),
        bodyIsRef: /^[A-Z]{1,6}-\d{4}-\d{1,8}$/i.test(sampleBody.trim()),
        educationSignals: "open" as const,
        docsState,
        docsOnFile: docsState === "empty" ? 0 : 3,
      };
      // Who else is in the running: the scope's published rules plus this one.
      const scopeRules = rulesForCaseScope(
        rt.repo.listWorkflowRules(orgId, { kind }), caseTypeId, caseTypeId === null,
      );
      const ordered = [...scopeRules, proposed].sort((a, b) => a.position - b.position || a.id - b.id);
      const winner = firstMatchingRule(ordered, input);
      const proposedMatches = ruleMatches(proposed, input);
      const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
      let verdict: string;
      if (winner && winner.id === 0 && proposedMatches) {
        verdict = html`<b>MATCH</b> — this rule would fire for that message: ${raw(esc(describeRule(proposed)))}`;
      } else if (winner && proposedMatches) {
        verdict = html`<b>MATCH, but an earlier rule wins</b> — “${raw(esc(winner.name))}” fires first (${raw(esc(describeRule(winner)))}). Raise this rule's position to take over.`;
      } else if (winner) {
        verdict = html`<b>NO MATCH</b> — this rule would not fire; “${raw(esc(winner.name))}” would handle the message instead (${raw(esc(describeRule(winner)))}).`;
      } else {
        verdict = html`<b>NO MATCH</b> — no rule in this scope would fire; the message routes to human review (nothing is ever dropped).`;
      }
      const details = html`<div class="small muted" style="margin-top:6px">Sample from ${raw(esc(sampleFrom || "(no sender)"))}: category <span class="mono">${raw(esc(input.category))}</span> · docs ${docsState} · sender ${input.senderState} · ${scopeRules.length} published rule(s) in scope.</div>`;
      res.type("html").send(html`<div class="small">${raw(verdict)}</div>${raw(details)}`);
    } catch (e) {
      res.status(400).type("html").send(html`<div class="small">Preview failed: ${raw(String((e as Error).message).replace(/[&<>"]/g, ""))}</div>`);
    }
  });

  app.post("/config/workflow-rules/delete", requireLogin, rt.requirePermission("publish_rules"), csrfCheck, (req, res) => {
    rt.repo.deleteWorkflowRule(Number(req.body.id), req.staff!.organization_id ?? 1);
    rt.repo.audit(null, req.staff!.username, "workflow_rule_deleted", `rule #${Number(req.body.id)}`);
    res.redirect("/config?tab=rules");
  });

  app.post("/config/workflow-rules/toggle", requireLogin, rt.requirePermission("publish_rules"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const rule = rt.repo.getWorkflowRule(id);
    // H-3 (rules): toggle only the acting organization's rules — the delete
    // route is already scoped; this route must agree with it.
    if (rule && rule.organization_id !== (req.staff!.organization_id ?? 1)) return res.redirect("/config?tab=rules");
    if (rule) {
      rt.repo.saveWorkflowRule({
        id,
        organizationId: rule.organization_id,
        caseTypeId: rule.case_type_id,
        kind: rule.kind,
        name: rule.name,
        position: rule.position,
        enabled: rule.enabled !== 1,
        conditions: rule.conditions,
        action: rule.action,
      });
      rt.repo.audit(null, req.staff!.username, "workflow_rule_toggled", `${rule.name} (#${id}) → ${rule.enabled !== 1 ? "on" : "off"}`);
    }
    res.redirect("/config?tab=rules");
  });

  app.post("/config/case-types/vocabulary", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const ct = rt.repo.listCaseTypes(req.staff!.organization_id ?? 1).find((x) => x.id === id)
      ?? (req.staff!.can_switch_org === true ? rt.repo.caseTypeById(id) : undefined);
    if (!ct) return res.redirect(`/config?tab=rules&msg=${encodeURIComponent("Unknown profile.")}`);
    const parseIdLabels = (text: string): Array<{ id: string; label: string; requires?: string[] }> =>
      String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [rawId, rawLabel, rawRequires] = line.split("|");
        const id = rawId.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const label = (rawLabel ?? rawId).trim();
        // P1-4: a stage line may declare required information — "stage|label|
        // item1, item2" (document keys or free-text info the file must hold).
        const requires = rawRequires ? rawRequires.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        return requires && requires.length ? { id, label, requires } : { id, label };
      }).filter((x) => x.id);
    const b = req.body as Record<string, string>;
    rt.repo.updateCaseTypeVocabulary(id, {
      terminology: {
        case: b.term_case?.trim() || "Applicant",
        contact: b.term_contact?.trim() || "Contact",
        category: b.term_category?.trim() || "Category",
        stage: b.term_stage?.trim() || "Current level",
        outcome: b.term_outcome?.trim() || "Admission decision",
      },
      stages: parseIdLabels(b.stages_text ?? ""),
      queues: parseIdLabels(b.queues_text ?? ""),
    });
    rt.repo.audit(null, req.staff!.username, "workflow_vocabulary_saved", `${ct.code}: terminology + stages + queues`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Vocabulary, stages and queues saved for “${ct.name}”.`)}`);
  });

  app.post("/config/case-types/profile", requireLogin, rt.requirePermission("send_automated"), csrfCheck, (req, res) => {
    const id = Number(req.body.id);
    const ct = rt.repo.listCaseTypes(req.staff!.organization_id ?? 1).find((x) => x.id === id);
    if (!ct) return res.redirect("/config?tab=rules&msg=Unknown+profile");
    rt.repo.updateCaseTypeProfile(id, {
      default_reply_action: String(req.body.default_reply_action) === "auto" ? "auto" : "draft",
      qualification_gate: String(req.body.qualification_gate) === "0" ? 0 : 1,
    });
    rt.repo.audit(null, req.staff!.username, "workflow_profile_saved", `${ct.code}: default_reply_action=${String(req.body.default_reply_action)}, qualification_gate=${String(req.body.qualification_gate)}`);
    res.redirect(`/config?tab=rules&msg=${encodeURIComponent(`Profile “${ct.name}” updated.`)}`);
  });

  app.post("/config/case-types/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!caseTypesTargetOk(req, organizationId)) return res.redirect(caseTypesRefused(organizationId));
    const code = String(req.body.code ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const category = String(req.body.category ?? "general").trim() || "general";
    if (!rt.repo.getOrganization(organizationId) || !code || !name) return res.redirect(`/config?tab=case-types&msg=${encodeURIComponent("A valid organization, CaseType code and name are required.")}`);
    const ct = rt.repo.createCaseType(organizationId, { code, name, category, config: { rules: [] } });
    rt.repo.audit(null, req.staff!.username, "case_type_created", `${organizationId}:${ct.code}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${ct.id}`);
  });

  app.post("/config/case-types/document", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!caseTypesTargetOk(req, organizationId)) return res.redirect(caseTypesRefused(organizationId));
    const caseTypeId = Number(req.body.case_type_id);
    const ct = rt.repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    const key = String(req.body.key ?? "").trim();
    const label = String(req.body.label ?? "").trim();
    if (!ct || !key || !label) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType or incomplete document slot.")}`);
    rt.repo.upsertDocumentDefinition(caseTypeId, { key, label, required: String(req.body.required) !== "0", blocking: String(req.body.blocking) !== "0", position: Number(req.body.position ?? 0) || 0 });
    rt.repo.audit(null, req.staff!.username, "case_type_document_saved", `${ct.code}:${key}`);
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/document-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!caseTypesTargetOk(req, organizationId)) return res.redirect(caseTypesRefused(organizationId));
    const caseTypeId = Number(req.body.case_type_id);
    const ct = rt.repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (ct) rt.repo.deleteDocumentDefinition(caseTypeId, String(req.body.key ?? ""));
    res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
  });

  app.post("/config/case-types/rules", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!caseTypesTargetOk(req, organizationId)) return res.redirect(caseTypesRefused(organizationId));
    const caseTypeId = Number(req.body.case_type_id);
    const ct = rt.repo.listCaseTypes(organizationId).find((x) => x.id === caseTypeId);
    if (!ct) return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent("Unknown CaseType — no rules saved.")}`);
    try {
      const parsed: unknown = JSON.parse(String(req.body.rules_json ?? "[]"));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("rule tree must be an array of at most 100 nodes");
      const valid = (n: any): boolean => n && (n.kind === "condition" || n.kind === "group") && (!n.children || (Array.isArray(n.children) && n.children.every(valid))) && (n.kind !== "group" || ["AND", "OR", "NOT"].includes(n.logic ?? "AND"));
      if (!parsed.every(valid)) throw new Error("invalid rule node or group logic");
      rt.repo.updateCaseTypeRules(caseTypeId, parsed as any[]);
      rt.repo.audit(null, req.staff!.username, "case_type_rules_saved", `${ct.code}: ${parsed.length} top-level nodes`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}#case-type-${caseTypeId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Rule tree was not saved: ${(e as Error).message}`)}#case-type-${caseTypeId}`);
    }
  });

  app.post("/config/case-types/axes", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const organizationId = Number(req.body.organization_id);
    if (!caseTypesTargetOk(req, organizationId)) return res.redirect(caseTypesRefused(organizationId));
    if (!rt.repo.getOrganization(organizationId)) return res.redirect("/config?tab=case-types&msg=Unknown+organization");
    try {
      const parsed: unknown = JSON.parse(String(req.body.axes_json ?? "[]"));
      if (!Array.isArray(parsed) || parsed.length > 50 || parsed.some((x: any) => !x || typeof x.key !== "string" || typeof x.label !== "string" || !Array.isArray(x.values))) throw new Error("axes must be [{key,label,values:[]}]");
      rt.repo.replaceOrganizationDocumentAxes(organizationId, parsed as Array<{ key: string; label: string; values: string[] }>);
      rt.repo.audit(null, req.staff!.username, "organization_axes_saved", `${organizationId}: ${parsed.length} axes`);
      return res.redirect(`/config?tab=case-types&organization=${organizationId}`);
    } catch (e) {
      return res.redirect(`/config?tab=case-types&organization=${organizationId}&msg=${encodeURIComponent(`Axes were not saved: ${(e as Error).message}`)}`);
    }
  });

  // Assign who handles a course (configured in the staff area).
  app.post("/config/course-owner", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Academic+compatibility+routes+are+Organization+1+only");
    const programme = String(req.body.programme ?? "").trim();
    const ownerRaw = String(req.body.owner ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#courses`;
    if (!programme) return res.redirect(back("No course selected."));
    const ownerId = ownerRaw ? Number(ownerRaw) : null;
    if (ownerId !== null && (!Number.isInteger(ownerId) || !rt.repo.getStaff(ownerId))) {
      return res.redirect(back(`${UNKNOWN_STAFF_MEMBER}.`));
    }
    rt.repo.assignProgrammeOwner(programme, ownerId);
    const who = ownerId !== null ? rt.repo.getStaff(ownerId)?.display_name ?? `#${ownerId}` : "nobody (unassigned)";
    rt.repo.audit(null, req.staff!.username, "course_owner_changed", `${programme} → ${who}`);

    // Round 19: an owner change should not leave open, unowned cases behind.
    // Cases a human already picked up are never re-routed automatically.
    let routed = 0;
    if (ownerId !== null) {
      const realm: 0 | 1 = req.staff!.demo ? 1 : 0;
      for (const c of rt.repo.openUnassignedCasesForProgramme(programme, realm)) {
        rt.repo.updateApplicant(c.id, { assigned_to: ownerId });
        rt.repo.audit(c.id, req.staff!.username, "case_routed", `assigned to ${who} — new owner of ${programme}`);
        rt.repo.notify("assignment", `${programme} ownership changed: case ${c.ref_number} routed to you`, c.id, ownerId);
        routed++;
      }
    }
    res.redirect(back(`Case ${programme} now handled by ${who}.${routed ? ` ${routed} open case(s) routed over.` : ""}`));
  });

  // Editable course fields: entry requirements (and name/school) change over
  // time — they are data, not code. New applicants are judged by the rules in
  // force when THEY applied (requirement snapshots); edits affect new cases.
  app.post("/config/programme/edit", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    if ((req.staff!.organization_id ?? 1) !== 1) return res.redirect("/config?tab=case-types&msg=Academic+compatibility+routes+are+Organization+1+only");
    const programme = String(req.body.programme ?? "").trim();
    const back = (m: string) => `/config?msg=${encodeURIComponent(m)}#courses`;
    if (!programme || !rt.repo.programmeByCode(programme)) return res.redirect(back("Unknown course."));
    rt.repo.updateProgramme(programme, {
      name: String(req.body.name ?? ""),
      school: String(req.body.school ?? ""),
      entry_requirements: String(req.body.entry_requirements ?? ""),
    });
    rt.repo.audit(null, req.staff!.username, "programme_updated", `${programme}: catalogue fields edited`);
    res.redirect(back(`Case ${programme} saved.`));
  });

  // Structured entry requirements — one qualification-system block per save.
  // OR-6: the legacy per-system block editor wrote to course_requirements,
  // a table the engine does NOT enforce — editing it would change what staff
  // see without changing what applicants are judged by (display ≠ enforce).
  // It is gone; the structured Requirements tab is the single source. A stale
  // POST gets an explicit refusal, never a silent write.
  app.post("/config/entry-requirements", requireLogin, requireRole("admin"), csrfCheck, (_req, res) => {
    res.redirect("/config?tab=requirements&msg=" + encodeURIComponent("Entry requirements are edited in the Requirements tab — that old form no longer saves anything."));
  });

  // ══ Requirements Configuration (round 18) ════════════════════════════════
  // Machine-evaluable rule trees per (programme × qualification system),
  // edited visually — no code, no raw expressions. Draft → preview → activate.

  // OR-6: grade values are picked from ladders, never typed freehand. This
  // server-side check mirrors exactly what the pickers offer, so the value
  // that gets stored is always one the UI could have displayed.
  const GRADE_FIELDS = new Set(["mean_grade", "subject"]);
  const NUMERIC_FIELDS: Record<string, { int: boolean; min: number; max: number; what: string }> = {
    credits: { int: true, min: 0, max: 99, what: "credit count" },
    principals: { int: true, min: 0, max: 9, what: "principal-pass count" },
    subsidiaries: { int: true, min: 0, max: 9, what: "subsidiary-pass count" },
    points: { int: true, min: 0, max: 45, what: "point total" },
    gpa: { int: false, min: 0, max: 4, what: "GPA" },
  };
  const CLASS_LADDERS: Record<string, string[]> = {
    degree: ["Pass", "Second Class Honours (Lower Division)", "Second Class Honours (Upper Division)", "First Class Honours"],
    diploma: ["Pass", "Credit", "Distinction"],
  };
  const validConditionValue = (
    system: AdmissionSystem,
    level: LegacyAcademicLevel,
    field: string | undefined,
    v: string
  ): { ok: true } | { ok: false; msg: string } => {
    if (!field) return { ok: true };
    if (field === "class") {
      const ladder = CLASS_LADDERS[level === "diploma" || level === "certificate" ? "diploma" : "degree"];
      return ladder.includes(v) ? { ok: true } : { ok: false, msg: `"${v}" is not a degree class on the ${level} ladder — pick one from the list.` };
    }
    if (GRADE_FIELDS.has(field)) {
      const ladder = EXAM_SYSTEMS.find((m) => m.system === system)?.gradeOptions ?? null;
      if (!ladder) return { ok: true }; // system has no grade ladder (e.g. DEGREE) — class/numbers apply
      return ladder.includes(v) ? { ok: true } : { ok: false, msg: `"${v}" is not a ${system} grade — pick one from the ladder.` };
    }
    const num = NUMERIC_FIELDS[field];
    if (num) {
      const n = Number(v);
      if (!Number.isFinite(n) || (num.int && !Number.isInteger(n)) || n < num.min || n > num.max) {
        return { ok: false, msg: `The ${num.what} must be ${num.int ? "a whole number" : "a number"} between ${num.min} and ${num.max}.` };
      }
      return { ok: true };
    }
    return { ok: true };
  };

  /** Parse a `reqs` target ("BASE:degree" | programme code) + system. */
  const reqsTarget = (req: Request): { programme: string | null; level: LegacyAcademicLevel; system: AdmissionSystem; back: (m: string) => string } | null => {
    const target = String(req.body.target ?? req.query.target ?? "").trim();
    const system = String(req.body.system ?? req.query.system ?? "").trim() as AdmissionSystem;
    const isBase = target.startsWith("BASE:");
    const level = (isBase ? target.slice(5) : rt.repo.programmeByCode(target)?.level ?? "degree") as LegacyAcademicLevel;
    const programme = isBase ? null : target.toUpperCase();
    const back = (m: string) =>
      `/config?tab=requirements&msg=${encodeURIComponent(m)}&reqs=${encodeURIComponent(target)}&system=${encodeURIComponent(system)}#reqbuilder`;
    if (!ADMISSION_SYSTEMS.includes(system)) return null;
    // OR-6: Master's and PhD are separate levels. A stale "postgrad" form
    // repost is normalised to masters instead of being dropped silently.
    const normalized: LegacyAcademicLevel = (level === ("postgrad" as LegacyAcademicLevel) ? "masters" : level) as LegacyAcademicLevel;
    if (!["degree", "diploma", "certificate", "masters", "phd"].includes(normalized)) return null;
    if (!isBase && !rt.repo.programmeByCode(programme!)) return null;
    return { programme, level: normalized, system, back };
  };

  // The academic-compat surface (rule trees, subject catalogue, schools)
  // is Organization 1's domain — the GET tab already redirects other orgs
  // away, and these POSTs must refuse them too. Same rule as course-owner.
  const org1Only = (req: Request): string | null =>
    (req.staff!.organization_id ?? 1) !== 1
      ? "/config?tab=case-types&msg=Academic+compatibility+routes+are+Organization+1+only"
      : null;

  app.post("/config/requirements/node-add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const set = rt.repo.ensureDraftSet(t.programme, t.level, t.system, req.staff!.username);
    const kind = String(req.body.kind) === "group" ? "group" : "condition";
    const parentId = req.body.parent ? Number(req.body.parent) : null;
    rt.repo.addRuleNode(set.id, parentId && parentId > 0 ? parentId : null, kind, "AND");
    rt.repo.audit(null, req.staff!.username, "requirements_draft_changed", `${t.programme ?? "base"} ${t.system}: ${kind} added (draft v${set.version})`);
    res.redirect(t.back(kind === "group" ? "Group added — set its AND/OR/NOT and conditions." : "Condition added — pick the field and minimum."));
  });

  app.post("/config/requirements/node-save", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const nodeId = Number(req.body.node);
    const logicRaw = String(req.body.logic ?? "");
    const patch: Parameters<Repo["updateRuleNode"]>[1] = {};
    if (["AND", "OR", "NOT"].includes(logicRaw)) patch.logic = logicRaw as "AND" | "OR" | "NOT";
    if (typeof req.body.field === "string" && req.body.field) patch.field = req.body.field as RuleField;
    if (typeof req.body.subject === "string") patch.subject = req.body.subject.trim() || null;
    if (typeof req.body.value === "string") {
      const v = req.body.value.trim();
      // OR-6: values must come from the picker ladders the UI offers — a
      // hand-typed grade outside the ladder would display one thing and
      // enforce another. Reject loudly instead of storing junk.
      const field = (typeof req.body.field === "string" && req.body.field ? req.body.field : undefined) ?? undefined;
      if (v) {
        const verdict = validConditionValue(t.system, t.level, field, v);
        if (!verdict.ok) return res.redirect(t.back(verdict.msg));
      }
      patch.value = v || null;
    }
    if (Object.keys(patch).length === 0) return res.redirect(t.back("Nothing to save."));
    // The node id comes from the form body — verify it belongs to THIS
    // target's DRAFT set before writing. Without this, a tampered or stale
    // `node=` reached ACTIVE and other courses' published rule sets, bypass-
    // ing the draft → activate versioning flow.
    if (!rt.repo.updateRuleNodeIfDraft(nodeId, t.programme, t.level, t.system, patch)) {
      return res.redirect(t.back("That rule does not belong to this course's draft — nothing was changed."));
    }
    res.redirect(t.back("Rule updated in the draft — preview it, then activate."));
  });

  app.post("/config/requirements/node-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const nodeId = Number(req.body.node);
    // Same ownership check as node-save: the body's node id may be stale or
    // hostile — only the target's own DRAFT set is deletable.
    if (!rt.repo.deleteRuleNodeIfDraft(nodeId, t.programme, t.level, t.system)) {
      return res.redirect(t.back("That rule does not belong to this course's draft — nothing was changed."));
    }
    res.redirect(t.back("Rule removed from the draft."));
  });

  app.post("/config/requirements/activate", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const draft = rt.repo.getDraftSet(t.programme, t.level, t.system);
    if (!draft) return res.redirect(t.back("No draft to activate."));
    if ((rt.repo.getRuleSetNodes(draft.id)).length === 0) {
      return res.redirect(t.back("The draft has no rules — add at least one condition before activating."));
    }
    const activated = rt.repo.activateDraftSet(draft.id)!;
    rt.repo.audit(null, req.staff!.username, "requirements_activated",
      `${t.programme ?? `${t.level} (university-wide)`} · ${t.system} · requirement set v${activated.version} activated`);
    res.redirect(t.back(`Requirement set v${activated.version} is now ACTIVE for ${t.programme ?? `all ${t.level} programmes`} (${t.system}). New evaluations use it; historical cases keep their frozen version.`));
  });

  app.post("/config/requirements/discard", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const t = reqsTarget(req);
    if (!t) return res.redirect("/config?tab=requirements");
    const draft = rt.repo.getDraftSet(t.programme, t.level, t.system);
    if (draft) rt.repo.discardDraftSet(draft.id);
    res.redirect(t.back("Draft discarded — the active requirement set is unchanged."));
  });

  app.post("/config/requirements/catalogue-add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const system = String(req.body.system ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#catalogue`;
    if (!ADMISSION_SYSTEMS.includes(system as AdmissionSystem)) return res.redirect(back("Unknown qualification system."));
    if (!name) return res.redirect(back("Subject name was empty."));
    // OR-6: duplicates are refused explicitly — never swallowed by INSERT OR IGNORE.
    if (!rt.repo.addCatalogueSubject(system, name)) {
      return res.redirect(back(`"${name}" is already in the ${system} catalogue — nothing added.`));
    }
    rt.repo.audit(null, req.staff!.username, "catalogue_changed", `${system}: subject "${name}" added`);
    res.redirect(back(`Subject "${name}" added to the ${system} catalogue.`));
  });

  app.post("/config/requirements/catalogue-rename", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const id = Number(req.body.id);
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/config?tab=requirements&msg=${encodeURIComponent(m)}#catalogue`;
    const row = rt.repo.listSubjectCatalogue().find((r) => r.id === id);
    if (!row) return res.redirect(back("Unknown subject — nothing renamed."));
    if (!name) return res.redirect(back("Subject name was empty."));
    if (!rt.repo.renameCatalogueSubject(id, name)) {
      return res.redirect(back(`"${name}" already exists in the ${row.system} catalogue — nothing renamed.`));
    }
    rt.repo.audit(null, req.staff!.username, "catalogue_changed", `${row.system}: "${row.name}" renamed to "${name}"`);
    res.redirect(back(`Subject renamed to "${name}".`));
  });

  // OR-6: schools & courses live on ONE page — schools are first-class so a
  // faculty exists before its first course and renames cascade to courses.
  app.post("/config/schools/add", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const name = String(req.body.name ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#schools`;
    if (!name) return res.redirect(back("School name was empty — nothing added."));
    if (!rt.repo.addSchool(name)) return res.redirect(back(`"${name}" already exists — nothing added.`));
    rt.repo.audit(null, req.staff!.username, "school_changed", `school "${name}" added`);
    res.redirect(back(`School "${name}" added — assign courses to it below.`));
  });

  app.post("/config/schools/rename", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const from = String(req.body.from ?? "").trim();
    const to = String(req.body.to ?? "").trim();
    const back = (m: string) => `/staff?msg=${encodeURIComponent(m)}#schools`;
    if (!from || !to) return res.redirect(back("Rename needs a current name and a new name."));
    if (from === to) return res.redirect(back("The new name is the same as the old one — nothing changed."));
    const moved = rt.repo.renameSchool(from, to);
    if (moved < 0) return res.redirect(back(`"${to}" already exists — nothing renamed.`));
    rt.repo.audit(null, req.staff!.username, "school_changed", `school "${from}" renamed to "${to}" (${moved} course(s) moved)`);
    res.redirect(back(`"${from}" renamed to "${to}" — ${moved} course(s) moved with it.`));
  });

  app.post("/config/requirements/catalogue-toggle", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const refused = org1Only(req);
    if (refused) return res.redirect(refused);
    const id = Number(req.body.id);
    const row = rt.repo.listSubjectCatalogue().find((r) => r.id === id);
    if (row) {
      rt.repo.setCatalogueActive(id, row.active !== 1);
      rt.repo.audit(null, req.staff!.username, "catalogue_changed", `${row.system}: "${row.name}" ${row.active !== 1 ? "restored" : "retired"}`);
    }
    res.redirect(`/config?tab=requirements#catalogue`);
  });

  // PPR P0-5: attachment sets — organization-owned groups of sendable files.
  app.post("/config/attachment-sets/create", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const name = String(req.body.name ?? "").trim();
    // H-3 consistency: the Document-library tab is own-org only (no picker,
    // uploads are org-checked) — sets are always created in the ACTING
    // admin's organization, whatever a hand-crafted form claims.
    const orgId = rt.organizationId(req);
    if (!name) return res.redirect(`/config?tab=pack&msg=${encodeURIComponent("A set needs a name.")}`);
    try {
      const set = rt.repo.createAttachmentSet(orgId, name, String(req.body.description ?? ""));
      rt.repo.audit(null, req.staff!.username, "attachment_set_created", `${set.name} (#${set.id}, org ${orgId})`);
      res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set “${set.name}” created — upload its PDFs below.`)}#aset-${set.id}`);
    } catch (e) {
      res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set was not created: ${(e as Error).message}`)}`);
    }
  });

  app.post("/config/attachment-sets/upload",
    requireLogin, requireRole("admin"), csrfCheck,
    express.raw({ type: "application/pdf", limit: "12mb" }),
    (req, res) => {
      const set = rt.repo.getAttachmentSet(Number(req.query.set));
      // H-3 (pack channel): the set must belong to the ACTING admin's
      // organization — a foreign set id is indistinguishable from an unknown
      // one, so nobody can drop files into another tenant's outgoing mail.
      if (!set || set.organization_id !== rt.organizationId(req)) return res.status(400).send("Unknown attachment set.");
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 512 || body.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(400).send("Not a PDF.");
      }
      // The filename arrives as a query parameter (raw-body upload).
      const rawName = String(req.query.filename ?? "").trim();
      const filename = rawName.replace(/[/\\]/g, "_").slice(0, 120) || `document-${Date.now()}.pdf`;
      rt.repo.addAttachmentSetFile(set.id, { filename, mime: "application/pdf", content: body, provenance: "uploaded" });
      rt.repo.audit(null, req.staff!.username, "attachment_set_file_added", `${set.name}: ${filename} (${body.length} bytes)`);
      res.send("Uploaded.");
    });

  app.post("/config/attachment-sets/file-delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const fileId = Number(req.body.file_id);
    const rows = rt.repo.listAttachmentSets(rt.organizationId(req));
    for (const s of rows) {
      if (rt.repo.listAttachmentSetFiles(s.id).some((f) => f.id === fileId)) {
        rt.repo.deleteAttachmentSetFile(fileId);
        rt.repo.audit(null, req.staff!.username, "attachment_set_file_removed", `${s.name}: file #${fileId}`);
        return res.redirect(`/config?tab=pack#aset-${s.id}`);
      }
    }
    res.redirect(`/config?tab=pack&msg=${encodeURIComponent("Unknown file.")}`);
  });

  app.post("/config/attachment-sets/delete", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const set = rt.repo.getAttachmentSet(Number(req.body.set_id));
    if (set && set.organization_id === rt.organizationId(req)) {
      rt.repo.deleteAttachmentSet(set.id, rt.organizationId(req));
      rt.repo.audit(null, req.staff!.username, "attachment_set_deleted", `${set.name} (#${set.id})`);
    }
    res.redirect(`/config?tab=pack&msg=${encodeURIComponent(`Set “${set?.name ?? "?"}” deleted. Templates referencing it will attach nothing (and say so in the audit).`)}`);
  });

  // Official pack files: download (staff) + replace (raw PDF upload).
  app.get("/pack/:key", requireLogin, (req, res) => {
    const slot = PACK_SLOTS.find((x) => x.key === req.params.key);
    if (!slot) return res.status(404).send("Unknown pack file.");
    const owned = rt.repo.listOrganizationPackSlots(rt.organizationId(req)).find((x) => x.key === slot.key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${owned?.filename || slot.pretty}"`);
    if (owned?.content) return res.send(owned.content);
    // Only the migrated Organization #1 dataset may read bundled PDFs.
    if (rt.organizationId(req) !== 1) return res.status(404).send("Pack file missing.");
    const file = path.join(PACK_DIR, slot.file);
    if (!fs.existsSync(file)) return res.status(404).send("Pack file missing.");
    res.sendFile(file);
  });
  app.post(
    "/config/pack/replace",
    requireLogin,
    requireRole("admin"),
    csrfCheck,
    express.raw({ type: "application/pdf", limit: "12mb" }),
    (req, res) => {
      const slot = PACK_SLOTS.find((x) => x.key === String(req.query.slot ?? ""));
      if (!slot) return res.status(400).send("Unknown pack slot.");
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 512 || body.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(400).send("Not a PDF.");
      }
      rt.repo.setOrganizationPackSlot(rt.organizationId(req), slot.key, {
        filename: slot.pretty,
        mime: "application/pdf",
        content: body,
      });
      rt.repo.audit(null, req.staff!.username, "pack_file_replaced", `${slot.key} replaced (${body.length} bytes)`);
      res.status(200).send("saved");
    }
  );
}
