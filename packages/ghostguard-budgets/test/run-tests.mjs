/**
 * ghostguard-budgets test suite — budgets/velocity, stricter-only,
 * kill switch, fail-closed state. All time travel uses an injected
 * clock; no real sleeps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlRecorder, readGatewayRecords } from "ghostguard";
import { createStatefulGuard } from "../src/guard.mjs";
import { freeze, unfreeze } from "../src/freeze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.mjs");

let passed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const ALLOW_ALL = { rules: [{ id: "allow-all", effect: "allow", when: "true" }] };
const NO_SPEND = {
  rules: [
    { id: "no-spend-ever", effect: "deny", locked: true, when: "permission_class == 'SPEND'" },
    { id: "comms-ask", effect: "ask", when: "permission_class == 'COMMUNICATE'" },
    { id: "allow-rest", effect: "allow", when: "true" },
  ],
};
const CONFIG = {
  spendBudgets: [
    { id: "daily-spend-cap", scope: "actor_project", window: "24h", limit: 500, amountField: "amount", onExceed: "deny" },
  ],
  velocityRules: [
    { id: "third-delete-asks", scope: "actor", window: "1h", match: { permission_class: "DELETE" }, maxInWindow: 2, onExceed: "ask" },
  ],
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "ggb-"));
}
function act(over = {}) {
  return {
    kind: "tool.call",
    permission_class: "READ",
    actor: "agent-1",
    project_id: "proj-1",
    initiator: "person",
    payload: {},
    ...over,
  };
}
const spend = (amount, over = {}) =>
  act({ kind: "shop.buy", permission_class: "SPEND", payload: { amount }, ...over });
const del = (over = {}) => act({ kind: "fs.delete", permission_class: "DELETE", ...over });

// ---------- spend budgets ----------
{
  const dir = freshDir();
  let now = T0;
  const g = createStatefulGuard({
    policy: ALLOW_ALL, config: CONFIG,
    statePath: join(dir, "state.json"), freezePath: join(dir, "freeze.json"),
    now: () => now,
  });
  let d = g.decide(spend(100)).decision;
  check("budget: spend 100 under cap 500 allows", d.verdict === "allow", JSON.stringify(d));
  d = g.decide(spend(300)).decision;
  check("budget: cumulative 400 still allows", d.verdict === "allow");
  d = g.decide(spend(200)).decision;
  check("budget: 400 + 200 over cap denies", d.verdict === "deny" && d.rule_id === "daily-spend-cap", JSON.stringify(d));
  d = g.decide(spend(100)).decision;
  check("budget: denied spend was NOT counted (400 + 100 == cap allows)", d.verdict === "allow", JSON.stringify(d));
  d = g.decide(spend(1)).decision;
  check("budget: at-cap next spend denies", d.verdict === "deny" && d.rule_id === "daily-spend-cap");
  const st = g.status({ actor: "agent-1", project_id: "proj-1" });
  check("status reports used 500 / remaining 0", st.spendBudgets[0].used === 500 && st.spendBudgets[0].remaining === 0, JSON.stringify(st.spendBudgets));

  // scope isolation: a different actor on the same project has its own budget
  d = g.decide(spend(100, { actor: "agent-2" })).decision;
  check("budget: different actor has a separate budget (allows)", d.verdict === "allow");

  // window expiry frees the budget again (injected clock, +25h)
  now += DAY + HOUR;
  d = g.decide(spend(200)).decision;
  check("budget: window expiry frees budget (spend allows next day)", d.verdict === "allow", JSON.stringify(d));
}

// ---------- spend: amount unknown fails toward ask ----------
{
  const dir = freshDir();
  const g = createStatefulGuard({
    policy: ALLOW_ALL, config: CONFIG,
    statePath: join(dir, "state.json"), freezePath: join(dir, "freeze.json"),
    now: () => T0,
  });
  const d = g.decide(act({ kind: "shop.buy", permission_class: "SPEND", payload: {} })).decision;
  check("budget: SPEND with no numeric amount escalates to ask (cannot verify)", d.verdict === "ask" && d.rule_id === "daily-spend-cap", JSON.stringify(d));
}

// ---------- velocity escalation ----------
{
  const dir = freshDir();
  let now = T0;
  const g = createStatefulGuard({
    policy: ALLOW_ALL, config: CONFIG,
    statePath: join(dir, "state.json"), freezePath: join(dir, "freeze.json"),
    now: () => now,
  });
  let d = g.decide(del()).decision;
  check("velocity: 1st DELETE allows (no escalation on #1)", d.verdict === "allow", JSON.stringify(d));
  d = g.decide(del()).decision;
  check("velocity: 2nd DELETE allows (escalation is on the Nth, not before)", d.verdict === "allow");
  d = g.decide(del()).decision;
  check("velocity: 3rd DELETE in the hour escalates allow -> ask", d.verdict === "ask" && d.rule_id === "third-delete-asks", JSON.stringify(d));
  d = g.decide(del()).decision;
  check("velocity: asked DELETE was not counted (4th still asks, count unchanged)", d.verdict === "ask" && d.rule_id === "third-delete-asks");
  d = g.decide(act({ permission_class: "READ" })).decision;
  check("velocity: unrelated READ unaffected by DELETE velocity", d.verdict === "allow");
  now += HOUR + 1;
  d = g.decide(del()).decision;
  check("velocity: window expiry resets the count (DELETE allows again)", d.verdict === "allow", JSON.stringify(d));
}

// ---------- stricter-only ----------
{
  const dir = freshDir();
  const g = createStatefulGuard({
    policy: NO_SPEND,
    config: { spendBudgets: [{ id: "huge-budget", scope: "global", window: "24h", limit: 1_000_000_000, onExceed: "deny" }] },
    statePath: join(dir, "state.json"), freezePath: join(dir, "freeze.json"),
    now: () => T0,
  });
  let d = g.decide(spend(5)).decision;
  check("stricter-only: a huge budget cannot loosen a locked stateless deny", d.verdict === "deny" && d.rule_id === "no-spend-ever", JSON.stringify(d));
  d = g.decide(act({ kind: "msg.send", permission_class: "COMMUNICATE" })).decision;
  check("stricter-only: stateless ask survives the stateful layer untouched", d.verdict === "ask" && d.rule_id === "comms-ask");

  // hostile config: onExceed "allow" is clamped to deny, with a warning
  const g2 = createStatefulGuard({
    policy: ALLOW_ALL,
    config: { velocityRules: [{ id: "loosen-attempt", scope: "global", window: "1h", match: { permission_class: "WRITE_LOCAL" }, maxInWindow: 0, onExceed: "allow" }] },
    statePath: join(dir, "state2.json"), freezePath: join(dir, "freeze.json"),
    now: () => T0,
  });
  d = g2.decide(act({ permission_class: "WRITE_LOCAL" })).decision;
  check("stricter-only: hostile onExceed:'allow' clamped — verdict is deny, never looser", d.verdict === "deny" && d.rule_id === "loosen-attempt", JSON.stringify(d));
  check("stricter-only: the clamp is reported in guard.warnings", g2.warnings.length >= 1 && g2.warnings.join(" ").includes("loosen-attempt"), JSON.stringify(g2.warnings));
}

// ---------- kill switch ----------
{
  const dir = freshDir();
  const statePath = join(dir, "state.json");
  const freezePath = join(dir, "freeze.json");
  const g = createStatefulGuard({
    policy: ALLOW_ALL, config: CONFIG, statePath, freezePath, now: () => T0,
  });
  let d = g.decide(spend(50)).decision;
  check("kill switch: spend flows before freeze", d.verdict === "allow");
  freeze(freezePath, { by: "ryan", reason: "test freeze" });
  d = g.decide(spend(50)).decision;
  check("kill switch: freeze flipped mid-run blocks next SPEND (deny, kill-switch-freeze)", d.verdict === "deny" && d.rule_id === "kill-switch-freeze", JSON.stringify(d));
  d = g.decide(del()).decision;
  check("kill switch: DELETE blocked while frozen", d.verdict === "deny" && d.rule_id === "kill-switch-freeze");
  d = g.decide(act({ kind: "msg.send", permission_class: "COMMUNICATE" })).decision;
  check("kill switch: COMMUNICATE blocked while frozen", d.verdict === "deny" && d.rule_id === "kill-switch-freeze");
  d = g.decide(act({ permission_class: "READ" })).decision;
  check("kill switch: READ still flows while frozen", d.verdict === "allow", JSON.stringify(d));
  const st = g.status();
  check("kill switch: status reports frozen with detail", st.frozen.frozen === true && st.frozen.detail.by === "ryan");
  unfreeze(freezePath);
  d = g.decide(spend(50)).decision;
  check("kill switch: unfreeze restores flow on the next action", d.verdict === "allow", JSON.stringify(d));

  // a freeze file saying frozen:false is not a freeze; a corrupt one IS (fail closed)
  writeFileSync(freezePath, JSON.stringify({ frozen: false }));
  d = g.decide(spend(50)).decision;
  check("kill switch: {frozen:false} file does not freeze", d.verdict === "allow");
  writeFileSync(freezePath, "this is not json {{{");
  d = g.decide(spend(50)).decision;
  check("kill switch: corrupt freeze file fails closed (still frozen)", d.verdict === "deny" && d.rule_id === "kill-switch-freeze");
  unfreeze(freezePath);
}

// ---------- fail-closed state ----------
{
  const dir = freshDir();
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, "garbage{{{ not json");
  const g = createStatefulGuard({
    policy: ALLOW_ALL, config: CONFIG, statePath, freezePath: join(dir, "freeze.json"), now: () => T0,
  });
  let d = g.decide(spend(10)).decision;
  check("fail-closed: corrupt state file denies SPEND (state-store-unavailable)", d.verdict === "deny" && d.rule_id === "state-store-unavailable", JSON.stringify(d));
  d = g.decide(act({ permission_class: "READ" })).decision;
  check("fail-closed: corrupt state file denies even READ (never silently allow)", d.verdict === "deny" && d.rule_id === "state-store-unavailable");

  writeFileSync(statePath, JSON.stringify({ nope: true }));
  d = g.decide(spend(10)).decision;
  check("fail-closed: state file with wrong shape denies", d.verdict === "deny" && d.rule_id === "state-store-unavailable");
}

// ---------- persistence across instances + recorder ----------
{
  const dir = freshDir();
  const statePath = join(dir, "state.json");
  const auditPath = join(dir, "audit.jsonl");
  const mk = () =>
    createStatefulGuard({
      policy: ALLOW_ALL, config: CONFIG, statePath,
      freezePath: join(dir, "freeze.json"), now: () => T0,
      recorder: createJsonlRecorder(auditPath),
    });
  let d = mk().decide(spend(400)).decision;
  check("persistence: first instance spends 400 (allow)", d.verdict === "allow");
  const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
  check("persistence: state file is valid JSON with the recorded event", Array.isArray(onDisk.events) && onDisk.events.length === 1 && onDisk.events[0].amount === 400);
  d = mk().decide(spend(200)).decision;
  check("persistence: second instance sees the budget (400 + 200 denies)", d.verdict === "deny" && d.rule_id === "daily-spend-cap");
  const records = readGatewayRecords(auditPath);
  check("recorder: both decisions were recorded with their verdicts", records.length === 2 && records[0].verdict === "allow" && records[1].verdict === "deny" && records[1].rule_id === "daily-spend-cap", JSON.stringify(records.map((r) => r.verdict)));
}

// ---------- CLI freeze / status / unfreeze ----------
{
  const dir = freshDir();
  const freezePath = join(dir, "freeze.json");
  const statePath = join(dir, "state.json");
  const run = (...a) => execFileSync("node", [CLI, ...a], { encoding: "utf8" });
  const out1 = JSON.parse(run("freeze", "--freeze-file", freezePath, "--by", "ryan", "--reason", "cli test"));
  check("CLI: freeze writes the flag and reports frozen:true", out1.frozen === true && existsSync(freezePath));
  const out2 = JSON.parse(run("status", "--freeze-file", freezePath, "--state", statePath));
  check("CLI: status reports frozen with by/reason", out2.frozen.frozen === true && out2.frozen.detail.by === "ryan" && out2.frozen.detail.reason === "cli test", JSON.stringify(out2.frozen));
  const out3 = JSON.parse(run("unfreeze", "--freeze-file", freezePath));
  check("CLI: unfreeze removes the flag", out3.frozen === false && out3.was_frozen === true && !existsSync(freezePath));
  const out4 = JSON.parse(run("status", "--freeze-file", freezePath, "--state", statePath));
  check("CLI: status after unfreeze reports frozen:false", out4.frozen.frozen === false);
}

console.log(`\nghostguard-budgets: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
