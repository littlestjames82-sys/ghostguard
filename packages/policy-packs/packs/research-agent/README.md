# Research Agent — a Policy Pack for GhostGuard

**Tested governance for an agent that researches the web.**

The agent may fetch, read, search, extract, and download freely, and
save what it finds to local disk — but **submitting a form or creating
an account asks a human first**, **uploading a local file routes to
the owner**, and **spending and deleting are refused outright**.
Spending and deleting are refused by `locked` rules: your own later
policy edits cannot tune them away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `web.fetch` | READ | allow | Reading the web is the day job. |
| `web.page.read` | READ | allow | |
| `web.search` | READ | allow | |
| `web.extract` | READ | allow | |
| `web.download` | READ | allow | Fetching content to read or process. |
| `web.download.save` | WRITE_LOCAL | allow | Saving fetched content to local disk. It leaves the machine only via a separate upload action. |
| `web.form.submit` | NETWORK_WRITE | **ask** | Writes to someone else's system — a human approves the exact payload first. |
| `web.account.create` | NETWORK_WRITE | **ask** | Creating an account is a form submit with a lasting identity attached. |
| `web.upload` (`payload.source == 'remote_url'`) | NETWORK_WRITE | **ask** | The file is fetched from a URL, not taken from the owner's disk. |
| `web.upload` (`payload.source == 'local_file'`) | NETWORK_WRITE | **hand_off → owner** | Sending the owner's own local files to a third party is the owner's call, not this run's approver's. |
| anything classified SPEND (e.g. `web.data.purchase`, `web.subscription.start`) | SPEND | **deny — locked** | The agent never spends. Paid sources are a human decision. |
| anything classified DELETE (e.g. `web.account.delete`, `web.file.delete`) | DELETE | **deny — locked** | Irreversible, and outside a research job. Humans delete by hand. |
| anything else | — | **deny** | Unmapped kinds and classes hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. A local-file upload is
  NETWORK_WRITE, so it matches the ask rule too — the `hand_off`
  tier outranks it, and the owner gets the decision. An upload
  somehow classified SPEND matches the locked deny, and deny
  outranks everything.
- **The initiator is not the payload.** Rules see the run-stamped
  `initiator` (person / routine / handoff / memory / system). A
  payload field named `initiator` is a different field and spoofs
  nothing. This pack holds routines to the same outbound standard
  as people: a routine may research unattended, but may not submit
  a form without the same ask.
- **Payload equality is exact.** A local-file upload is recognised
  only by `payload.source == 'local_file'`. An upload whose payload
  carries no `source` is not treated as local — it falls to the
  generic NETWORK_WRITE ask rather than handing off or slipping
  through.
- **Account creation is NETWORK_WRITE in this pack.** However the
  underlying tool labels it (some classify signup flows as EXECUTE),
  map `web.account.create` to NETWORK_WRITE per the table, or it is
  unmapped and denies by the fail-closed default.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/research-agent/policy.json", "utf8"));
const policy = compilePolicy(pack);
// evaluate per action with evaluatePolicy(policy, ctx) — see the
// GhostGuard README for the record-first gateway flow.
```

Agent Seatbelt (Python): load the same `policy.json` as the governor's
policy document — the format is shared, the verdicts are identical.

Then classify your agent's operations per the table above and route
every action through the gateway **before** executing it. That wiring
is the whole integration; the pack replaces the policy-writing step.

## Verify your copy

The pack ships its behavior tests; run them against your engine
before you trust it (from the policy-packs root):

```
npx tsx packs/research-agent/test/run.ts
```

11 checks: pack integrity, every verdict in the table, the
strictest-wins interactions, the fail-closed edges, initiator
branching and spoof resistance, and the locked layer surviving a
hostile overlay. If a platform changes its action surface, these
tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Pre-approve a trusted, read-only form** (e.g. a search form your
  agent must submit to query a source): add a bounded `pre_approved`
  rule naming that exact kind — never by weakening
  `network-writes-ask`, and never keyed to a payload flag the agent
  itself can set.
- **Change who local uploads hand off to:** change
  `local-file-uploads-to-owner`'s `handoff_to` from `owner` to a
  reviewer scope — only if that scope genuinely owns the disclosure
  decision for the files involved.
- **Downloads that execute instead of saving:** if your downloader
  runs what it fetches, classify that kind EXECUTE, not READ — it
  then denies by the fail-closed default until you add a deliberate
  rule for it.
- **Let the agent keep a remote workspace:** saves to a specific
  remote store are NETWORK_WRITE by classification, so they ask.
  If one store is genuinely scratch space, map it to a dedicated
  kind and add a bounded rule for that kind alone.
- **A second locked line** (e.g. a domain that must never be
  contacted): add your own `locked: true` deny rule; locked rules
  you add are protected the same way in your merges.
- **Do not** unlock `spend-never` or `delete-never` casually: they
  are locked because "the agent bought a data subscription" and
  "the agent deleted the account" are the incidents this pack
  exists to prevent. If a human workflow needs either, the human
  does that step by hand, outside the agent.

## Files

- `policy.json` — the policy document (6 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
