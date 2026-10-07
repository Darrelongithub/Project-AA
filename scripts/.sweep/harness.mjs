/**
 * Dev-only functional sweep harness.
 *
 * Fetches an admin page, extracts every non-theme/non-logout form, fills it
 * with plausible values, submits it, follows the redirect and reports the
 * flash message. A control that reports an error — or that silently keeps the
 * old value — is a candidate defect.
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3000";
let cookie = process.env.COOKIE || "";

function absorb(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const pair = c.split(";")[0];
    const name = pair.split("=")[0];
    const jar = new Map((cookie || "").split("; ").filter(Boolean).map((p) => [p.split("=")[0], p]));
    jar.set(name, pair);
    cookie = [...jar].map(([k, v]) => v).join("; ");
  }
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
  absorb(res);
  if (res.status >= 300 && res.status < 400) return get(res.headers.get("location"));
  return res.text();
}

async function post(path, body, asForm = true) {
  const headers = { cookie };
  let payload;
  if (asForm) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  } else {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method: "POST", headers, body: payload, redirect: "manual" });
  absorb(res);
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) return { redirect: loc, html: loc.startsWith("http") ? "" : await get(loc) };
  return { redirect: null, html: await res.text(), status: res.status };
}

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Pull <form ...>...</form> blocks with their action/method/fields. */
function forms(html) {
  const out = [];
  const re = /<form\b([\s\S]*?)>([\s\S]*?)<\/form>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    const action = (attrs.match(/action="([^"]*)"/) || [, ""])[1];
    const method = ((attrs.match(/method="([^"]*)"/) || [, "get"])[1] || "get").toLowerCase();
    const fields = [];
    for (const t of inner.matchAll(/<(input|select|textarea)\b([\s\S]*?)>/g)) {
      const tag = t[1];
      const a = t[2];
      const name = (a.match(/\bname="([^"]*)"/) || [, ""])[1];
      if (!name) continue;
      const type = (a.match(/type="([^"]*)"/) || [, tag === "select" ? "select" : tag === "textarea" ? "textarea" : "text"])[1];
      const value = (a.match(/\bvalue="([^"]*)"/) || [, ""])[1];
      const options = [...a.matchAll(/<option\b[^>]*value="([^"]*)"([^>]*)>/g)].map((o) => ({ value: o[1], selected: /selected/.test(o[2]) }));
      fields.push({ tag, name, type, value: decode(value), options });
    }
    // textarea content
    for (const t of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const name = (t[1].match(/\bname="([^"]*)"/) || [, ""])[1];
      if (name) fields.push({ tag: "textarea", name, type: "textarea", value: decode(t[2]), options: [] });
    }
    out.push({ action, method, fields, raw: m[0] });
  }
  return out;
}

const SAMPLE = {
  text: "Sweep Value 42",
  email: "sweep@example.org",
  number: "42",
  password: "sweep-password-42",
  date: "2030-01-31",
  textarea: "Sweep\nvalue 42",
};

const OVERRIDES = {
  name: "Sweep Entry",
  key: "sweep_key",
  label: "Sweep label",
  code: "SWEEP_CODE",
  category: "general",
  organization_name: "Demo Org",
  institution_name: "Demo Org",
  ref_prefix: "ORG",
  primary_color: "#3b1d5f",
  accent_color: "#9a78c7",
  locale: "en-GB",
  timezone: "UTC",
  mode: "draft",
  sla_target_hours: "6",
  escalation_hours: "9",
  unanswered_target_hours: "5",
  followup_ladder_days: "3,7,10",
  intake_hotwords: "application, apply",
  from_name: "Demo Org Intake",
  reply_to: "intake@example.org",
  signature_name: "Sweep Signer",
  signature_title: "Operations lead",
  signature_phone: "+254 700 000000",
  signature_line: "Sweep line",
  classifier_prompt: "Prefer document_submission when PDFs are attached.",
  term_case: "Case",
  term_contact: "Correspondent",
  term_category: "Category",
  term_stage: "Stage",
  term_outcome: "Outcome",
  stages_text: "received|Received\nin_review|In review\ncompleted|Completed",
  queues_text: "documents|Waiting for documents\nreview|Human review",
  rules_json: "[]",
  axes_json: "[]",
  conditions_json: "[]",
  subject: "Sweep subject",
  body: "Sweep body\n\nRegards",
  address: "sweep-alias@example.org",
  description: "Sweep description",
  sample_subject: "Application for the sweep role",
  sample_body: "Please find my documents attached.",
  sample_from: "someone@example.org",
  deadline: "2030-01-31",
  username: "sweepuser",
  display_name: "Sweep User",
  role: "staff",
  current: "password123",
  next: "password123",
  confirm: "password123",
  theme: "dark",
  gemini_api_key: "",
  gemini_model: "gemini-3.8-flash",
  gmail_address: "",
  gmail_client_id: "",
  gmail_client_secret: "",
  gmail_refresh_token_manual: "",
  gmail_public_base_url: "",
};

function fill(form) {
  const body = {};
  for (const f of form.fields) {
    if (f.type === "hidden") { body[f.name] = f.value; continue; }
    if (f.type === "checkbox") { body[f.name] = f.value || "1"; continue; }
    if (f.tag === "select") {
      const sel = f.options.find((o) => o.selected) || f.options[0];
      body[f.name] = OVERRIDES[f.name] ?? (sel ? sel.value : "");
      if (OVERRIDES[f.name] && f.options.length && !f.options.some((o) => o.value === OVERRIDES[f.name])) {
        body[f.name] = f.options[f.options.length - 1].value;
      }
      continue;
    }
    if (f.type === "file") continue;
    if (f.name in OVERRIDES) { body[f.name] = OVERRIDES[f.name]; continue; }
    body[f.name] = SAMPLE[f.type] ?? SAMPLE.text;
  }
  return body;
}

function flashOf(html) {
  const m = html.match(/<div class="flash"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return "";
  return m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** The `?msg=` on the redirect is the authoritative outcome text. */
function msgOf(redirect) {
  if (!redirect) return "";
  try {
    const u = new URL(redirect, BASE);
    return u.searchParams.get("msg") || "";
  } catch { return ""; }
}

const PAGES = process.argv.slice(2);

const results = [];
for (const page of PAGES) {
  const html = await get(page);
  const all = forms(html).filter((f) => f.method === "post" && !/\/logout|\/theme$/.test(f.action));
  for (const f of all) {
    // Skip destructive/dangerous actions during a read-mostly sweep.
    if (/\/(delete|rotate|purge|reset|toggle|retire|remove|seed-starters|backfill|sync|disconnect|test|reevaluate-open|dead-letter)/.test(f.action)) continue;
    if (/action=rotate|action=limit/.test(JSON.stringify(f.fields))) continue;
    if ((f.raw.match(/value="(rotate|limit)"/) || []).length) continue;
    const body = fill(f);
    const label = `${f.action}  [${Object.keys(body).filter((k) => k !== "_csrf").join(",")}]`;
    try {
      const r = await post(f.action, body);
      const msg = msgOf(r.redirect) || flashOf(r.html || "");
      const bad = /not saved|was not|unchanged|Nothing changed|Unknown|invalid|required|must be|failed|error|could not|does not|another organization|already/i.test(msg);
      results.push({ page, label, status: r.status, redirect: r.redirect, msg, bad, body });
    } catch (e) {
      results.push({ page, label, msg: "THREW " + e.message, bad: true });
    }
  }
}

for (const r of results) {
  console.log(`${r.bad ? "FAIL" : "ok  "}  ${r.page}  ${r.label}\n        → ${r.msg}${r.redirect && /msg=/.test(r.redirect) === false && r.bad ? "" : ""}`);
}
console.log(`\n${results.filter((r) => r.bad).length} suspicious of ${results.length}`);
writeFileSync("/tmp/sweep-results.json", JSON.stringify(results, null, 2));
console.log("cookie:", cookie);
