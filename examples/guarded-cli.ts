/**
 * Example 1 — a minimal guarded CLI agent.
 *
 * Run from a clone:  npm run example:cli
 * (Approve the asks by typing `y` at the prompts; piping
 *  `printf 'y\ny\n'` works too. EOF / anything else = not approved.)
 *
 * The agent proposes five actions — file writes, a "send", a
 * purchase, a delete — and every one of them passes through
 * GhostGuard first: classify → evaluate → RECORD → and only then,
 * on an allowing verdict, act. Consequential actions come back
 * `ask`; the agent shows you the exact recorded payload and reads
 * your answer from stdin. Approval re-evaluates with a carried
 * approval (`approved: true`), records that decision too, and only
 * then executes. The purchase is denied by a LOCKED rule — no
 * prompt can talk its way past that; the record names the rule.
 *
 * All effects are toy effects inside ./out/ next to this file, and
 * every decision lands in ./out/audit.jsonl via the reference
 * JSONL recorder. Delete ./out/ to reset the demo.
 */
import { readSync } from "node:fs";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePolicy, evaluatePolicy, gatewayRecordFromDecision,
  createJsonlRecorder, readGatewayRecords,
  type GatewayIntent, type PermissionClass, type PolicyContext,
} from "../src/index.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
rmSync(OUT, { recursive: true, force: true }); // demo sandbox: start clean
mkdirSync(OUT, { recursive: true });
const AUDIT = join(OUT, "audit.jsonl");
const recorder = createJsonlRecorder(AUDIT);

// The policy, as data. Note the ask rules carry `&& !approved`: a
// carried human approval satisfies them — which is exactly the
// re-evaluation the ask flow below performs. The deny is `locked`:
// it is the layer an editable overlay could never weaken.
const policy = compilePolicy({ rules: [
  { id: "no-spend-ever", effect: "deny", locked: true,
    when: "permission_class == 'SPEND'" },
  { id: "docs-are-pre-approved", effect: "pre_approved",
    when: "kind == 'fs.write' && startsWith(payload.path, 'docs/')" },
  { id: "ask-before-sending", effect: "ask",
    when: "permission_class == 'COMMUNICATE' && !approved" },
  { id: "ask-before-deleting", effect: "ask",
    when: "permission_class == 'DELETE' && !approved" },
  { id: "allow-the-rest", effect: "allow", when: "true" },
] });

const RUN = { actor: "cli-agent", initiator: "person" as const, project_id: "example-cli" };
let seq = 0;

/** Read one line from stdin synchronously; EOF/error → null. */
function readLine(): string | null {
  const chunks: Buffer[] = [];
  const byte = Buffer.alloc(1);
  try {
    for (;;) {
      const n = readSync(0, byte, 0, 1, null);
      if (n === 0) break; // EOF
      if (byte[0] === 0x0a) break; // \n
      chunks.push(Buffer.from(byte));
    }
  } catch {
    return null;
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf8").trim();
}

interface ProposedAction {
  kind: string;
  permission_class: PermissionClass;
  payload: Record<string, unknown>;
  /** The effect itself — only ever called on an allowing verdict. */
  run: () => string;
}

function propose(action: ProposedAction): void {
  seq += 1;
  const actionId = `act_${seq}`;
  const decide = (approved: boolean) => {
    const ctx: PolicyContext = {
      kind: action.kind, permission_class: action.permission_class,
      actor: RUN.actor, initiator: RUN.initiator, project_id: RUN.project_id,
      approved, payload: action.payload,
    };
    const decision = evaluatePolicy(policy, ctx);
    const intent: GatewayIntent = {
      action_id: actionId, kind: action.kind, permission_class: action.permission_class,
      actor: RUN.actor, initiator: RUN.initiator, project_id: RUN.project_id,
      action_payload: action.payload,
    };
    const record = gatewayRecordFromDecision(intent, decision);
    recorder(record); // record FIRST — if this throws, nothing runs
    return record;
  };

  console.log(`\n▸ ${action.kind} (${action.permission_class}) ${JSON.stringify(action.payload)}`);
  let record = decide(false);
  console.log(`  verdict: ${record.verdict} — ${record.reason}`);

  if (record.verdict === "ask") {
    const answer = readLinePrompt(`  Approve this exact payload? [y/N] `);
    if (answer) {
      record = decide(true); // carried approval, recorded as its own decision
      console.log(`  approved by human → re-evaluated: ${record.verdict} — ${record.reason}`);
    } else {
      console.log("  not approved — the action does not run.");
      return;
    }
  }
  if (record.verdict === "allow" || record.verdict === "pre_approved") {
    console.log(`  ✓ ${action.run()}`);
  } else {
    console.log(`  ✗ refused (${record.verdict}${record.rule_id ? `, rule "${record.rule_id}"` : ""}) — the action does not run.`);
  }
}

function readLinePrompt(prompt: string): boolean {
  process.stdout.write(prompt);
  const line = readLine();
  return line !== null && /^y(es)?$/i.test(line);
}

// ── The run ──────────────────────────────────────────────────────
propose({
  kind: "fs.write", permission_class: "WRITE_LOCAL",
  payload: { path: "notes/todo.txt", contents: "call the roofer\n" },
  run: () => {
    const p = join(OUT, "notes", "todo.txt");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "call the roofer\n");
    return `wrote ${p}`;
  },
});

propose({
  kind: "fs.write", permission_class: "WRITE_LOCAL",
  payload: { path: "docs/welcome.md", contents: "# Welcome\n" },
  run: () => {
    const p = join(OUT, "docs", "welcome.md");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "# Welcome\n");
    return `wrote ${p} (standing approval — no prompt)`;
  },
});

propose({
  kind: "comms.send", permission_class: "COMMUNICATE",
  payload: { to: "customer@example.com", text: "Your invoice is ready." },
  run: () => {
    appendFileSync(join(OUT, "outbox.log"), "TO customer@example.com: Your invoice is ready.\n");
    return "sent (appended to out/outbox.log)";
  },
});

propose({
  kind: "pay.purchase", permission_class: "SPEND",
  payload: { item: "gpu-hours", amount: 240 },
  run: () => "charged the card (you should never see this — the locked rule denies first)",
});

propose({
  kind: "fs.delete", permission_class: "DELETE",
  payload: { path: "notes/todo.txt" },
  run: () => {
    rmSync(join(OUT, "notes", "todo.txt"));
    return "deleted out/notes/todo.txt";
  },
});

// ── The paper trail ──────────────────────────────────────────────
const trail = readGatewayRecords(AUDIT);
console.log(`\n── Audit trail: ${trail.length} records in ${AUDIT}`);
for (const r of trail) {
  console.log(`   ${r.action_id}  ${r.kind.padEnd(14)} ${r.verdict.padEnd(12)} rule: ${r.rule_id ?? "(none — fail-closed default)"}`);
}
console.log("\nEvery action above was recorded before it ran — including the ones that never ran.");
