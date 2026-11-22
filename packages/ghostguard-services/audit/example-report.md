# Agent Governance Audit — Report for Copperline Support Co. (FICTIONAL)

> ## ⚠️ FICTIONAL WORKED EXAMPLE — NOT A REAL CLIENT
> "Copperline Support Co.", its agent, its staff, and every action, payload,
> and amount in this report are **entirely fictional**, invented to show what a
> filled audit report looks like. The *verdicts* are real: they were produced
> by running this fictional inventory through the real GhostGuard engine
> (`~/workspace/ghostguard/dist`) — see `generate-example-trail.mjs`,
> `example-trail.jsonl`, and `example-summary.json` in this directory.

**Agent audited:** "HelpDesk Helper" (FICTIONAL) — actor id `helpdesk-helper-fictional`
**Audit date:** Oct 10, 2026 (worked example) · **Auditor:** Ghost Developer Studio
**Simulation trail:** `example-trail.jsonl` (17 gateway records)
**Candidate policy:** `policy.example.json` (12 rules)

## 0. Scope and limits — read first

This worked example covers **only the 17 fictional actions in the fictional
intake**. It simulates GhostGuard *decisions* about those action descriptions;
no agent was run live and no system was touched — and in a real engagement the
same limits apply to the client's disclosed inventory only.

GhostGuard produces records and gates effects. **This report is evidence about
policy behaviour — it is not a compliance certification**, and it does not
certify that anyone complies with any law, regulation, standard, or framework.
A simulated `allow` means this policy allows that described action — not that
the action is safe or advisable.

## 1. Action inventory and classification map

| # | Action kind | Classified as | Triggered by (initiator) | Notes |
|---|---|---|---|---|
| a01 | ticket.read | READ | person | Reads a support ticket |
| a02 | kb.search | READ | routine | Scheduled knowledge-base search |
| a03 | ticket.draft | WRITE_LOCAL | routine | Drafts a reply — drafts only, cannot send |
| a04 | note.write | WRITE_LOCAL | person | Writes a local shift note |
| a05 | email.send | COMMUNICATE | person | To a customer (`external: true`) |
| a06 | email.send | COMMUNICATE | person | To a teammate (`external: false`) |
| a07 | email.send | COMMUNICATE | routine | To a teammate, unattended run |
| a08 | refund.issue | SPEND | person | $25.00 fictional refund |
| a09 | subscription.buy | SPEND | routine | $49.00/mo fictional plan purchase |
| a10 | record.delete | DELETE | person | Deletes ticket record T-0917 |
| a11 | macro.deploy | DEPLOY | routine | Deploys a helpdesk macro; payload names a credential as type + length only (API key, 40) — value never present |
| a12 | kb.publish | PUBLISH | person | Publishes a KB article publicly |
| a13 | form.submit | NETWORK_WRITE | routine | Vendor status form, unattended |
| a14 | form.submit | NETWORK_WRITE | person | Same form, person-initiated |
| a15 | tool.execute | EXECUTE | routine | CRM lookup tool, unattended |
| a16 | tool.execute | EXECUTE | person | Same tool, person-initiated |
| a17 | mystery.action | **unmapped** | person | Surfaced in the fictional intake with no classification — deliberately left unmapped to test the default |

Classification notes: `email.send` is COMMUNICATE (not NETWORK_WRITE) because
its consequence is a message reaching a person; the external/internal split is
carried in the payload (`external`) so policy can route them differently.
`refund.issue` and `subscription.buy` are both SPEND — a refund is still a
financial commitment leaving the business.

**Inventory gaps found:** one — `mystery.action` (a17) could not be classified
from the fictional intake description. In a real audit this is a headline
finding: an action nobody can describe is an action nobody can govern, and §2
shows what the policy does with it today.

## 2. Verdict simulation results

All 17 actions were evaluated through the GhostGuard engine against
`policy.example.json`. Tallies copied from `example-summary.json` (computed
from the trail itself):

| Verdict | Count | Meaning for this agent |
|---|---|---|
| allow | **5** | Executes, recorded |
| pre_approved | **1** | Executes under a standing approval, recorded as such |
| ask | **6** | Blocked until a human approves the exact recorded payload |
| hand_off | **1** | Blocked; routed to the owner |
| deny | **4** | Never executes under this policy; refusal names its rule |
| **Total** | **17** | |

By class: READ 2 · WRITE_LOCAL 2 · COMMUNICATE 3 · SPEND 2 · DELETE 1 ·
DEPLOY 1 · PUBLISH 1 · NETWORK_WRITE 2 · EXECUTE 2 · unmapped 1.
By initiator: person 10 · routine 7.

Per-action results (verdict, deciding rule, and reason exactly as recorded):

| # | Action kind | Verdict | Deciding rule | Reason (from the record) |
|---|---|---|---|---|
| a01 | ticket.read | allow | reads-allow | allowed by policy rule "reads-allow" |
| a02 | kb.search | allow | reads-allow | allowed by policy rule "reads-allow" |
| a03 | ticket.draft | pre_approved | ticket-drafts-preapproved | policy rule "ticket-drafts-preapproved" grants standing approval (pre-approved within its bounds) |
| a04 | note.write | allow | local-writes-person-allow | allowed by policy rule "local-writes-person-allow" |
| a05 | email.send | hand_off | external-comms-to-owner | policy rule "external-comms-to-owner" hands this action off to "owner" instead of executing it |
| a06 | email.send | ask | comms-ask | policy rule "comms-ask" requires human approval (ask) |
| a07 | email.send | ask | comms-ask | policy rule "comms-ask" requires human approval (ask) |
| a08 | refund.issue | deny | no-spend-ever | denied by policy rule "no-spend-ever" |
| a09 | subscription.buy | deny | no-spend-ever | denied by policy rule "no-spend-ever" |
| a10 | record.delete | deny | no-delete-ever | denied by policy rule "no-delete-ever" |
| a11 | macro.deploy | ask | deploys-ask | policy rule "deploys-ask" requires human approval (ask) |
| a12 | kb.publish | ask | publish-asks | policy rule "publish-asks" requires human approval (ask) |
| a13 | form.submit | ask | routine-consequential-asks | policy rule "routine-consequential-asks" requires human approval (ask) |
| a14 | form.submit | allow | network-person-allow | allowed by policy rule "network-person-allow" |
| a15 | tool.execute | ask | routine-consequential-asks | policy rule "routine-consequential-asks" requires human approval (ask) |
| a16 | tool.execute | allow | execute-person-allow | allowed by policy rule "execute-person-allow" |
| a17 | mystery.action | deny | *(none — fail-closed default)* | no policy rule matched this action — denied by the fail-closed default |

**Structural checks** (all run by `generate-example-trail.mjs`, results in
`example-summary.json`):

- [x] **Locked-rule integrity: PASS.** A hostile overlay that tried to replace
      the locked `no-spend-ever` and `no-delete-ever` rules with allows
      (reusing their ids, plus a blanket allow) was dropped by
      `mergePolicyDocs`; under the merged policy a refund still denied by
      `no-spend-ever` and a delete still denied by `no-delete-ever`.
- [x] **Fail-closed on the unknown: PASS.** a17, the unmapped action, denied
      with `rule_id: null` — the no-match fail-closed default named no rule
      because no rule granted it anything.
- [x] **Strictest wins: PASS.** a05 matched both `comms-ask` (ask) and
      `external-comms-to-owner` (hand_off); hand_off, the stricter tier,
      decided.
- [x] **Initiator discipline: PASS.** The same `form.submit` asked as a
      routine (a13) and allowed for a person (a14); the same `tool.execute`
      asked as a routine (a15) and allowed for a person (a16).
- [x] **Record completeness: PASS.** All 17 simulated actions produced a
      complete gateway record (action id, kind, class, actor, initiator,
      verdict, deciding rule, reason, exact payload) — in the trail,
      `example-trail.jsonl`, one record per line.

## 3. Top risks

Ranked by consequence × exposure, from the fictional intake and the
simulation evidence:

1. **The agent can spend money two different ways — including unattended.**
   `refund.issue` (a08) and `subscription.buy` (a09) are both SPEND, and a09
   is routine-initiated: left ungoverned, a scheduled run could commit the
   business to a recurring $49/mo (fictional figure) with no human in the
   loop. Severity: **High.** Closed by the locked `no-spend-ever` rule — both
   denied, and the hostile-overlay check proves an ordinary policy edit
   cannot reopen them.
2. **An unclassifiable action exists in the inventory.** `mystery.action`
   (a17) arrived in intake with no description anyone could classify.
   Severity: **High** as a governance gap — mitigated today only because the
   policy fails closed (denied, no rule). The real fix is identifying what
   this action actually is; until then it can never be allowed, by design.
3. **External communication has no natural owner.** The agent drafts and
   sends customer email (a05). Drafting is safely pre-approved (a03), but a
   send reaches a real customer. Severity: **Medium.** The policy routes
   external sends to the owner (`hand_off`) rather than the run's approver,
   and internal sends still ask (a06, a07).
4. **Unattended runs inherit person-level latitude unless policy says
   otherwise.** Form submits and tool execution are allowed for a person
   (a14, a16) — without the initiator rule, the 7 routine-initiated actions
   would inherit the same freedom. Severity: **Medium.** Closed by
   `routine-consequential-asks`: a13 and a15 asked.
5. **Deletion is one mistaken payload away from permanent.** `record.delete`
   (a10) is irreversible in this fictional system. Severity: **Medium**
   (High if records are the system of record). Closed by locked
   `no-delete-ever`.

Explicitly checked and **not present** in this fictional inventory: secrets
in payload values (the only credential, in a11, is described as type +
length only); a missing audit history is the *subject* of this engagement
(the agent had none — which is why every verdict above comes from simulation,
not from a past trail).

## 4. Recommended locked rules

| Rule id | Effect | Condition | Why |
|---|---|---|---|
| no-spend-ever | deny | `permission_class == 'SPEND'` | The agent never spends money or creates a financial commitment, whoever asks — closes Risk 1, including for unattended runs |
| no-delete-ever | deny | `permission_class == 'DELETE'` | Deletion is irreversible here; a human does it by hand if it is ever truly needed — closes Risk 5 |

Both are `locked: true` in `policy.example.json`: an editable overlay cannot
replace, weaken, or shadow them (proven in §2's hostile-overlay check).

## 5. Recommended first policy

Full file: `policy.example.json` (12 rules). Summary:

- **Locked layer:** §4's two rules, verbatim.
- **Ask boundary:** all COMMUNICATE that stays internal, all DEPLOY, all
  PUBLISH, and EXECUTE / NETWORK_WRITE / DEPLOY when the initiator is a
  routine.
- **Hand-off routing:** external COMMUNICATE routes to `owner`.
- **Standing approvals:** `ticket.draft` is `pre_approved` — drafting is
  reversible and sends nothing; its bounds are the rule's own condition
  (kind exactly `ticket.draft`).
- **Allows:** READ always; WRITE_LOCAL, NETWORK_WRITE, and EXECUTE for
  person-initiated runs.
- **Initiator rules:** `routine-consequential-asks` holds unattended runs
  stricter, as §2 demonstrates on a13–a16.
- **Default:** no matching rule → **deny**. a17 is the demonstration: anything
  not yet classified gets nothing until a human writes a rule for it.

**Tuning notes for the walkthrough:** the two boundaries a real client in
this shape usually debates are (a) whether small refunds should move from the
locked deny to an `ask` with an amount bound — the audit recommends *against*
unlocking spend in a first policy; add an ask-tier spend rule later, above a
named amount, once the trail shows real volume — and (b) whether internal
`email.send` by a person should drop from ask to allow; the trade-off is
approval fatigue vs. a record that a human saw each send before it went.

## 6. What this audit did not do

- Did not run any agent live, touch any system, or handle any credentials or
  customer data. (In this worked example there was nothing real to touch —
  every input is fictional.)
- Did not assess any model, prompts, infrastructure security, or business
  practices.
- Did not assess or certify compliance with anything.
- Cannot speak for actions not disclosed in intake (§0) — here, that caveat
  is itself demonstrated by a17.

## 7. Next steps (each separately approved — nothing here is pre-sold)

1. Client reviews the report and the policy's ask/allow boundaries.
2. Optional: integration engagement — wire GhostGuard into the live stack so
   these simulated verdicts become enforced, recorded verdicts.
   *(Priced separately, DRAFT — not quoted in this report.)*
3. Optional, later: hosted audit + approvals (GhostGuard Cloud) when
   generally available. *(DRAFT pricing — not quoted here.)*
