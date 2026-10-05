/**
 * `POST /api/v1/ingest/:org_key` — the public webhook surface (Phase 18).
 *
 * Everything here assumes the caller is hostile: it is an unauthenticated,
 * internet-reachable endpoint that creates records in a tenant's case file. So
 * the payload is validated to a schema before any of it reaches the pipeline,
 * the parse itself is capped (`entity.too.large` never becomes a case), every
 * field has a ceiling, the ingest key is resolved by a single indexed
 * exact-match lookup that tells a bad format and an unknown key exactly the same
 * story (404 `not found`), and each tenant gets its own request budget.
 *
 * What it does NOT do is invent a second path into the system. A webhook
 * submission becomes an `IncomingEmail` on a synthetic `webhook` channel and is
 * handed to `processEmail` like Gmail, the portal and the intake tester do. Same
 * case-type rules, same evidence gates, same draft-first automation switch, same
 * human-only outcomes. A caller who can post JSON cannot decide anything about a
 * case: this module never writes `outcome`, `triage`, `lifecycle`, `priority` or
 * any decision column, and it cannot — the generic patch methods refuse those
 * columns (see `test/decision-provenance.test.ts`), so no provenance guarantee
 * is being borrowed here, let alone assumed.
 */
import { Repo } from "../db/repo";
import type { PipelineContext } from "../pipeline/adapters";
import { processEmail } from "../pipeline";
import type { RateWindow } from "./throttle";
import { log } from "../util/log";
import type { IncomingEmail } from "../types";
import * as crypto from "crypto";

/** Path prefix the server mounts, and that the global body parsers skip. */
export const WEBHOOK_PATH_PREFIX = "/api/v1/ingest/";

/** Ceilings per field, in characters. Long enough for real submissions, short
 *  enough that one request cannot fill a case's history with a megabyte. */
export const WEBHOOK_FIELD_LIMITS = {
  email: 254,
  full_name: 120,
  external_id: 120,
  case_type: 40,
  message: 8_000,
  metadata_keys: 20,
  metadata_key: 40,
  metadata_value: 200,
  metadata_bytes: 4_000,
  top_level_keys: 40,
} as const;

/** The address shape the rest of the system accepts (`/intake/test` uses this). */
// Dots must separate non-empty labels: `a@example..org` is refused even though a
// naive "something-dot-something" pattern would wave it through.
const EMAIL_RE = /^[^\s@]+@(?:[^\s.@]+\.)+[^\s.@]+$/;

/** Control characters except tab, newline and carriage return. */
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface WebhookDeps {
  repo: Repo;
  ctx: PipelineContext;
  /** Shared limiter instance for the running process; the threshold is read per
   *  request from Settings so changing it needs no restart. */
  limiter: RateWindow;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export interface ValidatedWebhookPayload {
  email: string;
  fullName: string;
  externalId: string;
  caseTypeCode: string;
  message: string;
  metadata: Record<string, string>;
}

export type PayloadRejection = { ok: false; status: number; error: string; field?: string };

/** The ingest key travels in the URL, so it must never be echoed into a log
 *  line, an audit row or an error body: this is the one place that says so, and
 *  the server's request-error handler runs every `/api/` path through it. */
export function redactIngestKey(path: string): string {
  if (!path.startsWith(WEBHOOK_PATH_PREFIX)) return path;
  const rest = path.slice(WEBHOOK_PATH_PREFIX.length);
  const boundary = rest.search(/[/?#]/);
  return `${WEBHOOK_PATH_PREFIX}[redacted]${boundary === -1 ? "" : rest.slice(boundary)}`;
}

function reject(status: number, error: string, field?: string): PayloadRejection {
  return { ok: false, status, error, ...(field ? { field } : {}) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Scalar → cleaned string, or a rejection naming the field. Length is measured
 *  BEFORE truncation so a caller is told its value was refused, never handed a
 *  quietly shortened version of what it sent. */
function textField(body: Record<string, unknown>, key: string, max: number, opts: { singleLine?: boolean } = {}): { value: string } | PayloadRejection {
  const raw = body[key];
  if (raw === undefined || raw === null) return { value: "" };
  if (typeof raw === "object") return reject(400, `${key} must be a short text value, not a list or an object`, key);
  let text = String(raw).replace(STRIP_RE, "");
  text = opts.singleLine ? text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() : text.trim();
  if (text.length > max) return reject(400, `${key} is longer than ${max} characters`, key);
  return { value: text };
}

/** `metadata` is free-form but never free-for-all: at most 20 string-to-string
 *  pairs, 4 kB total. Objects, arrays and deep structures are refused rather than
 *  flattened, because a flattened structure is a payload the operator cannot
 *  read back as what was sent. Form callers may send it as a JSON string. */
function metadataField(body: Record<string, unknown>): { value: Record<string, string> } | PayloadRejection {
  let raw = body.metadata;
  if (raw === undefined || raw === null || raw === "") return { value: {} };
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return reject(400, "metadata must be an object of simple key/value pairs, or JSON text", "metadata");
    }
  }
  if (!isPlainObject(raw)) return reject(400, "metadata must be an object of simple key/value pairs", "metadata");
  const keys = Object.keys(raw);
  if (keys.length > WEBHOOK_FIELD_LIMITS.metadata_keys) {
    return reject(400, `metadata may carry at most ${WEBHOOK_FIELD_LIMITS.metadata_keys} fields`, "metadata");
  }
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key.replace(STRIP_RE, "").trim().length > WEBHOOK_FIELD_LIMITS.metadata_key) {
      return reject(400, `metadata field names are limited to ${WEBHOOK_FIELD_LIMITS.metadata_key} characters`, "metadata");
    }
    const value = raw[key];
    if (value !== null && typeof value === "object") {
      return reject(400, `metadata.${key} must be a single value, not a list or an object`, "metadata");
    }
    const text = String(value ?? "").replace(STRIP_RE, "").trim();
    if (text.length > WEBHOOK_FIELD_LIMITS.metadata_value) {
      return reject(400, `metadata.${key} is longer than ${WEBHOOK_FIELD_LIMITS.metadata_value} characters`, "metadata");
    }
    out[key.replace(STRIP_RE, "").trim().slice(0, WEBHOOK_FIELD_LIMITS.metadata_key)] = text;
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > WEBHOOK_FIELD_LIMITS.metadata_bytes) {
    return reject(400, `metadata is larger than ${WEBHOOK_FIELD_LIMITS.metadata_bytes} bytes`, "metadata");
  }
  return { value: out };
}

/**
 * The whole validation surface, as a pure function: no database, no pipeline.
 * A case type that does not belong to THIS organization is refused here — never
 * created, never borrowed from another tenant, since `getCaseType` is
 * organization-scoped by construction.
 */
export function validateWebhookPayload(
  body: unknown,
  repo: Repo,
  organizationId: number
): { ok: true; value: ValidatedWebhookPayload } | PayloadRejection {
  if (!isPlainObject(body)) return reject(400, "send a JSON object or form fields");
  if (Object.keys(body).length > WEBHOOK_FIELD_LIMITS.top_level_keys) {
    return reject(400, `a submission may carry at most ${WEBHOOK_FIELD_LIMITS.top_level_keys} fields`);
  }

  const emailField = textField(body, "email", WEBHOOK_FIELD_LIMITS.email, { singleLine: true });
  if ("error" in emailField) return emailField;
  const email = emailField.value.toLowerCase();
  if (!email) return reject(400, "email is required", "email");
  if (!EMAIL_RE.test(email)) return reject(400, "email is not a valid address", "email");

  const fullName = textField(body, "full_name", WEBHOOK_FIELD_LIMITS.full_name, { singleLine: true });
  if ("error" in fullName) return fullName;
  const externalId = textField(body, "external_id", WEBHOOK_FIELD_LIMITS.external_id, { singleLine: true });
  if ("error" in externalId) return externalId;
  const caseType = textField(body, "case_type", WEBHOOK_FIELD_LIMITS.case_type, { singleLine: true });
  if ("error" in caseType) return caseType;
  const message = textField(body, "message", WEBHOOK_FIELD_LIMITS.message);
  if ("error" in message) return message;
  const metadata = metadataField(body);
  if ("error" in metadata) return metadata;

  let resolvedCaseType = "";
  if (caseType.value) {
    // One lookup, organization-scoped and case-insensitive by collation, and a
    // miss is a refusal: nothing here creates a case type, borrows another
    // tenant's, or falls back to "other" so that the caller's typo becomes a
    // silently mis-routed case.
    const found = repo.getCaseType(caseType.value, organizationId);
    if (!found) return reject(400, `case_type "${caseType.value.slice(0, 60)}" is not configured for this organization`, "case_type");
    if (found.active === 0) return reject(400, `case_type "${caseType.value.slice(0, 60)}" is retired for this organization`, "case_type");
    resolvedCaseType = found.code;
  }

  return {
    ok: true,
    value: {
      email,
      fullName: fullName.value,
      externalId: externalId.value,
      caseTypeCode: resolvedCaseType,
      message: message.value,
      metadata: metadata.value,
    },
  };
}

export interface IngestParams {
  /** The `:org_key` path segment, exactly as it arrived. */
  orgKey: string;
  /** Parsed body (JSON object or form fields). */
  body: unknown;
  /** Approximate request size, recorded for the operator's diagnosis list. */
  payloadBytes: number;
  /** Requesting address, used only to budget unauthenticated key guessing. */
  ip: string;
}

/**
 * One submission, start to finish. Returns the response to send; it never throws,
 * so a caller cannot use a crafted payload to reach the generic error surface.
 */
export async function ingestWebhook(deps: WebhookDeps, params: IngestParams): Promise<WebhookReply> {
  const { repo, ctx, limiter } = deps;

  // Guessing keys is the only brute-force available here. Failed guesses carry
  // no tenant, so they cannot be rate-limited per organization — they get a
  // per-address budget instead, and never reach the database at all.
  const organizationId = repo.organizationForWebhookKey(params.orgKey ?? "");
  if (organizationId === null) {
    const guess = limiter.hit(`unknown:${params.ip}`, 30);
    if (!guess.ok) return { status: 429, body: { ok: false, error: "too many requests" }, retryAfterSeconds: guess.retryAfterSeconds };
    log(`webhook: refused an unrecognized ingest key from ${params.ip || "an unknown address"}`, "warn");
    return { status: 404, body: { ok: false, error: "not found" } };
  }

  const budget = limiter.hit(`org:${organizationId}`, repo.webhookRateLimitPerMinute(organizationId));
  if (!budget.ok) {
    repo.logWebhookDelivery({
      organizationId, outcome: "rate_limited", statusCode: 429,
      detail: "over the per-minute ingest rate limit", payloadBytes: params.payloadBytes,
    });
    return { status: 429, body: { ok: false, error: "too many requests" }, retryAfterSeconds: budget.retryAfterSeconds };
  }

  const validated = validateWebhookPayload(params.body, repo, organizationId);
  if (!validated.ok) {
    repo.logWebhookDelivery({
      organizationId, outcome: "rejected", statusCode: validated.status,
      detail: validated.error, payloadBytes: params.payloadBytes,
    });
    repo.audit(null, "webhook", "webhook_rejected", `organization ${organizationId}: ${validated.error}`);
    return { status: validated.status, body: { ok: false, error: validated.error, ...(validated.field ? { field: validated.field } : {}) } };
  }
  const payload = validated.value;

  // Idempotency: a retry or a double-submit must not open a second case. The
  // claim is taken before the pipeline runs, so two simultaneous submissions
  // with one external_id cannot both get through.
  if (payload.externalId) {
    const claim = repo.claimWebhookExternalId(organizationId, payload.externalId);
    if (!claim.claimed) {
      repo.logWebhookDelivery({
        organizationId, outcome: "duplicate", statusCode: 200, externalId: payload.externalId,
        senderEmail: payload.email, caseTypeCode: payload.caseTypeCode, refNumber: claim.refNumber ?? "",
        applicantId: claim.applicantId, detail: "an earlier submission carries this external_id",
        payloadBytes: params.payloadBytes,
      });
      return {
        status: 200,
        body: { ok: true, deduplicated: true, ref_number: claim.refNumber, case_id: claim.applicantId },
      };
    }
  }

  const finish = (reply: WebhookReply, outcome: string, detail: string, applicantId: number | null, refNumber: string) => {
    repo.logWebhookDelivery({
      organizationId, outcome, statusCode: reply.status, externalId: payload.externalId,
      senderEmail: payload.email, caseTypeCode: payload.caseTypeCode, refNumber, applicantId,
      detail, payloadBytes: params.payloadBytes, metadata: payload.metadata,
    });
    return reply;
  };

  // The same entry point Gmail, the portal and the intake tester use: an
  // IncomingEmail on a synthetic channel. `organizationId` is declared here, so
  // the pipeline's address-based tenant fallback is never consulted — the key,
  // not the payload, decides which tenant this belongs to.
  const stamp = crypto.randomBytes(6).toString("hex");
  const email: IncomingEmail = {
    id: `webhook-${organizationId}-${stamp}`,
    threadId: `webhook-${organizationId}-${stamp}`,
    from: payload.email,
    fromName: payload.fullName || undefined,
    to: repo.getOrganization(organizationId)?.inbound_address ?? undefined,
    subject: (payload.caseTypeCode || "Webhook submission").slice(0, 200),
    // `message` is the body and is read by the pipeline like any other message.
    // `metadata` is deliberately NOT merged into it: text the caller controls
    // already arrives through the body, and quietly concatenating more would let
    // a field the operator reads as structured data steer fact extraction. It is
    // stored as sent, on the delivery record, and never interpreted.
    body: payload.message,
    receivedAt: new Date().toISOString(),
    attachments: [],
    channel: "webhook",
    organizationId,
    caseTypeCode: payload.caseTypeCode || undefined,
  };

  let result: Awaited<ReturnType<typeof processEmail>>;
  try {
    result = await processEmail(email, ctx);
  } catch (error) {
    if (payload.externalId) repo.releaseWebhookClaim(organizationId, payload.externalId);
    const name = error instanceof Error ? error.constructor.name : "Error";
    log(`webhook: processing failed for organization ${organizationId} (${name})`, "error");
    repo.audit(null, "webhook", "webhook_failed", `organization ${organizationId}: processing failed (${name}); the submission was accepted for retry`);
    return finish(
      { status: 500, body: { ok: false, error: "the submission could not be processed" } },
      "failed", `processing threw ${name}`, null, ""
    );
  }

  if (result.skipped || !result.applicantId) {
    if (payload.externalId) repo.releaseWebhookClaim(organizationId, payload.externalId);
    const reason = result.skipped
      ? "the message was already claimed by another run"
      : "no case type matched this submission, so nothing was opened — send case_type, or configure the intake gate";
    return finish(
      { status: 202, body: { ok: true, accepted: false, ref_number: null, reason } },
      "parked", reason, null, ""
    );
  }

  const applicant = repo.getApplicant(result.applicantId);
  const refNumber = applicant?.ref_number ?? result.refNumber ?? "";
  if (payload.externalId) repo.recordWebhookClaim(organizationId, payload.externalId, result.applicantId, refNumber);
  repo.audit(result.applicantId, "webhook", "webhook_ingest_accepted",
    `via webhook${payload.externalId ? ` (external_id ${payload.externalId.slice(0, 60)})` : ""}: ${refNumber || "case opened"}`);

  return finish(
    {
      status: 200,
      body: {
        ok: true,
        deduplicated: false,
        ref_number: refNumber,
        case_id: result.applicantId,
        case_type: applicant?.case_type_code ?? payload.caseTypeCode ?? null,
        status: result.finalStatus,
        lifecycle: applicant?.lifecycle ?? result.lifecycle,
        // Told honestly, because it is the caller's whole question: a reply was
        // either actually delivered or it is waiting for a person.
        reply: result.autoSent ? "an automated reply was sent" : "a reply is held for staff review",
        received_at: email.receivedAt,
      },
    },
    "accepted", `${result.finalStatus} · ${applicant?.lifecycle ?? result.lifecycle}${result.autoSent ? " · reply sent" : " · reply held for staff"}`,
    result.applicantId, refNumber
  );
}
