/**
 * First-run seed data: settings, programmes, intakes, base requirements,
 * reply templates, and starter staff accounts.
 * Idempotent — safe to call on every boot.
 */
import * as crypto from "crypto";
import type { Repo } from "./repo";
import { DEFAULT_INTAKES, DEFAULT_PROGRAMMES, DEFAULT_REQUIREMENTS, DEFAULT_SETTINGS } from "../config";
import { hashPassword } from "../util/password";

export const TEMPLATE_SEEDS: Array<{ key: string; name: string; subject: string; body: string }> = [
  {
    key: "ack_received",
    name: "Documents received (complete file)",
    subject: "Your application documents have been received",
    body: `Dear {first_name},

Thank you for submitting your documents. Your application file {ref} is now COMPLETE:

{checklist}

Your file has been forwarded for verification. Current status: {status}.

Please note this acknowledgement confirms receipt only. The final decision on your application will be made by the admissions committee and communicated to you in due course.

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "missing_documents",
    name: "Missing documents notice",
    subject: "We have received some of your documents — action needed",
    body: `Dear {first_name},

We've received your application ({ref}). Thank you. The following documents have been logged so far:

{checklist}

We are still missing:

{missing_docs}

Please send the outstanding item(s) as PDF attachments in reply to this thread. Your file will proceed once it is complete.

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "docs_request",
    name: "Document request (new enquiry)",
    subject: "Your application: the documents we need from you",
    body: `Dear {first_name},

Thank you for your interest in {institution}. To open your application file ({ref}) we need the following documents as PDF attachments:

{missing_docs}

Once received, we will confirm within this thread.

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "status_answer",
    name: "Status answer (have you received my documents?)",
    subject: "The status of your application documents",
    body: `Dear {first_name},

Thank you for your message. Here is the current status of your application file {ref}:

Status: {status}

Your document checklist:

{checklist}

{missing_docs_section}

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "under_review",
    name: "Under review",
    subject: "Your application is under review",
    body: `Dear {first_name},

Your application ({ref}) is currently under review. Current status: {status}.

We will contact you if we need anything further.

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "verification",
    name: "Verification stage",
    subject: "Your application has moved to verification",
    body: `Dear {first_name},

Your application ({ref}) has moved to the verification stage. We are verifying the documents you submitted and will update you once complete.

Kind regards,
{institution} — Admissions Office`,
  },
  {
    key: "generic_enquiry",
    name: "Generic enquiry",
    subject: "Thank you for contacting Admissions",
    body: `Dear {first_name},

Thank you for contacting the {institution} Admissions Office. We have received your message regarding application {ref} and will respond as soon as possible.

Kind regards,
{institution} — Admissions Office`,
  },
];

export function seedDefaults(repo: Repo, opts: { createDemoUsers?: boolean; live?: boolean } = {}): void {
  // Older versions had a NULL-broken rule upsert that duplicated every base
  // requirement row on each re-seed. Clean that up idempotently.
  repo.dedupeRules();

  // Settings
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = repo.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k);
    if (!existing) repo.setSetting(k, v);
  }
  // Programmes & intakes
  for (const p of DEFAULT_PROGRAMMES) {
    const exists = repo.db.prepare("SELECT 1 FROM programmes WHERE code = ?").get(p.code);
    if (!exists) repo.addProgramme(p.code, p.name);
  }
  for (const i of DEFAULT_INTAKES) {
    repo.addIntake(i);
  }
  // Base requirements (only if table is empty — don't clobber staff edits)
  const ruleCount = (repo.db.prepare("SELECT COUNT(*) AS n FROM requirement_rules").get() as { n: number }).n;
  if (ruleCount === 0) repo.seedBaseRequirements(DEFAULT_REQUIREMENTS);
  // Templates (same: don't clobber edits)
  const tplCount = (repo.db.prepare("SELECT COUNT(*) AS n FROM templates").get() as { n: number }).n;
  if (tplCount === 0) {
    for (const t of TEMPLATE_SEEDS) repo.upsertTemplate(t.key, t.name, t.subject, t.body);
  } else {
    for (const t of TEMPLATE_SEEDS) {
      const exists = repo.db.prepare("SELECT 1 FROM templates WHERE key = ?").get(t.key);
      if (!exists) repo.upsertTemplate(t.key, t.name, t.subject, t.body);
    }
  }
  // Staff users
  const userCount = (repo.db.prepare("SELECT COUNT(*) AS n FROM staff_users").get() as { n: number }).n;
  if (userCount === 0) {
    if (opts.live) {
      // LIVE mode pointed at a real inbox must not boot with admin/admin123.
      // Generate a one-time password, print it once, force a rotation.
      const pw = crypto.randomBytes(12).toString("base64url");
      repo.createStaff("admin", "System Administrator", hashPassword(pw), "admin");
      console.warn(`\nseed: LIVE mode — created admin account with one-time password:\n\n    ${pw}\n\nChange it immediately in Staff settings.\n`);
    } else {
      repo.createStaff("admin", "System Administrator", hashPassword("admin123"), "admin");
    }
    // Demo staff accounts belong to the DEMO DATASET only (npm run demo).
    // A fresh production database gets the admin account alone.
    if (opts.createDemoUsers === true && !opts.live) {
      repo.createStaff("manager", "Mary Mwangi (Manager)", hashPassword("manager123"), "manager");
      repo.createStaff("jane", "Jane Wairimu (Officer)", hashPassword("jane123"), "officer");
      repo.createStaff("otis", "Otis Onyango (Officer)", hashPassword("otis123"), "officer");
      repo.createStaff("kofi", "Kofi Mensah (IT)", hashPassword("kofi123"), "it");
    }
  }
  repo.purgeExpiredSessions();
}
