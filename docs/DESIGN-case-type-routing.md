# DESIGN — routing inbound mail to a case type

**Status (updated by Part D).** The owner chose option **D**: safety valve first, then
alias routing. Both are now **BUILT**:

- **Safety valve — shipped (Part D Phase 2).** `POST /case/:id/case-type` lets any staff
  member who can see a case move it to another case type of the same organization. It
  re-freezes the configuration snapshot, leaves the recorded verdict alone until somebody
  presses Re-evaluate (QUESTIONS.md Q8), sends nothing, fires no rule, and audits
  `case_type_changed` with the actor and both ends. The control sits on the case page
  under the reference line. Tests: `test/case-retype.test.ts`.
- **Option C (delivered address) — shipped (Part D Phase 3).** Table `case_type_aliases`
  (`organization_id`, `case_type_id`, `address UNIQUE` installation-wide, `active`),
  resolved from the Delivered-To/To/Cc headers ingestion already parses, case-insensitive,
  honouring plus-addressing (`intake+billing@…` routes like `billing@…`; QUESTIONS.md Q9).
  Precedence: a connector's declaration, then an alias, then the single-case-type default,
  then nothing. Two aliases pointing at different case types are ambiguous and leave the
  case unconfigured for a person, with `case_type_alias_ambiguous` in the audit and a
  `review_needed` notification. Retiring an alias keeps the row and stops the routing.
  Minimal UI on Configuration → CaseTypes (`#aliases`). Tests: `test/alias-routing.test.ts`.

**Not chosen, not built:** option A (intake rules declaring a case type) and option B
(classifier labels mapped to case types) remain as written below, unchanged and available
if alias routing turns out not to cover a tenant's mailbox.

---

The rest of this file is the original decision paper, kept as written.

## The problem

A case's **case type** decides everything downstream: which documents are required,
which rule tree is evaluated, which templates and vocabulary apply, which workflow rules
match, and what the checklist on the case page says. Today a message's case type can only
come from one place: `email.caseTypeCode`, which is set by the **portal/test-intake
route** — never by real mail ingestion.

Consequences in a tenant with several case types:

- Real inbound mail arrives with no declared type, so `genericCaseType` is undefined.
- The case is flagged `unconfigured_case`: empty checklist, no rule tree, human review.
- Type-scoped workflow rules never match (only organization-wide rules, `case_type_id IS
  NULL`, are in scope), so per-type replies, ladders and assignments do not fire.
- Phase B4 added a default for the unambiguous case: a tenant with **exactly one** case
  type gets it automatically, audited as `case_type_inferred`. That covers single-service
  tenants and nothing else.

So: a tenant that configures a second case type currently makes its inbound routing
*worse*, not better. That is the gap.

Two related facts that constrain any design:

- `repo.updateCase()` already accepts `case_type_id`, but **no route or UI exposes it** —
  there is no way for a person to re-type a case today. Any option below needs that as
  its safety valve.
- `RuleAction` (src/rules/workflow.ts) has `decision`, `stage`, `queue`, `priority`,
  `assign`, `reply_action`, `template_key`, `attachment_set`, `followup`,
  `followup_action`, `audit_code`, `request_info`, `sla_hours` — **no case-type key**.

## Option A — intake rules declare the case type

An organization-wide intake rule (`case_type_id IS NULL`) gains an action key, e.g.
`case_type: "FREIGHT_QUOTE"`. Evaluation becomes two passes: first the org-wide intake
rules (which may name a type), then, once the type is known, the type-scoped rules —
which is already how `rulesForCaseScope` filters, so the second pass needs no new
machinery.

- **Pros.** Reuses the existing rule engine, its UI tab, its conditions
  (`text`/`subject`/`category`/`senderState`/`bodyIsRef`) and its audit codes. Fully
  deterministic and explainable: the audit already names the rule that fired. No new
  dependency, no model, no new configuration surface — one field on a form that already
  exists. Testable with the fixtures we have.
- **Cons.** Keyword rules mis-route fuzzy language ("quote" in a complaint about a
  quote). Two-pass ordering must be documented or administrators will be confused about
  which rule won. A tenant must write and maintain rules for every type. Rules that name
  a type must be validated (refuse a type the tenant does not have — the same guard Phase
  B1 added for templates).
- **Effort.** Small: one action key + validation, the two-pass change in
  `processEmail`, a select in the rule form, and tests.

## Option B — the classifier's label picks the case type

Message categories are already tenant data (Configuration → Requirements & repairs →
Message categories) and can be model-labelled with an enforced allow-list. Add a mapping
from category → case type, and let the label choose the type.

- **Pros.** Handles fuzzy language far better than keywords. Reuses the Phase C4
  evaluation harness, so the routing quality is **measurable before it is trusted** —
  the same bars (precision ≥ 95 %, ≥ 30 examples) can gate which mappings go live. One
  more row of configuration on a surface that already exists.
- **Cons.** Puts a model in the routing path: a wrong label becomes a wrong checklist,
  which is a worse failure than a held message. Needs a Gemini key and the labelling
  discipline. Two config surfaces now interact (categories and mappings), and the
  fallback label (`source: "fallback"`) must force a human — which Phase 3 already does
  for sends, and would need to do for typing too.
- **Effort.** Medium: the mapping table/UI, the pipeline change, and the
  uncertainty-holds rules extended to typing.

## Option C — the delivered address (or alias) picks the case type

Phase B4 already resolves the **tenant** from the address a message was delivered to.
Extend the same idea one level down: an organization may declare several inbound
addresses (or `+tags`/aliases), each bound to a case type — `quotes@…` opens a freight
quote, `claims@…` opens a claim.

- **Pros.** Deterministic, zero NLP, trivially explainable to a contact ("email
  quotes@…"), and it rides plumbing that now exists (`organizations.inbound_address`,
  `GmailClient` returning Delivered-To/To/Cc, the attribution audit). Cannot mis-read a
  message: the sender chose the route. Cheap to test.
- **Cons.** Requires the tenant to own aliases or mailboxes, and to publish them. Does
  not help a single shared inbox, which is the common small-office case. Aliases are
  often stripped by forwarding, so `Delivered-To` matters more than `To`.
- **Effort.** Small-medium: a per-organization address→type table (or a repeatable
  `inbound_addresses` field), the Settings UI, resolution in the same place tenant
  attribution happens, and an audit reason.

## Recommendation

**C first, then A, with the human safety valve; B only after C4 measurements exist.**

1. **C** is the cheapest reliable signal and it cannot be wrong about the message's
   content — where a tenant can publish an address per service, routing is solved.
2. **A** covers the shared-inbox case with the machinery administrators already
   understand, and every routing decision stays explainable in the audit trail.
3. **B** is the right answer for fuzzy language but must arrive *after* the labelling
   harness has been run on real mail, and only for category→type mappings that clear the
   bars. Turning it on first would put an unmeasured model in the routing path.

Whichever is chosen, three invariants should hold (and be tested):

- **Never guess silently.** The chosen type is audited with its reason
  (`case_type_routed: address=quotes@… / rule="Quotes open a case" / label=complaint
  (confidence 0.93) / inferred: only one case type / chosen by <staff>`).
- **No match means a person.** Unrouted mail keeps today's behaviour: `unconfigured_case`
  and human review — not a default type, not the first type in a list.
- **A person can always re-type a case.** Expose `repo.updateCase({case_type_id})` on the
  case page (admin or a permission), re-freeze the configuration snapshot, and audit it.
  Without this, every mis-route is a dead end.

Suggested order of work: safety valve (re-type on the case page) → C → A → measure → B.

**Done so far:** safety valve → C. **Next, if needed:** A (rules declaring a type) for
shared inboxes whose mail cannot be separated by address, then measure with
`scripts/eval-classifier.ts` before considering B.
