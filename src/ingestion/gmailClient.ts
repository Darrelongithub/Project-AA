/**
 * /ingestion — live Gmail access via the Gmail API (googleapis).
 *
 * Auth: OAuth2 "installed app" style — client id/secret + a refresh token
 * for the test inbox. Only what the pipeline needs is implemented:
 *   - list recent inbox message ids
 *   - fetch one message with attachments
 *   - send a plain-text reply inside a thread
 */
import type { IncomingEmail } from "../types";

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

  constructor(cfg: {
    address: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    oauth2.setCredentials({ refresh_token: cfg.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth: oauth2 });
    this.address = cfg.address;
  }

  async listRecentMessageIds(lookbackDays: number, maxResults = 50): Promise<string[]> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: `in:inbox newer_than:${lookbackDays}d`,
      maxResults,
    });
    return ((res.data.messages || []) as Array<{ id: string }>).map((m) => m.id);
  }

  async fetchEmail(id: string): Promise<IncomingEmail> {
    const res = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    const msg = res.data;
    const headers: Record<string, string> = {};
    for (const h of msg.payload.headers || []) headers[h.name.toLowerCase()] = h.value;

    const fromHeader = headers["from"] || "";
    const fromMatch = fromHeader.match(/<([^<>]+)>/) || fromHeader.match(/([^\s<>]+@[^\s<>]+)/);
    const from = fromMatch ? fromMatch[1] : fromHeader;
    const nameMatch = fromHeader.match(/^"?\s*([^"<]+?)\s*"?\s*</);

    const bodyParts: string[] = [];
    const attachments: Array<{ filename: string; mimeType: string; attachmentId: string }> = [];

    const walk = (part: MimePartNode) => {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
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
      attachments.map(async (a) => {
        const attRes = await this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId: id,
          id: a.attachmentId,
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
      receivedAt: new Date(Number(msg.internalDate)).toISOString(),
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
    await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId },
    });
  }
}
