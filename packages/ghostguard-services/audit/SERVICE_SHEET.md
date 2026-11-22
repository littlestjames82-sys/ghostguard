# Agent Governance Audit — Service Sheet

**By Ghost Developer Studio — GhostGuard services**

> ## ⚠️ DRAFT — NOT PUBLISHED, NOT AN OFFER
> This sheet is an unpublished draft prepared for internal review. It has not been
> sent to anyone, listed anywhere, or shared publicly. **All pricing is DRAFT**
> (see §6) and is not final until Ryan Cotten of Ghost Developer Studio approves
> it in writing. Nothing in this sheet is a commitment to any client.

---

## 1. What this is

An **Agent Governance Audit** is a fixed-scope review of one AI agent that can
take real-world actions — send messages, publish, spend, deploy, delete, write
files, call tools. We inventory everything the agent *can* do, run that action
set through **GhostGuard** (Ghost Developer Studio's record-first, fail-closed
policy engine), and hand you two things:

1. **A written audit report** — what your agent can do today, what a policy
   would allow / ask about / hand off / deny, your top governance risks, and
   the exact rules we recommend locking in first.
2. **Your first working GhostGuard policy** — a real policy file, tested
   against your action inventory, that you can run with the free, MIT-licensed
   GhostGuard engine.

**What GhostGuard does — stated plainly:** GhostGuard *produces records* and
*gates effects*. Every proposed action is classified, decided by an executable
policy, and written to an audit record **before** anything runs; an action
executes only on an `allow` / `pre_approved` verdict.

**What it does not do:** GhostGuard does **not** provide compliance
certification, and this audit does **not** certify that you, your agent, or your
business complies with any law, regulation, standard, or framework. It produces
evidence and decision records. What you do with them — and any compliance
obligations you have — remain yours.

## 2. Who it is for

- Indie developers and small teams shipping an agent that acts in the real
  world (browser, support, ops, publishing, purchasing) who have had — or want
  to avoid — the "it did *what*?" moment.
- Small AI agencies who need to hand a client a readable record of what the
  agent did, asked about, and was refused.
- Teams with light compliance *pressure* who need who/what/rule/when evidence
  for agent actions. (Evidence, again — not certification.)

Not a fit, yet: large-enterprise procurement engagements, and chatbots with no
real-world effects (there is nothing to govern).

## 3. Fixed scope — the steps

One agent, one action inventory, one policy. The audit runs in five steps:

| Step | What happens | Who |
|---|---|---|
| **1. Intake** | You complete the intake checklist (`INTAKE.md`): the agent's purpose, every action/tool it can invoke, how each action is triggered (person at the keyboard vs. unattended routine), where records/logs live today, and who should approve consequential actions. No credentials are ever collected — see §5. | Client |
| **2. Action inventory** | We map every action your agent can take onto GhostGuard's consequence classes (`READ`, `WRITE_LOCAL`, `EXECUTE`, `NETWORK_WRITE`, `DEPLOY`, `PUBLISH`, `COMMUNICATE`, `SPEND`, `DELETE`) and document the classification map. When in doubt, we classify *up* — an unknown shape is treated as consequential. | Studio |
| **3. Policy simulation** | We draft a candidate policy for your agent (including locked "never" rules) and **run your full action inventory through the real GhostGuard engine** — every action gets a simulated verdict (`allow` / `pre_approved` / `ask` / `hand_off` / `deny`), the deciding rule, and a complete gateway record. The simulation includes hostile checks: an editable overlay that tries to weaken a locked rule must fail, and unmapped/unknown actions must fail closed (deny). Nothing of yours executes — this is decision simulation against your action *descriptions*, not a live run of your agent. | Studio |
| **4. Report** | You receive the audit report (structure in `REPORT_TEMPLATE.md`): action inventory with simulated verdicts, verdict tallies, top risks in plain language, recommended locked rules, and the recommended first policy. | Studio |
| **5. Walkthrough** | One review session to go through the report, tune the ask/allow boundaries to how you actually work, and hand over the policy file plus the simulation trail (JSONL) so you can re-run it yourself. | Both |

**Out of scope** (available later as separate, separately-approved work):
wiring GhostGuard into your live stack (that is the integration engagement),
hosted audit/approvals (GhostGuard Cloud, not yet generally available),
policy changes after handover, and monitoring your agent on an ongoing basis.

## 4. Deliverables

You receive, as files you keep:

1. `audit-report.md` — the filled audit report for your agent.
2. `policy.json` — your recommended first GhostGuard policy (GhostGuard
   policy-document format; runs on the free MIT engine).
3. `trail.jsonl` — the simulation trail: one gateway record per inventoried
   action, with verdict and deciding rule.
4. The classification map (inside the report) — every action kind → its
   consequence class, so future actions can be classified consistently.

## 5. What the client must provide

- A completed intake (`INTAKE.md`).
- A list (or tool/MCP/function definitions) of every action the agent can
  take, with example payloads with **real secrets removed**. We never ask for,
  and you must never send, API keys, passwords, tokens, or customer personal
  data. If a payload involves a secret, describe it as *type + length only* —
  that is exactly how GhostGuard records it too.
- One person who can answer "who should approve this?" questions during the
  walkthrough.
- Example *fictional or redacted* inputs for any action whose payload shape
  matters to a rule (e.g. amounts, paths, recipients).

## 6. Pricing — DRAFT

> **DRAFT $499 one-time — DRAFT, not final, not published.**
> This anchor is carried from the GhostGuard product plan's DRAFT integration
> engagement price (`~/workspace/ghostguard/PLAN.md` §4) and re-pointed at the
> audit as the lower-commitment first step. Ryan has not approved this price
> for the audit, no client has been quoted it, and it may change or be
> withdrawn. Do not quote it externally.

Payment terms, taxes, and scheduling: **not yet defined — Ryan-gated** (see
the services `REPORT.md`). Nothing is bookable from this sheet.

## 7. Timeline — DRAFT

Indicative only, to be confirmed per engagement by Ryan: intake review within
2 business days of a complete intake; simulation + report within 5 business
days after that; walkthrough scheduled within the following week. These are
planning figures in a draft, not a service-level commitment.

## 8. The honest fine print

- The audit simulates **decisions** about the actions you disclose. An action
  you do not disclose cannot be inventoried, classified, or simulated — the
  report says so, and completeness of the inventory is your responsibility.
- A simulated `allow` means *this policy, on this action description, allows* —
  not that the action is safe, lawful, or wise in your environment.
- GhostGuard's guarantees are structural and narrow: record-first, fail-closed,
  strictest verdict wins, locked rules an overlay cannot weaken. The audit
  tests exactly those behaviours and reports the results; it does not audit
  your model, your prompts, your infrastructure security, or your business
  practices.
- GhostGuard produces records and gates effects. **It certifies nothing.**
  This audit certifies nothing.
