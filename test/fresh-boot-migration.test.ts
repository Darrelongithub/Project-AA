/**
 * Boot-time migrations on real files.
 *
 * These checks deliberately open file-based databases instead of `:memory:`:
 * an in-memory fixture is created inside the same connection that already knows
 * the current schema, so it can never show a migration tripping over state an
 * older release left behind. Two such states are pinned here — a genuinely empty
 * file (a fresh install) and a legacy file whose `UNIQUE (email_address,
 * thread_id)` constraint is rebuilt while a `cases` view still references the
 * table. The second one used to abort every boot with
 * `error in view cases: no such table: main.applicants`.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db/db";

const LEGACY_TABLES = `
  CREATE TABLE applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref_number TEXT NOT NULL UNIQUE,
    email_address TEXT NOT NULL, thread_id TEXT NOT NULL, full_name TEXT,
    intake TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    lifecycle TEXT NOT NULL DEFAULT 'application_received', requirements_snapshot TEXT,
    decision_by TEXT, decision_reason TEXT, decision_at TEXT, req_result TEXT, routing TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (email_address, thread_id));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, logo TEXT,
    ref_prefix TEXT NOT NULL DEFAULT 'ORG', theme TEXT, created_at TEXT);
  CREATE TABLE intakes (name TEXT PRIMARY KEY, deadline TEXT);
  CREATE TABLE processed_emails (email_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE templates (key TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

describe("fresh file-based database boot", () => {
  let tempDir: string | undefined;

  /** A file exactly as an older release would have left it: one real case row,
   * the pre-tenant uniqueness constraint and the extra statements given below. */
  function buildLegacyFile(name: string, extra: (db: Database.Database) => void = () => {}): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-fresh-boot-"));
    const file = path.join(tempDir, `${name}.sqlite`);
    const db = new Database(file);
    db.pragma("foreign_keys = OFF");
    db.exec(LEGACY_TABLES);
    db.prepare("INSERT INTO applicants (ref_number, email_address, thread_id, full_name) VALUES (?, ?, ?, ?)").run("LW-2025-000123", "amara@example.test", "t-1", "Amara Njoroge");
    db.prepare("INSERT INTO organizations (id, name) VALUES (1, ?)").run("Legacy Workspace Ltd");
    db.prepare("INSERT INTO intakes (name, deadline) VALUES (?, ?)").run("September 2025", "2025-08-01");
    db.prepare("INSERT INTO processed_emails (email_id) VALUES (?)").run("m-1");
    extra(db);
    db.close();
    return file;
  }

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("migrates a genuinely empty SQLite file before creating the cases view", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-aa-fresh-boot-"));
    const file = path.join(tempDir, "fresh.sqlite");
    fs.writeFileSync(file, "");
    expect(fs.statSync(file).size).toBe(0);

    const db = openDb(file);
    try {
      expect(db.name).toBe(file);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(
        db.prepare("SELECT name, type FROM sqlite_master WHERE name IN (?, ?) ORDER BY name").all("applicants", "cases")
      ).toEqual([
        { name: "applicants", type: "table" },
        { name: "cases", type: "view" },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("rebuilds the applicants constraint on a legacy file that still has the cases view", () => {
    const file = buildLegacyFile("view", (db) => db.exec("CREATE VIEW cases AS SELECT a.* FROM applicants a"));

    const db = openDb(file);
    try {
      // The reported failure was here: the view made SQLite abort the rename
      // that follows the applicants rebuild, so nothing was ever migrated.
      const definition = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'applicants'").get() as { sql: string }).sql;
      expect(definition).toMatch(/UNIQUE \(organization_id, email_address, thread_id\)/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE ref_number = 'LW-2025-000123'").get()).toEqual({ n: 1 });
      // Rows, ids and the AUTOINCREMENT high-water mark survive the rebuild.
      expect((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'applicants'").get() as { seq: number }).seq).toBe(1);
      // The compatibility view is back, and it reads the rebuilt table.
      expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'cases'").get()).toEqual({ type: "view" });
      expect(db.prepare("SELECT full_name FROM cases WHERE ref_number = 'LW-2025-000123'").get()).toEqual({ full_name: "Amara Njoroge" });
      // The submission window was rebuilt per tenant in the same transaction.
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'intakes'").get() as { sql: string }).sql).toMatch(/PRIMARY KEY \(organization_id, name\)/);
      expect(db.prepare("SELECT deadline FROM intakes WHERE name = 'September 2025'").get()).toEqual({ deadline: "2025-08-01" });
    } finally {
      db.close();
    }

    // Re-opening a migrated database must be a no-op, not a second migration.
    const again = openDb(file);
    try {
      expect(again.prepare("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 1 });
    } finally {
      again.close();
    }
  });

  it("restores an organization's own view over a rebuilt table", () => {
    const file = buildLegacyFile("own-view", (db) => db.exec("CREATE VIEW v_roster AS SELECT ref_number, full_name FROM applicants WHERE lifecycle = 'application_received'"));

    const db = openDb(file);
    try {
      expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'v_roster'").get()).toEqual({ type: "view" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM v_roster").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("refuses to shadow a legacy table named cases instead of hiding its rows", () => {
    const file = buildLegacyFile("table", (db) => {
      db.exec("ALTER TABLE applicants RENAME TO applicants_old");
      db.exec("CREATE TABLE cases (id INTEGER PRIMARY KEY, ref_number TEXT NOT NULL)");
      db.exec("INSERT INTO cases (id, ref_number) VALUES (1, 'LW-2024-000001')");
    });

    expect(() => openDb(file)).toThrow(/legacy table named 'cases'/);
    // The refusal is transactional: the untouched file still holds its rows.
    const check = new Database(file, { readonly: true });
    try {
      expect(check.prepare("SELECT ref_number FROM cases").all()).toEqual([{ ref_number: "LW-2024-000001" }]);
    } finally {
      check.close();
    }
  });
});
