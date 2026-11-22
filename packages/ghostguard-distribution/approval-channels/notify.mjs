#!/usr/bin/env node
/**
 * GhostGuard approval channels — the ask-notifier.
 *
 * When a guarded run gets an `ask` verdict, someone has to hear
 * about it. This tool takes a pending ask (a gateway record with
 * verdict ask — or hand_off) and POSTs a formatted notification to
 * a generic webhook URL from config. Format templates cover the
 * usual chat-webhook shapes:
 *
 *   generic   { text, record }                      (default)
 *   slack     { text }                              (Slack incoming webhook body)
 *   discord   { content }                           (Discord webhook body)
 *   telegram  { text } + parse hint — for bot-API style relay webhooks
 *
 * This is a NOTIFIER, not an approver: it never waits on the
 * webhook and never treats silence as consent. The message itself
 * carries the escalation metadata (asked_at, escalate_after) and
 * states the rule out loud: TIMEOUT = DENY. If the timeout passes
 * with no human decision on file, expireTimeouts() appends a DENY
 * decision entry to the decisions JSONL — fail-closed, never an
 * auto-approve.
 *
 * Config (JSON file or plain object):
 *   { webhookUrl, format: "generic|slack|discord|telegram",
 *     timeoutMs, escalateAfterMs?, channelLabel? }
 *
 * Usage:
 *   node notify.mjs --config config.json --ask ask.json \
 *       [--decisions decisions.jsonl]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const FORMATS = ["generic", "slack", "discord", "telegram"];

export class NotifyError extends Error {}

function msToHuman(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Build the notification message for a pending ask record. */
export function formatAskMessage(record, meta, format) {
  const lines = [
    `⏸ GhostGuard ASK — action held for a human decision`,
    `action: ${record.kind} (${record.permission_class ?? "unclassified"})`,
    `action_id: ${record.action_id}`,
    `actor: ${record.actor} · initiator: ${record.initiator} · project: ${record.project_id}`,
    `rule: ${record.rule_id ?? "none"} — ${record.reason}`,
    `payload: ${JSON.stringify(record.action_payload)}`,
    `asked_at: ${meta.asked_at}`,
    `escalate_after: ${meta.escalate_after}`,
    `⏱ Timeout = DENY: if no decision lands by ${meta.timeout_at}, this action is denied automatically. Silence is never an approval.`,
  ];
  if (meta.channel_label) lines.push(`channel: ${meta.channel_label}`);
  const text = lines.join("\n");
  switch (format) {
    case "slack": return { text };
    case "discord": return { content: text };
    case "telegram": return { text, parse_mode: "HTML" };
    case "generic": return { text, record, meta };
    default: throw new NotifyError(`unknown format "${format}" — one of ${FORMATS.join(", ")}`);
  }
}

/** Escalation metadata for an ask, from config timings. */
export function askMeta(config, now = new Date()) {
  const timeoutMs = config.timeoutMs ?? 15 * 60 * 1000;
  const escalateMs = config.escalateAfterMs ?? Math.floor(timeoutMs / 2);
  return {
    asked_at: now.toISOString(),
    escalate_after: new Date(now.getTime() + escalateMs).toISOString(),
    escalate_after_in: msToHuman(escalateMs),
    timeout_at: new Date(now.getTime() + timeoutMs).toISOString(),
    timeout_in: msToHuman(timeoutMs),
    on_timeout: "deny",
    channel_label: config.channelLabel ?? null,
  };
}

/**
 * Notify the webhook about a pending ask. Returns
 * { sent: true, meta, body } on a 2xx, throws NotifyError otherwise.
 * A failed notification is LOUD (the caller must know the human may
 * never have been told) — but note the governance stance: even a
 * delivered notification changes nothing about the verdict. The
 * action stays held until a real decision entry exists.
 */
export async function notifyAsk(record, config, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!record || (record.verdict !== "ask" && record.verdict !== "hand_off")) {
    throw new NotifyError(`record ${record?.action_id} has verdict "${record?.verdict}" — only ask/hand_off records are notified`);
  }
  if (!config.webhookUrl) throw new NotifyError("config.webhookUrl is required");
  const format = config.format ?? "generic";
  const meta = askMeta(config, now);
  const body = formatAskMessage(record, meta, format);
  let res;
  try {
    res = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new NotifyError(`webhook POST to ${config.webhookUrl} failed: ${e.message}`);
  }
  if (!res.ok) throw new NotifyError(`webhook POST to ${config.webhookUrl} returned ${res.status}`);
  return { sent: true, meta, body };
}

/** Read a decisions JSONL (cloud-entry or plain shape). Missing file = no decisions. */
export function readDecisions(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => {
    const o = JSON.parse(l);
    return o.entry_type === "decision" ? o : { action_id: o.action_id, decision: o.decision, approver: o.approver };
  }).filter((d) => d.action_id && d.decision);
}

/**
 * Fail-closed timeout pass: for every pending ask whose timeout_at
 * has passed and which has NO decision on file, append a DENY
 * decision entry (approver "ghostguard-timeout") to the decisions
 * JSONL and return the entries written. Asks a human already
 * decided are never touched; a timeout NEVER writes an approval.
 *
 * pending: [{ record, meta }] as produced alongside notifyAsk.
 */
export function expireTimeouts(pending, decisionsFile, { now = new Date() } = {}) {
  const decided = new Set(readDecisions(decisionsFile).map((d) => d.action_id));
  const written = [];
  for (const p of pending) {
    const id = p.record.action_id;
    if (decided.has(id)) continue;
    if (new Date(p.meta.timeout_at).getTime() > now.getTime()) continue;
    const entry = {
      entry_type: "decision",
      action_id: id,
      project_id: p.record.project_id,
      decision: "deny",
      approver: "ghostguard-timeout",
      reason: `no human decision before timeout_at ${p.meta.timeout_at} — timeout is a deny, never an approval`,
      decided_at: now.toISOString(),
      received_at: now.toISOString(),
    };
    appendFileSync(decisionsFile, JSON.stringify(entry) + "\n");
    written.push(entry);
    decided.add(id);
  }
  return written;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const configPath = get("--config");
  const askPath = get("--ask");
  if (!configPath || !askPath) {
    console.error("usage: node notify.mjs --config <config.json> --ask <ask-record.json> [--decisions <decisions.jsonl>]");
    process.exit(2);
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const record = JSON.parse(readFileSync(askPath, "utf8"));
    const r = await notifyAsk(record, config);
    console.log(`approval-channels: notified ${config.format ?? "generic"} webhook for ${record.action_id}; timeout_at ${r.meta.timeout_at} (timeout = deny)`);
  } catch (e) {
    console.error(`approval-channels: ERROR — ${e.message}`);
    process.exit(1);
  }
}
