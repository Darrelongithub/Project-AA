/**
 * First-run seed data: settings, programmes, intakes, base requirements and
 * reply templates. Idempotent — safe to call on every boot.
 * OR-1: seeds NO staff accounts and no mock data; the first visit to the
 * console walks the owner through creating their own admin account.
 */
import type { Repo } from "./repo";
import { DEFAULT_INTAKES, DEFAULT_PROGRAMMES, DEFAULT_SETTINGS, DEFAULT_STRUCTURED_BASE, DEFAULT_STRUCTURED_COURSES } from "../config";
import { migratedOrganizationOne, migratedAttachmentSets } from "../pack";
import { blockToNodes, CATALOGUE_SEED } from "../admissions/convert";
import type { CourseLevel, RuleNode } from "../types";
import { admissionsPreset } from "../presets/loader";

export const TEMPLATE_SEEDS: Array<{ key: string; name: string; subject: string; body: string }> =
  admissionsPreset().templates;

/** The official admission letter (OR-7: also the reset default). */
export const ADMISSION_LETTER_DEFAULT = admissionsPreset().admissionLetter;

/** OR-7: the official defaults, used by "Reset to default" on the Templates
 * page. Resetting restores exactly what shipped — nothing invented. */
export const TEMPLATE_DEFAULTS: Record<string, { name: string; subject: string; body: string; include_banner: boolean; attach_pack: string }> =
  Object.fromEntries([
    ...TEMPLATE_SEEDS.map((t) => [t.key, { name: t.name, subject: t.subject, body: t.body, include_banner: true, attach_pack: t.key === "docs_request" ? "application" : "none" }]),
    ["admission_letter", ADMISSION_LETTER_DEFAULT],
  ]);

/**
 * PPR P0-4: the migrated education profile's workflow rules — a faithful
 * data-form of the behaviour the hardcoded pipeline chain always had, so
 * migrating to rules changes nothing for existing staff:
 *
 *   INTAKE — a known contact always continues; mail with built-in education
 *   intake signals opens a case; everything else stays parked in Mail.
 *
 *   RESPONSE — complaints and eligibility/fee questions go to a human; a
 *   reference-only message gets the factual status; a fully qualified file
 *   gets the receipt; a status question gets the factual status; an
 *   incomplete clean file is chased with the document request (ladder armed);
 *   anything else becomes an internal human draft. Sends stay behind the
 *   qualification gate (the profile keeps `qualification_gate = 1`).
 */
export function seedEducationWorkflowRules(repo: Repo): void {
  if (repo.getSetting("education_rules_seeded_v1", "")) return;
  const insert = repo.db.prepare(
    "INSERT INTO workflow_rules (organization_id, case_type_id, kind, name, position, enabled, conditions, action) VALUES (1, NULL, ?, ?, ?, 1, ?, ?)"
  );
  const intake: Array<[string, number, unknown, unknown]> = [
    ["Known contact continues the conversation", 0,
      [{ field: "sender_state", value: "known" }],
      { decision: "attach", audit_code: "rule_known_contact" }],
    ["Education intake signals open a case", 1,
      [{ field: "signals", value: "education_intake" }],
      { decision: "create", audit_code: "rule_first_contact" }],
    ["Everything else stays in Mail", 2,
      [{ field: "always", value: true }],
      { decision: "ignore", audit_code: "email_parked_non_intake" }],
  ];
  for (const [name, pos, conditions, action] of intake) {
    insert.run("intake", name, pos, JSON.stringify(conditions), JSON.stringify(action));
  }
  const response: Array<[string, number, unknown, unknown]> = [
    ["Complaints go to a human (high priority)", 0,
      [{ field: "category", op: "in", values: ["complaint"] }],
      { decision: "review", priority: "high", reply_action: "hold", fallback: "human_draft", audit_code: "rule_complaint" }],
    ["Eligibility and fee questions go to a human", 1,
      [{ field: "category", op: "in", values: ["admission_enquiry", "fee_enquiry"] }],
      { decision: "review", reply_action: "hold", fallback: "human_draft", audit_code: "rule_enquiry_triage" }],
    ["Reference-only message gets the factual status", 2,
      [{ field: "body_is_ref", value: true }, { field: "sender_state", value: "known" }],
      { reply_action: "send", template_key: "status_answer", audit_code: "rule_status_ref" }],
    ["Complete file gets the receipt", 3,
      [{ field: "docs_state", values: ["complete"] }],
      { reply_action: "send", template_key: "ack_received", audit_code: "rule_ack" }],
    ["Status question gets the factual status", 4,
      [{ field: "has_attachments", value: false }, { field: "category", op: "in", values: ["missing_document", "follow_up"] }, { field: "docs_state", values: ["any"] }],
      { reply_action: "send", template_key: "status_answer", audit_code: "rule_status_question" }],
    ["Incomplete clean file is chased for documents", 5,
      [{ field: "docs_state", values: ["empty", "missing"] }],
      {
        reply_action: "send",
        template_map: { empty: "docs_request", missing: "missing_documents" },
        followup: "ladder", request_info: true, audit_code: "rule_docs_chase",
      }],
    ["Anything else goes to a human", 6,
      [{ field: "always", value: true }],
      { reply_action: "hold", fallback: "human_draft", audit_code: "rule_human_review" }],
  ];
  for (const [name, pos, conditions, action] of response) {
    insert.run("response", name, pos, JSON.stringify(conditions), JSON.stringify(action));
  }
  repo.setSetting("education_rules_seeded_v1", "1");
}

/**
 * PPR P0-5: attachment sets. The migrated education profile's sets are
 * seeded ONCE from its own labeled migration data — after this, sends read
 * organization-owned sets and nothing else. New organizations start with
 * ZERO sets and upload their own files; they never see the migrated names.
 */
export function seedAttachmentSets(repo: Repo): void {
  if (repo.getSetting("attachment_sets_seeded_v1", "")) return;
  for (const group of migratedAttachmentSets()) {
    const set = repo.createAttachmentSet(1, group.name, group.name === "transfer"
      ? "For applicants transferring credit from another institution"
      : `Migrated ${group.name} pack (legacy education profile)`);
    for (const f of group.files) {
      repo.addAttachmentSetFile(set.id, { filename: f.filename, mime: f.mimeType, content: f.content, provenance: "migrated" });
    }
  }
  repo.setSetting("attachment_sets_seeded_v1", "1");
}

function seedGenericModel(repo: Repo): void {
  const org = repo.db.prepare("SELECT id FROM organizations WHERE id = 1").get();
  const migrated = migratedOrganizationOne();
  if (!org) {
    repo.db.prepare("INSERT INTO organizations (id, name, ref_prefix, theme) VALUES (1, ?, ?, ?)")
      .run(migrated?.name || DEFAULT_SETTINGS.institution_name || "Organization", "RU", JSON.stringify({ primary: "#650019", accent: "#c89a4a" }));
  }
  if (migrated?.tagline && !repo.getSetting("splash_tagline", "")) repo.setSetting("splash_tagline", migrated.tagline);
  // PPR P1-5: the migrated identity's sender display name becomes real org
  // data applied to outgoing mail (it used to sit dead in settings).
  if (migrated?.fromName) {
    const org = repo.getOrganization(1);
    if (org && !org.from_name) repo.updateOrganization(1, { fromName: migrated.fromName });
    repo.db.prepare("DELETE FROM settings WHERE key = 'from_name'").run();
  }
  // Case types are the canonical generic equivalent of the legacy programme
  // catalogue. Codes are stable, so this is safe on every boot. PPR P0-2:
  // the migrated academic profiles carry the education module with today's
  // exact automation posture — qualification-gated sends AND the preserved
  // legacy provisional-admission behaviour (M-3 restored auto-admit routing).
  // New organizations never go through this path: their profiles are created
  // through the console with draft automation and auto-admit OFF.
  for (const p of DEFAULT_PROGRAMMES) {
    repo.createCaseType(1, { code: p.code, name: p.name, category: p.school || "general", educationModule: true, qualificationGate: true, defaultReplyAction: "send", autoAdmit: true });
  }
  repo.createCaseType(1, { code: "GENERAL", name: "General enquiry", category: "general", educationModule: true, qualificationGate: true, defaultReplyAction: "send", autoAdmit: true });
  const categories = [
    ["admission", "Admission enquiry"], ["normal", "Normal enquiry"],
    ["document_submission", "Document submission"], ["support", "Support"],
  ] as const;
  for (const [key, label] of categories) repo.addEmailCategory(1, { key, label });
  for (const key of [
    "application-form", "brochure-2026", "student-medical-form", "data-protection-form",
    "next-of-kin-form", "hostels-list", "fee-structure-2026", "sponsorship-form",
    "orientation-programme-2026", "credit-transfer-form",
  ]) {
    const exists = repo.db.prepare("SELECT 1 FROM organization_pack_slots WHERE organization_id = 1 AND key = ?").get(key);
    if (!exists) repo.db.prepare("INSERT INTO organization_pack_slots (organization_id, key) VALUES (1, ?)").run(key);
  }
  // Backfill ownership without rewriting or deleting any legacy row.
  repo.db.prepare("UPDATE applicants SET organization_id = 1 WHERE organization_id IS NULL").run();
  repo.db.prepare("UPDATE applicants SET category = COALESCE(category, programme) WHERE category IS NULL").run();
  repo.db.prepare("UPDATE applicants SET case_type_id = (SELECT id FROM case_types WHERE organization_id = 1 AND code = applicants.programme) WHERE case_type_id IS NULL AND programme IS NOT NULL").run();
  repo.db.prepare("UPDATE staff_users SET organization_id = 1 WHERE organization_id IS NULL").run();
  repo.db.prepare("UPDATE templates SET organization_id = 1 WHERE organization_id IS NULL").run();
}

export function seedDefaults(repo: Repo, opts: { live?: boolean } = {}): void {
  seedGenericModel(repo);
  // PPR P0-5: the migrated profile's attachment sets — before templates,
  // which reference them by name and must resolve.
  seedAttachmentSets(repo);
  // PPR P0-4: the migrated education profile's first-email/response rules —
  // seeded once, then they belong to the staff like every other rule.
  seedEducationWorkflowRules(repo);
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
    // Systems without an automated rule route (humans decide them) come from
    // the preset; every other system seeds under its own code.
    const noAutoRoute = new Set(admissionsPreset().noAutomatedRuleRoute);
    for (const b of DEFAULT_STRUCTURED_BASE) {
      if (noAutoRoute.has(b.block.system)) continue;
      seedTree(null, b.level, b.block.system, blockToNodes(b.block));
    }
    for (const c of DEFAULT_STRUCTURED_COURSES) {
      if (noAutoRoute.has(c.block.system)) continue;
      const level = DEFAULT_PROGRAMMES.find((p) => p.code === c.programme)?.level ?? "degree";
      seedTree(c.programme, level, c.block.system, blockToNodes(c.block));
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
  const dates = admissionsPreset().admissionDates;
  if (!repo.getSetting("reg_date", "")) repo.setSetting("reg_date", dates.regDate);
  if (!repo.getSetting("orientation_dates", "")) repo.setSetting("orientation_dates", dates.orientationDates);

  // No generic banner is seeded. An organization can upload its own logo or
  // configure a banner through the organization-owned branding settings.

  repo.purgeExpiredSessions();
}
