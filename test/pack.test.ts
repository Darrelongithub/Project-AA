/**
 * Document packs are organization-owned files, not bundled assets.
 *
 * Guarantees pinned here: an empty tenant has an empty pack, uploaded files are
 * served with their stored mime type, a requested-but-missing file is reported
 * as an issue instead of silently dropped, and template rendering degrades to
 * safe fallbacks rather than leaking placeholder braces.
 */
import { describe, expect, it } from "vitest";
import { organizationPack, packManifest } from "../src/pack";
import { renderTemplate } from "../src/drafting";
import { freshRepo } from "./helpers";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(900, 0x61)]);

describe("organization document packs", () => {
  it("starts empty — nothing is bundled on a fresh install", () => {
    const repo = freshRepo();
    expect(packManifest(repo, 1)).toEqual([]);
    expect(organizationPack(repo, 1)).toEqual({ files: [], issues: [] });
  });

  it("serves the files the organization uploaded, with their stored metadata", () => {
    const repo = freshRepo();
    repo.setOrganizationPackSlot(1, "handbook", { filename: "service-handbook.pdf", mime: "application/pdf", content: PDF });
    repo.setOrganizationPackSlot(1, "form", { filename: "request-form.pdf", mime: "application/pdf", content: PDF });

    const manifest = packManifest(repo, 1);
    expect(manifest.map((slot) => slot.key).sort()).toEqual(["form", "handbook"]);
    expect(manifest.every((slot) => slot.exists && slot.bytes === PDF.length)).toBe(true);

    const pack = organizationPack(repo, 1);
    expect(pack.issues).toEqual([]);
    expect(pack.files.map((file) => file.filename).sort()).toEqual(["request-form.pdf", "service-handbook.pdf"]);
    for (const file of pack.files) {
      expect(file.mimeType).toBe("application/pdf");
      expect(file.content.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("reports a requested-but-missing file instead of silently skipping it", () => {
    const repo = freshRepo();
    repo.setOrganizationPackSlot(1, "handbook", { filename: "service-handbook.pdf", mime: "application/pdf", content: PDF });
    const pack = organizationPack(repo, 1, ["handbook", "price_list"]);
    expect(pack.files.map((file) => file.filename)).toEqual(["service-handbook.pdf"]);
    expect(pack.issues.join(" ")).toMatch(/price_list/);
  });

  it("never leaks one organization's files into another's pack", () => {
    const repo = freshRepo();
    repo.setOrganizationPackSlot(1, "handbook", { filename: "tenant-one.pdf", mime: "application/pdf", content: PDF });
    const other = repo.createOrganization({ name: "Second Tenant", refPrefix: "SEC" });
    expect(organizationPack(repo, other.id).files).toEqual([]);
    expect(packManifest(repo, other.id)).toEqual([]);
  });
});

describe("template rendering", () => {
  it("substitutes configured tokens", () => {
    const out = renderTemplate(
      "Update on your {case_type} — {institution}",
      "Reference {ref}; current stage: {status}. {checklist}",
      {
        ref: "ORG-2026-000123",
        institution: "Example Service Cooperative",
        caseType: "Service request",
        missingLabels: [],
        checklist: "- Request form\n- Identity document",
        statusLabel: "In review",
      }
    );
    expect(out.subject).toContain("Service request");
    expect(out.body).toContain("ORG-2026-000123");
    expect(out.body).toContain("Identity document");
  });

  it("degrades missing context to safe fallbacks, never literal braces", () => {
    const out = renderTemplate("{case_type} — {ref}", "{status} {missing_docs}", {
      ref: "ORG-X", institution: "Example", missingLabels: [], checklist: "", statusLabel: "Received",
    });
    expect(out.subject).not.toContain("{case_type}");
    expect(out.body).not.toContain("{status}");
    expect(out.body).not.toContain("{missing_docs}");
  });
});
