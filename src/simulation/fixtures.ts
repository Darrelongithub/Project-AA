/**
 * Simulation scenarios v2 — the corpus the system is scored against.
 *
 * The scenarios themselves are DATA (data/simulation/fixtures.json); this
 * module is the generic interpreter that turns them into live fixtures.
 * Attachments are REAL PDFs generated at runtime:
 *   - text PDFs exercise the embedded-text tier
 *   - Grace's primary certificate is a genuine image-only scan (OCR tier)
 *   - Kevin resends a byte-identical ID (duplicate detection)
 */
import * as fs from "fs";
import * as path from "path";
import { bundledDataDir } from "../presets/loader";
import type { Attachment, Classification, DocType, EmailCategory, IncomingEmail, LifecycleStage, Priority, VisionExtraction } from "../types";
import type { Repo } from "../db/repo";
import { docLines, makeScannedPdf, makeTextPdf } from "./pdfFactory";

export interface Expected {
  finalStatus: Classification;
  lifecycle: LifecycleStage;
  autoSent: boolean;
  autoKind: "ack" | "missing_docs" | "docs_request" | "status_answer" | null;
  flagTypes: string[]; // active blocking flag types after the last email
  superseded: number;
  duplicates: number;
  missing: DocType[];
  category: EmailCategory; // category of the last processed email
  priority: Priority;
  /** v3: audit events that MUST exist for the applicant (one extra check each). */
  audited?: string[];
}

export interface Fixture {
  name: string;
  description: string;
  /** Static list, or a builder receiving the repo (e.g. to quote a generated ref). */
  emails: IncomingEmail[] | ((repo: Repo) => IncomingEmail[] | Promise<IncomingEmail[]>);
  expected: Expected;
  /** v3: run before the fixture's first email (e.g. configure a deadline). */
  before?: (repo: Repo) => void;
  /** v3: run before the Nth email (e.g. mark the case completed mid-scenario). */
  beforeEmail?: (repo: Repo, index: number) => void;
  /** v3: cleanup after scoring (e.g. reset a category back to auto mode). */
  after?: (repo: Repo) => void;
}

interface AttSpec {
  filename: string;
  docType?: string;
  name?: string;
  spec?: Record<string, unknown>;
  scanned?: boolean;
  mockVision?: VisionExtraction;
  customLines?: string[];
  content?: Buffer; // reuse exact bytes (duplicate testing)
}

async function att(s: AttSpec): Promise<Attachment> {
  if (s.content) {
    return { filename: s.filename, mimeType: "application/pdf", content: s.content, mockVision: s.mockVision ?? null };
  }
  const lines = s.customLines ?? docLines(s.docType!, { name: s.name ?? "X", ...(s.spec ?? {}) });
  const content = s.scanned ? await makeScannedPdf(lines) : await makeTextPdf(lines);
  return { filename: s.filename, mimeType: "application/pdf", content, mockVision: s.mockVision ?? null };
}

function email(p: IncomingEmail): IncomingEmail {
  return p;
}

/** OR-5: the official application-form checklist documents that accompany a
 * file. School-leaver academic evidence (leaving certificate) applies to
 * certificate/diploma/degree entry; postgraduate files carry prior-degree
 * paperwork instead. Everyone provides a passport photo and birth certificate. */
function checklistDocs(prefix: string, name: string, opts: { birth?: boolean; school?: boolean } = {}): Promise<Attachment>[] {
  const specs: AttSpec[] = [];
  if (opts.school !== false) specs.push({ filename: `${prefix}-leaving.pdf`, docType: "leaving_certificate", name });
  specs.push({ filename: `${prefix}-photo.pdf`, docType: "passport_photo", name });
  if (opts.birth !== false) specs.push({ filename: `${prefix}-birth.pdf`, docType: "birth_cert", name });
  return specs.map((sp) => att(sp));
}

/** One repo operation a scenario declares for a hook (before/after/beforeEmail). */
interface HookOp {
  op: "getOrCreateApplicant" | "setIntakeDeadline" | "setAutomationMode" | "completeCaseByEmail";
  email?: string;
  threadId?: string;
  fullName?: string;
  intake?: string;
  deadline?: string | null;
  category?: string;
  mode?: "draft" | "auto";
  by?: string;
  note?: string;
}

interface ScenarioAttachment {
  filename?: string;
  docType?: string;
  name?: string;
  spec?: Record<string, unknown>;
  scanned?: boolean;
  customLines?: string[];
  customLinesFrom?: { docType: string; name: string; spec?: Record<string, unknown> };
  mockVision?: { document_type: string; text?: string; textFrom?: string; fields?: Record<string, unknown>; confidence?: string };
  contentFrom?: string;
  checklist?: { prefix: string; name: string; birth?: boolean; school?: boolean };
}

interface ScenarioEmail {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: string;
  attachments: ScenarioAttachment[];
}

interface Scenario {
  name: string;
  description: string;
  before?: HookOp[];
  after?: HookOp[];
  beforeEmail?: { at: number; ops: HookOp[] };
  refLookup?: { email: string };
  emails: ScenarioEmail[];
  expected: Expected;
}

function loadScenarios(): Scenario[] {
  const file = path.join(bundledDataDir(), "simulation", "fixtures.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Scenario[];
}

function runOp(repo: Repo, op: HookOp): void {
  switch (op.op) {
    case "getOrCreateApplicant":
      repo.getOrCreateApplicant(op.email!, op.threadId!, { fullName: op.fullName! });
      break;
    case "setIntakeDeadline":
      repo.setIntakeDeadline(op.intake!, op.deadline ?? null);
      break;
    case "setAutomationMode":
      repo.setAutomationMode(op.category!, op.mode!);
      break;
    case "completeCaseByEmail": {
      const a = repo.findByEmailAny(op.email!)!;
      repo.setLifecycle(a.id, "completed", op.by!, op.note!);
      break;
    }
  }
}

async function buildAttachment(
  entry: ScenarioAttachment, bytesByFilename: Map<string, Buffer>
): Promise<Attachment[]> {
  if (entry.checklist) {
    const c = entry.checklist;
    return Promise.all(checklistDocs(c.prefix, c.name, { birth: c.birth, school: c.school }));
  }
  let customLines = entry.customLines;
  if (!customLines && entry.customLinesFrom) {
    const from = entry.customLinesFrom;
    customLines = docLines(from.docType, { name: from.name, ...(from.spec ?? {}) });
  }
  let mockVision: VisionExtraction | undefined;
  if (entry.mockVision) {
    const mv = entry.mockVision;
    mockVision = {
      document_type: mv.document_type,
      text: mv.textFrom === "customLines" ? (customLines ?? []).join("\n") : (mv.text ?? ""),
      fields: mv.fields ?? {},
      confidence: mv.confidence,
    } as VisionExtraction;
  }
  return [await att({
    filename: entry.filename!,
    docType: entry.docType,
    name: entry.name,
    spec: entry.spec,
    scanned: entry.scanned,
    mockVision,
    customLines,
    content: entry.contentFrom ? bytesByFilename.get(entry.contentFrom) : undefined,
  })];
}

async function buildEmails(
  emails: ScenarioEmail[], bytesByFilename: Map<string, Buffer>, ref?: string
): Promise<IncomingEmail[]> {
  const out: IncomingEmail[] = [];
  for (const e of emails) {
    const parts = await Promise.all(e.attachments.map((a) => buildAttachment(a, bytesByFilename)));
    const attachments = parts.flat();
    for (const a of attachments) bytesByFilename.set(a.filename, a.content);
    out.push(email({
      id: e.id,
      threadId: e.threadId,
      from: e.from,
      fromName: e.fromName,
      subject: ref ? e.subject.split("{ref}").join(ref) : e.subject,
      body: ref ? e.body.split("{ref}").join(ref) : e.body,
      receivedAt: e.receivedAt,
      attachments,
    }));
  }
  return out;
}

export async function buildFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  for (const sc of loadScenarios()) {
    const bytesByFilename = new Map<string, Buffer>();
    const fixture: Fixture = {
      name: sc.name,
      description: sc.description,
      emails: sc.refLookup
        ? async (repo: Repo) => {
            const ref = repo.findByEmailAny(sc.refLookup!.email)!.ref_number;
            return buildEmails(sc.emails, bytesByFilename, ref);
          }
        : await buildEmails(sc.emails, bytesByFilename),
      expected: sc.expected,
    };
    if (sc.before) {
      const ops = sc.before;
      fixture.before = (repo: Repo) => { for (const op of ops) runOp(repo, op); };
    }
    if (sc.after) {
      const ops = sc.after;
      fixture.after = (repo: Repo) => { for (const op of ops) runOp(repo, op); };
    }
    if (sc.beforeEmail) {
      const hook = sc.beforeEmail;
      fixture.beforeEmail = (repo: Repo, i: number) => {
        if (i === hook.at) for (const op of hook.ops) runOp(repo, op);
      };
    }
    fixtures.push(fixture);
  }
  return fixtures;
}
