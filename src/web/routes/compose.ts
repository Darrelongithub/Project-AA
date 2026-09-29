/**
 * compose routes. Extracted verbatim from server.ts createApp;
 * shared closure state arrives via RouteCtx — behavior unchanged.
 */
import type { Express, Request } from "express";
import { type ApplicantRow, LIFECYCLE_LABELS } from "../../types";
import { checklistText, renderTemplate } from "../../drafting";
import { docLabel } from "../../rules";
import { composePage, composeWindowPage } from "../pages";
import { csrfCheck, requireLogin } from "../auth";
import { LoginThrottle } from "../throttle";
import { outgoingMessageId } from "../../util/ids";
import { emailBanner, organizationName } from "../../branding";
import type { RouteCtx } from "./ctx";

export function registerCompose(app: Express, rt: RouteCtx): void {
  // Compose: an action (e.g. "Request missing documents") or any template
  // opens a full-page reply with everything pre-filled — the officer edits if
  // they want, presses Send, done. One obvious path: draft → send.
  const renderFor = (a: ApplicantRow, subject: string, body: string) =>
    renderTemplate(subject, body, {
      ref: a.ref_number,
      institution: organizationName(rt.repo, a.organization_id ?? 1),
      name: a.full_name ?? undefined,
      missingLabels: rt.repo.effectiveRequirements(a)
        .filter((r) => r.required)
        .filter((r) => !rt.repo.listDocuments(a.id, { activeOnly: true }).some((d) => d.document_type === r.document_type))
        .map((r) => docLabel(r.document_type)),
      checklist: checklistText({
        requirements: rt.repo.effectiveRequirements(a),
        presentTypes: rt.repo.listDocuments(a.id, { activeOnly: true }).map((d) => d.document_type),
      }),
      statusLabel: LIFECYCLE_LABELS[a.lifecycle],
      programme: a.programme ? (rt.repo.programmeByCode(a.programme)?.name ?? a.programme) : undefined,
      regDate: rt.repo.getSetting("reg_date", ""),
      orientationDates: rt.repo.getSetting("orientation_dates", ""),
    });
  /** Case id from the composer (query or body) — visibility-checked. */
  const composeCase = (req: Request, raw: unknown): ApplicantRow | null | "refused" | "crossRealm" => {
    const id = Number(raw);
    if (!Number.isFinite(id)) return null;
    const a = rt.repo.getApplicant(id);
    if (!a || !rt.repo.applicantVisibleTo(req.staff!, a)) return "refused";
    // Realm guard (matches the /case/:id choke point): a cross-realm case is
    // indistinguishable from a non-existent one — demo staff can neither
    // open nor send to a live case, and vice versa.
    if (!rt.sameRealm(req, a)) return "crossRealm";
    return a;
  };

  app.get("/compose", requireLogin, (req, res) => {
    const caseId = req.query.case ? String(req.query.case) : "";
    const templateKey = req.query.template ? String(req.query.template) : undefined;
    if (caseId) {
      const a = composeCase(req, caseId);
      if (a === "refused") return rt.refuseScope(req, res);
      if (a === "crossRealm") return res.status(404).send("Case not found.");
      if (a) {
        const tpl = templateKey ? rt.repo.getTemplate(templateKey, rt.organizationId(req)) : undefined;
        const rendered = tpl ? renderFor(a, tpl.subject, tpl.body) : undefined;
        return res.send(composeWindowPage(rt.c(req), {
          applicant: a, templateKey: tpl?.key,
          subject: rendered?.subject, body: rendered?.body,
        }));
      }
    }
    const scope = rt.repo.caseScopeFor(req.staff!);
    const q = req.query.q !== undefined ? String(req.query.q).trim() : undefined;
    const matches = rt.repo.searchApplicants({
      q: q || undefined, demo: req.staff!.demo, schools: scope, limit: 8,
    });
    res.send(composeWindowPage(rt.c(req), { matches, q, templateKey }));
  });

  // Same double-click guard as /case/:id/send: without it a double POST
  // mailed the applicant TWICE (and minted duplicate message_ids).
  const sendGuard = new LoginThrottle({ windowMs: 5000, maxFails: 1, maxEntries: 2000 });

  app.post("/compose", requireLogin, csrfCheck, async (req, res) => {
    const a = composeCase(req, req.body.case);
    if (a === "refused") return rt.refuseScope(req, res);
    if (a === "crossRealm") return res.status(404).send("Case not found.");
    if (!a) return res.redirect("/compose");
    // Template choice happens via GET (chips re-render the draft); the POST
    // has exactly one job: send. The template only decides pack + banner.
    const tplKey = String(req.body.template ?? "");
    const tpl = tplKey ? rt.repo.getTemplate(tplKey, rt.organizationId(req)) : undefined;

    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!subject || !body) {
      return res.send(composeWindowPage(rt.c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: "Both a subject and a message are needed before this can be sent.",
      }));
    }
    if (!sendGuard.claim(`${req.staff!.id}:${a.id}:${tpl?.key ?? "-"}:${subject} ${body}`)) {
      return res.send(composeWindowPage(rt.c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: "Duplicate send ignored — that reply was just sent.",
      }));
    }
    const pack = rt.packForTemplate(tpl?.attach_pack, a.id, req.staff!.username);
    try {
      await rt.sendOrgMail(a, subject, body, {
        banner: tpl && tpl.include_banner === 0 ? null : emailBanner(rt.repo, rt.organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      rt.repo.audit(a.id, req.staff!.username, "send_failed", (e as Error).message);
      return res.send(composeWindowPage(rt.c(req), {
        applicant: a, templateKey: tpl?.key, subject, body,
        error: `Send failed: ${(e as Error).message}`,
      }));
    }
    rt.repo.insertEmail({
      applicant_id: a.id, message_id: outgoingMessageId("composewin"), thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject, body, category: null, auto: 0,
      at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    rt.staffAction(req, a.id, "email_sent_manual", `new-window compose${tpl ? ` (${tpl.key})` : ""}: "${subject}"${pack ? ` (+${pack.label} pack, ${pack.files.length} file(s))` : ""}`);
    res.redirect(rt.backToCase(a.id, `Reply sent to ${a.email_address}${pack ? ` with the ${pack.label} pack attached` : ""}.`));
  });

  app.get("/case/:id/compose", requireLogin, (req, res) => {
    const a = rt.repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tpl = rt.repo.getTemplate(String(req.query.template ?? ""), rt.organizationId(req));
    if (!tpl) return res.redirect(rt.backToCase(a.id, "Unknown template."));
    const rendered = renderFor(a, tpl.subject, tpl.body);
    res.send(composePage(rt.c(req), a, tpl, rendered));
  });

  app.post("/case/:id/compose", requireLogin, csrfCheck, async (req, res) => {
    const a = rt.repo.getApplicant(Number(req.params.id));
    if (!a) return res.status(404).send("Case not found.");
    const tplKey = String(req.body.template ?? "");
    const tpl = rt.repo.getTemplate(tplKey, rt.organizationId(req));
    if (!tpl) return res.redirect(rt.backToCase(a.id, "Unknown template."));
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").trim();
    if (!subject || !body) {
      const rendered = renderFor(a, subject || tpl.subject, body || tpl.body);
      return res.send(composePage(rt.c(req), a, tpl, rendered, "Both a subject and a body are needed before this can be sent."));
    }
    if (!sendGuard.claim(`${req.staff!.id}:${a.id}:${tpl.key}:${subject} ${body}`)) {
      return res.redirect(rt.backToCase(a.id, "Duplicate send ignored — that reply was just sent."));
    }
    const pack = rt.packForTemplate(tpl.attach_pack, a.id, req.staff!.username);
    try {
      await rt.sendOrgMail(a, subject, body, {
        banner: tpl.include_banner === 0 ? null : emailBanner(rt.repo, rt.organizationId(req)),
        attachments: pack ? pack.files : [],
      });
    } catch (e) {
      rt.repo.audit(a.id, req.staff!.username, "send_failed", (e as Error).message);
      return res.redirect(rt.backToCase(a.id, `Send failed: ${(e as Error).message}`));
    }
    rt.repo.insertEmail({
      applicant_id: a.id, message_id: outgoingMessageId("compose"), thread_id: a.thread_id, direction: "out",
      from_addr: "", to_addr: a.email_address, subject, body, category: null, auto: 0, at: new Date().toISOString(),
      attachments: pack ? pack.files.map((f) => f.filename) : [],
    });
    rt.staffAction(req, a.id, "email_sent_manual", `composed reply (${tpl.key}): "${subject}"${pack ? ` (+${pack.label} pack)` : ""}`);
    res.redirect(rt.backToCase(a.id, `Reply sent to ${a.email_address}${pack ? ` with the ${pack.label} pack attached` : ""}.`));
  });
}
