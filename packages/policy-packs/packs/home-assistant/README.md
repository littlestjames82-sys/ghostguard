# Home Assistant — a Policy Pack for GhostGuard

**Tested governance for an agent that runs your house.**

The agent may read sensors freely and, at the owner's command, run
lights, media, and thermostat under a standing approval — but
**anything started unattended is held stricter**: automations ask
before actuating, unattended purchases are refused outright,
**messages to strangers route to the owner**, and **locks, alarms,
and deleting recordings are refused by `locked` rules** that your
own later policy edits cannot tune away.

By Ghost Developer Studio. Works with the GhostGuard engine
(TypeScript) and the Agent Seatbelt governor (Python) — both evaluate
this exact policy document.

## What it governs

The pack decides over actions classified into this vocabulary (your
integrator maps your agent's real operations onto these kinds):

| Action kind | Class | Verdict | Why |
| --- | --- | --- | --- |
| `home.sensor.read` | READ | allow | Checking the house changes nothing. |
| `home.climate.read` | READ | allow | |
| `home.camera.snapshot.view` | READ | allow | A snapshot view, not a recording change. |
| `home.light.set` | EXECUTE | **pre_approved** (owner) / **ask** (unattended) | Comfort actuation runs on standing approval — when the owner starts it. See the initiator model below. |
| `home.media.play` | EXECUTE | **pre_approved** (owner) / **ask** (unattended) | |
| `home.thermostat.set` | EXECUTE | **pre_approved** (owner) / **ask** (unattended) | |
| `home.purchase.order` | SPEND | **ask** (owner) / **deny** (unattended) | Owner-initiated purchases ask on the exact payload; unattended money is refused, not asked. |
| `home.message.send` with `payload.to_contact == true` | COMMUNICATE | **ask** | A message to a known contact asks a human first. |
| `home.message.send` to a non-contact (`to_contact` false or absent) | COMMUNICATE | **hand_off → owner** | Strangers get the owner's voice, not the agent's. Unknown counts as non-contact. |
| `home.lock.set`, any `home.lock.*` / `home.alarm.*` (`alarm.arm`, `alarm.disarm`) | EXECUTE | **deny — locked** | The agent never touches security state. The owner uses the vendor app. |
| `home.recording.delete` (any DELETE) | DELETE | **deny — locked** | In this agent, DELETE means recordings — evidence. Never the agent's to destroy. |
| `home.garage.open` | EXECUTE | **deny** | **Deliberately unmapped** — see below. |
| anything else | — | **deny** | Unmapped kinds hit the fail-closed default until you map them deliberately — see Tuning. |

Semantics worth knowing:

- **Strictest verdict wins** (deny > hand_off > ask > pre_approved >
  allow), independent of rule order. An allow you add later can never
  outrank this pack's restrictive rules — which is exactly how the
  initiator branching below works: the stricter rule for an
  unattended run wins at its tier, wherever it sits in the file.
- **The deliberate gap: `home.garage.open`.** A garage door is
  consequential — it opens the house — so this pack pointedly does
  *not* cover it with any kind rule. An owner-initiated attempt
  matches nothing and denies by the fail-closed default (the test
  suite asserts the verdict names no rule). If you want the agent to
  operate the garage, that must be a deliberate rule you write — see
  Tuning — never an accident of a broad allow.
- **Unknown recipients are non-contacts.** The hand-off rule fires
  when `payload.to_contact != true`. An absent marker evaluates to
  null, and null is not true — so a message whose integrator forgot
  to classify the recipient routes to the owner, the fail-safe
  direction. Forgetting the marker can never widen who gets messaged.
- **DELETE means recordings here.** This agent has no other delete
  surface, so the locked deny claims the whole DELETE class and the
  README says so out loud. If your agent gains a harmless delete
  (clearing a shopping list), map it to a different kind/class
  deliberately instead of weakening `delete-never`.

### The initiator model

This pack's headline behaviour is that **who started the run changes
the verdict for the identical action**.

- **`person` is the owner**: the homeowner at the keyboard or in the
  unlocked app, starting the run themselves. Owner-initiated actions
  get the pack's baseline verdicts — reads allow, lights/media/
  thermostat pre-approved, purchases and contact messages ask.
- **`routine`, `handoff`, `memory`, and `system` are non-owner
  initiators**: automations and schedules (`routine`), runs handed
  off by another agent (`handoff`), remembered triggers firing later
  (`memory`), and the platform itself (`system`). None of them is
  the owner standing there. They are held stricter: EXECUTE actuation
  that is pre-approved for the owner **asks** when unattended, and a
  SPEND that would merely ask from the owner **denies** when
  unattended — unattended money is a refusal, not a prompt to
  whoever happens to be nearby. Reads stay free for every initiator:
  checking the house at 2am is what routines are for. Locked lines
  do not move at all: a routine lock attempt denies exactly like the
  owner's, because deny outranks the unattended ask.
- **The payload cannot spoof the initiator.** Rules read the
  run-stamped `initiator`, set by the run's entry point (trusted
  code). A payload field named `initiator` is a different field —
  `payload.initiator` — and no rule reads it. The test suite proves
  both directions: an owner run carrying `payload.initiator:
  "routine"` still gets its pre-approval, and a routine run carrying
  `payload.initiator: "person"` still asks.

## Install

GhostGuard (TypeScript):

```ts
import { readFileSync } from "node:fs";
import { compilePolicy } from "ghostguard";

const pack = JSON.parse(readFileSync("packs/home-assistant/policy.json", "utf8"));
const policy = compilePolicy(pack);
// evaluate per action with evaluatePolicy(policy, ctx) — see the
// GhostGuard README for the record-first gateway flow.
```

Agent Seatbelt (Python): load the same `policy.json` as the governor's
policy document — the format is shared, the verdicts are identical.

Then classify your agent's operations per the table above and route
every action through the gateway **before** executing it. Two wiring
notes this pack depends on: stamp `initiator` from the run's entry
point (never from the action payload), and have your classifier set
`payload.to_contact` on every message send. That wiring is the whole
integration; the pack replaces the policy-writing step.

## Verify your copy

The pack ships its behavior tests; run them against your engine
before you trust it (from the policy-packs root):

```
npx tsx packs/home-assistant/test/run.ts
```

12 checks: pack integrity, every verdict in the table, both initiator
branches (actuation and spend) with their exact person/unattended
pairs, spoof resistance in both directions, the deliberate garage
gap and the other fail-closed edges, and the locked layer surviving
a hostile overlay. If your platform changes its action surface,
these tests are where the pack gets re-proven.

## Tuning knobs

All rules except the locked core are yours to edit — edit a copy of
`policy.json`, keep the tests, and change the tests to match your
intent before you change the rules to match your tests.

- **Let a trusted routine run the lights unattended:** narrow
  `unattended-actuation-asks` to exclude the kinds you trust, e.g.
  end its expression with `&& kind != 'home.light.set'` — the
  routine's lights then fall through to `devices-pre-approved`.
  Narrow it kind by kind, in writing; never delete the rule, or
  every unattended actuation inherits the owner's standing approval.
- **Cover the garage — deliberately:** add an ask rule naming the
  kind, e.g. `{ "id": "garage-asks", "effect": "ask", "when": "kind == 'home.garage.open'" }`.
  Ask, not pre_approved: a door that opens the house should never
  run on standing approval, and should never be allowed for
  unattended initiators at all without your own stricter rule.
- **Bound the thermostat's standing approval:** add a range to the
  pre-approved kinds, e.g. a separate `pre_approved` rule for
  `kind == 'home.thermostat.set' && payload.target_c >= 16 && payload.target_c <= 26`,
  and remove the thermostat from `devices-pre-approved` — settings
  outside your range then match nothing permissive and an owner run
  denies by default (fail-closed), which is the prompt to ask
  yourself why the agent wanted 30°C.
- **Let the agent reorder consumables unattended:** if a standing
  grocery/filter reorder is genuinely wanted, replace
  `unattended-spend-never` with a bounded `pre_approved` rule naming
  the exact kinds (and a payload amount bound) — knowing you are
  removing this pack's headline protection, and saying so in the
  rule's note. The owner's general purchase ask stays untouched.
- **Contact messages ask a different person, or hand off:** if
  message approval should route like non-contacts do, change
  `messages-ask` to effect `hand_off` with your `handoff_to`. Do not
  "fix" unknown recipients by flipping the non-contact rule to
  `payload.to_contact == false`: that would let unmarked messages
  (absent marker → null) fall through to the ask tier instead of the
  owner's hands.
- **Do not** unlock `security-never` or `delete-never` casually:
  they are locked because "the agent disarmed the alarm" and "the
  agent deleted the footage" are the incidents this pack exists to
  prevent. If a human security workflow needs the agent to *prepare*
  something, map the preparation to a read or draft kind and keep
  the state change itself in the vendor app, outside the agent.

## Files

- `policy.json` — the policy document (9 rules).
- `test/run.ts` — the behavior suite described above.
- `README.md` — this file.

See `../../PLAN.md` for the pack format definition and the full
Policy Packs catalog.
