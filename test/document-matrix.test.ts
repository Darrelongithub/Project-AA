/**
 * Document matrices are organization-owned configuration, not bundled presets.
 *
 * These tests pin the guarantees that matter for any deployment:
 *  - a checklist is a pure function of the stored definitions (order included),
 *  - axes narrow a checklist deterministically and reject invalid selections,
 *  - one submitted document fills exactly one slot, optional slots never turn
 *    a file red, and unmatched uploads are reported rather than silently used,
 *  - a case keeps the checklist it was opened with until a person upgrades it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import { configureTestOrganization, freshRepo, webLogin } from "./helpers";
import {
  documentRequirementsForCaseType,
  documentRequirementsFromAxes,
  fillSlots,
  type CaseTypeDocumentDefinition,
} from "../src/documents/matrix";
import { DOC_TYPES, type DocType } from "../src/types";
import { docLabel } from "../src/rules";
import { classifyDocumentType } from "../src/extraction/classify";
import { genericDocumentLines } from "../src/simulation/config";
import { hashPassword } from "../src/util/password";
import { createApp } from "../src/web/server";
import { MockSender, MockVisionAdapter, type PipelineContext } from "../src/pipeline/adapters";
import { makeHeuristicWatcher } from "../src/watcher";
import type { Repo } from "../src/db/repo";

const definition = (key: string, label: string, required: boolean, blocking: boolean, extra: Partial<CaseTypeDocumentDefinition> = {}): CaseTypeDocumentDefinition =>
  ({ key, label, required, blocking, ...extra });

const CHECKLIST: CaseTypeDocumentDefinition[] = [
  definition("request_form", "Request form", true, true, { position: 2 }),
  definition("id", "Identity document", true, true, { position: 1 }),
  definition("supporting_document", "Supporting note", false, false, { position: 3 }),
];

describe("checklist generation from stored definitions", () => {
  it("keeps the configured order and flags", () => {
    const out = documentRequirementsForCaseType({ caseType: { id: 1, code: "SERVICE_REQUEST" }, definitions: CHECKLIST });
    expect(out.map((row) => row.key)).toEqual(["id", "request_form", "supporting_document"]);
    expect(out.find((row) => row.key === "supporting_document")).toMatchObject({ required: false, blocking: false });
  });

  it("is deterministic for identical input", () => {
    const input = { caseType: { id: 7, code: "VENDOR_INTAKE" }, definitions: CHECKLIST };
    expect(JSON.stringify(documentRequirementsForCaseType(input))).toBe(JSON.stringify(documentRequirementsForCaseType(input)));
  });

  it("narrows a checklist by axis selection and rejects an invalid one", () => {
    const axes = [{ key: "region", label: "Region", values: ["north", "south"] }];
    const definitions = [
      definition("request_form", "Request form", true, true),
      definition("regional_permit", "Regional permit", true, true, { axis: "region", values: ["north"] }),
    ];
    const north = documentRequirementsFromAxes({ axes, selections: { region: "north" }, definitions });
    const south = documentRequirementsFromAxes({ axes, selections: { region: "south" }, definitions });
    expect(north.map((row) => row.key)).toEqual(["request_form", "regional_permit"]);
    expect(south.map((row) => row.key)).toEqual(["request_form"]);
    expect(() => documentRequirementsFromAxes({ axes, selections: { region: "elsewhere" }, definitions })).toThrow(/Invalid selection/);
  });
});

describe("slot semantics — one document fills exactly one slot", () => {
  const specs = CHECKLIST.map((row) => ({ document_type: row.key, required: row.required, blocking: row.blocking }));

  it("fills exact types and reports the absent blocking slot", () => {
    const { filled, missing, leftover } = fillSlots(specs, ["request_form"]);
    expect(filled).toEqual(["request_form"]);
    expect(missing.map((slot) => slot.document_type)).toEqual(["id"]);
    expect(leftover).toEqual([]);
  });

  it("never counts an optional slot as missing", () => {
    const { missing } = fillSlots(specs, ["request_form", "id"]);
    expect(missing).toEqual([]);
  });

  it("does not let a duplicate fill two slots, and reports unmatched uploads", () => {
    const { filled, missing, leftover } = fillSlots(specs, ["id", "id", "invoice"]);
    expect(filled).toEqual(["id"]);
    expect(missing.map((slot) => slot.document_type)).toEqual(["request_form"]);
    expect(leftover).toEqual(["id", "invoice"]);
  });
});

describe("generic document hints and labels", () => {
  const classified: DocType[] = ["request_form", "id", "birth_cert", "passport_photo"];

  for (const type of classified) {
    it(`synthetic ${type} text classifies back to ${type}`, () => {
      const lines = genericDocumentLines(type, "ALEX MORGAN");
      expect(lines.length).toBeGreaterThan(2);
      expect(classifyDocumentType(lines.join("\n"))).toBe(type);
    });
  }

  it("unrecognised text stays unknown rather than guessing a slot", () => {
    expect(classifyDocumentType("Quarterly market summary for the regional office")).toBe("unknown");
  });

  it("every catalogued document type has a human label", () => {
    for (const type of DOC_TYPES) {
      expect(docLabel(type).length).toBeGreaterThan(2);
      expect(docLabel(type)).not.toBe(type);
    }
  });
});

describe("repository wiring — the stored checklist is the single source", () => {
  let repo: Repo;

  beforeAll(() => {
    repo = freshRepo();
  });

  it("reads the checklist from the case's own configuration", () => {
    const caseRow = repo.createCase({ emailAddress: "contact@example.test", threadId: "t-matrix-1", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    const types = repo.effectiveRequirements(caseRow).map((row) => row.document_type);
    expect(types).toEqual(["request_form", "id", "supporting_document"]);
  });

  it("keeps an unconfigured case without invented requirements", () => {
    const organization = repo.createOrganization({ name: "Unconfigured Tenant", refPrefix: "UNC" });
    const caseRow = repo.createCase({ emailAddress: "blank@example.test", threadId: "t-matrix-2", organizationId: organization.id });
    expect(repo.effectiveRequirements(caseRow)).toEqual([]);
  });

  it("freezes the checklist at first evaluation and keeps it after later edits", () => {
    const caseRow = repo.createCase({ emailAddress: "frozen@example.test", threadId: "t-matrix-3", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" });
    repo.freezeCaseConfig(caseRow);
    repo.freezeRequirementsSnapshot(caseRow);
    const type = repo.caseTypeForCase(caseRow.id)!;
    repo.upsertDocumentDefinition(type.id, { key: "extra_approval", label: "Extra approval", required: true, blocking: true });
    const frozen = repo.effectiveRequirements(repo.getCase(caseRow.id)!).map((row) => row.document_type);
    expect(frozen).not.toContain("extra_approval");

    // An explicit upgrade adopts the current configuration; nothing else does.
    repo.reFreezeCaseConfig(repo.getCase(caseRow.id)!);
    repo.freezeRequirementsSnapshot(repo.getCase(caseRow.id)!);
    expect(repo.effectiveRequirements(repo.getCase(caseRow.id)!).map((row) => row.document_type)).toContain("extra_approval");
    repo.deleteDocumentDefinition(type.id, "extra_approval");
  });
});

describe("configuration is where checklists are edited", () => {
  let server: Server;
  let base = "";
  let cookie = "";

  beforeAll(async () => {
    const repo = freshRepo();
    repo.createStaff("boss", "Configuration Tester", hashPassword("matrix-pass-1"), "admin");
    const ctx: PipelineContext = {
      repo,
      adapters: { vision: new MockVisionAdapter(), watcher: makeHeuristicWatcher(), sender: new MockSender() },
    };
    const app = createApp({ repo, ctx });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cookie = (await webLogin(base, "boss", "matrix-pass-1")).cookie;
  });

  afterAll(() => server?.close());

  it("shows the organization's case types and their slots, and no bundled preset", async () => {
    const page = await (await fetch(`${base}/config?tab=case-types`, { headers: { cookie } })).text();
    expect(page).toContain("SERVICE_REQUEST");
    expect(page).toContain("Request form");
    expect(page).not.toMatch(/name="doc_[a-z_]+_required"/);
  });

  it("keeps the removed legacy requirement endpoints closed", async () => {
    const auth = await webLogin(base, "boss", "matrix-pass-1");
    const res = await fetch(`${base}/config/requirements/save`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${auth.csrf}&document_type=request_form&required=1`,
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});

describe("a fresh installation configures nothing by itself", () => {
  it("boots empty until an administrator builds the configuration", () => {
    const repo = freshRepo({ configured: false });
    expect(repo.listOrganizations()).toEqual([]);
    expect(repo.listCases()).toEqual([]);
    expect(repo.staffCount()).toBe(0);
    const { organizationId, codes } = configureTestOrganization(repo);
    expect(codes).toEqual(["SERVICE_REQUEST", "VENDOR_INTAKE", "ACCESS_REQUEST"]);
    expect(repo.listCaseTypes(organizationId).map((type) => type.code).sort()).toEqual([...codes].sort());
  });
});
