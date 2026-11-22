#!/usr/bin/env node
// GhostGuard voice approval — CLI.
//
//   node src/cli.mjs pending  --trail <trail.jsonl> --decisions <decisions.jsonl>
//   node src/cli.mjs decide   --trail <trail.jsonl> --decisions <decisions.jsonl>
//                             --evidence <dir> --action <action_id>
//                             --audio <recording> --decision approve|deny --approver <name>
//   node src/cli.mjs verify   --decisions <decisions.jsonl> --evidence <dir>
//
// "decide" is the human's step: they recorded themselves saying the
// decision (on their phone, in MrGhosty later — see SPEC.md), and this
// appends the hash-bound decision entry. No transcription, no
// voice-match, no identity claim.
import { decideWithVoice, listPending, verifyEvidence } from "./voice-decide.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function need(args, name) {
  if (!args[name]) throw new Error(`--${name} is required`);
  return args[name];
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (command === "pending") {
    const trail = need(args, "trail");
    const decisions = args.decisions ?? "decisions.jsonl";
    const pending = listPending(trail, decisions);
    for (const r of pending) {
      process.stdout.write(`${r.action_id}\t${r.verdict}\t${r.kind}\tproject=${r.project_id}\n`);
    }
    process.stdout.write(`${pending.length} pending\n`);
  } else if (command === "decide") {
    const entry = decideWithVoice({
      trailPath: need(args, "trail"),
      decisionsPath: args.decisions ?? "decisions.jsonl",
      evidenceDir: args.evidence ?? "evidence",
      actionId: need(args, "action"),
      audioPath: need(args, "audio"),
      decision: need(args, "decision"),
      approver: need(args, "approver"),
    });
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    process.stdout.write(
      `recorded: ${entry.decision} for ${entry.action_id} by ${entry.approver} ` +
        `(payload ${entry.payload_sha256.slice(0, 12)}…, audio ${entry.audio_sha256.slice(0, 12)}…)\n`,
    );
  } else if (command === "verify") {
    const result = verifyEvidence(need(args, "decisions"), args.evidence ?? "evidence");
    if (result.ok) {
      process.stdout.write(`verify OK — ${result.checked} voice decision(s), all evidence hashes match\n`);
    } else {
      for (const m of result.mismatches) {
        process.stdout.write(`MISMATCH ${m.action_id} (${m.audio_file}): ${m.problem}\n`);
      }
      process.stdout.write(`verify FAILED — ${result.mismatches.length} problem(s) in ${result.checked} voice decision(s)\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write("usage: ghostguard-voice <pending|decide|verify> [options] — see README.md\n");
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
