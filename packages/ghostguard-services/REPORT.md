# GhostGuard Services — Build Report

**Built Oct 10, 2026** from ideas #19 (Agent Governance Audit service) and #20
(White-Label Audit Portal for agencies) in
`~/workspace/goals/ghostguard/files/ghostguard-more-ideas.md`, on Ryan's
"Knock em out" with his standing **"dont publish"** instruction.

**Status of everything here: local drafts only.** Nothing was published, sent,
listed, shared, deployed, or hosted. No file in `~/workspace/ghostguard/` or
`~/workspace/ghostguard/cloud/` was modified — the GhostGuard engine was only
*imported* from its built `dist/`. All pricing anywhere in this pack is
**DRAFT**.

---

## What was built

### `audit/` — Agent Governance Audit service pack

| File | What it is |
|---|---|
| `SERVICE_SHEET.md` | The service sheet: what the audit is, who it's for, the 5 fixed-scope steps (intake → action inventory/classification → GhostGuard policy simulation incl. hostile-overlay + fail-closed checks → report → walkthrough), deliverables (report, policy file, simulation trail, classification map), what the client must provide (with a hard "never send real secrets — type + length only" rule), timeline (marked indicative/DRAFT), and §6 pricing marked **DRAFT $499 one-time** in a prominent callout. The sheet states plainly that GhostGuard produces records and gates effects and **certifies nothing**, and that the audit certifies nothing either. |
| `INTAKE.md` | The exact intake instrument: 7 sections (client/agent, full action inventory with per-action consequence questions, initiators, approvals/people incl. the "never" list that becomes locked rules, records/history incl. past incidents as regression cases, boundaries/expectations) plus a studio-only completion checklist requiring report numbers to be copied from real simulation output. |
| `REPORT_TEMPLATE.md` | Fill-in audit report skeleton driven by a trail: scope-and-limits (§0, honesty language built in), action inventory + classification map, verdict simulation tables with the five structural checks (locked-rule integrity, fail-closed unknown, strictest wins, initiator discipline, record completeness), ranked top risks with mandatory themes, recommended locked rules, recommended first policy, "what this audit did not do", and separately-approved next steps. |
| `policy.example.json` | The fictional worked example's candidate policy: 12 rules — 2 locked (`no-spend-ever`, `no-delete-ever`), external-comms hand-off to owner, comms/deploy/publish asks, routine-stricter ask, one bounded `pre_approved` (ticket drafts), and person/READ allows. No catch-all allow: unmapped actions fall to the fail-closed default. |
| `generate-example-trail.mjs` | The generator. Evaluates the fictional inventory through the **real engine** (`compilePolicy` / `evaluatePolicy` / `mergePolicyDocs` / `gatewayRecordFromDecision` / `createJsonlRecorder` from `~/workspace/ghostguard/dist`) and runs the structural checks, including a hostile overlay that tries to replace both locked rules with allows. Re-runnable: `node audit/generate-example-trail.mjs`. |
| `example-trail.jsonl` | **Real output:** 17 gateway records, one per fictional action, written by the real JSONL recorder. |
| `example-summary.json` | **Real output:** tallies + structural-check results computed from the trail records. |
| `example-report.md` | The template filled end-to-end for the fictional client (below), with every number/reason copied from `example-summary.json`. Labelled FICTIONAL in its header and throughout. |

### The fictional worked example — how its numbers were produced

Client: **"Copperline Support Co." (FICTIONAL)** and its fictional support
agent "HelpDesk Helper" — invented names, actions, payloads, and amounts.
17 fictional actions spanning all 9 permission classes plus 1 deliberately
unmapped action, with person (10) and routine (7) initiators. Each action was
classified, evaluated by the real engine against `policy.example.json`, and
recorded via `gatewayRecordFromDecision` + `createJsonlRecorder` — no
hand-written verdicts anywhere in the example.

**Real results:** allow **5** · pre_approved **1** · ask **6** · hand_off **1**
· deny **4** (total 17). All **5 structural checks PASSED**: hostile overlay
could not weaken either locked rule (refund still denied by `no-spend-ever`,
delete by `no-delete-ever` under the merged policy); the unmapped action
denied with `rule_id: null` (fail-closed default); hand_off beat ask where
both matched (external email); the same form submit / tool execute asked for
a routine but allowed for a person; all 17 records complete.

### `whitelabel/` — White-Label Trail Portal prototype

| File | What it is |
|---|---|
| `portal.html` | Single-file static prototype (18.8 KB, no server, no dependencies). Renders verdict tally cards, a pending-approvals section (ask/hand_off with local-only Approve/Deny, labelled as prototype state), and a searchable, verdict-filterable trail table with per-record payload detail. Loads a GhostGuard JSONL trail via file input (parsed locally in the browser; nothing uploaded) or uses the embedded demo. **Branding is swappable:** a commented `BRANDING` config at the top of the script (agency name, logo text, accent color, client name), overridable by `?agency=&logo=&accent=&client=` query params. Footer keeps a small, honest **"Powered by GhostGuard · Ghost Developer Studio"** line, per the product design. |
| `SPEC.md` | How the prototype becomes the Agency-tier feature: per-agency subdomains, client workspaces on GhostGuard Cloud's workspace model, real decision appends + delivery instead of page state, authenticated approver identity, **server-side** redaction before rendering, read-only client role, client-owned exports, attribution terms that survive branding — plus explicit boundaries (not a policy editor, not a compliance product, no cross-client leakage) and the Ryan-gates. The Agency price is cited as **DRAFT $99/mo** throughout. |

The embedded demo trail in `portal.html` is the same 17 real records from
`audit/example-trail.jsonl` (injected programmatically from that file, not
retyped), labelled "FICTIONAL DEMO DATA" in a banner on the page itself.
Prototype verification: JS parses clean (`vm.Script`), embedded trail extracts
to 17 records with 7 pending (6 ask + 1 hand_off), branding config + powered-by
line + file input all present.

## What remains Ryan-gated (nothing below has been done)

1. **Pricing:** the audit's DRAFT $499 anchor (carried from the GhostGuard
   plan's DRAFT integration engagement) and the Agency tier's DRAFT $99/mo —
   Ryan must approve, change, or kill both before either is quoted anywhere.
2. **Any public listing or sharing:** posting the service sheet anywhere,
   adding it to the studio site, listing the white-label feature, or using a
   portal screenshot in any public material.
3. **Sending anything to anyone:** the service sheet or intake going to a
   prospect, or the portal prototype being shown to an agency/client — all
   need Ryan's per-recipient go-ahead.
4. **Terms that don't exist yet:** payment terms, scheduling/booking route,
   engagement terms, and the white-label attribution terms as actual license
   text — all undefined in these drafts on purpose.
5. **Building the hosted white-label version:** domain/subdomain scheme, any
   hosting spend, and the Cloud M3.2 work in `SPEC.md` §3 are separate,
   separately-approved builds.
