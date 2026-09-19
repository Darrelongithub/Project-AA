/**
 * Official admissions document packs — the real PDFs the university sends.
 *
 *   Application pack: what an enquirer receives (form + brochure).
 *   Admission pack:   what an admitted student receives (letter attachments).
 *
 * Files live in ./data/pack (committed with the project). Missing files are
 * skipped with a log line rather than crashing a send.
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./config";
import { log } from "./util/log";

export interface PackFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Every official pack file, keyed for the Configuration panel. */
export interface PackSlot {
  key: string;
  file: string;
  pretty: string;
  pack: "application" | "admission" | "transfer";
  purpose: string;
}

export const PACK_SLOTS: PackSlot[] = [
  { key: "application-form", file: "application-form.pdf", pretty: "Riara University Application Form.pdf", pack: "application", purpose: "Application form sent to enquirers" },
  { key: "brochure-2026", file: "brochure-2026.pdf", pretty: "Riara University Brochure 2026.pdf", pack: "application", purpose: "Prospectus sent to enquirers" },
  { key: "student-medical-form", file: "student-medical-form.pdf", pretty: "RU Student Medical Form.pdf", pack: "admission", purpose: "Admission pack — medical form" },
  { key: "data-protection-form", file: "data-protection-form.pdf", pretty: "RU Data Protection Form.pdf", pack: "admission", purpose: "Admission pack — data protection consent" },
  { key: "next-of-kin-form", file: "next-of-kin-form.pdf", pretty: "RU Next of Kin Form.pdf", pack: "admission", purpose: "Admission pack — next of kin" },
  { key: "hostels-list", file: "hostels-list.pdf", pretty: "RU Hostels List.pdf", pack: "admission", purpose: "Admission pack — accommodation" },
  { key: "fee-structure-2026", file: "fee-structure-2026.pdf", pretty: "Riara University Fee Structure 2026.pdf", pack: "admission", purpose: "Admission pack — fee structure" },
  { key: "sponsorship-form", file: "sponsorship-form.pdf", pretty: "RU Sponsorship Form.pdf", pack: "admission", purpose: "Admission pack — sponsorship" },
  { key: "orientation-programme-2026", file: "orientation-programme-2026.pdf", pretty: "September 2026 Orientation Programmes.pdf", pack: "admission", purpose: "Admission pack — orientation" },
  { key: "credit-transfer-form", file: "credit-transfer-form.pdf", pretty: "Riara University Credit Transfer Form.pdf", pack: "transfer", purpose: "For applicants transferring credit from another institution" },
];

/**
 * Data directory, anchored to the DATABASE file — not to process.cwd().
 * Running the server from another working directory (systemd, cron, someone's
 * shell) must not make the official packs "disappear".
 */
export const DATA_DIR = path.dirname(path.resolve(loadConfig().dbPath));
export const PACK_DIR = path.join(DATA_DIR, "pack");

/** Pack files with existence + size, for the Documents & pack panel. */
export function packManifest(): Array<PackSlot & { exists: boolean; bytes: number }> {
  return PACK_SLOTS.map((slot) => {
    try {
      const st = fs.statSync(path.join(PACK_DIR, slot.file));
      return { ...slot, exists: true, bytes: st.size };
    } catch {
      return { ...slot, exists: false, bytes: 0 };
    }
  });
}

/** Result of building a pack: what goes out, and exactly what was missing. */
export interface PackBuild {
  files: PackFile[];
  issues: string[];
}

function read(name: string, pretty: string, issues: string[]): PackFile | null {
  try {
    return { filename: pretty, mimeType: "application/pdf", content: fs.readFileSync(path.join(PACK_DIR, name)) };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    log(`pack: ${name} ${missing ? "not found in" : "unreadable from"} data/pack — skipped`, "warn");
    issues.push(
      `${pretty} (${name}) is ${missing ? "missing from" : "unreadable from"} data/pack — the outgoing pack is incomplete`
    );
    return null;
  }
}

function build(issues: string[], ...files: Array<PackFile | null>): PackBuild {
  return { files: files.filter((f): f is PackFile => f !== null), issues };
}

/** Sent with every application enquiry reply. */
export function applicationPack(): PackBuild {
  const issues: string[] = [];
  return build(
    issues,
    read("application-form.pdf", "Riara University Application Form.pdf", issues),
    read("brochure-2026.pdf", "Riara University Brochure 2026.pdf", issues)
  );
}

/** Attached to the admission letter once a candidate passes. */
export function admissionPack(): PackBuild {
  const issues: string[] = [];
  return build(
    issues,
    read("student-medical-form.pdf", "RU Student Medical Form.pdf", issues),
    read("data-protection-form.pdf", "RU Data Protection Form.pdf", issues),
    read("next-of-kin-form.pdf", "RU Next of Kin Form.pdf", issues),
    read("hostels-list.pdf", "RU Hostels List.pdf", issues),
    read("fee-structure-2026.pdf", "Riara University Fee Structure 2026.pdf", issues),
    read("sponsorship-form.pdf", "RU Sponsorship Form.pdf", issues),
    read("orientation-programme-2026.pdf", "September 2026 Orientation Programmes.pdf", issues)
  );
}

/** Default email banner (./data/branding/email-banner.jpg). */
export function defaultEmailBanner(): { mime: string; base64: string } | null {
  try {
    const buf = fs.readFileSync(path.join(DATA_DIR, "branding", "email-banner.jpg"));
    return { mime: "image/jpeg", base64: buf.toString("base64") };
  } catch {
    return null;
  }
}
