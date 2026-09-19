/**
 * First-run seed data: settings, programmes, intakes, base requirements and
 * reply templates. Idempotent — safe to call on every boot.
 * OR-1: seeds NO staff accounts and no mock data; the first visit to the
 * console walks the owner through creating their own admin account.
 */
import type { Repo } from "./repo";
import { DEFAULT_INTAKES, DEFAULT_PROGRAMMES, DEFAULT_REQUIREMENTS, DEFAULT_SETTINGS, DEFAULT_STRUCTURED_BASE, DEFAULT_STRUCTURED_COURSES } from "../config";
import { defaultEmailBanner } from "../pack";
import { blockToNodes, CATALOGUE_SEED } from "../admissions/convert";
import type { CourseLevel, RuleNode } from "../types";

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

{document_issues}

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

{read_back}

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

/** The official admission letter (OR-7: also the reset default). */
export const ADMISSION_LETTER_DEFAULT = {
  name: "Admission letter (with full admission pack)",
  subject: "Welcome to Riara University — Your Admission to {programme}",
  body: `Dear {name},

Welcome to Riara University!

Congratulations on your admission to the {programme} programme. We are delighted to extend our warmest greetings as you embark on an exciting academic journey with us. Your admission to Riara University (RU) signifies the beginning of an enriching and transformative experience, and we are thrilled to have you as part of our vibrant community.

In preparation for the upcoming semester, please note the following important information and deadlines:

Registration Date: registration and verification of your original documents is scheduled on or before {reg_date}. Please ensure your timely arrival to facilitate a smooth transition into university life.

Orientation: the orientation programme is set for {orientation_dates}, where you will receive valuable information about our academic policies, support services and campus resources. Attendance is essential for all new students.

Documents for Verification: bring the following (originals and copies): i) certificates (high school, certificate, diploma and/or degree), ii) one passport-size photograph, iii) ID card or passport (or a waiting card / parent or guardian ID where applicable), and iv) birth certificate.

Laptop Requirement: it is mandatory for all students to own a personal laptop upon admission.

Enclosed with this letter you will find the student medical form, data protection form, next of kin form, hostels list, fee structure, sponsorship form and the orientation programme — complete them and bring them for verification.

Your reference number: {ref}.

Kind regards,
{institution} — Admissions Office`,
  include_banner: true,
  attach_pack: "admission",
};

/** OR-7: the official defaults, used by "Reset to default" on the Templates
 * page. Resetting restores exactly what shipped — nothing invented. */
export const TEMPLATE_DEFAULTS: Record<string, { name: string; subject: string; body: string; include_banner: boolean; attach_pack: string }> =
  Object.fromEntries([
    ...TEMPLATE_SEEDS.map((t) => [t.key, { name: t.name, subject: t.subject, body: t.body, include_banner: true, attach_pack: t.key === "docs_request" ? "application" : "none" }]),
    ["admission_letter", ADMISSION_LETTER_DEFAULT],
  ]);

export function seedDefaults(repo: Repo, opts: { live?: boolean } = {}): void {
  // Older versions had a NULL-broken rule upsert that duplicated every base
  // requirement row on each re-seed. Clean that up idempotently.
  repo.dedupeRules();

  // Settings
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = repo.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k);
    if (!existing) repo.setSetting(k, v);
  }
  // Programmes & intakes — the real catalogue, grouped by school, with the
  // official entry requirements as reference text for staff.
  for (const p of DEFAULT_PROGRAMMES) {
    repo.addProgramme(p.code, p.name, p.school, p.entry, p.level);
  }
  for (const i of DEFAULT_INTAKES) {
    repo.addIntake(i);
  }
  // Structured entry requirements — seeded ONCE per database. After that the
  // requirements belong to the staff: edits AND deletions in Configuration
  // persist across restarts (a per-row existence check would resurrect them).
  if (!repo.getSetting("structured_requirements_seeded", "")) {
    for (const b of DEFAULT_STRUCTURED_BASE) {
      repo.upsertSystemBlock(null, b.level, b.block);
    }
    for (const c of DEFAULT_STRUCTURED_COURSES) {
      const level = DEFAULT_PROGRAMMES.find((p) => p.code === c.programme)?.level ?? "degree";
      repo.upsertSystemBlock(c.programme, level, c.block);
    }
    repo.setSetting("structured_requirements_seeded", "v1-published-set");
  }
  // Admissions rules engine (round 18): subject catalogue + machine-evaluable
  // rule trees per (programme, qualification system). Seeded once — after that
  // the rules belong to the staff and are versioned per activation.
  const setCount = (repo.db.prepare("SELECT COUNT(*) AS n FROM admission_rules").get() as { n: number }).n;
  if (setCount === 0) {
    repo.seedCatalogue(CATALOGUE_SEED);
    const insertSet = repo.db.prepare(
      "INSERT INTO admission_rules (programme, level, system, version, status, created_by) VALUES (?,?,?,1,'active','seed')"
    );
    const insertNode = repo.db.prepare(
      "INSERT INTO admission_rule_nodes (set_id, parent_id, kind, logic, field, subject, comparator, value, position) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    const seedTree = (programme: string | null, level: CourseLevel, system: string, nodes: RuleNode[]): void => {
      const res = insertSet.run(programme, level, system);
      const setId = Number(res.lastInsertRowid);
      const write = (n: RuleNode, parentId: number | null): void => {
        const r = insertNode.run(
          setId, parentId, n.kind, n.kind === "group" ? (n.logic ?? "AND") : null,
          n.kind === "condition" ? (n.field ?? "mean_grade") : null,
          n.kind === "condition" ? (n.subject ?? null) : null,
          ">=", n.kind === "condition" ? (n.value ?? null) : null, n.position ?? 0
        );
        for (const c of n.children ?? []) write(c, Number(r.lastInsertRowid));
      };
      for (const n of nodes) write(n, null);
    };
    const SYSTEM_MAP: Record<string, string | null> = {
      KCSE: "KCSE", IGCSE: "IGCSE", ALEVEL: "ALEVEL", IB: "IB",
      DIPLOMA: "DIPLOMA", DEGREE: "DEGREE", PREUNI: null, // no automated PREUNI route — humans decide it
    };
    for (const b of DEFAULT_STRUCTURED_BASE) {
      const sys = SYSTEM_MAP[b.block.system];
      if (!sys) continue;
      seedTree(null, b.level, sys, blockToNodes(b.block));
    }
    for (const c of DEFAULT_STRUCTURED_COURSES) {
      const sys = SYSTEM_MAP[c.block.system];
      if (!sys) continue;
      const level = DEFAULT_PROGRAMMES.find((p) => p.code === c.programme)?.level ?? "degree";
      seedTree(c.programme, level, sys, blockToNodes(c.block));
    }
  }
  // OR-5: document requirements are generated deterministically from the
  // official application-form checklist (src/documents/matrix.ts). The legacy
  // requirement_rules table is no longer seeded or read — it was the old
  // staff-editable toggle surface and is deliberately retired.
  // Templates (same: don't clobber edits). OR-7: docs_request carries the
  // application pack by default — the pipeline and manual sends both honour
  // the per-template flag.
  const tplCount = (repo.db.prepare("SELECT COUNT(*) AS n FROM templates").get() as { n: number }).n;
  if (tplCount === 0) {
    for (const t of TEMPLATE_SEEDS) {
      repo.upsertTemplate(t.key, t.name, t.subject, t.body, undefined, t.key === "docs_request" ? "application" : "none");
    }
  } else {
    for (const t of TEMPLATE_SEEDS) {
      const exists = repo.db.prepare("SELECT 1 FROM templates WHERE key = ?").get(t.key);
      if (!exists) repo.upsertTemplate(t.key, t.name, t.subject, t.body, undefined, t.key === "docs_request" ? "application" : "none");
    }
  }
  // Staff users: intentionally NONE. OR-1 — the product ships with no
  // accounts and no default credentials. The very first visit to the console
  // shows a one-time setup screen where the owner creates their own admin
  // account (see /setup in src/web/server.ts). Test suites create accounts
  // explicitly through repo.createStaff.
  void opts;
  // Admission letter: the official template (name + dates vary per student).
  if (!repo.getTemplate("admission_letter")) {
    const d = ADMISSION_LETTER_DEFAULT;
    repo.upsertTemplate("admission_letter", d.name, d.subject, d.body, d.include_banner, d.attach_pack);
  }

  // Admission-letter dates (editable in Settings → Response targets).
  if (!repo.getSetting("reg_date", "")) repo.setSetting("reg_date", "Monday 31st August, 2026");
  if (!repo.getSetting("orientation_dates", "")) repo.setSetting("orientation_dates", "Thursday 3rd and Friday 4th September, 2026");

  // Email banner: seed the bundled official banner once; staff can replace it
  // in Configuration → Email branding.
  if (!repo.getSetting("email_banner", "")) {
    const banner = defaultEmailBanner();
    if (banner) {
      repo.setSetting("email_banner", banner.base64);
      repo.setSetting("email_banner_mime", banner.mime);
    }
  }

  repo.purgeExpiredSessions();
}
