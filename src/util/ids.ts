import * as crypto from "crypto";

/**
 * Unique ids for staff- and system-composed outbound mail rows. The old
 * `${prefix}-${Date.now()}` scheme collided whenever two sends landed in
 * the same millisecond — exactly what a double-clicked Send button or a
 * retried POST produces — leaving duplicate message_ids in the thread.
 * Timestamp (base36, for human debugging) plus 32 bits of randomness.
 */
export function outgoingMessageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}
