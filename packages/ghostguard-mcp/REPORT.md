# GhostGuard MCP Adapter — Completion Report

_Built Oct 10, 2026, per Ryan's "Knock em out dont publish". Standalone
package at `~/workspace/ghostguard-mcp/`. Nothing published, deployed,
or pushed; no private flag flipped anywhere; no pricing changed;
`~/workspace/ghostguard` core files were only read/imported (its built
`dist/`), never modified._

## What was built

- **Governed MCP proxy** (`src/proxy.mjs`, Node ESM, zero runtime
  dependencies, stdio NDJSON JSON-RPC): spawns a configured upstream
  MCP server, forwards `initialize` / `tools/list` / everything else
  untouched, and governs every `tools/call`:
  - classify via config `toolClasses` map; unmapped tools default to
    `defaultClass` (`EXECUTE`) — fail closed;
  - evaluate with GhostGuard's `compilePolicy` / `evaluatePolicy`
    (base policy optionally merged with an overlay via
    `mergePolicyDocs`, so locked rules survive hostile overlays);
  - assemble the record with `gatewayRecordFromDecision` and write it
    via `createJsonlRecorder` **before** forwarding — a recorder
    failure blocks the call;
  - forward only on `allow` / `pre_approved`; `ask` / `hand_off` /
    `deny` return JSON-RPC error `-32042` naming verdict, deciding
    rule, reason, action id, and `args_hash`.
- **Carried approvals** (`src/approvals.mjs`, `src/hash.mjs`,
  `src/approve.mjs`): a local approvals JSON file of SHA-256 hashes
  over canonical `{tool, arguments}`; checked fresh per call;
  `ask` means blocked until a human adds the exact-args hash with
  the approve CLI (`--tool/--args`, or `--hash` copied from a blocked
  error; `--list` / `--revoke` included).
- **Config** (`src/config.mjs`): `--config` flag or
  `GHOSTGUARD_MCP_CONFIG` env; fail-closed validation (unknown
  PermissionClass, missing policy/upstream = startup exit, never a
  silent pass-through).
- **Fake upstream fixture** (`fixture/fake-upstream.mjs`): 8 tools
  (echo, add, write_note, send_email, buy, delete_file, publish_post,
  mystery_tool), a received-call log, and an `audit_seen` proof hook
  that checks the audit trail already held an allow record when a
  call arrived.
- **Samples**: `policy.example.json` (locked no-spend / no-delete,
  publish hand_off, ask rules for COMMUNICATE/EXECUTE/NETWORK_WRITE/
  DEPLOY, approved-allow, read/write-local allow),
  `overlay.hostile.example.json`, `config.example.json` demo wiring.
- **Tests + docs**: `test/run-tests.mjs` wired as `npm test` /
  `npm run verify`; full README with config, classification,
  approval flow, and honest limits.

## Verification (exact commands + results)

```sh
cd ~/workspace/ghostguard-mcp && npm test
```

Result: **21 passed, 0 failed.** The suite spawns the real proxy
against the real fixture and proves, end to end:

1. `initialize` + `tools/list` forwarded (8 tools).
2. Allowed `echo`/`add` (READ) execute via upstream.
3. Record-before-execution: upstream logged `audit_seen=true` for
   allowed calls, including the approved retry.
4. `buy` (SPEND) → `deny` / `no-spend-ever`, never in upstream log —
   **with the hostile overlay merged in** (overlay reused the locked
   rule id as an allow and added allow-everything; both failed).
5. `delete_file` (DELETE) → `deny` / `no-delete-ever`, never forwarded.
6. `publish_post` (PUBLISH) → `hand_off` to `owner`, never forwarded.
7. `send_email` (COMMUNICATE) → `ask` / `comms-ask`, never forwarded;
   error names verdict + rule and carries the `args_hash`.
8. Approve CLI adds the exact approval → same call executes; the
   same tool with different args stays blocked (exact-args approvals).
9. Unmapped `mystery_tool` → fails closed (defaultClass EXECUTE →
   `ask`), never forwarded.
10. Audit trail holds all 9 `tools/call` records in call order,
    each naming its deciding rule/reason; approved retry recorded
    as `allow`.

Additional smoke check: the shipped `config.example.json` demo was
booted from the package root and driven over stdio — `echo` recorded
`allow`/`allow-read`, `buy` returned the `-32042` GhostGuard deny
naming `no-spend-ever`. Demo artifacts (audit/approvals/upstream
log) were cleaned up afterwards.

## Left undone (by design / honest limits)

- No HTTP/SSE MCP transport — stdio only.
- No interactive approval prompting — `ask` blocks and waits for a
  human to edit the approvals file and the client to retry (the
  approvals surface is the file + CLI, same stance as GhostGuard core).
- Audit trail is reference JSONL, not tamper-proof storage.
- Tool *results* are not governed, and upstream-initiated requests
  (sampling/elicitation) pass through ungoverned — documented in
  the README.
- No packaging/publishing step taken, per instructions.
