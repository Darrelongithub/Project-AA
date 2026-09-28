/**
 * Shared route context: the createApp closure, built once per app.
 * Moved verbatim from server.ts; routes receive it as `rt`.
 */
import type { NextFunction, Request, Response } from "express";
import { Repo } from "../../db/repo";
import type { PipelineContext } from "../../pipeline/adapters";
import { type Permission, PERMISSION_LABELS } from "../../types";
import { layout } from "../views";
import type { OnceResult } from "../../util/once";
import { organizationName, organizationSender, organizationTheme } from "../../branding";
import type { PackFile } from "../../pack";

export interface WebDeps {
  repo: Repo;
  ctx: PipelineContext; // reuse the pipeline's sender/vision adapters
  /** Manual "Sync now" hook — one live ingest pass; `ran:false` = a pass was already in flight. */
  gmailSync?: () => Promise<OnceResult<Error | null>>;
  /** One-off backfill hook — one pass over a deeper window (30/90/365 days). */
  gmailBackfill?: (days: number) => Promise<OnceResult<Error | null>>;
  /** True when the running process has live environment Gmail credentials. */
  gmailConfigured?: boolean;
  gmailAddress?: string;
  /** Test the active Gmail client, including env-only deployments. */
  gmailTest?: () => Promise<Error | null>;
}

export type LegacyAcademicLevel = "degree" | "diploma" | "certificate" | "masters" | "phd";

export function buildRouteCtx(deps: WebDeps) {
  const { repo, ctx, gmailSync, gmailBackfill, gmailConfigured } = deps;
  const organizationId = (req?: Request): number => req?.staff?.organization_id ?? 1;
  const instName = (req?: Request): string => organizationName(repo, organizationId(req));
  // PPR P1-5: every outgoing send carries the organization's sender identity
  // (From display name / Reply-To) — one wrapper so no send path can forget it.
  const sendOrgMail = (
    a: { email_address: string; thread_id: string; organization_id?: number | null },
    subject: string,
    body: string,
    extras: { banner?: { mime: string; base64: string } | null; attachments?: Array<{ filename: string; mimeType: string; content: Buffer }> }
  ): Promise<void> =>
    ctx.adapters.sender.send(a.email_address, subject, body, a.thread_id, {
      ...organizationSender(repo, a.organization_id ?? 1),
      ...extras,
    });
  const authName = (): string => repo.getOrganization(1)?.name?.trim() || organizationName(repo, 1);

  const c = (req: Request) => ({
    repo,
    user: req.staff!,
    unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
    csrf: req.csrfToken ?? "",
    theme: req.theme,
    institution: instName(req),
    brand: repo.getOrganization(organizationId(req)) ? {
      ...organizationTheme(repo, organizationId(req)),
      logo: repo.getOrganization(organizationId(req))!.logo,
      tagline: organizationId(req) === 1 ? repo.getSetting("splash_tagline", "") : "",
    } : undefined,
    gmailConfigured: Boolean(gmailConfigured) && repo.getSetting("gmail_disabled", "") !== "1",
    gmailAddress: deps.gmailAddress,
  });

  const backToCase = (id: string | number, msg: string) => `/case/${id}?msg=${encodeURIComponent(msg)}`;

  /** Staff action helper: stops the SLA clock + audits. */
  const staffAction = (req: Request, applicantId: number, event: string, detail: string) => {
    const a = repo.getApplicant(applicantId);
    if (a && a.sla_due_at && !a.sla_handled_at) {
      repo.updateApplicant(applicantId, { sla_handled_at: new Date().toISOString() });
    }
    repo.audit(applicantId, req.staff!.username, event, detail);
  };

  // Realm guard: a case is only visible to accounts in the SAME realm —
  // live admins never open mock cases, demo accounts never open live ones.
  const sameRealm = (req: Request, a: { demo?: number } | null): boolean =>
    Boolean(a) && (a!.demo ?? 0) === (req.staff!.demo ?? 0);

  // PPR P1-8: the four automation actions are distinct permissions, replacing
  // the admin/user role split for them. Admins hold all four; other staff hold
  // what they were granted (see repo.hasPermission for the default grants).
  const requirePermission = (permission: Permission) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (req.staff && repo.hasPermission(req.staff.id, permission)) {
        next();
        return;
      }
      res.status(403).send(`403 — you do not hold the “${PERMISSION_LABELS[permission]}” permission.`);
    };

  /** PPR P0-5: which organization-owned attachment set (if any) rides along
   *  with a template. Missing/empty sets are audited — a send that silently
   *  drops a promised PDF is the worst kind of failure. Only sets owned by
   *  the SENDING organization resolve (E3: no privileged pack channel). */
  const packForTemplate = (ref: string | undefined, applicantId: number, actor: string): { files: PackFile[]; label: string } | null => {
    if (!ref || ref === "none") return null;
    const applicant = repo.getApplicant(applicantId);
    const resolved = repo.attachmentSetFiles(applicant?.organization_id ?? 1, ref);
    if (resolved.issues.length) repo.audit(applicantId, actor, "pack_incomplete", resolved.issues.join("; "));
    return { files: resolved.files, label: resolved.label };
  };

  // ── New-window composer ────────────────────────────────────────────────────
  // A standalone compose window: pick the recipient (scoped search), load a
  // template if wanted, edit, send. Same rules as every other send path —
  // scoping enforced on BOTH the open and the send, pack/banner come from the
  // chosen template, attachments recorded on the case history.
  const refuseScope = (req: Request, res: Response, backHref = "/compose", backLabel = "← Back to the composer"): void => {
    res.status(403).send(layout({
      title: "Outside your schools",
      institution: instName(req),
      user: req.staff,
      unread: repo.unreadCount(req.staff!.id, req.staff!.demo, repo.caseScopeFor(req.staff!)),
      csrf: req.csrfToken,
      content: `<div class="card" style="max-width:560px;margin:60px auto;text-align:center">
        <h1>This case is outside your assigned schools</h1>
        <p class="sub">You can only reach cases that belong to a school you handle. If this should be yours, ask an administrator to update your visibility scope.</p>
        <p><a class="btn" href="${backHref}">${backLabel}</a></p>
      </div>`,
    }));
  };
  return {
    repo,
    ctx,
    gmailSync,
    gmailBackfill,
    gmailConfigured,
    gmailTest: deps.gmailTest,
    gmailAddress: deps.gmailAddress,
    organizationId,
    instName,
    sendOrgMail,
    authName,
    c,
    backToCase,
    staffAction,
    sameRealm,
    requirePermission,
    packForTemplate,
    refuseScope,
  };
}

export type RouteCtx = ReturnType<typeof buildRouteCtx>;
