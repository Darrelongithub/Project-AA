# LABELLING-GUIDE — measuring the classifier on your own mail

The per-category auto-send allowlist ships **empty**, and a category should only be
added to it after it has been measured on *your* mail. This guide is how to do that:
100 real messages, labelled by hand, scored by `scripts/eval-classifier.ts`.

The bars are fixed in code (`PASS_BARS` in `scripts/eval-classifier.ts`) and are not
negotiable per run:

- overall accuracy **≥ 90 %**;
- a category may auto-send only with precision **≥ 95 %** on **≥ 30** labelled examples;
- every wrong label that carried high confidence (≥ `CLASSIFIER_MIN_CONFIDENCE`, 0.70
  by default) is listed individually by id.

Anything below the bar stays draft-only. The harness exits non-zero when a bar fails,
so it can gate a change.

## 1. Pull 100 real messages

Take them from the mailbox the console actually reads — the same population the
classifier will see, not a hand-picked easy set.

- Aim for **the last 2–4 weeks** and **every kind of sender** you get: new enquiries,
  replies, complaints, newsletters, internal notes, spam that reaches the mailbox.
- Include the awkward ones on purpose: messages with attachments but no text, messages
  that quote a reference number, forwarded chains, messages in two languages.
- If a category you care about is rare (complaints usually are), keep pulling until you
  have **at least 30 examples of every category you intend to allowlist** — otherwise
  the harness will (correctly) refuse to clear it.

**Use the console's labelling export** (admin only):

```
GET /export/labels.csv            # most recent 200 inbound messages of YOUR organization
GET /export/labels.csv?limit=500  # up to 1000
```

It writes `id,subject,body,true_category` with `true_category` **deliberately blank** —
label before reading any machine answer. Parked (case-less) mail is included, because the
messages a classifier must learn to refuse are part of the measurement. The file starts
with a `#` note about the personal data it contains (the harness skips comment lines),
carries an `X-Personal-Data` response header, and every export writes a `labels_exported`
audit entry naming who exported how many rows for which organization. The export is
scoped to the acting administrator's organization: another tenant's mail never appears,
and a hand-crafted `?organization_id=` is ignored.

Save it straight into the git-ignored location:

```bash
mkdir -p labels
curl -sS -b "sid=$SESSION_COOKIE" "http://127.0.0.1:8080/export/labels.csv?limit=500" \
  -o labels/round1.labels.csv
head -1 labels/round1.labels.csv     # the personal-data note
```

(or just click it in the browser as an administrator and move the download into
`labels/`). If you need more than 1000 messages, export in batches — the cap is
deliberate: a bigger file is a bigger leak.

## 2. Strip personal data before the file leaves your machine

The export is already tenant-scoped, capped and audited, but it still contains real
message text.

The CSV necessarily contains message text, so treat it as personal data:

- Replace every real name, phone number, address, ID/passport number, reference number
  and account number with a placeholder (`[NAME]`, `[PHONE]`, `[REF]`, …). The
  classifier routes on the *shape* of a message, and so should your labels.
- Use opaque ids (`m001`…`m100`) — never the sender's address — in the `id` column.
- Keep the file out of the repository. `labels/` and `*.labels.csv` are git-ignored;
  store it encrypted or delete it after the run.
- The harness output is safe to share: **reports contain ids, labels and numbers only**,
  never a subject or a body (that is asserted by `test/eval-classifier.test.ts`).

## 3. Label

Fill in `true_category` using exactly the product's eight keys. Copy
`docs/eval-template.csv` and replace the example rows.

| Key | Use it when | Notes |
|---|---|---|
| `complaint` | the writer is complaining, escalating, or says service was unacceptable | **wins over everything else** — a complaint that also asks a question is a complaint |
| `document_submission` | the writer says they are sending/attaching the documents or forms | an attachment alone is not enough; the words must say "here are my documents" |
| `missing_document` | the writer asks whether you received something, or says a document is missing | "did you get my file?" |
| `fee_enquiry` | money: fees, invoices, payments, pricing, quotes | |
| `follow_up` | chasing an earlier message: "following up", "any update", "still waiting" | |
| `general_enquiry` | a question about your service, requirements or process | a question with a screenshot attached is still an enquiry |
| `application` | the writer wants to start/open a request | |
| `other` | none of the above: newsletters, spam, internal notes, automated notifications | |

Tie-breaks, in order: `complaint` → `general_enquiry` (a question, even with an
attachment) → `document_submission` (only when the words say documents are being sent)
→ `fee_enquiry` → `missing_document` → `follow_up` → `application` → `other`.
This is the same precedence the deterministic matcher uses, so your labels and the
fallback classifier are measuring the same thing.

Rules for labelling:

- Label **what the message is**, not what you would do about it.
- One label per message. If it genuinely is two things, use the tie-break order above.
- Do not read the classifier's answer before labelling — that is how a measurement
  becomes a rationalisation.
- **Have a second person label 20 of the 100 independently** and count the
  disagreements. If you disagree on more than 2–3, your rubric is ambiguous: fix the
  rubric first, because a classifier can never be more consistent than its labels.

## 4. Run the harness

```bash
# the deterministic keyword matcher (no model, no network, no key)
./node_modules/.bin/tsx scripts/eval-classifier.ts \
  --csv labels/round1.labels.csv \
  --auto-send general_enquiry,complaint \
  --json labels/round1.report.json

# your configured classifier: Gemini may only answer from the categories you list
GEMINI_API_KEY=... ./node_modules/.bin/tsx scripts/eval-classifier.ts \
  --csv labels/round1.labels.csv \
  --classifier configured \
  --categories application,document_submission,missing_document,fee_enquiry,general_enquiry,follow_up,complaint,other \
  --auto-send general_enquiry \
  --json labels/round1-configured.report.json
```

Notes:

- `--auto-send` is the allowlist you are *considering*. The harness reports which of
  those categories actually clear the bar; the product's allowlist is unchanged until
  an administrator adds categories in Settings → Automation mode.
- `--classifier configured` needs the categories you configured in Settings →
  Message categories, and a Gemini key reachable from Connections (stored secret or environment). It
  never prints the key and never writes it to the report.
- Exit code 0 = every bar met; 1 = a bar failed; 2 = bad arguments or CSV.

## 5. Read it and act

- **accuracy** below 90 %: do not allowlist anything. Look at the confusion matrix —
  the two categories that trade messages with each other are where the wording of your
  rubric or your category list is wrong.
- **precision** is the number that matters for auto-send: of everything the classifier
  labelled X, how much really was X. Recall matters for triage workload.
- **wrong-with-high-confidence** is your bug list: every id listed there was confidently
  wrong. Read those messages (in your private copy) and decide whether the rubric, the
  category list or the model is at fault.
- **"Would go to a person"** tells you the staff workload at the current allowlist. An
  empty allowlist means 100 %, which is where every installation starts.
- A deterministic run and a configured run on the same file tell you what the model is
  actually worth: if the configured run is not clearly better on the categories you
  care about, do not pay for it.

Re-run after any change to your categories, your rubric or the model, and keep the JSON
reports (not the CSVs) as the record. `test/eval-classifier.test.ts` proves the harness
itself counts correctly; it uses tiny synthetic fixtures and says nothing about your
accuracy.
