/**
 * "Guarded by GhostGuard" badge + public trail summary (more-ideas
 * #17): the trust surface an agent or agency can link publicly.
 *
 * The redaction contract is the product: the summary contains ONLY
 * tallies — total actions, counts by verdict, by deciding rule, by
 * permission class, and (when a policy is supplied) the locked-rule
 * hit count. NO payloads, NO payload text, NO actor names, NO
 * action ids, NO project ids, NO timestamps. If a field is not a
 * count or a rule/class/verdict label, it does not ship.
 */

import { tallyRecords, esc } from "./trail.mjs";

/** Build the redacted summary object from records. */
export function summarizeTrail(records, opts = {}) {
  const tallies = tallyRecords(records);
  const locked = opts.lockedRules ?? new Set();
  const summary = {
    format: "ghostguard-trail-summary/v1",
    guarded_by: "GhostGuard",
    total_actions_recorded: tallies.total,
    by_verdict: tallies.byVerdict,
    by_rule: tallies.byRule,
    by_permission_class: tallies.byClass,
  };
  if (locked.size > 0) {
    summary.locked_rule_hits = records.filter(
      (r) => r.rule_id && locked.has(r.rule_id),
    ).length;
  }
  return summary;
}

/**
 * Shields-style SVG badge: "Guarded by GhostGuard — N actions
 * recorded". Self-contained, no external fonts/images. Width is
 * estimated from text length (monospace-ish metric), good enough
 * for a badge.
 */
export function renderBadgeSvg(summary) {
  const left = "Guarded by GhostGuard";
  const n = summary.total_actions_recorded;
  const right = `${n} action${n === 1 ? "" : "s"} recorded`;
  const charW = 6.6;
  const pad = 10;
  const leftW = Math.ceil(left.length * charW) + pad * 2;
  const rightW = Math.ceil(right.length * charW) + pad * 2;
  const totalW = leftW + rightW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="22" role="img" aria-label="${esc(left)}: ${esc(right)}">
<title>${esc(left)}: ${esc(right)}</title>
<rect width="${leftW}" height="22" fill="#3b2a63"/>
<rect x="${leftW}" width="${rightW}" height="22" fill="#6716f3"/>
<text x="${leftW / 2}" y="15" fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${esc(left)}</text>
<text x="${leftW + rightW / 2}" y="15" fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${esc(right)}</text>
</svg>
`;
}

/** Public summary page: badge + tally tables, same redaction
 *  contract as the JSON (this page is what the badge links to). */
export function renderSummaryHtml(summary) {
  const table = (title, obj) =>
    `<h2>${esc(title)}</h2><table>` +
    Object.entries(obj ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v}</td></tr>`)
      .join("") +
    `</table>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guarded by GhostGuard — trail summary</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:2rem auto;max-width:640px;padding:0 1rem;color:#1f2328}table{border-collapse:collapse}td{border:1px solid #d1d9e0;padding:.3rem .6rem}code{font-family:ui-monospace,Menlo,monospace}.note{color:#59636e;font-size:.88rem}</style></head><body>
<h1>Guarded by GhostGuard</h1>
${renderBadgeSvg(summary)}
<p><strong>${summary.total_actions_recorded}</strong> actions recorded through the GhostGuard gateway.` +
    (summary.locked_rule_hits !== undefined
      ? ` <strong>${summary.locked_rule_hits}</strong> were decided by locked rules.`
      : "") +
    `</p>
${table("By verdict", summary.by_verdict)}
${table("By deciding rule", summary.by_rule)}
${table("By permission class", summary.by_permission_class)}
<p class="note">This public summary is tallies only, by design: counts and deciding-rule statistics. It contains no action payloads, no actor names, and no timestamps. The full trail is held by the operator; GhostGuard records every action before it runs — an action that was not recorded did not happen. This summary is evidence of recording, not a compliance certification.</p>
</body></html>
`;
}
