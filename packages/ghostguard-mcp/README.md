# GhostGuard MCP Adapter (`ghostguard-mcp`)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-mcp)](https://github.com/littlestjames82-sys/ghostguard-mcp/releases)

**A governed MCP proxy: every upstream `tools/call` is classified, policy-decided, and recorded — before it is forwarded.**

By **Ghost Developer Studio**. Public repository — v0.1.0.

Point any MCP client at this server instead of the real one. It spawns
your real MCP server as a child process ("upstream"), forwards
`initialize`, `tools/list`, and everything else untouched, and puts a
[GhostGuard](https://github.com/littlestjames82-sys/ghostguard) gateway in front of `tools/call` only:

1. **Classify** — the tool name is mapped to a GhostGuard
   `PermissionClass` via your config map. An unmapped tool gets the
   config's `defaultClass` (`EXECUTE` unless you change it) — a
   consequential class the sample policy asks on. Classification fails
   closed; unknown shapes never sail through as reads.
2. **Decide** — the GhostGuard policy engine evaluates the call
   (fail-closed, strictest verdict wins, locked rules cannot be
   weakened by an overlay).
3. **Record** — a complete gateway record (tool, exact arguments,
   arguments hash, verdict, deciding rule) is appended to the JSONL
   audit file *before* anything is forwarded. If the audit write
   fails, the call is not forwarded. **No record, no action.**
4. **Act** — only `allow` / `pre_approved` calls are forwarded.
   `ask`, `hand_off`, and `deny` are blocked at the proxy and returned
   as a JSON-RPC error naming the verdict, the deciding rule, the
   reason, and the blocked call's action id.

## Quick start (demo against the bundled fake upstream)

```sh
cd ~/workspace/ghostguard-mcp
node src/proxy.mjs --config config.example.json
```

`config.example.json` proxies the bundled fixture
(`fixture/fake-upstream.mjs`: `echo`, `add`, `write_note`,
`send_email`, `buy`, `delete_file`, `publish_post`, `mystery_tool`)
under `policy.example.json`. With it: `echo` runs, `buy` is denied by
the locked `no-spend-ever` rule, `send_email` is blocked with an
`ask` verdict, and every call lands in `ghostguard-mcp-audit.jsonl`.

Run the proof suite any time:

```sh
npm test        # 21 checks, end-to-end through the real proxy + fixture
```

## Configuration

The proxy takes `--config <path>` or `GHOSTGUARD_MCP_CONFIG`. Relative
file paths in the config resolve against the config file's directory.

```jsonc
{
  "upstream": {
    "command": "node",                      // your real MCP server
    "args": ["path/to/server.mjs"],
    "env": { "KEY": "value" },              // optional, added to its env
    "cwd": "."                              // optional
  },
  "policyFile": "policy.example.json",      // GhostGuard policy doc…
  "policy": { "rules": [ /* …or inline… */ ] },
  "overlayFile": "overlay.json",            // optional editable overlay,
                                            // merged with mergePolicyDocs:
                                            // locked base rules survive it
  "auditFile": "ghostguard-mcp-audit.jsonl",
  "approvalsFile": "ghostguard-mcp-approvals.json",
  "actor": "mcp-client",                    // who is proposing actions
  "projectId": "my-project",
  "initiator": "person",                    // person|routine|handoff|memory|system
  "defaultClass": "EXECUTE",                // class for unmapped tools
  "toolClasses": {
    "echo": "READ",
    "send_email": "COMMUNICATE",
    "buy": "SPEND",
    "delete_file": "DELETE"
  }
}
```

### The classification map is load-bearing

`PermissionClass` vocabulary (from GhostGuard):
`READ | WRITE_LOCAL | EXECUTE | NETWORK_WRITE | DEPLOY | PUBLISH |
COMMUNICATE | SPEND | DELETE`.

Map every tool your upstream exposes. When in doubt, classify *up* —
a send mapped as `READ` will be allowed by any sane policy, and no
policy can save a wrong classification. Anything you forget lands on
`defaultClass`, which the sample setup deliberately routes to `ask`.

### The sample policy (`policy.example.json`)

| Rule | Effect | When |
| --- | --- | --- |
| `no-spend-ever` | deny, **locked** | `SPEND` |
| `no-delete-ever` | deny, **locked** | `DELETE` |
| `publish-handoff` | hand_off → `owner` | `PUBLISH` |
| `comms-ask` / `execute-ask` / `network-write-ask` / `deploy-ask` | ask | that class, unapproved |
| `approved-actions-allow` | allow | a carried approval covers the call |
| `allow-read` / `allow-write-local` | allow | `READ` / `WRITE_LOCAL` |

Anything no rule matches is denied by the engine's fail-closed
default. It is a starting point, not a recommendation — write your own.

## Approval flow (`ask` means blocked until approved)

The proxy never prompts: stdio is the protocol channel, so an `ask`
verdict blocks the call and the returned error carries an
`args_hash` — the SHA-256 of the canonical `{ tool, arguments }`.
A human approves **that exact call** by adding its hash to the
approvals file, with the bundled CLI:

```sh
# approve the exact call you intend to allow:
node src/approve.mjs --approvals ghostguard-mcp-approvals.json \
  --tool send_email --args '{"to":"client@example.com","body":"hi"}' --by ryan

node src/approve.mjs --approvals ghostguard-mcp-approvals.json --list
node src/approve.mjs --approvals ghostguard-mcp-approvals.json --revoke <args_hash>
```

Then the client retries the call. Same tool + same arguments →
executes (and is recorded, with the approval visible in the context
that decided it). Same tool + *different* arguments → different hash,
still blocked. Removing the entry revokes it from the next call on;
the file is re-read on every `tools/call`, so no restart is needed.

The approvals file is plain JSON — an array of
`{ tool, args_hash, approved_by, approved_at, note? }` — so a human
can also edit it directly or copy `args_hash` from a blocked call's
error (approve by `--hash <sha256>`).

## What the audit record looks like

One JSONL line per `tools/call`, allowed or blocked, in call order:

```json
{"action_id":"mcp-…","kind":"mcp.tools/call","permission_class":"SPEND",
 "actor":"mcp-client","initiator":"person","project_id":"…",
 "verdict":"deny","rule_id":"no-spend-ever",
 "reason":"denied by policy rule \"no-spend-ever\"","handoff_to":null,
 "target_ref":"buy","target":{"tool":"buy","mapped":true},
 "action_payload":{"tool":"buy","arguments":{"item":"x","amount":1},
 "args_hash":"…"},"dry_run":false}
```

## Files

| File | What it is |
| --- | --- |
| `src/proxy.mjs` | The governed proxy server (the whole product). |
| `src/config.mjs` | Config loading + fail-closed validation. |
| `src/hash.mjs` | Canonical-JSON SHA-256 used for approval hashes. |
| `src/approvals.mjs` | Approvals-file reading (checked per call). |
| `src/approve.mjs` | Human CLI: add / list / revoke approvals. |
| `fixture/fake-upstream.mjs` | Fake MCP server for tests/demo; logs every call it receives and whether the audit record already existed when the call arrived. |
| `test/run-tests.mjs` | End-to-end suite (21 checks). |
| `policy.example.json` | Sample policy (above). |
| `overlay.hostile.example.json` | Sample hostile overlay the tests merge in — it cannot weaken the locked rules. |
| `config.example.json` | Sample config wiring the fixture + sample policy. |

## Honest limits

- **Stdio, NDJSON only.** One upstream child process per proxy,
  newline-delimited JSON-RPC (the standard MCP stdio transport).
  No HTTP/SSE transport, no upstream pooling.
- **Governance covers `tools/call` only.** `tools/list`, resources,
  prompts, and initialization are forwarded as-is. A tool's *result*
  is not inspected — GhostGuard gates the action, not the reply.
- **Approvals are a local file.** Anyone who can write the approvals
  file can approve actions; anyone who can write the config can
  reclassify tools. Both files are trust boundaries — protect them
  like credentials. Approval entries are exact-args and don't expire;
  revoke them with the CLI.
- **The audit file is a reference JSONL trail, not tamper-proof.**
  It proves order and content inside this package's threat model;
  ship the lines to a real event store if you need stronger
  guarantees.
- **Approvals-by-hash cover arguments as sent.** If a client sends
  semantically identical but textually different arguments (e.g. a
  reordered nested *array*), it's a different call and a different
  hash. Object key order is canonicalized; array order is not.
- **Upstream-initiated requests** (sampling, elicitation) are
  forwarded to the client untouched but are not governed; if your
  upstream is chatty in both directions, review that surface too.
- **It wraps GhostGuard, it isn't GhostGuard.** The engine is
  imported from the published `ghostguard` package — `npm install`
  brings it in as this package's only runtime dependency.

## Status

Built Oct 10, 2026 as a standalone package, public at v0.1.0; the core GhostGuard package is untouched
(read/import only). One runtime dependency (the published
`ghostguard` package); everything else is Node ≥ 18 stdlib. See `REPORT.md` for test evidence.

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/ghostguard-mcp
cd ghostguard-mcp && npm install && npm test
```

Part of the GhostGuard family by **Ghost Developer Studio**.

## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded *(this repo)*
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
