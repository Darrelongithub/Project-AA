/** Dedicated tpl renderer and non-destructive legacy-template migration. */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderTemplate } from "../src/drafting";
import { TemplatePartialError, inspectTemplate, renderTpl } from "../src/drafting/tpl";
import { LEGACY_TEMPLATE_MIGRATION_MARKER, openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tpl.ts partial/include renderer", () => {
  it("composes nested partials before replacing values", () => {
    const rendered = renderTpl(
      "{{> wrapper}}",
      { first_name: "Alex", institution: "Example Cooperative" },
      {
        wrapper: "{{> greeting}}\n\n{{> signature}}",
        greeting: "Hello {first_name},",
        signature: "Regards,\n{institution}",
      }
    );

    expect(rendered).toBe("Hello Alex,\n\nRegards,\nExample Cooperative");
  });

  it("wires default partials through the existing outgoing renderer", () => {
    const rendered = renderTemplate(
      "{{> case_reference}}",
      "{{> greeting}}\n\n{{> missing_information}}\n\n{{> organization_signature}}",
      {
        ref: "ORG-2026-000001",
        institution: "Example Cooperative",
        name: "Alex Morgan",
        missingLabels: ["Identity document"],
        checklist: "✗ Identity document",
        statusLabel: "Received",
      }
    );

    expect(rendered.subject).toBe("[ORG-2026-000001] Case reference: ORG-2026-000001");
    expect(rendered.body).toContain("Hello Alex,");
    expect(rendered.body).toContain("We are still missing:");
    expect(rendered.body).toContain("Example Cooperative");
    expect(rendered.body).not.toMatch(/\{\{|\{first_name\}|\{institution\}/);
  });

  it("reports unknown directives and throws typed errors instead of dropping them", () => {
    expect(inspectTemplate("{{> not_registered}} {made_up}")).toMatchObject({
      unknownPartials: ["not_registered"],
      unknownTokens: ["made_up"],
    });

    let thrown: unknown;
    try { renderTpl("{{> not_registered}}", {}); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TemplatePartialError);
    expect(thrown).toMatchObject({ code: "TEMPLATE_PARTIAL_ERROR", partialName: "not_registered" });
  });

  it("refuses recursive partial cycles with the include chain", () => {
    expect(() => renderTpl("{{> first}}", {}, { first: "{{> second}}", second: "{{> first}}" }))
      .toThrow(/first -> second -> first/);
  });
});

describe("legacy templates → organization_templates migration", () => {
  function prepareLegacyDatabase(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-tpl-migration-"));
    tempDirs.push(dir);
    const file = path.join(dir, "legacy.sqlite");
    const db = openDb(file);
    db.prepare("INSERT INTO organizations (id, name, ref_prefix) VALUES (1, 'Legacy Tenant', 'LEG')").run();
    db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_TEMPLATE_MIGRATION_MARKER);
    db.prepare(
      `INSERT INTO templates
         (key, organization_id, name, subject, body, include_banner, attach_pack, default_snapshot, updated_at)
       VALUES (?, 1, ?, ?, ?, 0, 'none', ?, ?)`
    ).run(
      "legacy_reply",
      "Legacy reply",
      "Legacy subject {ref}",
      "Legacy body for {institution}",
      JSON.stringify({
        name: "Legacy default",
        subject: "Default subject {ref}",
        body: "Default body",
        include_banner: 0,
        attach_pack: "none",
      }),
      "2025-01-02 03:04:05"
    );
    db.close();
    return file;
  }

  it("copies every field, preserves the source row, and marks the one-shot migration", () => {
    const file = prepareLegacyDatabase();
    const db = openDb(file);

    const source = db.prepare(
      "SELECT key, organization_id, name, subject, body, include_banner, attach_pack, default_snapshot, updated_at FROM templates WHERE key = 'legacy_reply'"
    ).get() as Record<string, unknown>;
    const migrated = db.prepare(
      "SELECT key, organization_id, name, subject, body, include_banner, attach_pack, default_snapshot, updated_at FROM organization_templates WHERE key = 'legacy_reply'"
    ).get() as Record<string, unknown>;

    expect(migrated).toEqual(source);
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get(LEGACY_TEMPLATE_MIGRATION_MARKER)).toEqual({ value: "1" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM templates WHERE key = 'legacy_reply'").get()).toEqual({ n: 1 });
    db.close();
  });

  it("never overwrites a newer organization row", () => {
    const file = prepareLegacyDatabase();
    let db = openDb(file);
    db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_TEMPLATE_MIGRATION_MARKER);
    db.prepare(
      `INSERT INTO organization_templates
         (organization_id, key, name, subject, body, include_banner, attach_pack, case_type_id)
       VALUES (1, 'legacy_reply', 'New name', 'New subject', 'New body', 1, 'none', 0)
       ON CONFLICT(organization_id, key) DO UPDATE SET name='New name', subject='New subject', body='New body'`
    ).run();
    db.close();

    db = openDb(file);
    expect(db.prepare("SELECT name, subject, body FROM organization_templates WHERE organization_id = 1 AND key = 'legacy_reply'").get())
      .toEqual({ name: "New name", subject: "New subject", body: "New body" });
    expect(db.prepare("SELECT name, subject, body FROM templates WHERE key = 'legacy_reply'").get())
      .toEqual({ name: "Legacy reply", subject: "Legacy subject {ref}", body: "Legacy body for {institution}" });
    db.close();
  });

  it("keeps the legacy fallback readable and writes later edits only to the new store", () => {
    const file = prepareLegacyDatabase();
    let db = openDb(file);
    db.prepare("DELETE FROM organization_templates WHERE organization_id = 1 AND key = 'legacy_reply'").run();
    db.close();

    // The marker prevents source resurrection, while the fallback still reads
    // the untouched source row.
    db = openDb(file);
    const repo = new Repo(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM organization_templates WHERE key = 'legacy_reply'").get()).toEqual({ n: 0 });
    expect(repo.getTemplate("legacy_reply", 1)?.body).toBe("Legacy body for {institution}");

    repo.upsertTemplate("legacy_reply", "Edited reply", "Edited {ref}", "Edited for {institution}", true, "none", 1);
    expect(repo.getTemplate("legacy_reply", 1)?.body).toBe("Edited for {institution}");
    expect(db.prepare("SELECT body FROM organization_templates WHERE organization_id = 1 AND key = 'legacy_reply'").get())
      .toEqual({ body: "Edited for {institution}" });
    expect(db.prepare("SELECT body FROM templates WHERE key = 'legacy_reply'").get())
      .toEqual({ body: "Legacy body for {institution}" });
    expect(repo.templateDefaultSnapshot("legacy_reply", 1)?.subject).toBe("Default subject {ref}");
    db.close();
  });

  it("withholds the marker for orphan tenant rows so a later boot can finish safely", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-tpl-orphan-"));
    tempDirs.push(dir);
    const file = path.join(dir, "orphan.sqlite");
    let db = openDb(file);
    db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_TEMPLATE_MIGRATION_MARKER);
    db.prepare("INSERT INTO templates (key, organization_id, name, subject, body) VALUES ('orphan', 99, 'Orphan', 'Subject', 'Body')").run();
    db.close();

    db = openDb(file);
    expect(db.prepare("SELECT 1 FROM settings WHERE key = ?").get(LEGACY_TEMPLATE_MIGRATION_MARKER)).toBeUndefined();
    expect(new Repo(db).getTemplate("orphan", 99)?.name).toBe("Orphan");
    expect(db.prepare("SELECT COUNT(*) AS n FROM templates WHERE key = 'orphan'").get()).toEqual({ n: 1 });
    db.close();
  });
});
