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
import { log } from "./util/log";

export interface PackFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

const PACK_DIR = path.join(process.cwd(), "data", "pack");

function read(name: string, pretty: string): PackFile | null {
  try {
    return { filename: pretty, mimeType: "application/pdf", content: fs.readFileSync(path.join(PACK_DIR, name)) };
  } catch {
    log(`pack: ${name} not found in data/pack — skipped`, "warn");
    return null;
  }
}

/** Sent with every application enquiry reply. */
export function applicationPack(): PackFile[] {
  return [
    read("application-form.pdf", "Riara University Application Form.pdf"),
    read("brochure-2026.pdf", "Riara University Brochure 2026.pdf"),
  ].filter((f): f is PackFile => f !== null);
}

/** Attached to the admission letter once a candidate passes. */
export function admissionPack(): PackFile[] {
  return [
    read("student-medical-form.pdf", "RU Student Medical Form.pdf"),
    read("data-protection-form.pdf", "RU Data Protection Form.pdf"),
    read("next-of-kin-form.pdf", "RU Next of Kin Form.pdf"),
    read("hostels-list.pdf", "RU Hostels List.pdf"),
    read("fee-structure-2026.pdf", "Riara University Fee Structure 2026.pdf"),
    read("sponsorship-form.pdf", "RU Sponsorship Form.pdf"),
    read("orientation-programme-2026.pdf", "September 2026 Orientation Programmes.pdf"),
  ].filter((f): f is PackFile => f !== null);
}

/** Default email banner (./data/branding/email-banner.jpg). */
export function defaultEmailBanner(): { mime: string; base64: string } | null {
  try {
    const buf = fs.readFileSync(path.join(process.cwd(), "data", "branding", "email-banner.jpg"));
    return { mime: "image/jpeg", base64: buf.toString("base64") };
  } catch {
    return null;
  }
}
