#!/usr/bin/env node
/**
 * ghostguard-budgets CLI — the kill switch, plus state status.
 *
 *   node src/cli.mjs freeze   [--freeze-file <path>] [--by <who>] [--reason <why>]
 *   node src/cli.mjs unfreeze [--freeze-file <path>]
 *   node src/cli.mjs status   [--freeze-file <path>] [--state <path>] [--config <path>]
 *
 * Defaults: freeze file ./ghostguard.freeze.json, state file
 * ./ghostguard-budgets-state.json (both overridable by flag or by the
 * GHOSTGUARD_FREEZE_FILE / GHOSTGUARD_BUDGETS_STATE env vars).
 * `status` without a --config reports the freeze flag and the raw
 * event count only (budget totals need the config to name windows).
 */
import { freeze, readFreeze, unfreeze } from "./freeze.mjs";
import { loadConfigFile } from "./config.mjs";
import { createStatefulGuard } from "./guard.mjs";
import { defaultKernelPolicy } from "ghostguard";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const freezePath =
  args["freeze-file"] ?? process.env.GHOSTGUARD_FREEZE_FILE ?? "./ghostguard.freeze.json";
const statePath =
  args.state ?? process.env.GHOSTGUARD_BUDGETS_STATE ?? "./ghostguard-budgets-state.json";

if (cmd === "freeze") {
  const detail = freeze(freezePath, { by: args.by ?? null, reason: args.reason ?? null });
  console.log(JSON.stringify({ ok: true, frozen: true, freeze_file: freezePath, ...detail }, null, 2));
} else if (cmd === "unfreeze") {
  const removed = unfreeze(freezePath);
  console.log(JSON.stringify({ ok: true, frozen: false, freeze_file: freezePath, was_frozen: removed }, null, 2));
} else if (cmd === "status") {
  const frozen = readFreeze(freezePath);
  if (args.config) {
    const guard = createStatefulGuard({
      policy: defaultKernelPolicy(),
      configPath: args.config,
      statePath,
      freezePath,
    });
    console.log(JSON.stringify({ freeze_file: freezePath, state_file: statePath, ...guard.status() }, null, 2));
  } else {
    let events = null;
    let stateError = null;
    try {
      const { loadState } = await import("./state.mjs");
      events = loadState(statePath).events.length;
    } catch (err) {
      stateError = err.message;
    }
    console.log(
      JSON.stringify({ freeze_file: freezePath, state_file: statePath, frozen, events_in_state: events, state_error: stateError }, null, 2),
    );
  }
} else {
  console.error("usage: ghostguard-budgets <freeze|unfreeze|status> [--freeze-file <path>] [--state <path>] [--config <path>] [--by <who>] [--reason <why>]");
  process.exit(2);
}
