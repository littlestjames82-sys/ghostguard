# Agent Governance Audit — Intake Checklist

**DRAFT — unpublished internal document.** Used only when Ryan approves an
engagement. Do not send this to anyone without his go-ahead.

> **Golden rule for the client, printed at the top of anything they see:**
> Never send real API keys, passwords, tokens, private keys, or customer
> personal data. Where a payload involves a secret, describe it as
> **type + length only** (e.g. "API key, 40 characters"). That is all an audit
> ever needs — and it is exactly how GhostGuard records secrets, too.

Instructions: collect every section. The audit cannot start until §1–§4 are
complete; mark anything unknown as `UNKNOWN` rather than guessing — an unknown
becomes a finding in the report, not a hole in it.

---

## §1 — The client and the agent

- [ ] Client / business name: `__________`
- [ ] Contact person + preferred contact method: `__________`
- [ ] Agent name (as its users know it): `__________`
- [ ] What the agent is *for* (one paragraph, plain language): `__________`
- [ ] Agent framework / runtime (e.g. custom code, LangChain-style, MCP tools,
      browser agent, workflow runner, other): `__________`
- [ ] Model provider(s), if any: `__________` *(provider names only — no keys)*
- [ ] Where the agent runs (their server / laptop / cloud / SaaS): `__________`
- [ ] Who uses it today (owner only / team / customers / public): `__________`
- [ ] How long has it been live, and roughly how many actions/day: `__________`

## §2 — The action inventory (the heart of the intake)

For **every** action/tool/function the agent can invoke, one row:

| # | Action kind (their name) | What it actually does | Example payload (redacted — no real secrets/PII) | Triggered by |
|---|---|---|---|---|
| 1 | | | | person / routine / schedule / webhook / other agent |
| 2 | | | | |
| 3 | | | | |

Plus, for each action:

- [ ] Can it **spend money** or create a financial commitment? Max amount?
- [ ] Can it **send** anything to a person outside the business? To whom?
- [ ] Can it **publish** anything publicly?
- [ ] Can it **delete or overwrite** anything? Is the effect reversible?
- [ ] Can it **deploy or change configuration** of a live system?
- [ ] Does it touch files outside a working/sandbox directory?
- [ ] Does it use a credential? (type + length only — never the value)

And globally:

- [ ] Is there any action the agent can take that is **not** in the list
      above (dynamic tool loading, code execution, a shell, a plug-in system)?
      If yes, describe it — unmapped actions are a headline audit topic.
- [ ] Can the agent create, modify, or chain **its own** actions/tools?

## §3 — How runs start (initiators)

GhostGuard policy can hold unattended runs to a stricter standard, so this
matters:

- [ ] Which entry points start a run? (person at keyboard/chat, schedule,
      routine/cron, webhook/event, another agent's handoff, memory/trigger)
- [ ] Roughly what share of runs are **unattended** (no human watching)?
- [ ] Can an external input (email, form, web page, message) start or steer a
      run? Which inputs?
- [ ] Can a run's instructions come from content the agent *read* (pages,
      documents, tool results) rather than from its operator?

## §4 — Approvals and people

- [ ] Who is the approver of last resort (name/role, not credentials)?
- [ ] Who else may approve, and are there actions only specific people may
      approve (e.g. only finance approves refunds)?
- [ ] Are there actions that must **never** happen, whoever asks? List them —
      these are candidate **locked rules**.
- [ ] Are there actions that should route to someone *other* than the usual
      approver (candidate `hand_off` rules)?
- [ ] How should an approval request reach the approver today (chat, email,
      phone, in-app)? Desired future channel?
- [ ] What should happen if no approver answers? *(Audit default stance:
      the action stays unexecuted — a timeout is never an approval.)*

## §5 — Records and history

- [ ] Does the agent log its actions today? Where, and in what format?
- [ ] Can a past action be reconstructed after the fact — who proposed it,
      what payload ran, who approved it? Give one real (redacted) example if
      one exists.
- [ ] Has the agent ever taken an unwanted action? Describe it (redacted) —
      it becomes a regression case in the simulation.
- [ ] How long must records be kept? Who must be able to read them?
- [ ] Sample trail/log export available? (Redacted; JSON/JSONL/text all fine.)

## §6 — Boundaries and expectations

- [ ] Systems/accounts the agent must **never** touch, even by request:
- [ ] Customers/data the agent must never contact or expose:
- [ ] Any regulatory or contractual record-keeping duties the client *believes*
      apply to them: *(recorded as their statement; the audit does not assess
      or certify compliance — see the service sheet)*
- [ ] What would make this audit a success for them, in one sentence:
- [ ] Anything else we should know:

## §7 — Studio use only (filled by the auditor)

- [ ] Intake complete (§1–§4): date `______` — gaps/UNKNOWNs: `__________`
- [ ] Classification map drafted for every §2 row: `☐`
- [ ] Past-incident regression cases (§5) added to the simulation set: `☐`
- [ ] Candidate locked rules (§4 "never" list) drafted: `☐`
- [ ] Candidate policy compiled and simulation run: trail file `__________`
- [ ] Hostile-overlay check run (overlay cannot weaken a locked rule): `☐`
- [ ] Unmapped-action check run (unknown kind/class fails closed): `☐`
- [ ] Report filled from the real trail — numbers copied from the simulation
      output, never estimated: `☐`
- [ ] Report states the honesty limits: simulation covers disclosed actions
      only; GhostGuard produces records/gates effects and certifies nothing: `☐`
