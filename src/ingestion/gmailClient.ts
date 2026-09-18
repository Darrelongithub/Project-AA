/**
 * /ingestion — live Gmail access via the Gmail API (googleapis).
 *
 * Auth: OAuth2 "installed app" style — client id/secret + a refresh token
 * for the test inbox. Only what the pipeline needs is implemented:
 *   - list recent message ids (a configurable label, paginated)
 *   - fetch one message with attachments (inline documents included)
 *   - send a plain-text reply inside a thread
 *
 * Round 19 hardening:
 *   - the mailbox is paginated — more than the first 50 messages are seen;
 *   - a dedicated label can be watched instead of (or as well as) the inbox;
 *   - inline images that ARE the document are captured as attachments;
 *   - a size guard rejects oversized mail BEFORE base64-buffering it.
 */
import type { IncomingEmail } from "../types";
import { MAX_ATTACHMENT_BYTES } from "../extraction/extract";
import { log } from "../util/log";

/** Whole-message cap; above this the mail is parked, never downloaded. */
export const MAX_EMAIL_BYTES = Number(process.env.GMAIL_MAX_EMAIL_BYTES || 40 * 1024 * 1024);

/** A message too big to process — park it permanently, tell a human. */
export class EmailTooLargeError extends Error {
  sizeEstimate: number;
  constructor(messageId: string, sizeEstimate: number) {
    super(
      `message ${messageId} is ~${(sizeEstimate / 1024 / 1024).toFixed(1)} MB — above the ${(MAX_EMAIL_BYTES / 1024 / 1024).toFixed(0)} MB mail cap`
    );
    this.sizeEstimate = sizeEstimate;
    this.name = "EmailTooLargeError";
  }
}

/**
 * Header-safe `To`/`Subject` values for raw MIME construction. CR/LF in a
 * staff-editable subject would otherwise inject arbitrary headers (Cc/Bcc…);
 * non-ASCII subjects must be RFC 2047 encoded or the headers are invalid.
 */
export function sanitizeHeaders(to: string, subject: string): { to: string; subject: string } {
  const cleanTo = to.replace(/[\r\n]+/g, " ").trim();
  let cleanSubject = subject.replace(/[\r\n]+/g, " ").trim();
  if (/[^\x20-\x7e]/.test(cleanSubject)) {
    cleanSubject = `=?UTF-8?B?${Buffer.from(cleanSubject, "utf8").toString("base64")}?=`;
  }
  return { to: cleanTo, subject: cleanSubject };
}

interface MimePartNode {
  mimeType: string;
  headers?: Array<{ name: string; value: string }>;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePartNode[];
}

export class GmailClient {
  private gmail: any;
  readonly address: string;

  readonly label?: string;

  constructor(cfg: {
    address: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Gmail label to watch (default: the inbox). */
    label?: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    oauth2.setCredentials({ refresh_token: cfg.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth: oauth2 });
    this.address = cfg.address;
    this.label = cfg.label?.trim() || undefined;
  }

  /** Which mailbox region we read from — shown on the Configuration page. */
  watchTarget(): string {
    return this.label ? `label:${this.label}` : "in:inbox";
  }

  async listRecentMessageIds(
    lookbackDays: number,
    opts: { perPage?: number; maxPages?: number } = {}
  ): Promise<string[]> {
    const perPage = Math.min(opts.perPage ?? 100, 500);
    const maxPages = opts.maxPages ?? 10;
    const scope = this.label ? `label:${this.label}` : "in:inbox";
    const q = `${scope} newer_than:${lookbackDays}d`;

    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: perPage,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const m of (res.data.messages || []) as Array<{ id: string }>) ids.push(m.id);
      pageToken = res.data.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return ids;
  }

  async fetchEmail(id: string): Promise<IncomingEmail> {
    // Size guard BEFORE downloading: a 40 MB scan used to be base64-buffered
    // into memory before anything noticed. Metadata is tiny and carries the
    // server's own size estimate.
    const meta = await this.gmail.users.messages.get({ userId: "me", id, format: "metadata" });
    const sizeEstimate = Number(meta.data.sizeEstimate || 0);
    if (sizeEstimate > MAX_EMAIL_BYTES) throw new EmailTooLargeError(id, sizeEstimate);

    const res = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    const msg = res.data;
    const headers: Record<string, string> = {};
    for (const h of msg.payload.headers || []) headers[h.name.toLowerCase()] = h.value;

    const fromHeader = headers["from"] || "";
    const fromMatch = fromHeader.match(/<([^<>]+)>/) || fromHeader.match(/([^\s<>]+@[^\s<>]+)/);
    const from = fromMatch ? fromMatch[1] : fromHeader;
    const nameMatch = fromHeader.match(/^"?\s*([^"<]+?)\s*"?\s*</);

    const bodyParts: string[] = [];
    const attachments: Array<{
      filename: string;
      mimeType: string;
      attachmentId?: string;
      /** Some clients embed inline images as base64 directly in the part. */
      data?: Buffer;
      size?: number;
    }> = [];

    const walk = (part: MimePartNode) => {
      const disposition = (part.headers || []).find((h) => h.name.toLowerCase() === "content-disposition")?.value || "";
      const isDocumentish = /^(application\/pdf|image\/(png|jpe?g|tiff?))$/i.test(part.mimeType);
      if (part.body?.attachmentId) {
        // Named attachments always; INLINE images of document types too —
        // phone users paste their scan into the message body itself.
        const inlineDocument = /inline/i.test(disposition) && isDocumentish;
        if ((part.filename && part.filename.length > 0) || inlineDocument) {
          let filename = part.filename && part.filename.length > 0 ? part.filename : "";
          if (!filename) {
            const cid = (part.headers || []).find((h) => h.name.toLowerCase() === "content-id")?.value || "";
            filename = `inline-${cid.replace(/[<>]/g, "") || attachments.length + 1}.${part.mimeType.split("/")[1] || "bin"}`;
          }
          attachments.push({ filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
          return;
        }
      } else if (/inline/i.test(disposition) && isDocumentish && part.body?.data) {
        // Inline document image carried directly in the part (no attachmentId).
        const cid = (part.headers || []).find((h) => h.name.toLowerCase() === "content-id")?.value || "";
        const ext = part.mimeType.split("/")[1] || "bin";
        const filename =
          part.filename && part.filename.length > 0
            ? part.filename
            : `inline-${cid.replace(/[<>]/g, "") || attachments.length + 1}.${ext}`;
        attachments.push({
          filename,
          mimeType: part.mimeType,
          data: Buffer.from(part.body.data, "base64"),
          size: part.body.size,
        });
        return;
      }
      if (part.mimeType === "text/plain" && part.body?.data) {
        bodyParts.push(Buffer.from(part.body.data, "base64").toString("utf8"));
      }
      for (const child of part.parts || []) walk(child);
    };
    walk(msg.payload);

    // If there was no text/plain part, degrade to stripped HTML.
    let body = bodyParts.join("\n");
    if (!body.trim()) {
      const htmlParts: string[] = [];
      const walkHtml = (part: MimePartNode) => {
        if (part.mimeType === "text/html" && part.body?.data) {
          htmlParts.push(Buffer.from(part.body.data, "base64").toString("utf8"));
        }
        for (const child of part.parts || []) walkHtml(child);
      };
      walkHtml(msg.payload);
      body = htmlParts.join("\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }

    const attachmentBuffers = await Promise.all(
      attachments
        .filter((a) => {
          // The extraction layer enforces the same cap on bytes, but an
          // attachment that DECLARES itself oversized is never downloaded.
          const declared = a.size ?? a.data?.length ?? 0;
          if (declared > MAX_ATTACHMENT_BYTES) {
            log(`gmail: skipping ${a.filename} — declared ${(declared / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB attachment cap`, "warn");
            return false;
          }
          return true;
        })
        .map(async (a) => {
          if (a.data) {
            // Inline image already carried its bytes in the MIME part.
            return { filename: a.filename, mimeType: a.mimeType, content: a.data };
          }
          const attRes = await this.gmail.users.messages.attachments.get({
            userId: "me",
            messageId: id,
            id: a.attachmentId!,
          });
          return {
            filename: a.filename,
            mimeType: a.mimeType,
            content: Buffer.from(attRes.data.data, "base64"),
          };
        })
    );

    return {
      id,
      threadId: msg.threadId,
      from,
      fromName: nameMatch ? nameMatch[1].trim() : undefined,
      subject: headers["subject"] || "(no subject)",
      body,
      // Some messages (drafts, imported mail) carry no internalDate — a NaN
      // date used to throw toISOString() and silently drop the message.
      receivedAt: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
      attachments: attachmentBuffers,
    };
  }

  async sendReply(
    to: string,
    subject: string,
    body: string,
    threadId: string,
    extras?: { attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>; banner?: { mime: string; base64: string } | null }
  ): Promise<void> {
    const { to: cleanTo, subject: cleanSubject } = sanitizeHeaders(to, subject);
    const headers = [`To: ${cleanTo}`, `Subject: ${cleanSubject}`, "MIME-Version: 1.0"];

    const b64 = (buf: Buffer | string) => {
      const s = typeof buf === "string" ? buf : buf.toString("base64");
      return s.match(/.{1,76}/g)?.join("\r\n") ?? "";
    };
    const attachments = extras?.attachments ?? [];
    const banner = extras?.banner ?? null;

    let raw: string;
    if (!banner && attachments.length === 0) {
      raw = [...headers, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
    } else {
      // multipart/mixed [ related(text + inline banner), att, att, … ]
      const mixed = "RU-MIXED-" + Date.now().toString(16);
      const related = "RU-REL-" + Date.now().toString(16);
      const parts: string[] = [];
      if (banner) {
        parts.push(
          [
            `--${mixed}`,
            `Content-Type: multipart/related; boundary="${related}"`,
            "",
            `--${related}`,
            "Content-Type: text/plain; charset=UTF-8",
            "",
            body,
            "",
            `--${related}`,
            `Content-Type: ${banner.mime}; name="riara-banner"`,
            `Content-Disposition: inline; filename="riara-banner.jpg"`,
            "Content-Transfer-Encoding: base64",
            "Content-Id: <riara-banner>",
            "",
            b64(banner.base64),
            `--${related}--`,
          ].join("\r\n")
        );
      } else {
        parts.push([`--${mixed}`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n"));
      }
      for (const a of attachments) {
        const safeName = a.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
        parts.push(
          [
            `--${mixed}`,
            `Content-Type: ${a.mimeType}; name="${safeName}"`,
            `Content-Disposition: attachment; filename="${safeName}"`,
            "Content-Transfer-Encoding: base64",
            "",
            b64(a.content),
          ].join("\r\n")
        );
      }
      raw = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", parts.join("\r\n"), `--${mixed}--`, ""].join("\r\n");
    }

    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    try {
      await this.gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encoded, threadId },
      });
    } catch (e) {
      const reason = String((e as { errors?: Array<{ reason?: string }>; message?: string })?.errors?.[0]?.reason ?? (e as Error)?.message ?? "");
      // A stale/unknown thread id (conversation deleted, case created outside
      // Gmail) used to kill the send entirely. Retry as a fresh message —
      // the applicant still gets the reply, just as a new thread.
      if (/thread|not found|invalid/i.test(reason)) {
        await this.gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
        return;
      }
      throw e;
    }
  }
}
