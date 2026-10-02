# PILOT-RUNBOOK — proving the real Gmail path on a throwaway mailbox

**Status of the real Gmail path.** It has been tested **only against a local sandbox
that mimics Gmail's HTTP shape** (`test/gmail-sandbox.test.ts`: the real
`GmailClient`/`GmailSender`/googleapis stack over a local server, asserting the bytes
Google would receive and the MIME it would serve back). **No test in this repository has
ever talked to a real Gmail account**, and nothing in the Part C run made a real Gmail or
Gemini call. This runbook is the first time the wire meets Google — do it with a
throwaway mailbox, never with a production one.

**Never do the pilot on a real tenant's database.** Use a fresh `DB_PATH` or a copy.

**Client library versions this run was verified on:** `googleapis` 182.0.0
(`google-auth-library` 11.1.0, `gaxios` 7.3.1), `pdfjs-dist` 6.3.289, Node 22.22.3. The
send path was additionally verified from the **compiled** `dist` layout: a multipart reply
with an attachment, organization From/Reply-To and thread id, asserted byte-wise against a
local sandbox. Real Google endpoints are still untouched — that is what this pilot is for.

---

## 0. What you need

- A **throwaway Gmail account** you are happy to lose (e.g. `yourorg-pilot@gmail.com`).
- A Google Cloud project with the **Gmail API** enabled, an **OAuth client** (Desktop
  app) and a **refresh token** for that account with the `gmail.modify` scope (the
  console sends as `me`, reads all mail, and must be able to reply in threads).
  Obtaining these is your step — this repository never sees them, and nothing here
  prints or stores them outside the console's own `secrets` table.
- The build: `npm ci --ignore-scripts && npm run build`.
- A separate database: `export DB_PATH=/tmp/pilot.sqlite` (delete it afterwards).

## 1. Start clean and create the workspace

```bash
rm -f /tmp/pilot.sqlite*
MODE=live DB_PATH=/tmp/pilot.sqlite npm start
```

Open the console, complete the one-time setup (organization name + your administrator
account). Check the workspace is empty and that it says so:

- Overview shows no cases, and the banner **"Mail is not connected"** is visible.
- `sqlite3 /tmp/pilot.sqlite "select count(*) from applicants; select count(*) from case_types;"` → 0 and 0.
- Templates: the seven neutral starters exist (Templates section) — **edit their wording
  before anything can go out**, because a pilot reply that reads like a template is a
  pilot reply you would not send.

## 2. Connect the throwaway mailbox

Settings → Connections → Gmail: address, client id, client secret, refresh token.
Save, then confirm:

- the card says **connected**, and the dashboard's Gmail line says connected;
- the **"Mail is not connected" banner is gone** from every page (that banner is driven
  by the sender actually in use, so its disappearance is the proof that outgoing mail
  now goes to Gmail and not to the in-memory recorder);
- `sqlite3 /tmp/pilot.sqlite "select count(*) from secrets where key like 'gmail%';"` → 2
  (client secret + refresh token stored as secrets, never in `settings`).

## 3. CONFIRM THE GLOBAL DRAFT-ONLY SWITCH IS ON

This is the gate for the whole pilot. Nothing may be sent automatically until you
decide otherwise, and even then only for a category you allowlist.

- Settings → **Automation mode**: global mode reads **draft — hold EVERY automated
  reply for approval**, and every category row reads draft.
- The copy above the dial says the allowlist starts empty and that releasing the global
  mode is not enough on its own.
- Database check:

```bash
sqlite3 /tmp/pilot.sqlite "select value from settings where key='automation_mode';"   # draft
sqlite3 /tmp/pilot.sqlite "select count(*) from automation_config where mode='auto';" # 0
```

If either is wrong, stop and fix it before sending any test mail.

## 4. Configure one case type

Configuration → CaseTypes: create one case type (e.g. `PILOT_REQUEST` / "pilot
request"), give it two required documents, save a rule tree if you want one, then:

- Workflow rules: an **intake** rule that opens a case on words your test mails will
  contain, and a **response** rule that drafts a reply from a real template. Try to save
  a rule naming a template you have not created — it must be **refused with a reason**.
- Configuration → Requirements & repairs: add one **submission window** with a deadline
  in the past (so you can test the late-arrival flag) and one in the future.
- Configuration → CaseTypes → **Inbound addresses**: if your throwaway mailbox can receive
  plus-addressed mail (most can), add one alias for the case type you just created —
  for example `pilot+billing@example.com` → your case type. If you have a second case
  type, add a second alias (`pilot+claims@example.com`) so you can test the ambiguous
  case below. Aliases are matched case-insensitively and honour the `+tag`, so one real
  mailbox is enough.
- Settings → Letters & identity: set the **inbound mailbox address** to the throwaway
  address (this is how the pilot's mail is attributed to your organization), plus the
  From name and Reply-To you want on outgoing mail.
- Team: create one non-admin officer, and give them a **visibility scope** of only this
  case type; check the scope matrix saves and that the officer sees only those cases.

## 5. Send the test messages

Send each from a **different** external address to the throwaway mailbox. Wait up to 60
seconds per message (the poll interval), or use Settings → Connections → "Sync now".

| # | Message | What must happen |
|---|---|---|
| 1 | Plain enquiry containing your intake rule's words, no attachment | A case opens; a reply is **drafted, not sent**; audit shows `case_created`, `email_received`, `case_type_gate`, `requirements_checked`, `automation_held` |
| 2 | Same, with a real PDF attachment (a document on your checklist) | The document is read (case page shows the text and its confidence); checklist ticked; still drafted |
| 3 | Same, with a **CC** to a second address | One case, one thread; the CC'd address is visible in the mail view; nothing is sent to the CC by automation |
| 4 | A message quoting the **reference number** from case 1, sent by the *same* contact | Attaches to case 1 (no second case); the factual status reply is drafted for a person |
| 5 | The same quoted reference from a **different, unknown** sender | Nothing is sent to that stranger; no disclosure of case 1's details to them |
| 6 | **Deleted-thread case**: reply to a draft so a real thread exists, delete that conversation in Gmail, then trigger another send on the same case | The send must still succeed — the retry path re-sends as a new message when Gmail reports the thread is gone (this exact bug was fixed in Part C) |
| 7 | A password-protected PDF | Recorded unreadable with the "password-protected" reason; case held; no automated reply |
| 8 | A file larger than the attachment cap (10 MB) | Parked/recorded as oversized with an audit entry; never fed to the heavy tiers |
| 9 | A newsletter or promo with none of your intake words | **Parked**: kept in Mail with no case, audit `email_parked_non_intake`, nothing sent |
| 10 | A message naming your past-deadline submission window | Case carries the window; audit `window_inferred` and a `late_submission` flag; the case is **not** auto-rejected |
| 11 | **Alias routing**: a message sent to the alias you configured, e.g. `pilot+billing@example.com` (try upper case and a display name too: `"Accounts" <Pilot+Billing@Example.com>`) | The case opens under the case type that address points at; audit `case_type_by_alias` names the alias; the checklist on the case page is that type's |
| 12 | **Ambiguous aliases**: one message addressed to two configured aliases that point at *different* case types (To: `pilot+billing@example.com`, Cc: `pilot+claims@example.com`) | No case type is guessed: `unconfigured_case` flag whose detail names both addresses, audit `case_type_alias_ambiguous`, a `review_needed` notification, and the case page's re-type control lets a person choose. Nothing is sent |
| 13 | **Re-type a case by hand**: on any case, use the case page's "Re-type this case" control | Case type, code, category and frozen checklist all move; audit `case_type_changed` names the actor and both ends; the recorded verdict is unchanged until you press Re-evaluate; nothing is sent |

## 6. Check the audit trail for each

Case page → Audit log, or Configuration → Requirements & repairs → export
(`/export/audit.csv`). For every message above you should be able to answer: *why did
this become (or not become) a case, which case type was chosen and why, what was
drafted, and what was sent*. Specifically:

- `email_not_delivered` must **never** appear while Gmail is connected (it means the
  console recorded a send it could not make). If you see it, stop — the sender is still
  the in-memory recorder.
- `template_missing` means a rule named a template that does not exist: fix the rule or
  create the template; the case is held meanwhile, which is correct.
- `tenant_attribution_fallback` means the message named no organization address: check
  the inbound address in Settings → Letters & identity.
- `held_for_classification` appears only if you configured Message categories; it means
  the label was a guess and a person must route it.

## 7. Let one reply actually go out

Only after everything above is clean, and only in the pilot:

1. Approve a held draft by hand on the case page (a person clicking Send). Confirm it
   arrives in the sending account's Sent mail, in the right thread, with your
   organization's From name and Reply-To, and with any attachment set you bound to the
   template.
2. If you want to test automation end to end: release the global switch **and** allowlist
   exactly one category, then re-send test 1. Confirm the reply arrives, the audit says
   `email_sent_auto`, and no `email_not_delivered`.
3. Put the switch back to **draft** and empty the allowlist when you are done.

## 8. Go / no-go checklist

Go only if every box is ticked:

- [ ] Fresh/copy database; no real tenant data involved at any point.
- [ ] Global automation mode is `draft` and the allowlist is empty (verified in the DB).
- [ ] Gmail shows connected and the "Mail is not connected" banner is gone.
- [ ] All ten test messages behaved as the table says.
- [ ] No `email_not_delivered`, no unexplained `send_failed`, no dead letters
      (Configuration → Requirements & repairs → Parked mail).
- [ ] The deleted-thread case (6) still delivered.
- [ ] Oversized and password-protected files were held, never auto-processed.
- [ ] A stranger quoting a reference (5) received nothing and learned nothing.
- [ ] Every case's audit trail explains its routing without reading the code.
- [ ] Alias routing (11) filed the case under the right case type, and the ambiguous
      message (12) was left for a person instead of guessed.
- [ ] Re-typing a case (13) moved its checklist and sent nothing.
- [ ] A hand-approved reply arrived correctly formatted, in thread, with attachments.
- [ ] The pilot database is deleted or archived, and the throwaway account's
      credentials are removed from the console if you are finished.

**No-go** if any box fails: keep the switch on draft, capture the audit CSV and the
server log, and treat it as a bug report.

## 9. After the pilot

- Label 100 real messages and run `scripts/eval-classifier.ts` before you allowlist any
  category (`docs/LABELLING-GUIDE.md`). The pilot proves the plumbing; the harness
  proves the routing.
- Only then consider releasing automation for one category at a time, and watch
  `email_sent_auto` versus `automation_held` in the audit log for a week.
