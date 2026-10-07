/**
 * The redesign's other new surfaces: one-click process templates, the email
 * signature, and the per-organization branding rules.
 *
 * `WHAT_CHANGED.md` describes ten changes and, before this file, the suite
 * tested one of them (the CSS in `test/light-mode.test.ts`). These are the
 * parts that can silently affect another tenant — which is exactly the kind of
 * behaviour that must not rely on someone noticing.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults, seedProcessTemplate, PROCESS_TEMPLATES } from "../src/db/seed";
import { addIntakeHotwords, intakeHotwordsFor, DEFAULT_SETTINGS } from "../src/config";
import {
  emailBanner, organizationSignature, formatSignatureHtml, formatSignatureText,
  bodyAlreadySigned, orgSetting, setOrgSetting,
} from "../src/branding";
import { bannerFilename } from "../src/ingestion/gmailClient";

function repo(): Repo {
  const r = new Repo(openDb(":memory:"));
  seedDefaults(r);
  return r;
}

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("process templates", () => {
  it("every advertised template seeds, and seeding twice changes nothing", () => {
    const r = repo();
    const orgId = r.createOrganization({ name: "Template Org", refPrefix: "TPL" }).id;
    for (const tpl of PROCESS_TEMPLATES) {
      const first = seedProcessTemplate(r, orgId, tpl.id);
      expect(first.created).toBe(true);
      expect(first.caseTypeCode).toBe(tpl.code);
      const again = seedProcessTemplate(r, orgId, tpl.id);
      expect(again.created).toBe(false);
      // Idempotent: still exactly one case type, not two.
      expect(r.listCaseTypes(orgId).filter((t) => t.code === tpl.code)).toHaveLength(1);
    }
  });

  it("a starter is draft-first — it never arms an automatic send", () => {
    const r = repo();
    const orgId = r.createOrganization({ name: "Safe Org", refPrefix: "SAF" }).id;
    seedProcessTemplate(r, orgId, "applications");
    const ct = r.getCaseType("APPLICATION", orgId)!;
    expect(ct.default_reply_action).toBe("draft");
    expect(ct.evidence_gate).toBe(1);
  });

  it("refuses an unknown organization instead of writing to a default one", () => {
    const r = repo();
    expect(() => seedProcessTemplate(r, 9999, "generic")).toThrow(/Unknown organization/i);
  });
});

describe("BUG-11 — a process template does not reword another tenant's intake", () => {
  it("seeding for organization 2 leaves organization 1's hotwords alone", () => {
    const r = repo();
    const org1 = r.createOrganization({ name: "One", refPrefix: "ONE" }).id;
    const org2 = r.createOrganization({ name: "Two", refPrefix: "TWO" }).id;
    const before = r.getSetting("intake_hotwords", "");
    expect(before).toBe(DEFAULT_SETTINGS.intake_hotwords);

    seedProcessTemplate(r, org2, "hiring");

    // Organization 1 reads exactly what it had.
    expect(intakeHotwordsFor(r, org1)).toBe(before);
    expect(intakeHotwordsFor(r, org1)).not.toMatch(/vacancy/);
    // Organization 2 sees its own words, on top of the shared defaults.
    expect(intakeHotwordsFor(r, org2)).toMatch(/vacancy/);
    expect(intakeHotwordsFor(r, org2)).toContain(before);
  });

  it("addIntakeHotwords writes to the organization's own key", () => {
    const r = repo();
    addIntakeHotwords(r, 7, ["Banana", "banana", "Plantain"]);
    expect(r.getSetting("intake_hotwords_7", "")).toBe("banana, plantain");
    // de-duplicated, lowercased, and the shared key untouched
    expect(r.getSetting("intake_hotwords", "")).toBe(DEFAULT_SETTINGS.intake_hotwords);
  });
});

describe("BUG-10 — branding belongs to the organization that uploaded it", () => {
  it("organization 2 does not inherit organization 1's banner", () => {
    const r = repo();
    // Organization 1 must exist first: it is the legacy single tenant whose
    // uploads live under the un-suffixed key.
    const org1 = r.createOrganization({ name: "One", refPrefix: "ONE" }).id;
    const org2 = r.createOrganization({ name: "Two", refPrefix: "TWO" }).id;
    expect(org1).toBe(1);
    expect(org2).toBe(2);
    r.setSetting("email_banner", PNG_1PX);
    r.setSetting("email_banner_mime", "image/png");

    expect(emailBanner(r, 1)?.base64).toBe(PNG_1PX);
    // Organization 2 must fall through to its own logo / the default mark,
    // never to another tenant's upload.
    expect(emailBanner(r, org2)?.base64).not.toBe(PNG_1PX);
  });

  it("each organization can have its own banner", () => {
    const r = repo();
    const org2 = r.createOrganization({ name: "Two", refPrefix: "TWO" }).id;
    setOrgSetting(r, "email_banner", org2, "TWO_BANNER");
    setOrgSetting(r, "email_banner_mime", org2, "image/png");
    expect(emailBanner(r, org2)?.base64).toBe("TWO_BANNER");
    expect(emailBanner(r, org2)?.mime).toBe("image/png");
  });

  it("signature fields are scoped the same way", () => {
    const r = repo();
    const org1 = r.createOrganization({ name: "One", refPrefix: "ONE" }).id;
    const org2 = r.createOrganization({ name: "Two", refPrefix: "TWO" }).id;
    setOrgSetting(r, "signature_name", org1, "Org One Signer");
    expect(organizationSignature(r, 1).name).toBe("Org One Signer");
    expect(organizationSignature(r, org2).name).toBe("");

    setOrgSetting(r, "signature_name", org2, "Org Two Signer");
    expect(organizationSignature(r, org2).name).toBe("Org Two Signer");
    expect(organizationSignature(r, 1).name).toBe("Org One Signer");
  });

  it("orgSetting reads the scoped key first and the legacy key only for organization 1", () => {
    const r = repo();
    r.setSetting("legacy_key", "global");
    expect(orgSetting(r, "legacy_key", 1)).toBe("global");
    expect(orgSetting(r, "legacy_key", 5)).toBe("");
    r.setSetting("legacy_key_5", "scoped");
    expect(orgSetting(r, "legacy_key", 5)).toBe("scoped");
  });
});

describe("email signature rendering", () => {
  it("renders name, title, phone and extra line in order", () => {
    const html = formatSignatureHtml({ name: "Jane", title: "Ops", phone: "+254", line: "Extra" }, "Org");
    expect(html).toContain("Jane");
    expect(html).toContain("Ops");
    expect(html.indexOf("Jane")).toBeLessThan(html.indexOf("Ops"));
    expect(html.indexOf("Ops")).toBeLessThan(html.indexOf("+254"));
  });

  it("falls back to the organization name when no fields are set", () => {
    expect(formatSignatureHtml({ name: "", title: "", phone: "", line: "" }, "Acme")).toContain("Acme");
    expect(formatSignatureText({ name: "", title: "", phone: "", line: "" }, "Acme")).toContain("Acme");
  });

  it("is empty when there is nothing to sign with", () => {
    expect(formatSignatureHtml({ name: "", title: "", phone: "", line: "" }, "")).toBe("");
    expect(formatSignatureText({ name: "", title: "", phone: "", line: "" }, "")).toBe("");
  });

  it("strips '<' so an operator cannot inject markup into outgoing mail", () => {
    const html = formatSignatureHtml({ name: "Jane <script>alert(1)</script>", title: "", phone: "", line: "" }, "");
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("text form uses the conventional '--' separator", () => {
    expect(formatSignatureText({ name: "Jane", title: "", phone: "", line: "" }, "")).toBe("\n\n--\nJane");
  });
});

describe("BUG-16 — both MIME paths agree on what counts as already signed", () => {
  const sig = "\n\n--\nJane";

  it("recognises its own signature block", () => {
    expect(bodyAlreadySigned("Hello" + sig, sig)).toBe(true);
  });

  it("recognises the conventional '-- ' separator", () => {
    expect(bodyAlreadySigned("Hello\n-- \nJane", sig)).toBe(true);
  });

  it("does NOT treat a body that merely mentions the signer as signed", () => {
    // The old web-side rule matched `body.includes(sig.name)`, so a quoted
    // reply that said "thanks Jane" silently lost its signature entirely.
    expect(bodyAlreadySigned("Thanks Jane, that helped.", "\n\n--\nJane")).toBe(false);
    expect(bodyAlreadySigned("I spoke to Jane yesterday.", "\n\n--\nJane")).toBe(false);
  });

  it("has nothing to suppress when there is no signature", () => {
    expect(bodyAlreadySigned("anything", "")).toBe(false);
  });
});

describe("BUG-13 — the inline banner keeps a real file extension", () => {
  it("maps common image types to their extension", () => {
    expect(bannerFilename("image/jpeg")).toBe("organization-banner.jpg");
    expect(bannerFilename("image/png")).toBe("organization-banner.png");
    expect(bannerFilename("image/gif")).toBe("organization-banner.gif");
    expect(bannerFilename("image/webp")).toBe("organization-banner.webp");
    expect(bannerFilename("image/svg+xml")).toBe("organization-banner.svg");
  });

  it("ignores parameters and casing on the media type", () => {
    expect(bannerFilename("Image/PNG; charset=binary")).toBe("organization-banner.png");
  });

  it("degrades safely for an unknown type rather than inventing an extension", () => {
    expect(bannerFilename("application/octet-stream")).toBe("organization-banner");
    expect(bannerFilename("")).toBe("organization-banner");
  });
});
