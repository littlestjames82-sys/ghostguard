/**
 * Incident Report Generator (more-ideas #9): a JSONL GatewayRecord
 * trail -> ONE self-contained HTML file (inline CSS, no external
 * assets, no scripts) a human can open, print, or hand to a client
 * or insurer: what happened, in order, with every refusal and every
 * ask shown with the rule that decided it and the exact payload —
 * secrets redacted to type+length.
 *
 * Honest framing, printed on the report itself: this is evidence
 * assembled from the trail, not a compliance certification.
 */

import { tallyRecords, redactSecrets, recordTime, esc } from "./trail.mjs";

const VERDICT_STYLE = {
  allow: "#1a7f37",
  pre_approved: "#1a7f37",
  ask: "#9a6700",
  hand_off: "#8250df",
  deny: "#cf222e",
};

const CSS = `
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:2rem auto;max-width:980px;padding:0 1rem;color:#1f2328;line-height:1.45}
h1{font-size:1.5rem;margin-bottom:.2rem} h2{margin-top:2rem;border-bottom:1px solid #d1d9e0;padding-bottom:.3rem}
.meta{color:#59636e;font-size:.9rem}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{border:1px solid #d1d9e0;padding:.35rem .5rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}
.verdict{font-weight:600;white-space:nowrap}
.card{border:1px solid #d1d9e0;border-left:5px solid #9a6700;border-radius:6px;padding:.7rem 1rem;margin:.8rem 0}
.card.deny{border-left-color:#cf222e}.card.hand_off{border-left-color:#8250df}
.card.locked{border-color:#cf222e;background:#fff5f5;box-shadow:0 0 0 1px #cf222e inset}
.locked-badge{background:#cf222e;color:#fff;border-radius:4px;padding:.05rem .45rem;font-size:.75rem;font-weight:700}
pre{background:#f6f8fa;border:1px solid #d1d9e0;border-radius:6px;padding:.6rem;overflow-x:auto;font-size:.8rem;white-space:pre-wrap;word-break:break-word}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.notice{border:1px solid #d1d9e0;background:#f6f8fa;border-radius:6px;padding:.6rem 1rem;font-size:.88rem}
`;

function tallyTable(title, obj) {
  const rows = Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v}</td></tr>`)
    .join("");
  return `<h3>${esc(title)}</h3><table><tr><th>Key</th><th>Count</th></tr>${rows || '<tr><td colspan="2">(none)</td></tr>'}</table>`;
}

/**
 * Render the report.
 *   records:  (filtered) GatewayRecords, in trail order
 *   opts: { title, sourceName, generatedAt, filtersDescription,
 *           lockedRules: Set<string>, totalBeforeFilter }
 */
export function renderIncidentReport(records, opts = {}) {
  const title = opts.title ?? "GhostGuard Incident Report";
  const locked = opts.lockedRules ?? new Set();
  const tallies = tallyRecords(records);
  const lockedHits = records.filter((r) => r.rule_id && locked.has(r.rule_id));

  const timelineRows = records
    .map((r, i) => {
      const color = VERDICT_STYLE[r.verdict] ?? "#1f2328";
      const isLocked = r.rule_id && locked.has(r.rule_id);
      return (
        `<tr><td>${i + 1}</td><td>${esc(recordTime(r) ?? "—")}</td>` +
        `<td><code>${esc(r.kind)}</code></td><td>${esc(r.permission_class ?? "—")}</td>` +
        `<td>${esc(r.actor)}</td><td>${esc(r.initiator ?? "—")}</td>` +
        `<td class="verdict" style="color:${color}">${esc(r.verdict)}</td>` +
        `<td><code>${esc(r.rule_id ?? "(none)")}</code>${isLocked ? ' <span class="locked-badge">LOCKED RULE</span>' : ""}</td></tr>`
      );
    })
    .join("");

  const detailCards = records
    .filter((r) => r.verdict === "deny" || r.verdict === "ask" || r.verdict === "hand_off")
    .map((r) => {
      const isLocked = r.rule_id && locked.has(r.rule_id);
      const payload = esc(JSON.stringify(redactSecrets(r.action_payload ?? {}), null, 2));
      const target = r.target ? esc(JSON.stringify(redactSecrets(r.target), null, 2)) : null;
      return (
        `<div class="card ${esc(r.verdict)}${isLocked ? " locked" : ""}">` +
        `<strong>${esc(r.verdict.toUpperCase())}</strong> — <code>${esc(r.kind)}</code> (${esc(r.permission_class ?? "—")})` +
        (isLocked ? ' &nbsp;<span class="locked-badge">LOCKED RULE HIT</span>' : "") +
        `<br>Action <code>${esc(r.action_id)}</code> · actor ${esc(r.actor)} · initiator ${esc(r.initiator ?? "—")} · ${esc(recordTime(r) ?? "no timestamp")}` +
        `<br>Deciding rule: <code>${esc(r.rule_id ?? "(none — fail-closed default)")}</code>` +
        (r.handoff_to ? `<br>Handed off to: <code>${esc(r.handoff_to)}</code>` : "") +
        `<br>Reason: ${esc(r.reason ?? "")}` +
        `<br>Exact payload (secrets redacted to type + length):<pre>${payload}</pre>` +
        (target ? `Target:<pre>${target}</pre>` : "") +
        `</div>`
      );
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">Generated ${esc(opts.generatedAt ?? new Date().toISOString())} by GhostGuard Reports` +
    (opts.sourceName ? ` · Source trail: <code>${esc(opts.sourceName)}</code>` : "") +
    (opts.filtersDescription ? `<br>Filters applied: ${esc(opts.filtersDescription)}` : "") +
    `<br>Records in report: ${records.length}` +
    (opts.totalBeforeFilter !== undefined && opts.totalBeforeFilter !== records.length
      ? ` (of ${opts.totalBeforeFilter} in the trail)`
      : "") +
    `</p>
<div class="notice">This report is <strong>evidence assembled from the recorded trail</strong> — intent, verdict, deciding rule, and exact (redacted) payload for each action. It is not a compliance certification and does not by itself prove anything beyond what the trail records. An action that was not recorded did not happen; a gap in the trail is itself a finding.</div>

<h2>Summary</h2>
${tallyTable("By verdict", tallies.byVerdict)}
${tallyTable("By deciding rule", tallies.byRule)}
${tallyTable("By permission class", tallies.byClass)}
<p><strong>Locked-rule hits:</strong> ${lockedHits.length}` +
    (locked.size === 0
      ? " (no policy was supplied, so locked rules could not be identified — pass --policy to mark them)"
      : ` — records decided by a locked rule: ${lockedHits.map((r) => `<code>${esc(r.action_id)}</code>`).join(", ") || "none"}`) +
    `</p>

<h2>Timeline</h2>
<table><tr><th>#</th><th>Time</th><th>Kind</th><th>Class</th><th>Actor</th><th>Initiator</th><th>Verdict</th><th>Deciding rule</th></tr>${timelineRows || '<tr><td colspan="8">(no records)</td></tr>'}</table>

<h2>Denials, asks &amp; hand-offs — in detail</h2>
${detailCards || "<p>None. Every recorded action was allowed or pre-approved.</p>"}
</body></html>
`;
}
