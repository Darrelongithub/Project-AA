import { describe, expect, it } from "vitest";
import { admissionPack, applicationPack } from "../src/pack";
import { renderTemplate } from "../src/drafting";

describe("official document packs", () => {
  it("application pack = application form + brochure", () => {
    const pack = applicationPack();
    expect(pack.map((a) => a.filename)).toEqual([
      "Riara University Application Form.pdf",
      "Riara University Brochure 2026.pdf",
    ]);
    for (const a of pack) {
      expect(a.mimeType).toBe("application/pdf");
      expect(a.content.subarray(0, 5).toString()).toBe("%PDF-");
      expect(a.content.length).toBeGreaterThan(10_000);
    }
  });

  it("admission pack = letter plus the seven accompanying documents", () => {
    const pack = admissionPack();
    expect(pack.length).toBe(7);
    expect(pack.map((a) => a.filename)).toEqual([
      "RU Student Medical Form.pdf",
      "RU Data Protection Form.pdf",
      "RU Next of Kin Form.pdf",
      "RU Hostels List.pdf",
      "Riara University Fee Structure 2026.pdf",
      "RU Sponsorship Form.pdf",
      "September 2026 Orientation Programmes.pdf",
    ]);
    for (const a of pack) expect(a.content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("admission-letter placeholders render programme + dates", () => {
    const out = renderTemplate(
      "Welcome to {institution} — {programme}",
      "Registration {reg_date}; orientation {orientation_dates}. Ref {ref}.",
      {
        ref: "RU-2026-000123",
        institution: "Riara University",
        programme: "Bachelor of Business Information Technology (BBIT)",
        regDate: "Monday 31st August, 2026",
        orientationDates: "Thursday 3rd and Friday 4th September, 2026",
        missingLabels: [],
        checklist: "",
        statusLabel: "Documents checked",
      }
    );
    expect(out.subject).toContain("Bachelor of Business Information Technology");
    expect(out.body).toContain("Monday 31st August, 2026");
    expect(out.body).toContain("Thursday 3rd and Friday 4th September, 2026");
  });

  it("missing context values degrade to safe fallbacks, never literal braces", () => {
    const out = renderTemplate("{programme} — {reg_date}", "{orientation_dates}", {
      ref: "RU-X", institution: "I", missingLabels: [], checklist: "", statusLabel: "s",
    });
    expect(out.subject).not.toContain("{programme}");
    expect(out.body).not.toContain("{orientation_dates}");
  });
});
