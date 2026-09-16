/**
 * Applicant portal pages (v3 features 12, 35, 40).
 *
 * Security stance: the reference number identifies the case — it is NOT the
 * password. Access requires ref + the applicant's own email + a one-time
 * code. Uploads enter the same case history as a 'portal'-channel message.
 */
import type { Repo } from "../db/repo";
import type { ApplicantRow } from "../types";
import { LIFECYCLE_LABELS } from "../types";
import { docLabel } from "../rules";
import { avatar, crest, esc, fmtDate, layout, lifecycleBadge, lifecycleStepper, type Theme } from "./views";

export function portalStartPage(error?: string, theme?: Theme): string {
  return layout({
    title: "Applicant portal — Riara University",
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(56)}
  <h1 class="center">Applicant portal</h1>
  <p class="sub center">Check your file and upload missing documents. Your reference number finds your case — we then send a one-time code to <b>your own email</b> to prove it's really you.</p>
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/portal/start">
    <label>Reference number</label>
    <input type="text" name="ref" placeholder="e.g. RU-2026-000001" autofocus>
    <label>Email address you applied with</label>
    <input type="email" name="email" placeholder="you@example.org">
    <p style="margin-top:16px"><button class="btn" style="width:100%">Send my access code</button></p>
  </form>
  <p class="small muted">Prefer just checking status? Use the <a href="/status">status lookup</a>.</p>
</div>`,
  });
}

export function portalOtpPage(ref: string, demoCode: string | null, error?: string, theme?: Theme): string {
  return layout({
    title: "Enter your access code — Riara University",
    publicPage: true,
    theme,
    content: `
<div class="loginbox card">
  ${crest(56)}
  <h1 class="center">Enter your access code</h1>
  <p class="sub">We sent a 6-digit code to the email on file for <span class="mono">${esc(ref)}</span>. It expires in 10 minutes.</p>
  ${demoCode ? `<p class="small">🧪 <b>Demo mode:</b> email delivery is off, so here is your code:</p><div class="otpbox">${esc(demoCode)}</div>` : ""}
  ${error ? `<div class="flash err" style="position:static;margin-bottom:14px">${esc(error)}</div>` : ""}
  <form method="post" action="/portal/verify">
    <input type="hidden" name="ref" value="${esc(ref)}">
    <label>6-digit code</label>
    <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autofocus style="letter-spacing:8px;font-weight:700;text-align:center">
    <p style="margin-top:16px"><button class="btn" style="width:100%">Sign in to my application</button></p>
  </form>
  <p class="small muted"><a href="/portal">← start over</a></p>
</div>`,
  });
}

export function portalHomePage(repo: Repo, a: ApplicantRow, flash?: string, theme?: Theme): string {
  const requirements = repo.effectiveRequirements(a).filter((r) => r.required);
  const activeDocs = repo.listDocuments(a.id, { activeOnly: true });
  const missing = requirements.filter((r) => !activeDocs.some((d) => d.document_type === r.document_type));

  const checklist = requirements
    .map((r) => {
      const doc = activeDocs.find((d) => d.document_type === r.document_type);
      return doc
        ? `<div><span class="ok">✓</span> ${esc(docLabel(r.document_type))} <span class="muted small">received ${esc(fmtDate(doc.received_at))}</span></div>`
        : `<div><span class="no">✗</span> ${esc(docLabel(r.document_type))} <span class="muted small">missing</span></div>`;
    })
    .join("");

  const missingOptions = missing
    .map((m) => `<option value="${m.document_type}">${esc(docLabel(m.document_type))}</option>`)
    .join("");

  return layout({
    title: `${a.ref_number} — my application`,
    publicPage: true,
    theme,
    content: `
<div class="card" style="max-width:760px;margin:24px auto">
  <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    ${avatar(a.full_name ?? a.ref_number, 46)}
    <div><h1 class="mono" style="margin:0">${esc(a.ref_number)}</h1>
    <div class="sub" style="margin:2px 0 0">${esc(a.full_name ?? "")} · status: ${esc(LIFECYCLE_LABELS[a.lifecycle])}</div></div>
    ${lifecycleBadge(a.lifecycle)}
    <form method="post" action="/portal/logout" style="margin-left:auto"><button class="btn ghost small">Sign out</button></form>
  </div>
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
  ${lifecycleStepper(a.lifecycle)}

  <h2>Your document checklist</h2>
  <div class="checklist">${checklist}</div>

  ${missing.length ? `
  <h2>Upload a missing document</h2>
  <div class="uploadzone" id="uz">
    <p>📤 <b>Drag a PDF/JPG/PNG here</b> or use the button below.</p>
    <input type="file" id="fu" accept="application/pdf,image/png,image/jpeg">
    <p class="small muted">Your upload is attached to this case automatically and checked by the same process as emailed documents.</p>
    <div id="up-msg" class="small" style="margin-top:8px"></div>
    <button class="btn" id="up-btn" disabled>Upload now</button>
  </div>
  <script>
  (function () {
    var input = document.getElementById('fu');
    var btn = document.getElementById('up-btn');
    var msg = document.getElementById('up-msg');
    var zone = document.getElementById('uz');
    var file = null;
    input.addEventListener('change', function () { file = input.files[0] || null; btn.disabled = !file; msg.textContent = file ? ('Selected: ' + file.name) : ''; });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.style.borderColor = '#1d3557'; });
    zone.addEventListener('dragleave', function () { zone.style.borderColor = ''; });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.style.borderColor = '';
      file = e.dataTransfer.files[0] || null; btn.disabled = !file;
      if (file) msg.textContent = 'Selected: ' + file.name;
    });
    btn.addEventListener('click', function () {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { msg.textContent = 'File too large (max 10 MB).'; return; }
      btn.disabled = true; btn.textContent = 'Uploading…';
      var fr = new FileReader();
      fr.onload = function () {
        var base64 = String(fr.result).split(',')[1];
        fetch('/portal/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', data: base64 })
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.ok) { location.reload(); } else { msg.textContent = j.error || 'Upload failed.'; btn.disabled = false; btn.textContent = 'Upload now'; }
        }).catch(function () { msg.textContent = 'Upload failed — please retry.'; btn.disabled = false; btn.textContent = 'Upload now'; });
      };
      fr.readAsDataURL(file);
    });
  })();
  </script>` : `<p class="small" style="margin-top:12px">✅ Your file is complete — thank you! New documents you upload will update this case.</p>`}

  <p class="small muted">Signed in with a one-time code sent to ${esc(a.email_address)}. Admission decisions are made by the admissions committee and communicated officially.</p>
</div>`,
  });
}
