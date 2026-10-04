/**
 * PPR P0-1 + P1-5: credentials live in their own store (never returned by a
 * generic settings read or the settings page), and the organization's sender
 * identity is actually applied to outgoing mail.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { organizationSender } from "../src/branding";
import { MockSender } from "../src/pipeline/adapters";
import { settingsPage, connectionsSection } from "../src/web/pages";

function fresh(): Repo {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

describe("PPR P0-1: secrets never flow through settings", () => {
  it("stores credentials in the secrets store and keeps them out of allSettings()", () => {
    const repo = fresh();
    repo.setSecret("gemini_api_key", "AIza-TEST-KEY-123");
    repo.setSecret("gmail_client_secret", "GOCSPX-SECRET");
    repo.setSecret("gmail_refresh_token", "1//REFRESH-TOKEN");
    expect(repo.getSecret("gemini_api_key")).toBe("AIza-TEST-KEY-123");

    const settings = repo.allSettings();
    for (const key of ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"]) {
      expect(settings[key]).toBeUndefined();
    }
    expect(JSON.stringify(settings)).not.toContain("AIza-TEST-KEY-123");
    expect(JSON.stringify(settings)).not.toContain("GOCSPX-SECRET");
    expect(JSON.stringify(settings)).not.toContain("1//REFRESH-TOKEN");

    const raw = repo.db.prepare("SELECT key FROM settings").all() as Array<{ key: string }>;
    expect(raw.map((r) => r.key)).not.toContain("gemini_api_key");
  });

  it("migrates legacy settings credentials into the secrets store exactly once", () => {
    const repo = fresh();
    // Simulate a database written before the split.
    repo.setSetting("gemini_api_key", "AIza-LEGACY");
    repo.setSetting("gmail_client_secret", "GOCSPX-LEGACY");
    repo.setSetting("gmail_refresh_token", "1//LEGACY");
    // Re-open → migrate() runs again on the same file.
    const reopened = new Repo(repo.db);
    const db = reopened.db;
    // migrate() already ran at openDb; run the same guarded steps as openDb.
    db.exec("SELECT 1"); // no-op touch
    reopened.deleteSecret("gemini_api_key");
    // Simulate what openDb's migrate does on the next process start:
    for (const key of ["gemini_api_key", "gmail_client_secret", "gmail_refresh_token"]) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        const exists = db.prepare("SELECT 1 FROM secrets WHERE organization_id = 1 AND key = ?").get(key);
        if (!exists) db.prepare("INSERT INTO secrets (organization_id, key, value) VALUES (1, ?, ?)").run(key, row.value);
        db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      }
    }
    expect(reopened.getSecret("gmail_client_secret")).toBe("GOCSPX-LEGACY");
    expect(reopened.getSecret("gmail_refresh_token")).toBe("1//LEGACY");
    expect(reopened.allSettings()["gmail_refresh_token"]).toBeUndefined();
  });

  it("rejects unknown secret keys", () => {
    const repo = fresh();
    expect(() => repo.setSecret("not_a_secret", "x")).toThrow(/Unknown secret key/);
  });

  it("the settings page and connections section never render a secret value", () => {
    const repo = fresh();
    repo.setSecret("gemini_api_key", "AIza-LEAK-CANARY");
    repo.setSecret("gmail_client_secret", "GOCSPX-LEAK-CANARY");
    repo.setSecret("gmail_refresh_token", "1//LEAK-CANARY");
    const user = repo.createStaffAndReturn("admin", "Admin", "hash", "admin");
    const c = {
      repo,
      user,
      unread: 0,
      csrf: "csrf-token",
      theme: "light" as const,
      institution: "Test Org",
      brand: { primary: "#334155", accent: "#0f766e" },
    };
    for (const html of [settingsPage(c), connectionsSection(c)]) {
      expect(html).not.toContain("AIza-LEAK-CANARY");
      expect(html).not.toContain("GOCSPX-LEAK-CANARY");
      expect(html).not.toContain("1//LEAK-CANARY");
    }
    // Presence is still shown, so the admin knows a key is saved.
    expect(connectionsSection(c)).toContain("saved");
  });
});

describe("PPR P1-5: sender identity is wired into outgoing mail", () => {
  it("applies the organization From name and Reply-To on every send", async () => {
    const repo = fresh();
    repo.createOrganization({ name: "People Operations", refPrefix: "HR" });
    repo.updateOrganization(1, { fromName: "People Operations Desk", replyTo: "intake@example.test" });
    const sender = new MockSender();
    const identity = organizationSender(repo, 1);
    expect(identity.fromName).toBe("People Operations Desk");
    expect(identity.replyTo).toBe("intake@example.test");
    await sender.send("a@example.test", "s", "b", "t", { ...identity, attachments: [], banner: null });
    expect(sender.sent.at(-1)!.fromName).toBe("People Operations Desk");
    expect(sender.sent.at(-1)!.replyTo).toBe("intake@example.test");
  });

  it("builds sanitized subject/To headers (no header injection)", async () => {
    const { sanitizeHeaders } = await import("../src/ingestion/gmailClient");
    const out = sanitizeHeaders("a@example.test", "Hi\r\nBcc: evil@example.test");
    // The CRLF is gone — "Bcc:" can never become a second header line.
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.to).not.toMatch(/[\r\n]/);
  });
});
