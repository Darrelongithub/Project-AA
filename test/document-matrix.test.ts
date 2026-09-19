/**
 * OR-5 — deterministic document-requirement generator.
 *
 * The owner's reading of data/pack/application-form.pdf pages 3–4
 * ("CHECKLIST AND DECLARATION") is the authoritative source of what an
 * application file must contain. Requirements are a PURE function of
 * level × curriculum × nationality × route (+ the KCPE constant) — never
 * staff-configurable. Conditional items are asked for, never assumed.
 * Missing data is never treated as failure (existing guarantee).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { webLogin } from "./helpers";
import {
  KENYAN_REQUIRES_KCPE,
  documentRequirementsFor,
  fillSlots,
  BANNED_GENERIC_TERMS,
  type RequirementInput,
} from "../src/documents/matrix";
import { DOC_TYPES, type DocType } from "../src/types";
import { docLabel } from "../src/rules";
import { classifyDocumentType } from "../src/extraction/classify";
import { docLines } from "../src/simulation/pdfFactory";
import { openDb } from "../src/db/db";
import { Repo } from "../src/db/repo";
import { seedDefaults } from "../src/db/seed";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";

const types = (input: RequirementInput): DocType[] =>
  documentRequirementsFor(input)
    .map((r) => r.document_type)
    .sort();

const CORE_FRESH: DocType[] = [
  "application_form",
  "birth_cert",
  "exam_result_slip",
  "id",
  "leaving_certificate",
  "passport_photo",
];

describe("OR-5: deterministic document matrix", () => {
  it("KENYAN_REQUIRES_KCPE is the owner constant (false) and kcpe_cert is never a required slot", () => {
    expect(KENYAN_REQUIRES_KCPE).toBe(false);
    const levels = ["certificate", "diploma", "degree", "masters", "phd"] as const;
    const routes = ["fresh", "transfer"] as const;
    const nats = ["kenyan", "international", "unknown"] as const;
    for (const level of levels) {
      for (const route of routes) {
        for (const nationality of nats) {
          const out = documentRequirementsFor({ level, route, nationality });
          expect(out.some((r) => r.document_type === "kcpe_cert")).toBe(false);
        }
      }
    }
  });

  it("core file is identical for certificate/diploma/degree fresh applicants", () => {
    for (const level of ["certificate", "diploma", "degree"] as const) {
      expect(types({ level, route: "fresh", nationality: "kenyan" })).toEqual([...CORE_FRESH].sort());
      expect(types({ level, route: "fresh", nationality: "unknown" })).toEqual([...CORE_FRESH].sort());
    }
  });

  it("conditional statements are asked per programme and never assumed (LLB / BBA only)", () => {
    const llb = types({ level: "degree", route: "fresh", nationality: "kenyan", programmeCode: "LLB" });
    expect(llb).toContain("law_personal_statement");
    expect(llb).not.toContain("business_statement_of_objective");

    const bba = types({ level: "degree", route: "fresh", nationality: "kenyan", programmeCode: "BBA" });
    expect(bba).toContain("business_statement_of_objective");
    expect(bba).not.toContain("law_personal_statement");

    const bsc = types({ level: "degree", route: "fresh", nationality: "kenyan", programmeCode: "BSC-CS" });
    expect(bsc).toEqual([...CORE_FRESH].sort());

    // Conditional items carry their condition and are required (asked for).
    const spec = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "kenyan", programmeCode: "LLB" })
      .find((r) => r.document_type === "law_personal_statement")!;
    expect(spec.required).toBe(true);
    expect(spec.conditional?.length ?? 0).toBeGreaterThan(0);
  });

  it("postgraduate ladder: prior-degree docs REPLACE the school-leaver academic slots", () => {
    // A Master's/PhD applicant proves the prior degree(s); the high-school
    // result slip and leaving certificate are school-leaver entry items.
    const CORE_ALL_LEVELS = ["application_form", "passport_photo", "id", "birth_cert"];
    const m = types({ level: "masters", route: "fresh", nationality: "kenyan" });
    expect(m).toEqual(
      [...CORE_ALL_LEVELS, "undergraduate_transcript", "undergraduate_degree_certificate"].sort()
    );
    const p = types({ level: "phd", route: "fresh", nationality: "kenyan" });
    expect(p).toEqual(
      [
        ...CORE_ALL_LEVELS,
        "undergraduate_transcript",
        "undergraduate_degree_certificate",
        "masters_transcript",
        "masters_degree_certificate",
      ].sort()
    );
  });

  it("transfer route adds exactly the credit transfer requirement", () => {
    const t = types({ level: "degree", route: "transfer", nationality: "kenyan" });
    expect(t).toEqual([...CORE_FRESH, "credit_transfer_form"].sort());
    const fresh = types({ level: "degree", route: "fresh", nationality: "kenyan" });
    expect(fresh).not.toContain("credit_transfer_form");
  });

  it("international applicants get post-admission items that NEVER block the file", () => {
    const out = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "international" });
    const blocking = out.filter((r) => r.blocking);
    expect(blocking.map((r) => r.document_type).sort()).toEqual([...CORE_FRESH].sort());
    const post = out.filter((r) => !r.blocking).map((r) => r.document_type).sort();
    expect(post).toEqual(["foreign_qualification_equivalence", "student_pass_application"]);
    for (const r of out.filter((x) => !x.blocking)) {
      expect(r.required).toBe(false); // never turns a file Red
    }
    // Unknown nationality: ask nothing extra — never assume.
    const unk = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "unknown" });
    expect(unk.every((r) => r.blocking)).toBe(true);
  });

  it("BAN: no generated slot, label or catalogue term may say 'academic certificate'", () => {
    for (const level of ["certificate", "diploma", "degree", "masters", "phd"] as const) {
      for (const route of ["fresh", "transfer"] as const) {
        for (const nationality of ["kenyan", "international", "unknown"] as const) {
          for (const r of documentRequirementsFor({ level, route, nationality, programmeCode: "LLB" })) {
            for (const banned of BANNED_GENERIC_TERMS) {
              expect(r.label.toLowerCase()).not.toContain(banned);
              expect(r.document_type.toLowerCase()).not.toContain(banned.replace(/\s+/g, "_"));
            }
          }
        }
      }
    }
    for (const t of DOC_TYPES) {
      const label = docLabel(t).toLowerCase();
      for (const banned of BANNED_GENERIC_TERMS) expect(label).not.toContain(banned);
    }
  });

  it("is a pure, stable function of its inputs (deterministic across calls)", () => {
    const a = documentRequirementsFor({ level: "masters", route: "transfer", nationality: "international", programmeCode: "MBA" });
    const b = documentRequirementsFor({ level: "masters", route: "transfer", nationality: "international", programmeCode: "MBA" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("OR-5: slot semantics — one document fills exactly one slot", () => {
  const reqs = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "kenyan" });

  it("exact-type documents fill their own slots, duplicates do not double-fill", () => {
    const { filled, missing } = fillSlots(reqs, ["application_form", "id", "id"]);
    expect(filled).toContain("application_form");
    expect(filled).toContain("id");
    expect(missing.map((m) => m.document_type)).not.toContain("id");
    expect(missing.map((m) => m.document_type)).toContain("birth_cert");
  });

  it("a generic academic upload fills ONE academic slot (highest priority first)", () => {
    const one = fillSlots(reqs, ["academic_cert"]);
    expect(one.filled).toContain("exam_result_slip");
    expect(one.filled).not.toContain("leaving_certificate");
    const two = fillSlots(reqs, ["academic_cert", "academic_cert"]);
    expect(two.filled).toContain("exam_result_slip");
    expect(two.filled).toContain("leaving_certificate");
  });

  it("specific documents beat the generic fallback to the same slot", () => {
    const r = fillSlots(reqs, ["exam_result_slip", "academic_cert"]);
    expect(r.filled).toContain("exam_result_slip");
    expect(r.filled).toContain("leaving_certificate");
  });

  it("non-blocking (post-admission) slots never consume documents nor report missing", () => {
    const intl = documentRequirementsFor({ level: "degree", route: "fresh", nationality: "international" });
    const { missing } = fillSlots(intl, CORE_FRESH);
    expect(missing.map((m) => m.document_type)).toEqual([]);
  });
});

describe("OR-5: classifier + synthetic PDF per special type", () => {
  const special: Array<[DocType, Record<string, unknown>?]> = [
    ["exam_result_slip"],
    ["leaving_certificate"],
    ["passport_photo"],
    ["undergraduate_transcript"],
    ["undergraduate_degree_certificate"],
    ["masters_transcript"],
    ["masters_degree_certificate"],
    ["law_personal_statement"],
    ["business_statement_of_objective"],
    ["credit_transfer_form"],
    ["birth_cert"],
    ["id"],
  ];

  for (const [type] of special) {
    it(`synthetic ${type} text classifies back to ${type}`, () => {
      const lines = docLines(type, { name: "Test Student" } as never);
      expect(lines.length).toBeGreaterThan(2);
      expect(classifyDocumentType(lines.join("\n"))).toBe(type);
    });
  }

  it("every catalogued DocType has a human label", () => {
    for (const t of DOC_TYPES) {
      expect(docLabel(t).length).toBeGreaterThan(2);
      expect(docLabel(t)).not.toBe(t); // raw fallback means a missing label
    }
  });
});

describe("OR-5: repo wiring — generator is the single source, snapshots still freeze", () => {
  let repo: Repo;

  beforeAll(() => {
    repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
  });

  it("effectiveRequirements for a fresh LLB applicant contains the personal-statement slot and no staff-editable leftovers", () => {
    const a = repo.getOrCreateApplicant("llb@example.com", "t-or5-llb");
    repo.updateApplicant(a.id, { programme: "LLB" });
    const reqs = repo.effectiveRequirements(repo.getApplicant(a.id)!);
    const t = reqs.map((r) => r.document_type);
    expect(t).toContain("law_personal_statement");
    expect(t).toContain("exam_result_slip");
    expect(t).toContain("leaving_certificate");
    expect(t).not.toContain("kcpe_cert");
    expect(t).not.toContain("academic_cert"); // the banned vague type is never a slot
  });

  it("transfer applicants automatically get the credit transfer slot", () => {
    const a = repo.getOrCreateApplicant("tr@example.com", "t-or5-tr");
    repo.updateApplicant(a.id, { programme: "BBA", transfer: 1 } as never);
    const t = repo.effectiveRequirements(repo.getApplicant(a.id)!).map((r) => r.document_type);
    expect(t).toContain("credit_transfer_form");
    expect(t).toContain("business_statement_of_objective");
  });

  it("an applicant frozen under an older snapshot keeps it (no re-judging)", () => {
    const a = repo.getOrCreateApplicant("frozen@example.com", "t-or5-frozen");
    const legacy = [{ document_type: "academic_cert", required: true }];
    repo.db.prepare("UPDATE applicants SET requirements_snapshot = ? WHERE id = ?").run(JSON.stringify(legacy), a.id);
    const reqs = repo.effectiveRequirements(repo.getApplicant(a.id)!);
    expect(reqs.map((r) => r.document_type)).toEqual(["academic_cert"]);
  });
});

describe("OR-5: Configuration no longer offers document toggles", () => {
  let server: Server;
  let base = "";
  let cookie = "";
  let csrf = "";

  beforeAll(async () => {
    const repo = new Repo(openDb(":memory:"));
    seedDefaults(repo);
    repo.createStaff("boss", "Matrix Tester", hashPassword("matrix-pass-1"), "admin");
    const ctx: PipelineContext = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
    };
    const app = createApp({ repo, ctx });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const r = await webLogin(base, "boss", "matrix-pass-1");
    cookie = r.cookie;
    csrf = r.csrf;
  });

  afterAll(() => server?.close());

  it("Requirements tab shows the deterministic matrix (read-only), no document toggles", async () => {
    const page = await (await fetch(`${base}/config?tab=requirements`, { headers: { cookie } })).text();
    expect(page).toContain("generated deterministically");
    // No staff-editable document-requirement toggles remain anywhere in Configuration.
    expect(page).not.toContain("/config/requirements/save");
    expect(page).not.toMatch(/name="doc_[a-z_]+_required"/);
    // The matrix itself is visible so staff can see what will be asked.
    expect(page).toContain("examination result slip");
  });

  it("the documented matrix page exists in the repo (docs/DOCUMENT_MATRIX.md)", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const p = resolve(process.cwd(), "docs/DOCUMENT_MATRIX.md");
    expect(existsSync(p)).toBe(true);
    const md = readFileSync(p, "utf8");
    expect(md).toContain("KCPE");
    expect(md).toContain("personal statement");
    expect(md.toLowerCase()).not.toContain("academic certificate");
  });

  void csrf;
});
