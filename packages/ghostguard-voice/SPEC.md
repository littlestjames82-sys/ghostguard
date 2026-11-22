# GhostGuard Voice Approval — Spec (v1 prototype)

_Standalone prototype, Oct 10, 2026. Private, unpublished. Companion to
GhostGuard (`~/workspace/ghostguard`, read-only — this spec follows its
record/decision shapes, it does not change them)._

## What v1 is

A human answers a pending GhostGuard `ask` / `hand_off` with their
**voice**: they record themselves stating the decision, and this tool
turns that recording into a normal GhostGuard **decision entry** in a
decisions JSONL, bound by hashes to (a) the exact payload of the ask
and (b) the recording itself.

**What v1 is NOT:** it does not transcribe the recording, it does not
check *what* was said, and it does **not** identify the speaker.
**Voice-match / biometric identity verification is NOT implemented.**
In v1, voice is the *channel*; the human's device and the recording
are the *evidence*. The `approver` name on the entry is self-asserted,
exactly like the self-reported approver string in GhostGuard Cloud's
skeleton auth model. Any copy or UI that implies "the system verified
it was Ryan's voice" would be false for v1 and must not be written.

## Flow

1. An agent's action is evaluated by GhostGuard and recorded with
   verdict `ask` (or `hand_off`) in a trail JSONL. The action does
   not execute.
2. The human sees the pending ask (today: `ghostguard-voice pending`;
   later: MrGhosty's approvals surface or the Cloud inbox).
3. The human records a voice note stating the decision (today: any
   recorder; the file may be any format — the tool treats it as
   opaque bytes) and names approve or deny.
4. `ghostguard-voice decide` (or `decideWithVoice()`):
   - looks the `action_id` up in the trail — unknown → error;
   - refuses unless the recorded verdict is `ask` / `hand_off` — a
     policy `deny` (or an `allow`) is **not decidable**, so a voice
     decision can never override policy;
   - refuses if the action already has a decision (append-only
     history, no re-deciding);
   - copies the recording **verbatim** into the evidence folder,
     computes `audio_sha256` over its bytes;
   - computes `payload_sha256` over the canonical JSON of the ask
     record's `action_payload` — the decision is bound to the exact
     payload that was asked about, the same ratification binding as
     GhostGuard's other approval flows (MCP adapter's exact-args
     approvals work the same way);
   - appends ONE decision entry line to the decisions JSONL. The
     trail is never rewritten.
5. The waiting agent (or an operator) picks the decision up and acts
   on it: approve → execute the recorded payload exactly; deny → the
   action stays unexecuted. A missing decision is never an approval
   (fail-closed, as everywhere in GhostGuard).

## Decision entry shape

Mirrors GhostGuard Cloud's decision entries
(`{ entry_type: "decision", action_id, project_id, decision, approver,
decided_at }`) plus voice-evidence fields:

```json
{
  "entry_type": "decision",
  "channel": "voice",
  "action_id": "ask-1",
  "project_id": "proj-1",
  "decision": "approve",
  "approver": "Ryan",
  "decided_at": "2026-10-10T05:00:00.000Z",
  "verdict_answered": "ask",
  "rule_id": "comms-ask",
  "payload_sha256": "<sha256 of canonical action_payload>",
  "audio_sha256": "<sha256 of the recording bytes>",
  "audio_file": "<action_id>-<hash prefix>.<ext> in the evidence folder",
  "audio_bytes": 1234,
  "audio_original_name": "voice-note.wav"
}
```

## Evidence integrity

`ghostguard-voice verify` re-hashes every stored recording and
compares it to the `audio_sha256` in its decision entry. If someone
edits, swaps, or deletes a stored recording after the fact, verify
reports the mismatch (exit 1). This is **detection, not prevention**:
the evidence folder is plain files, so anyone with write access to
it can tamper — verify is how you'd notice. Tamper-*proofing*
(hash-chained entries, WORM/remote storage, signed entries) is
future work, listed honestly here rather than implied.

## How this plugs into MrGhosty later

MrGhosty already has the approvals pattern (its Brain memory inbox:
candidates wait for Ryan's Approve tap; nothing acts without it) and
the phone is where Ryan already approves things. The intended path:

1. **Phone records.** MrGhosty's approvals surface shows the pending
   GhostGuard ask (exact payload, as the record carries it). Ryan
   taps Approve/Deny and records a short voice note in-app. Phone
   unlock (his device credential) is the identity anchor for v1 —
   see roadmap below; the voice note is the evidence artifact, not
   the authenticator.
2. **Decision entry travels.** The phone produces the same decision
   entry shape as this prototype (recording hashed on-device, bytes
   uploaded as the evidence attachment), posted to GhostGuard Cloud
   (the M3/M3.1 server) as a decision for the action — the Cloud
   store already appends decision entries in this shape and never
   rewrites history.
3. **Waiting agent resumes.** The agent that asked is parked in the
   Cloud recorder's `waitForDecision(actionId)` long-poll (already
   built in M3.1). The decision landing wakes it: approve → it
   executes exactly the recorded payload (and can check the
   `payload_sha256` still matches what it asked about); deny or
   timeout → nothing executes.
4. **Trail shows the whole story.** Record (ask, exact payload) →
   decision (voice channel, approver, payload + audio hashes) →
   execution. The recording itself stays in the evidence store,
   retrievable by `audio_file`, re-verifiable with the same
   re-hash check as this prototype's `verify`.

What MrGhosty work that requires (NOT in this prototype): an in-app
recorder + approvals UI binding, uploading the decision to Cloud,
and carrying the approval back — all integration, no new semantics.

## Identity roadmap (explicitly staged, nothing skipped silently)

- **v1 (this prototype):** voice = channel, recording = evidence,
  approver name self-asserted, device possession is the de-facto
  anchor when run on the human's own machine/phone. No speaker
  identification of any kind.
- **v1.5 (integration):** decisions made inside an unlocked,
  authenticated session (MrGhosty on Ryan's phone; Cloud approver
  accounts when Cloud gets real identity). The *session* is the
  identity; the voice note remains evidence.
- **v2 (candidate, careful):** voice-match as an *additional* signal —
  compare a decision recording against an enrolled reference (the
  studio already handles owner voice references consent-first in
  GhostVoice/Sopro work). Even then: voice-match would be one factor
  alongside device/session, never the sole gate for consequential
  approvals, and it would ship with its own false-accept/false-reject
  measurements or not at all. Replay resistance (challenge phrases —
  the system speaks a random phrase the human repeats) belongs in
  this step, not before claims are made.

## Spoofing cautions

- **A recording is replayable.** Anyone who obtains a past "approve"
  recording could present it as a new decision. v1 mitigations are
  structural: a decision only counts for the `action_id` +
  `payload_sha256` it was recorded against, each action is decidable
  once, and recordings of *other* actions don't transfer. That stops
  cross-action replay; same-action replay is moot (already decided).
  It does not stop someone with the recording racing the real
  approver on the same pending ask — that is what v1.5 session
  identity is for.
- **Synthetic voice exists.** Ryan's own studio builds voice cloning
  (GhostVoice). A cloned-voice "approval" is indistinguishable to v1
  because v1 makes no voice claim at all — another reason identity
  must come from the device/session, not the audio.
- **The payload binding is the real protection.** Whatever channel a
  decision arrives by, it approves *this exact payload*. If the
  payload changes, the hash changes and the approval does not apply.
- **Deny stays deny.** No channel — voice included — can override a
  policy denial. Voice decides only what policy already routed to a
  human (`ask` / `hand_off`).
- **Evidence can be tampered with after the fact** on any writable
  store; `verify` detects it. Don't store evidence somewhere the
  agent being governed can write to.

## Honest limits of this prototype

- No transcription: the tool cannot confirm the recording actually
  says "approve" — the human supplies the decision flag alongside
  the recording, and the recording is the evidence a later reviewer
  can listen to. (A reviewer listening is the check.)
- No Cloud/MrGhosty wiring yet: local JSONL files only.
- No hash-chaining or signing of entries; single-file append-only by
  discipline, not by cryptography.
- Local filesystem trust assumed: whoever can write the decisions
  file can forge an entry — same caveat as GhostGuard Cloud's
  skeleton auth, stated rather than hidden.
