# STATUS_MODEL.md — what every state means and who acts next (OR-2)

A case is never described by one magic status string. Five **separated, derived**
facts decide where it sits:

| Fact | Values | Set by |
| --- | --- | --- |
| `lifecycle` | application_received → documents_received → documents_checked → awaiting_review → verification → completed | the pipeline, as documents arrive and get checked |
| `routing` | `auto_admit` · `human_review` · `waiting_documents` · null | the requirement evaluation (`src/admissions/evaluate.ts`) |
| `routing_reason` | e.g. `missing_documents`, `partial_submission`, `requirement_not_satisfied` | same evaluation |
| `admission_decision` | `undecided` · `auto_admitted` · `admitted_after_review` · `not_admitted` | auto-admit path or a human on the case page |
| `escalated` / `followup_next_at` | flags | SLA sweep / follow-up scheduler |

## The five queues (`src/admissions/queues.ts`)

Queue placement is a pure function of the facts above (`queueOf`) — evaluated in
order, first match wins:

1. **Completed / Verification** — lifecycle reached `verification` or `completed`.
   *Who acts:* verification team; no admissions action left.
2. **Waiting for Documents** — `routing = waiting_documents`. Sub-states:
   missing documents · partial submission · document clarification · awaiting
   applicant response (a follow-up asking for documents is out).
   *Who acts:* nobody until the applicant replies; the system follows up on a
   schedule. A case is here ONLY while something is genuinely missing — a file
   that arrived but hasn't been reviewed is NOT here (regression-tested).
3. **Human Review Required** — `routing = human_review`, or escalated, or
   **documents are in but no routing exists yet** (the OR-2 fix: these cases
   used to fall into Enquiries). Sub-states carry plain-language labels:
   "Entry requirements not met — decide manually", "Documents in — needs a
   manual decision", "Escalated — overdue, needs attention now", etc. The queue
   page shows the evaluation reason next to every row, so a label never appears
   without its explanation.
   *Who acts:* the assigned officer / course owner.
4. **Admissions / Decision** — a decision exists, or `routing = auto_admit`
   (ready for decision). *Who acts:* registrar confirms or reverses; auto-admits
   are auditable and reversible on the case page.
5. **Enquiries & Communication** — no documents in play: new question, awaiting
   our reply, replied, or follow-up due. *Who acts:* whoever owns the thread.

## Transitions

```
email arrives → pipeline classifies + extracts
   ├─ documents missing        → Waiting for Documents (follow-ups scheduled)
   ├─ docs in, rules pass      → auto_admit → Admissions/Decision
   ├─ docs in, rules fail/unclear → human_review → Human Review Required
   └─ no documents             → Enquiries
human decision on case page → admission_decision set → Admissions/Decision
lifecycle completes          → Completed / Verification
SLA breach                   → escalated=1 → stays in Human Review, labelled
```

## Invariants (pinned by tests)

- A case is in exactly one queue (`queueOf` returns one placement; first match).
- Documents received + no routing ⇒ Human Review, **never** Enquiries and never
  "waiting for documents" (test/owner-acceptance.test.ts, group OR-2).
- Escalation never leaves Human Review.
- No internal codes (doc types, routing codes) are shown in queue labels —
  labels are the plain-language strings in `QUEUES`, with the evaluation reason
  displayed alongside.
