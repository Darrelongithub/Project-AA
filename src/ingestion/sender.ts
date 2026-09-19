/**
 * The outgoing-mail sender used by BOTH live entry points (`npm run serve`
 * and `npm run ingest`). One implementation, so pack attachments and the
 * banner can never be silently dropped on one path while working on the other.
 */
import type { GmailClient } from "./gmailClient";
import type { EmailSender, SendExtras } from "../pipeline/adapters";

export class GmailSender implements EmailSender {
  constructor(private gmail: Pick<GmailClient, "sendReply">) {}
  async send(to: string, subject: string, body: string, threadId: string, extras?: SendExtras): Promise<void> {
    await this.gmail.sendReply(to, subject, body, threadId, extras);
  }
}
