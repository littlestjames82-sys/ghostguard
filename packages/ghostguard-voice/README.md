# GhostGuard Voice Approval (prototype)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/littlestjames82-sys/ghostguard-voice)](https://github.com/littlestjames82-sys/ghostguard-voice/releases)

**Answer a pending GhostGuard `ask` with your voice — the recording becomes hash-bound evidence in the trail.**

An agent's action is recorded by GhostGuard with verdict `ask`. Instead
of clicking a button, the human records a short voice note stating the
decision. This tool appends a normal GhostGuard **decision entry**,
bound by SHA-256 to the ask's exact payload and to the recording's
bytes, and keeps the recording verbatim in an evidence folder that can
be re-verified later.

By **Ghost Developer Studio**. Standalone prototype (idea #12 from the
GhostGuard more-ideas list) — public prototype at v0.1.0.

## The honest identity statement — read this first

**Voice-match identity verification is NOT implemented.** This tool
does not transcribe the recording, does not check what was said, and
does not identify the speaker. In v1, voice is the **channel** and the
recording is the **evidence**; the `approver` name is self-asserted
and whatever identity exists comes from the human's own
device/session — **phone unlock is the identity anchor in the
MrGhosty path (see SPEC.md), the voice is not.** Design and roadmap:
[`SPEC.md`](SPEC.md).

## Quick start

```sh
# see what's waiting for a human
node src/cli.mjs pending --trail trail.jsonl --decisions decisions.jsonl

# decide one with a voice recording (any format — treated as opaque bytes)
node src/cli.mjs decide --trail trail.jsonl --decisions decisions.jsonl \
  --evidence evidence/ --action ask-1 --audio voice-note.wav \
  --decision approve --approver Ryan

# later: prove the stored recordings haven't been altered
node src/cli.mjs verify --decisions decisions.jsonl --evidence evidence/
```

## Library

```js
import { decideWithVoice, listPending, verifyEvidence } from "./src/voice-decide.mjs";

const entry = decideWithVoice({
  trailPath: "trail.jsonl",
  decisionsPath: "decisions.jsonl",
  evidenceDir: "evidence/",
  actionId: "ask-1",
  audioPath: "voice-note.wav",
  decision: "approve",        // or "deny"
  approver: "Ryan",
});
// entry.payload_sha256 — binds the decision to the ask's exact payload
// entry.audio_sha256   — binds it to this recording; entry.audio_file
//                        names the verbatim copy in the evidence folder
```

## Safety rules (enforced, tested)

- **Only `ask` / `hand_off` are decidable.** A voice decision can
  **never override a policy `deny`** (or an `allow`); deciding one
  errors and writes nothing.
- **Unknown `action_id` errors.** **Already-decided actions error** —
  decisions are append-only and cannot be re-decided or rewritten.
- **Payload binding:** the entry carries `payload_sha256` over the
  ask's canonical `action_payload`. Change the payload and the
  approval no longer matches it.
- **Evidence integrity:** `verify` re-hashes every stored recording;
  a recording edited, swapped, or deleted after the decision is
  reported by name (exit 1). Detection, not prevention — see SPEC.md.
- **The trail is never modified.** Decisions go to their own JSONL,
  one appended line each, in GhostGuard Cloud's decision shape
  (`entry_type: "decision"`, `decision: "approve"|"deny"`, …) plus
  `channel: "voice"` and the evidence fields.
- **The recording is never altered or transcribed** — copied byte for
  byte; its format is irrelevant to the tool.

## What's in the box

| File | What it is |
| --- | --- |
| `src/voice-decide.mjs` | Library: trail/decisions reading, `decideWithVoice`, `listPending`, `verifyEvidence`. |
| `src/cli.mjs` | CLI: `pending` / `decide` / `verify`. |
| `src/hash.mjs` | Canonical-JSON + SHA-256 helpers (payload binding, audio hashing). |
| `test/run-tests.mjs` | 14 checks — see REPORT.md. Fixture audio is synthetic (generated WAV header + silent samples, no speech, nobody's voice). |
| `SPEC.md` | MrGhosty integration path, identity roadmap, spoofing cautions, honest limits. |

Node ≥ 18; ESM. The prototype's code imports nothing at runtime —
`ghostguard` is declared in `package.json` as the family companion
package. The GhostGuard core package is **read-only** to this
prototype — it consumes GhostGuard's record and decision shapes, it
does not modify or require them at runtime (trails arrive as JSONL
files).

## Status

Prototype: local files only. No Cloud or MrGhosty wiring yet (the
integration path is specified in SPEC.md), no transcription, no
voice-match, no signing/hash-chaining of entries. `npm run verify`
runs the test suite.


## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask *(this repo)*
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
