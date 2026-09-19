import type { Confidence, DocType, DocumentRecord, RequirementSetEntry } from "../src/types";

export const REQS: RequirementSetEntry[] = [
  { document_type: "academic_cert", required: true },
  { document_type: "kcpe_cert", required: true, meanGrade: "C-", subjectGrades: "C- in English" },
  { document_type: "id", required: true },
  { document_type: "application_form", required: true },
  { document_type: "birth_cert", required: false },
];

let nextId = 1;

export function mkDoc(
  type: DocType,
  opts: {
    confidence?: Confidence;
    fields?: Record<string, unknown>;
    method?: DocumentRecord["extraction_method"];
    name?: string;
    text?: string;
  } = {}
): DocumentRecord {
  return {
    id: nextId++,
    applicant_id: 1,
    document_type: type,
    source_email_id: "email-test-1",
    extraction_method: opts.method ?? "pdf_text",
    extracted_text: opts.text ?? `some ${type} text`,
    extracted_fields: opts.fields ?? (opts.name ? { name: opts.name } : {}),
    confidence: opts.confidence ?? "high",
    superseded_by: null,
    received_at: "2026-09-14T00:00:00Z",
  };
}

/** A complete, clean, high-confidence document set (incl. optional birth cert). */
export function completeDocs(): DocumentRecord[] {
  return [
    mkDoc("academic_cert", { name: "ALICE WANJIKU KAMAU", fields: { name: "ALICE WANJIKU KAMAU", meanGrade: "B", subjectGrades: { English: "B", Kiswahili: "B", Mathematics: "B" } } }),
    mkDoc("kcpe_cert", { name: "ALICE WANJIKU KAMAU", fields: { name: "ALICE WANJIKU KAMAU", meanGrade: "B", subjectGrades: { English: "B" } } }),
    mkDoc("id", { name: "ALICE WANJIKU KAMAU" }),
    mkDoc("application_form", { name: "ALICE WANJIKU KAMAU" }),
    mkDoc("birth_cert", { name: "ALICE WANJIKU KAMAU" }),
  ];
}

/**
 * Full sign-in flow for fetch-based tests: GET /login (collect the lcsrf
 * cookie + hidden field), then POST credentials with the token. Returns the
 * session cookie and a page CSRF token for subsequent POSTs.
 */
export async function webLogin(
  base: string,
  username: string,
  password: string
): Promise<{ cookie: string; csrf: string; status: number }> {
  const page = await fetch(`${base}/login`);
  const lcsrfCookie = ((page.headers.get("set-cookie") || "").match(/lcsrf=([^;]+)/) || [])[1] ?? "";
  const html = await page.text();
  const hidden = (/name="_lcsrf" value="([^"]+)"/.exec(html) || [])[1] ?? lcsrfCookie;
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `lcsrf=${lcsrfCookie}` },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&_lcsrf=${encodeURIComponent(hidden)}`,
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  let csrf = "";
  if (res.status === 302) {
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    csrf = (/name="csrf" content="([^"]+)"/.exec(home) || [])[1] ?? "";
  }
  return { cookie, csrf, status: res.status };
}
