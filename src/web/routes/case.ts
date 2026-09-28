/**
 * case routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express } from "express";
import { type EmailCategory, type LifecycleStage, EMAIL_CATEGORY_LABELS, LIFECYCLE_LABELS, LIFECYCLE_ORDER, PERMISSION_LABELS } from "../../types";
import { checklistText, renderTemplate } from "../../drafting";
import { docLabel } from "../../rules";
import { Decision } from "../../decisions";
import { fillSlots } from "../../documents/matrix";
import { autoAdmitPolicy, evaluateAdmission, evaluateCaseTypeRules } from "../../admissions/evaluate";
import { casePage, replayPage } from "../pages";
import { layout } from "../views";
import { csrfCheck, requireLogin, requireRole } from "../auth";
import { emailBanner } from "../../branding";
import { admissionsPreset } from "../../presets/loader";
import type { RouteCtx } from "./ctx";

export function registerCase(app: Express, rt: RouteCtx): void {
  // OR-8: visibility scoping covers EVERY case surface — the case page,
  // compose, replay and every POST action. Unknown ids and out-of-scope ids
  // get the SAME refusal, so scoped staff can't probe which cases exist.
  app.use("/case/:id", requireLogin, (req, res, next) => {
    const a = rt.repo.getApplicant(Number(req.params.id));
    // Realm guard at the ONE choke point every /case/:id route passes through
    // (pages, compose, replay, notes, tasks, decisions, reminders…): a
    // cross-realm case is indistinguishable from a non-existent one.
    if (a && !rt.sameRealm(req, a)) {
      res.status(404).send("Case not found.");
      return;
    }
    if (!a || !rt.repo.applicantVisibleTo(req.staff!, a)) {
      res.status(403).send(layout({
        title: "Outside your schools",
        institution: rt.instName(req),
        user: req.staff,
        unread: rt.repo.unreadCount(req.staff!.id, req.staff!.demo, rt.repo.caseScopeFor(req.staff!)),
        csrf: req.csrfToken,
        content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
          <h1>This case is outside your assigned schools</h1>
          <p class="sub">You can only open cases that belong to a school you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
          <p><a class="btn" href="/applicants">← Back to your queues</a></p>
        </div>`,
      }));
      return;
    }
    next();
  });

  app.get("/case/:id", requireLogin, (req, res) => {
    const a = rt.repo.getApplicant(Number(req.params.id));
    if (!a || !rt.sameRealm(req, a)) return res.status(404).send("Case not found.");
    res.send(casePage(rt.c(req), a, req.query.msg ? String(req.query.msg) : undefined));
  });

  /** Decision replay — the step-by-step chain behind any flag/verdict. */
  app.get("/case/:id/replay", requireLogin, (req, res) => {
    const a = rt.repo.getApplicant(Number(req.params.id));
    if (!a || !rt.sameRealm(req, a)) return res.status(404).send("Case not found.");
    res.send(replayPage(rt.c(req), a));
  });

  /** Tasks — turn a case into work items. */
  app.post("/case/:id/task/add", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const title = String(req.body.title ?? "").trim();
    if (!title) return res.redirect(rt.backToCase(id, "Task title was empty — nothing added."));
    rt.repo.addTask(id, title, req.staff!.id);
    rt.staffAction(req, id, "task_added", title);
    res.redirect(rt.backToCase(id, "Task added."));
  });

  app.post("/case/:id/task/toggle", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const taskId = Number(req.body.task_id);
    const tasks = rt.repo.listTasks(id).filter((t) => t.id === taskId);
    if (tasks.length) {
      rt.repo.toggleTask(taskId, !tasks[0].done);
      rt.staffAction(req, id, "task_toggled", `#${taskId} → ${tasks[0].done ? "open" : "done"}`);
    }
    res.redirect(rt.backToCase(id, "Task updated."));
  });

  /**
   * Human handoff on held drafts (v3 feature 16): the system prepared a
   * reply but did not send it. Staff can [Send], [Save changes] or [Discard].
   */
  app.post("/case/:id/draft", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const draft = rt.repo.queuedOutbox(id);
    if (!draft) return res.redirect(rt.backToCase(id, "No draft on file."));
    // PPR P1-3/P1-8: an ordinary draft is officer work (staff send paths stay
    // allowed); a draft awaiting APPROVAL may only be released by a holder of
    // the "Approve automation" permission.
    if (draft.needs_approval && !rt.repo.hasPermission(req.staff!.id, "approve_automation")) {
      return res.status(403).send(`403 — you do not hold the “${PERMISSION_LABELS.approve_automation}” permission.`);
    }
    const decision = String(req.body.decision ?? "");
    const subject = String(req.body.subject ?? draft.subject);
    const body = String(req.body.body ?? draft.body);

    if (decision === "discard") {
      rt.repo.deleteOutbox(draft.id);
      rt.staffAction(req, id, "draft_discarded", `"${subject}"`);
      return res.redirect(rt.backToCase(id, "Draft discarded."));
    }
    if (decision === "edit") {
      rt.repo.updateOutbox(draft.id, subject, body);
      rt.staffAction(req, id, "draft_edited", `"${subject}"`);
      return res.redirect(rt.backToCase(id, "Draft saved — send it when ready."));
    }
    if (decision !== "send") {
      return res.redirect(rt.backToCase(id, "Unknown draft action — nothing sent."));
    }
    // Never let internal routing boilerplate ("INTERNAL — DO NOT AUTO-SEND…")
    // leave the building — the officer must replace it with a real reply first.
    if (body.trimStart().startsWith("INTERNAL \u2014 DO NOT AUTO-SEND")) {
      return res.redirect(rt.backToCase(id, "That draft still contains internal routing notes — edit the body before sending."));
    }
    // The held draft remembers which template rendered it — approving the
    // draft honours that template's pack attachment exactly like a direct
    // send would. Without this, held replies (the common path under the
    // qualification gate) went out without the promised pack PDFs.
    // Claim BEFORE the awaited send: a second concurrent approval reads the
    // same queued draft only until this update fires — from here on it loses.
    if (!rt.repo.claimOutboxDraft(draft.id, new Date().toISOString())) {
      return res.redirect(rt.backToCase(id, "That draft is already being sent — refresh before trying again."));
    }
    const draftTpl = draft.template_key ? rt.repo.getTemplate(draft.template_key, rt.organizationId(req)) : undefined;
    const pack = rt.packForTemplate(draftTpl?.attach_pack, id, req.staff!.username);
    try {
      await rt.sendOrgMail(a, subject, body, {
        banner: draftTpl && draftTpl.include_banner === 0 ? null : emailBanner(rt.repo, rt.organizationId(req)),
        attachments: pack ? pack.files : [],
      });
      rt.repo.insertEmail({
        applicant_id: id, message_id: `handoff-${draft.id}-${Date.now()}`, thread_id: a.thread_id,
        direction: "out", from_addr: "", to_addr: a.email_address, subject, body,
        category: null, auto: 0, at: new Date().toISOString(),
        attachments: pack ? pack.files.map((f) => f.filename) : [],
      });
      rt.repo.deleteOutbox(draft.id);
      rt.staffAction(req, id, "human_override", `approved held draft: "${subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
      res.redirect(rt.backToCase(id, `Reply sent${pack ? ` with the ${pack.label} pack attached` : ""}.`));
    } catch (e) {
      rt.repo.releaseOutboxDraft(draft.id); // let the officer retry the send
      rt.repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      res.redirect(rt.backToCase(id, `Send failed: ${(e as Error).message}`));
    }
  });

  app.post("/case/:id/action", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const action = String(req.body.action ?? "");

    if (action === "advance" || action === "complete") {
      const to: LifecycleStage | undefined =
        action === "complete"
          ? "completed"
          : LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(a.lifecycle) + 1];
      if (to) {
        // P1-4: a profile may declare required information per stage. Moving
        // INTO a stage whose list is not yet satisfied is refused with the
        // missing items named — staff decide what to collect; the console
        // refuses to pretend the stage is ready. Empty list (the default) =
        // no enforcement; the education profile keeps its generated matrix
        // as the richer requirements source.
        const stageCfg = rt.repo.caseTypeForCase(id)?.stages?.find((s) => s.id === to);
        const requires = stageCfg?.requires ?? [];
        if (requires.length) {
          const docs = rt.repo.listDocuments(id, { activeOnly: true });
          const satisfied = (item: string): boolean => {
            const k = item.trim().toLowerCase();
            return docs.some((d) =>
              String(d.document_type).toLowerCase() === k
              || Object.keys(d.extracted_fields ?? {}).some((f) => f.toLowerCase() === k)
              || String(d.extracted_text ?? "").toLowerCase().includes(k));
          };
          const missing = requires.filter((r) => !satisfied(r));
          if (missing.length) {
            return res.redirect(rt.backToCase(id, `Cannot move to “${stageCfg?.label ?? to}” yet — still needed: ${missing.join(", ")}.`));
          }
        }
        rt.repo.setLifecycle(id, to, req.staff!.username, `advanced by ${req.staff!.display_name}`);
        if (to === "verification" || to === "completed") rt.staffAction(req, id, "case_action", `moved to ${to}`);
        else rt.staffAction(req, id, "case_action", `advanced to ${to}`);
        return res.redirect(rt.backToCase(id, `Status → ${LIFECYCLE_LABELS[to]}.`));
      }
    }

    if (action === "request_info") {
      // Actions open a READY, pre-filled reply — nothing leaves until the
      // officer has seen it and pressed Send on the compose page.
      const activeDocs = rt.repo.listDocuments(id, { activeOnly: true });
      const tplKey = activeDocs.length === 0 ? "docs_request" : "missing_documents";
      return res.redirect(`/case/${id}/compose?template=${tplKey}`);
    }
    if (action === "ack_receipt") {
      return res.redirect(`/case/${id}/compose?template=ack_received`);
    }
    if (action === "status_answer") {
      return res.redirect(`/case/${id}/compose?template=status_answer`);
    }
    res.redirect(rt.backToCase(id, "No action taken."));
  });

  // Rapid double-click protection for template sends: the same officer sending
  // the same template to the same case within 5s is treated as one action.
  const recentSends = new Map<string, number>();
  const sendGuardOk = (key: string): boolean => {
    const now = Date.now();
    if (recentSends.size > 2000) recentSends.clear();
    const last = recentSends.get(key) ?? 0;
    if (now - last < 5000) return false;
    recentSends.set(key, now);
    return true;
  };

  app.post("/case/:id/send", requireLogin, csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const tpl = rt.repo.getTemplate(String(req.body.template ?? ""), rt.organizationId(req));
    if (!tpl) return res.redirect(rt.backToCase(id, "Unknown template."));
    if (req.body.preview === undefined && !sendGuardOk(`${req.staff!.id}:${id}:${tpl.key}`)) {
      return res.redirect(rt.backToCase(id, "Duplicate send ignored — that reply was just sent."));
    }
    const activeDocs = rt.repo.listDocuments(id, { activeOnly: true });
    const requirements = rt.repo.effectiveRequirements(a).filter((r) => r.required);
    const present = activeDocs.map((d) => d.document_type);
    const { missing } = fillSlots(requirements, present);
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: rt.instName(req),
      name: a.full_name ?? undefined,
      missingLabels: missing.map((m) => docLabel(m.document_type)),
      checklist: checklistText({ requirements, presentTypes: present }),
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
    });
    // "Preview" in the Responses card: show the rendered reply in-page, send nothing.
    if (req.body.preview !== undefined) {
      return res.send(casePage(rt.c(req), a, "Preview only — nothing has been sent.", rendered));
    }
    const pack = rt.packForTemplate(tpl.attach_pack, id, req.staff!.username);
    try {
      await rt.sendOrgMail(a, rendered.subject, rendered.body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(rt.repo, rt.organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      rt.repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(rt.backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    rt.repo.insertEmail({
      applicant_id: id, message_id: `manual-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    rt.staffAction(req, id, "email_sent_manual", `template ${tpl.key}: "${rendered.subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
    res.redirect(rt.backToCase(id, `Sent "${tpl.name}"${pack ? ` with the ${pack.label} pack attached` : ""}.`));
  });

  /** PPR P0-5: send an attachment set with its wrapper template. The set is
   *  named explicitly — legacy names map to the migrated profile's seeded
   *  sets; anything else must be one of the organization's own sets. */
  app.post("/case/:id/send-pack", requireLogin, requireRole("admin"), csrfCheck, async (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const kind = String(req.body.kind ?? "");
    const resolved = rt.repo.attachmentSetFiles(a.organization_id ?? rt.organizationId(req), kind);
    if (!kind || kind === "none" || resolved.issues.some((i) => i.includes("does not exist"))) {
      return res.redirect(rt.backToCase(id, "Unknown attachment set — nothing sent."));
    }
    const isAdmission = kind === "admission";
    const tpl = rt.repo.getTemplate(isAdmission ? "admission_letter" : "docs_request", rt.organizationId(req));
    if (!tpl) return res.redirect(rt.backToCase(id, "Template missing — nothing sent."));
    const rendered = renderTemplate(tpl.subject, tpl.body, {
      ref: a.ref_number,
      institution: rt.instName(req),
      name: a.full_name ?? undefined,
      missingLabels: [],
      checklist: "",
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      programme: a.programme ? (rt.repo.listProgrammes().find((p) => p.code === a.programme)?.name ?? a.programme) : undefined,
      regDate: rt.repo.getSetting("reg_date", ""),
      orientationDates: rt.repo.getSetting("orientation_dates", ""),
    });
    const pack = resolved;
    // Missing pack files must never be a silent gap in a real send.
    if (pack.issues.length) {
      rt.repo.audit(id, req.staff!.username, "pack_incomplete", pack.issues.join("; "));
    }
    try {
      await rt.sendOrgMail(a, rendered.subject, rendered.body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(rt.repo, rt.organizationId(req)),
        attachments: pack.files,
      });
    } catch (e) {
      rt.repo.audit(id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(rt.backToCase(id, `Send failed: ${(e as Error).message}`));
    }
    rt.repo.insertEmail({
      applicant_id: id, message_id: `pack-${Date.now()}`, thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject: rendered.subject, body: rendered.body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack.files.map((f) => f.filename),
    });
    rt.staffAction(req, id, isAdmission ? "admission_pack_sent" : "application_pack_sent",
      `${pack.files.length} document(s): "${rendered.subject}"`);
    const packWarn = pack.issues.length
      ? ` ⚠ ${pack.issues.length} pack file(s) missing — see audit.`
      : "";
    res.redirect(rt.backToCase(id, `${isAdmission ? "Admission" : "Attachment"} set “${pack.label}” sent — ${pack.files.length} document(s) attached.${packWarn}`));
  });

  app.post("/case/:id/note", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const body = String(req.body.body ?? "").trim();
    if (!body) return res.redirect(rt.backToCase(id, "Note was empty — nothing saved."));
    rt.repo.addNote(id, req.staff!.id, body);
    rt.staffAction(req, id, "note_added", body.slice(0, 120));
    res.redirect(rt.backToCase(id, "Note saved."));
  });

  app.post("/case/:id/assign", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const staffId = req.body.staff_id ? Number(req.body.staff_id) : null;
    // An unknown staff id violates the assigned_to FK and would 500 —
    // validate before writing.
    if (staffId !== null && !rt.repo.getStaff(staffId)) {
      return res.redirect(rt.backToCase(id, "Unknown staff member — not assigned."));
    }
    rt.repo.updateApplicant(id, { assigned_to: staffId });
    const who = staffId ? rt.repo.getStaff(staffId)?.display_name : "nobody";
    rt.staffAction(req, id, "case_assigned", `assigned to ${who}`);
    if (staffId) {
      const a = rt.repo.getApplicant(id)!;
      rt.repo.notify("assignment", `${a.ref_number} assigned to you`, id, staffId);
    }
    res.redirect(rt.backToCase(id, `Assigned to ${who ?? "nobody"}.`));
  });

  app.post("/case/:id/priority", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const p = String(req.body.priority ?? "normal");
    if (["normal", "high", "urgent"].includes(p)) {
      rt.repo.updateApplicant(id, { priority: p as never });
      rt.staffAction(req, id, "priority_changed", `priority → ${p}`);
      return res.redirect(rt.backToCase(id, `Priority set to ${p}.`));
    }
    res.redirect(rt.backToCase(id, "Unknown priority — nothing changed."));
  });

  /**
   * Re-categorise the latest incoming email after review (managers/admins).
   * Audit-logged; the next sync routes its documents with the new category.
   */
  app.post("/case/:id/category", requireLogin, requireRole("admin"), csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a) return res.status(404).send("Case not found.");
    const cat = String(req.body.category ?? "");
    if (!(cat in EMAIL_CATEGORY_LABELS)) {
      return res.redirect(rt.backToCase(id, "Unknown category — nothing changed."));
    }
    if (!rt.repo.updateLatestEmailCategory(id, cat as EmailCategory)) {
      return res.redirect(rt.backToCase(id, "No incoming email to re-categorise yet."));
    }
    rt.staffAction(req, id, "category_changed", `latest incoming email → ${cat}`);
    res.redirect(rt.backToCase(id, `Latest email re-categorised as ${EMAIL_CATEGORY_LABELS[cat as EmailCategory]}.`));
  });

  /**
   * Human review resolution (round 18): a person decides a case the automated
   * path could not — special consideration, an approved exception, an
   * alternative qualification, or a decline. Recorded as a HUMAN decision,
   * always separately from anything automated.
   */
  app.post("/case/:id/admission-decision", requireLogin, rt.requirePermission("record_outcome"), csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a || !rt.sameRealm(req, a)) return res.status(404).send("Case not found.");
    // PPR P0-2: outcome vocabulary and the decision form exist only for
    // education-module cases. Non-academic cases have no admission decision.
    if (!rt.repo.educationCaseFor(a)) {
      return res.redirect(rt.backToCase(id, "This case type has no admission decision — outcomes are recorded through its own workflow."));
    }
    const decision = String(req.body.decision ?? "");
    const reason = String(req.body.reason ?? "").trim();
    if (decision !== "admit" && decision !== "decline") {
      return res.redirect(rt.backToCase(id, "Choose admit or decline — nothing was recorded."));
    }
    if (!reason) {
      return res.redirect(rt.backToCase(id, "A reason is required for every human admission decision — it goes on the audit trail."));
    }
    // Human-review routes come from the admissions preset; an unknown route
    // falls back to the standard-review label, as it always has.
    const ROUTES: Record<string, string> = Object.fromEntries(
      admissionsPreset().decisionRoutes.map((r) => [r.value, r.label])
    );
    const standardRoute = ROUTES["standard_review"];
    const route = decision === "admit" ? (ROUTES[String(req.body.route ?? "")] ?? standardRoute) : standardRoute;
    const outcome = decision === "admit" ? "approved_after_review" : "not_approved";
    rt.repo.recordDecision(id, Decision.human({
      outcome,
      reasoning: `${route}: ${reason}`,
      decidedBy: req.staff!.username,
    }));
    // The file is closed either way; the decision field says HOW it closed.
    rt.repo.setLifecycle(id, "completed", req.staff!.username,
      decision === "admit" ? `admitted after human review (${route})` : "not admitted after human review");
    rt.repo.audit(id, req.staff!.username, "human_admission_decision",
      `${decision === "admit" ? "Admitted after Human Review" : "Not Admitted after Human Review"} · reviewer: ${req.staff!.display_name} · ${route} · reason: ${reason}`);
    rt.repo.notify("review_needed", `${a.ref_number}: ${decision === "admit" ? "admitted" : "not admitted"} after human review by ${req.staff!.display_name}`, id);
    res.redirect(rt.backToCase(id, decision === "admit"
      ? `Recorded: Admitted after Human Review (${route}).`
      : "Recorded: Not Admitted after Human Review."));
  });

  /** Re-run the admissions evaluation on demand (new documents arrived etc.).
   *  PPR P0-3: every re-evaluation states WHICH configuration version it
   *  re-applied (the case's frozen version). Upgrading an open case to the
   *  profile's CURRENT version is only possible by explicit request
   *  (`reapply=current`) and is audited as a human decision. */
  app.post("/case/:id/reevaluate", requireLogin, csrfCheck, (req, res) => {
    const id = Number(req.params.id);
    const a = rt.repo.getApplicant(id);
    if (!a || !rt.sameRealm(req, a)) return res.status(404).send("Case not found.");
    let versionNote = "";
    if (String(req.body.reapply ?? "") === "current") {
      const upgraded = rt.repo.reFreezeCaseConfig(a);
      rt.repo.audit(id, req.staff!.username, "config_version_upgraded", `case explicitly re-applied on CURRENT profile configuration version ${upgraded.config_version} by staff request`);
      versionNote = ` — explicitly re-applied on CURRENT configuration version ${upgraded.config_version}`;
    }
    const frozen = rt.repo.caseConfigFrozen(rt.repo.getApplicant(id)!);
    const version = frozen?.config_version ?? rt.repo.getApplicant(id)!.config_version_frozen ?? 1;
    if (!rt.repo.educationCaseFor(a)) {
      // Generic profile: re-run the configured rule tree from the FROZEN
      // rules — outcome stays undecided, human review always.
      const caseType = rt.repo.caseTypeForCase(id);
      const facts: Record<string, unknown> = {};
      for (const doc of rt.repo.listDocuments(id, { activeOnly: true })) Object.assign(facts, doc.extracted_fields ?? {});
      const rules = frozen?.rules ?? (caseType ? rt.repo.caseTypeRules(caseType) : []);
      const result = caseType ? evaluateCaseTypeRules(rt.repo, caseType, rules, facts) : { result: "undetermined" as const, routing: "human_review" as const };
      rt.repo.audit(id, req.staff!.username, "evaluation_rerun", `re-applied frozen configuration version ${version} → rules ${result.result}; outcome remains undecided`);
      return res.redirect(rt.backToCase(id, `Evaluation re-run under configuration version ${version} (the version this case was opened under): rules ${String(result.result).replace(/_/g, " ")} — outcome remains undecided${versionNote}`));
    }
    const flags = rt.repo.activeFlags(id).filter((f) => f.type !== "duplicate_submission");
    // M-3: a re-run keeps the profile's auto-admit posture, so a manual
    // re-evaluation can neither invent nor silently downgrade a provisional
    // admission (the watcher + gates still apply on the next intake pass).
    const result = evaluateAdmission(rt.repo, id, flags, { autoAdmit: autoAdmitPolicy(rt.repo, id) });
    rt.repo.syncFlags(id, [...flags, ...result.derivedFlags]);
    rt.repo.audit(id, req.staff!.username, "evaluation_rerun", `re-applied frozen configuration version ${version} → ${result.report.result}/${result.report.routing}`);
    res.redirect(rt.backToCase(id, `Evaluation re-run under configuration version ${version} (the version this case was opened under): ${result.report.result.replace(/_/g, " ")} → ${result.report.routing.replace(/_/g, " ")}.${versionNote}`));
  });
}
