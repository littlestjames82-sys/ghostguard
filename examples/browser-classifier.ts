/**
 * Example 2 — classifying a browser agent's actions, Jev-governor
 * style.
 *
 * Run from a clone:  npm run example:browser
 *
 * A browser agent's raw action kinds (navigate, fill, click, …)
 * mean nothing to a policy until they are classified. This example
 * is the mapping the Jev Ultrafast governor uses, applied to the
 * shipped default policy:
 *
 *   navigate / read / extract  → READ           (looking is free)
 *   fill / plain click         → WRITE_LOCAL    (changes the page,
 *                                                sends nothing)
 *   submit-capable click       → NETWORK_WRITE  (this is the one
 *                                                that places the
 *                                                order / sends the
 *                                                form — classify up)
 *
 * …plus the consequential kinds a real session grows: sending a
 * message (COMMUNICATE), buying (SPEND), deleting (DELETE) — which
 * the default policy asks a human about. One overlay rule adds the
 * Jev stance on submit clicks: they ask unless the run carries an
 * approval. And one kind is deliberately left UNMAPPED: kinds
 * outside the permission map never reach the policy at all — the
 * gateway refuses them first, and records the refusal.
 *
 * Non-interactive: `ask` verdicts are shown and skipped (a real
 * integration would surface the recorded payload to its approver).
 * Every decision is recorded to ./out/browser-audit.jsonl.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePolicy, evaluatePolicy, defaultKernelPolicy, mergePolicyDocs,
  gatewayRecordFromDecision, createJsonlRecorder, readGatewayRecords,
  type PermissionClass, type PolicyDecision,
} from "../src/index.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
rmSync(join(OUT, "browser-audit.jsonl"), { force: true });
mkdirSync(OUT, { recursive: true });
const recorder = createJsonlRecorder(join(OUT, "browser-audit.jsonl"));

/** The classifier: raw browser kind → consequence class.
 *  null = not in the permission map — the gateway refuses these
 *  before policy ever sees them. When in doubt, classify up. */
function classify(kind: string): PermissionClass | null {
  switch (kind) {
    case "browser.navigate":
    case "browser.read":
    case "browser.extract":
      return "READ";
    case "browser.fill":
    case "browser.click":
      return "WRITE_LOCAL";
    case "browser.submit_click":
      return "NETWORK_WRITE";
    case "browser.send_message":
      return "COMMUNICATE";
    case "browser.purchase":
      return "SPEND";
    case "browser.delete_item":
      return "DELETE";
    default:
      return null;
  }
}

// Default policy + one overlay rule (merged, not edited in place):
// submit clicks ask unless the run carries an approval.
const policy = compilePolicy(mergePolicyDocs(defaultKernelPolicy(), { rules: [
  { id: "submit-clicks-ask-unapproved", effect: "ask",
    when: "kind == 'browser.submit_click' && !approved" },
] }));

const RUN = { actor: "browser-agent", initiator: "person" as const, project_id: "example-browser" };

interface BrowserAction { kind: string; payload: Record<string, unknown>; approved?: boolean; }

function propose(seq: number, action: BrowserAction): void {
  const cls = classify(action.kind);
  let decision: PolicyDecision;
  if (cls === null) {
    // Outside the permission map: refused before policy evaluation,
    // exactly like the legacy gate — and still recorded.
    decision = {
      verdict: "deny", rule_id: null, handoff_to: null,
      reason: `kind "${action.kind}" is not in the permission map — refused before policy evaluation`,
    };
  } else {
    decision = evaluatePolicy(policy, {
      kind: action.kind, permission_class: cls, actor: RUN.actor,
      initiator: RUN.initiator, project_id: RUN.project_id,
      approved: action.approved ?? false, payload: action.payload,
    });
  }
  const record = gatewayRecordFromDecision({
    action_id: `act_${seq}`, kind: action.kind, permission_class: cls,
    actor: RUN.actor, initiator: RUN.initiator, project_id: RUN.project_id,
    action_payload: action.payload,
  }, decision);
  recorder(record); // record first — always
  const clsLabel = cls ?? "UNMAPPED";
  const outcome =
    record.verdict === "allow" || record.verdict === "pre_approved" ? "would run"
    : record.verdict === "ask" ? "ASK — a human sees this exact payload first; skipped in this demo"
    : "REFUSED — never runs";
  console.log(
    `${action.kind.padEnd(24)} → ${clsLabel.padEnd(13)} ${record.verdict.padEnd(12)} [${record.rule_id ?? "no rule — fail-closed"}] ${outcome}`,
  );
}

const script: BrowserAction[] = [
  { kind: "browser.navigate", payload: { url: "https://example.com/orders" } },
  { kind: "browser.read", payload: { selector: "h1" } },
  { kind: "browser.fill", payload: { field: "quantity", value: "2" } },
  { kind: "browser.submit_click", payload: { button: "Place order" } },
  { kind: "browser.submit_click", payload: { button: "Place order" }, approved: true },
  { kind: "browser.send_message", payload: { to: "support", text: "Where is my order?" } },
  { kind: "browser.purchase", payload: { item: "extended warranty", amount: 59 } },
  { kind: "browser.delete_item", payload: { item: "saved card •••• 4242" } },
  { kind: "browser.teleport", payload: { where: "elsewhere" } },
];
script.forEach((a, i) => propose(i + 1, a));

const trail = readGatewayRecords(join(OUT, "browser-audit.jsonl"));
console.log(`\n${trail.length} decisions recorded to out/browser-audit.jsonl — the asks and the refusal included.`);
