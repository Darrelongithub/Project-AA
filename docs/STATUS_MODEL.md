# STATUS_MODEL.md — what every state means and who acts next (OR-2)

A case is never described by one magic status string. Five **separated, derived**
facts decide where it sits:

| Fact | Values | Set by |
| --- | --- | --- |
| `lifecycle` | application_received → documents_received → documents_checked → awaiting_review → verification → completed | the pipeline as information arrives and is checked, a workflow rule's `stage`, or a person on the case page |
| `routing` | `human_review` · `waiting_documents` · null | the requirement evaluation (`src/rules/evaluate.ts`, `src/rules/caseType.ts`) |
| `routing_reason` | `missing_documents` · `ready_for_review` · `verification_required` | same evaluation |
| `outcome` | `undecided` · `approved_after_review` · `not_approved` · `auto_approved` (imported only) | a human on the case page, with a reason; the pipeline never records one |
| `escalated` / `followup_next_at` | flags | SLA sweep / follow-up scheduler |

A case type may rename every one of these surfaces through its own vocabulary
(`terminology`, `stages`, `queues`); the internal keys and database columns never move.

## The five queues (`src/rules/queues.ts`)

Queue placement is a pure function of the facts above (`queueOf`) — evaluated in
order, first match wins:

1. **Completed / Verification** — lifecycle reached `verification` or `completed`.
   *Who acts:* whoever verifies; no decision is left to record.
2. **Outcomes** — a human outcome exists (`outcome ≠ undecided`).
   *Who acts:* nobody; this is the audit view of decided cases, and an outcome can
   be reopened by new evidence.
3. **Waiting for Documents** — `routing = waiting_documents`. Sub-states: missing
   information · awaiting contact response (a follow-up asking for information is
   out). *Who acts:* nobody until the contact replies; the reminder ladder follows
   up on a schedule. A case is here ONLY while something is genuinely missing — a
   file that arrived but has not been reviewed is NOT here (regression-tested).
4. **Human Review Required** — `routing = human_review`, or escalated, or
   **documents are in but no routing exists yet** (the OR-2 fix: these cases used
   to fall into Enquiries). Sub-states carry plain-language labels: "Evidence
   requires verification", "Ready for review", "Escalated". The queue page shows
   the evaluation reason next to every row, so a label never appears without its
   explanation. *Who acts:* the assigned staff member (a workflow rule's `assign`
   action, or the case page).
5. **Enquiries & Communication** — no documents in play: new enquiry, awaiting our
   reply, or replied. *Who acts:* whoever owns the thread.

## Transitions

```
email arrives → intake gate (tenant signals / known contact) → pipeline classifies + extracts
   ├─ parked (no configured signal, unknown contact) → Mail, no case, audited
   ├─ information missing     → Waiting for Documents (reminder ladder armed)
   ├─ everything present, rule tree passes → Human Review (ready_for_review)
   ├─ rule tree fails or cannot be read    → Human Review (verification_required)
   └─ no documents, a question             → Enquiries
human outcome on the case page → outcome set (+ reason, actor) → Outcomes
lifecycle completes            → Completed / Verification
SLA breach                     → escalated=1 → stays in Human Review, labelled
```

## Invariants (pinned by tests)

- A case is in exactly one queue (`queueOf` returns one placement; first match).
- Documents received + no routing ⇒ Human Review, **never** Enquiries and never
  "waiting for documents" (`test/owner-acceptance.test.ts`, group OR-2).
- Escalation never leaves Human Review.
- The machine never records an outcome: `outcome` changes only through
  `POST /case/:id/outcome`, which requires the `record_outcome` permission and a
  written reason of 1–2000 characters.
- An unconfigured case (no case type) is flagged `unconfigured_case` and held for a
  human; a case type with an empty rule tree is gated by its document checklist
  alone — "no rules" is not "undetermined".
- No internal codes (document types, routing codes) are shown in queue labels —
  labels are the plain-language strings in `QUEUES`, with the evaluation reason
  displayed alongside.
