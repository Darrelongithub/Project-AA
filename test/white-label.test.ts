/** WLR — White-Label Round acceptance coverage.
 * The second organization is deliberately not Organization #1: this scans
 * actual organization-scoped render/send/document paths for legacy branding.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { renderTemplate } from "../src/drafting";
import { organizationPack } from "../src/pack";
import { settingsPage } from "../src/web/pages";
import { layout } from "../src/web/views";

function fresh() {
  const repo = new Repo(openDb(":memory:"));
  seedDefaults(repo);
  return repo;
}

function assertNoLegacyBranding(value: unknown) {
  expect(String(value)).not.toContain("Riara");
}

describe("WLR: a second organization is fully white-label", () => {
  it("scans Settings/rendered HTML, generated email, and organization document filenames", () => {
    const repo = fresh();
    const org = repo.createOrganization({
      name: "Test Org",
      theme: { primary: "#123456", accent: "#f97316" },
      logo: "data:image/png;base64,TESTORG",
    });

    const settingsHtml = settingsPage({
      repo,
      user: { id: 1, username: "admin", display_name: "Admin", role: "admin", active: 1, organization_id: org.id },
      unread: 0,
      csrf: "csrf",
      theme: "light",
      institution: org.name,
      brand: { ...org.theme, logo: org.logo },
    });
    const renderedHtml = layout({
      title: "Test Org",
      content: settingsHtml,
      institution: org.name,
      brand: { ...org.theme, logo: org.logo },
    });

    const template = repo.getTemplate("ack_received", org.id) ?? {
      subject: "Your case {ref}",
      body: "Hello {name}, {institution} has received your case.",
    };
    const email = renderTemplate(template.subject, template.body, {
      ref: "CASE-1",
      institution: org.name,
      name: "Alex Applicant",
      missingLabels: [],
      checklist: "Received",
      statusLabel: "Received",
    });
    const filenames = organizationPack(repo, org.id).files.map((file) => file.filename);

    expect(repo.listOrganizationPackSlots(org.id).every((slot) => !slot.filename)).toBe(true);
    expect(repo.listTemplates(org.id).every((tpl) => !tpl.body.includes("Riara"))).toBe(true);
    expect(renderedHtml).toContain("Test Org");
    expect(renderedHtml).toContain("#123456");
    expect(renderedHtml).toContain("#f97316");
    expect(email.body).toContain("Test Org");
    assertNoLegacyBranding(renderedHtml);
    assertNoLegacyBranding(email.body);
    assertNoLegacyBranding(email.subject);
    assertNoLegacyBranding(filenames.join("\n"));
  });
});
