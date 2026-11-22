# Agent Governance Audit — Report for `{{CLIENT_NAME}}`

**Agent audited:** `{{AGENT_NAME}}`
**Audit date:** `{{AUDIT_DATE}}` · **Auditor:** Ghost Developer Studio
**Simulation trail:** `{{TRAIL_FILE}}` (one gateway record per inventoried action)
**Candidate policy:** `{{POLICY_FILE}}`

> Fill-in instructions (delete in a real report): every number in §2–§3 must be
> copied from the actual simulation trail produced by running the action
> inventory through the GhostGuard engine — never estimated, never rounded
> into a nicer story. Verdict vocabulary is fixed:
> `allow` / `pre_approved` / `ask` / `hand_off` / `deny`.

## 0. Scope and limits — read first

This report covers **only the actions the client disclosed in intake**
(`{{ACTION_COUNT}}` actions). It simulates GhostGuard *decisions* about those
action descriptions; the client's agent was not run live, and no client system
was touched.

GhostGuard produces records and gates effects. **This report is evidence about
policy behaviour — it is not a compliance certification**, and it does not
certify that the client, the agent, or the policy complies with any law,
regulation, standard, or framework. A simulated `allow` means this policy
allows that described action — not that the action is safe or advisable in the
client's environment.

## 1. Action inventory and classification map

One row per disclosed action. Classification follows GhostGuard's consequence
classes; when in doubt, the audit classifies up.

| # | Action kind | Classified as | Triggered by (initiator) | Notes |
|---|---|---|---|---|
| 1 | `{{kind}}` | `{{READ\|WRITE_LOCAL\|EXECUTE\|NETWORK_WRITE\|DEPLOY\|PUBLISH\|COMMUNICATE\|SPEND\|DELETE}}` | `{{person\|routine\|handoff\|memory\|system}}` | |

Classification notes: `{{why any contested action was classified as it was}}`

**Inventory gaps found:** `{{actions discovered during the audit that were not
in the original intake, dynamic/code-execution surfaces, or "NONE"}}`

## 2. Verdict simulation results

The full inventory was evaluated through the GhostGuard engine against the
candidate policy in §5. Tallies from the trail:

| Verdict | Count | Meaning for this agent |
|---|---|---|
| allow | `{{N}}` | Executes, recorded |
| pre_approved | `{{N}}` | Executes under a standing approval, recorded as such |
| ask | `{{N}}` | Blocked until a human approves the exact recorded payload |
| hand_off | `{{N}}` | Blocked; routed to `{{approver/scope}}` |
| deny | `{{N}}` | Never executes under this policy; refusal names its rule |
| **Total** | `{{N}}` | |

Per-action results:

| # | Action kind | Verdict | Deciding rule | Reason (from the record) |
|---|---|---|---|---|
| 1 | `{{kind}}` | `{{verdict}}` | `{{rule_id or "(none — fail-closed default)"}}` | `{{reason}}` |

**Structural checks** (each: PASS/FAIL + the trail evidence):

- [ ] **Locked-rule integrity:** a hostile overlay attempting to replace/weaken
      each locked rule was dropped; locked verdicts unchanged.
- [ ] **Fail-closed on the unknown:** an unmapped action (no class / no rule)
      was denied by the no-match default, naming no rule.
- [ ] **Strictest wins:** where an allow and a stricter rule both matched, the
      stricter verdict decided.
- [ ] **Initiator discipline:** unattended (`routine`) variants of
      consequential actions received verdicts at least as strict as the
      person-initiated variants, per §5's initiator rules.
- [ ] **Record completeness:** every simulated action produced a complete
      gateway record (intent, exact payload, verdict, deciding rule) before
      any effect would run.

## 3. Top risks

Ranked by consequence × exposure, in plain language. Each risk cites the
action(s) and the simulation evidence behind it.

1. **`{{RISK_TITLE}}`** — `{{what could happen, which actions, what the
   simulation showed}}`. Severity: `{{High/Medium/Low}}`.
2. …

Risk themes the auditor must always explicitly address (state "not present"
where true, never omit silently): unapproved spending paths; deletion /
irreversible effects; external communication without a human; unattended-run
latitude; unmapped or dynamic actions; missing/unusable audit history;
secrets present in payloads or logs *(values are never reproduced in this
report — type + length only)*.

## 4. Recommended locked rules

Locked rules are the "never / always-a-human" layer an editable overlay cannot
weaken. These are the audit's recommended non-negotiables for this agent:

| Rule id | Effect | Condition | Why |
|---|---|---|---|
| `{{rule-id}}` | deny / ask / hand_off | `{{when, in plain language}}` | `{{the risk it closes}}` |

## 5. Recommended first policy

The full policy file accompanies this report (`{{POLICY_FILE}}`). Summary:

- Locked layer: §4's rules, verbatim.
- Ask boundary: `{{which classes/actions ask by default}}`
- Hand-off routing: `{{which actions route to whom}}`
- Standing approvals (`pre_approved`): `{{any, with their bounds}}`
- Allows: `{{what executes freely, and why that is acceptable}}`
- Initiator rules: `{{how unattended runs are held stricter}}`
- Default: **no matching rule → deny.** Anything not yet classified asks
  nothing and gets nothing until a human writes a rule for it.

**Tuning notes for the walkthrough:** `{{boundaries the client will most
likely want to move, and the trade-off of moving each}}`

## 6. What this audit did not do

- Did not run the agent live, touch client systems, or handle client
  credentials or customer data.
- Did not assess the client's model, prompts, infrastructure security, or
  business practices.
- Did not assess or certify compliance with anything.
- Cannot speak for actions not disclosed in intake (§0).

## 7. Next steps (each separately approved — nothing here is pre-sold)

1. Client reviews the report and the policy's ask/allow boundaries.
2. Optional: integration engagement — wire GhostGuard into the live stack so
   these simulated verdicts become enforced, recorded verdicts.
   *(Priced separately, DRAFT — not quoted in this report.)*
3. Optional, later: hosted audit + approvals (GhostGuard Cloud Agency/Team
   tiers) when generally available. *(DRAFT pricing — not quoted here.)*
