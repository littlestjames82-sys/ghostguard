# Policy Author — the controlled-English grammar

One statement per line. Blank lines and lines starting with `#`
are comments. Matching is case-insensitive; a trailing period is
fine. **Anything else is a loud error** — the compiler names the
line and stops. A statement is never silently dropped, because a
dropped safety rule fails open.

## Statement forms

| You write | It compiles to |
|---|---|
| `never allow <action>` / `never <action>` | a **locked** `deny` rule for that class |
| `always ask before <action>` / `ask before <action>` | an `ask` rule for that class |
| `allow <action>` | an `allow` rule for that class |
| `pre-approve <action>` / `<action> is pre-approved` | a `pre_approved` (standing approval) rule |
| `<name> must approve <action>` | a `hand_off` rule routing that class to `<name>` |
| `owner must approve messages to strangers` | a `hand_off` to `owner` for COMMUNICATE actions whose payload has `recipient_known == false` (the one special form) |
| `routines must ask before <action>` / `unattended runs must ask before <action>` | an `ask` rule for that class when the run's `initiator` is `routine` |

## Action vocabulary (`<action>` phrases)

| Phrase(s) | PermissionClass |
|---|---|
| reading | READ |
| writing local files, local writes | WRITE_LOCAL |
| executing commands, running commands | EXECUTE |
| network writes, submitting forms | NETWORK_WRITE |
| deploying, deploys, deployments | DEPLOY |
| publishing, posting publicly | PUBLISH |
| sending messages, messages | COMMUNICATE |
| spending, spend, purchases, buying | SPEND |
| deleting, delete, deletions | DELETE |

Two statements that compile to the same rule id are also an error
(reword one). Everything a statement does *not* mention is left to
the engine's fail-closed default: no matching rule → deny.

## Example
```
# demo shop policy
never allow spending
always ask before deploying
owner must approve messages to strangers
allow reading
writing local files is pre-approved
```
