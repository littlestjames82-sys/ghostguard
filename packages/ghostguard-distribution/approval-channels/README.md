# GhostGuard Approval Channels — ask-notifier

When a guarded run gets an `ask` (or `hand_off`) verdict, a human
has to hear about it. This takes a pending ask record and POSTs a
formatted notification to a **generic webhook URL from config**,
with format templates for the usual chat shapes:

| format | body |
|---|---|
| `generic` | `{ text, record, meta }` |
| `slack` | `{ text }` |
| `discord` | `{ content }` |
| `telegram` | `{ text, parse_mode }` (bot-API/relay style) |

The message carries the escalation metadata — `asked_at`,
`escalate_after`, `timeout_at` — and states the rule in the text:
**TIMEOUT = DENY**. Silence is never an approval.

## Fail-closed timeout
`expireTimeouts(pending, decisionsFile)` is the other half: for any
ask past its `timeout_at` with no human decision on file, it appends
a **deny** decision entry (approver `ghostguard-timeout`) to the
decisions JSONL. Asks a human already decided are never touched;
a timeout can never write an approval.

## Use
```sh
node notify.mjs --config config.example.json --ask <ask-record.json>
```

## Tests
Local stub HTTP server only — the suite boots its own server on an
ephemeral port and asserts payload format, metadata, loud failure
on a dead webhook, and the timeout behaviour. **No real webhook is
ever called by the tests.**

## Honest limits
This is a notifier, not an approvals surface: it delivers the ask
and records timeouts; collecting a human's decision (and feeding it
back as a carried approval) is the job of the Cloud inbox / MCP
approvals file. A webhook URL in config is a secret — keep configs
out of repos.
