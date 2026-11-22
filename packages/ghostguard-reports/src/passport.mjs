/**
 * Agent Passports — signed identity for agents (more-ideas #8).
 *
 * A passport is a small JSON document naming an agent: who it is
 * (agent_id), who built it (builder), the permission classes it may
 * ever request (allowed_classes), and its trust tier. It is signed
 * with an Ed25519 keypair held by the issuer (the studio / team
 * running GhostGuard); anyone holding the PUBLIC key can verify a
 * passport, and nobody can forge or edit one without the private key.
 *
 * Why Ed25519 and not an HMAC: a symmetric MAC makes every verifier
 * also a potential forger — whoever can check a passport could mint
 * one. Passports are meant to be shown to other systems (a bus, a
 * client portal, another studio's gateway), so verification must not
 * hand out signing power. Ed25519 is in node:crypto, deterministic,
 * fast, and the keys are tiny. That asymmetry is the whole point.
 *
 * The passport does not replace policy. It feeds it: see
 * tightenDecision(), which takes a REAL GhostGuard engine decision
 * and can only ever make it stricter (or deny outright when the
 * passport is missing/invalid or the class is outside the passport's
 * bounds) — never looser. Tiers:
 *   new         — unproven. allow/pre_approved escalate to ask for
 *                 NETWORK_WRITE and every class above it.
 *   established — allow/pre_approved escalate to ask for SPEND and
 *                 DELETE (the two classes whose effects are hardest
 *                 to undo).
 *   trusted     — no tier escalation (class bounds still apply).
 * Earning a higher tier is an issuer decision, recorded by issuing a
 * new passport — this module deliberately has no self-promotion path.
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

/** PermissionClass vocabulary — mirrors ghostguard's src/types.ts. */
export const PERMISSION_CLASSES = [
  "READ",
  "WRITE_LOCAL",
  "EXECUTE",
  "NETWORK_WRITE",
  "DEPLOY",
  "PUBLISH",
  "COMMUNICATE",
  "SPEND",
  "DELETE",
];

/** Consequence order, low to high — the yardstick for escalation. */
const CLASS_RANK = new Map(PERMISSION_CLASSES.map((c, i) => [c, i]));

export const TRUST_TIERS = ["new", "established", "trusted"];

/** Strictness rank of a verdict (ghostguard's tier order, inverted). */
export const VERDICT_RANK = {
  allow: 0,
  pre_approved: 1,
  ask: 2,
  hand_off: 3,
  deny: 4,
};

/** Classes at/above this rank escalate for the given tier. */
const TIER_ESCALATION_FLOOR = {
  new: CLASS_RANK.get("NETWORK_WRITE"),
  established: CLASS_RANK.get("SPEND"),
  trusted: Number.POSITIVE_INFINITY,
};

export const PASSPORT_FORMAT = "ghostguard-passport/v1";

/** Deterministic JSON: object keys sorted at every depth. The
 *  signature covers this string, so issuer and verifier must produce
 *  byte-identical text for the same passport body. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") +
    "}"
  );
}

/** Generate an issuer keypair. Returns PEM strings; the private key
 *  is a secret — store it like one (the CLI writes it mode 0600). */
export function generateIssuerKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/**
 * Issue (sign) a passport. `fields` = { agent_id, builder,
 * allowed_classes, trust_tier, issued_at? } — issued_at defaults to
 * now. Returns the passport document { format, passport, alg,
 * signature }. Throws on invalid fields: an issuer should never be
 * able to mint a passport its own verifier would reject.
 */
export function issuePassport(fields, privateKeyPem) {
  const passport = {
    agent_id: fields.agent_id,
    builder: fields.builder,
    allowed_classes: [...(fields.allowed_classes ?? [])],
    trust_tier: fields.trust_tier,
    issued_at: fields.issued_at ?? new Date().toISOString(),
  };
  const problems = validatePassportBody(passport);
  if (problems.length > 0) {
    throw new Error("refusing to issue an invalid passport: " + problems.join("; "));
  }
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalStringify(passport), "utf8"),
    createPrivateKey(privateKeyPem),
  );
  return {
    format: PASSPORT_FORMAT,
    passport,
    alg: "Ed25519",
    signature: signature.toString("base64"),
  };
}

function validatePassportBody(p) {
  const problems = [];
  if (!p || typeof p !== "object") return ["passport body is not an object"];
  if (typeof p.agent_id !== "string" || p.agent_id.length === 0)
    problems.push("agent_id must be a non-empty string");
  if (typeof p.builder !== "string" || p.builder.length === 0)
    problems.push("builder must be a non-empty string");
  if (!Array.isArray(p.allowed_classes) || p.allowed_classes.length === 0)
    problems.push("allowed_classes must be a non-empty array");
  else
    for (const c of p.allowed_classes)
      if (!CLASS_RANK.has(c)) problems.push(`allowed_classes contains unknown class "${c}"`);
  if (!TRUST_TIERS.includes(p.trust_tier))
    problems.push(`trust_tier must be one of ${TRUST_TIERS.join(", ")}`);
  if (typeof p.issued_at !== "string" || Number.isNaN(Date.parse(p.issued_at)))
    problems.push("issued_at must be an ISO date-time string");
  return problems;
}

/**
 * Verify a passport document against the issuer's PUBLIC key.
 * Returns { valid, errors } — never throws on bad input; a malformed
 * or tampered passport is simply invalid. ANY change to a signed
 * field (agent, builder, classes, tier, date) breaks the signature,
 * as does verifying against the wrong key.
 */
export function verifyPassport(doc, publicKeyPem) {
  const errors = [];
  if (!doc || typeof doc !== "object") return { valid: false, errors: ["not an object"] };
  if (doc.format !== PASSPORT_FORMAT) errors.push(`format must be ${PASSPORT_FORMAT}`);
  if (doc.alg !== "Ed25519") errors.push('alg must be "Ed25519"');
  if (typeof doc.signature !== "string" || doc.signature.length === 0)
    errors.push("signature missing");
  errors.push(...validatePassportBody(doc.passport ?? {}));
  if (errors.length > 0) return { valid: false, errors };

  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(canonicalStringify(doc.passport), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(doc.signature, "base64"),
    );
  } catch (err) {
    return { valid: false, errors: [`signature check failed: ${err.message}`] };
  }
  return ok
    ? { valid: true, errors: [] }
    : { valid: false, errors: ["signature does not match the passport body"] };
}

/**
 * The policy-context helper: take a decision the REAL GhostGuard
 * engine already made (`decision` from evaluatePolicy) plus the
 * action context and the agent's VERIFIED passport body (the inner
 * `passport` object, after verifyPassport() returned valid — pass
 * null for "no passport"), and return the decision the gateway
 * should act on. Stricter-only, fail-closed:
 *   - no passport            -> deny (passport:missing)
 *   - class outside passport -> deny (passport:class-not-allowed)
 *   - tier escalation        -> allow/pre_approved become ask
 *   - everything else        -> the engine's decision, unchanged
 * It can never loosen: the returned verdict's VERDICT_RANK is always
 * >= the engine verdict's (the tests sweep every combination).
 */
export function tightenDecision(decision, ctx, passport) {
  if (!passport) {
    return {
      verdict: "deny",
      rule_id: "passport:missing",
      reason:
        "No verified agent passport was presented; the passport gate denies by default (fail-closed).",
      handoff_to: null,
    };
  }
  const cls = ctx.permission_class;
  if (cls != null && !passport.allowed_classes.includes(cls)) {
    return {
      verdict: "deny",
      rule_id: "passport:class-not-allowed",
      reason: `Passport for agent "${passport.agent_id}" does not allow the ${cls} class (allowed: ${passport.allowed_classes.join(", ")}); the passport gate denies.`,
      handoff_to: null,
    };
  }
  const floor = TIER_ESCALATION_FLOOR[passport.trust_tier];
  const escalatable =
    decision.verdict === "allow" || decision.verdict === "pre_approved";
  if (
    escalatable &&
    cls != null &&
    floor !== undefined &&
    CLASS_RANK.get(cls) >= floor
  ) {
    return {
      verdict: "ask",
      rule_id: "passport:tier-gate",
      reason: `Engine verdict was ${decision.verdict} (rule ${decision.rule_id ?? "(none)"}), escalated to ask: a "${passport.trust_tier}"-tier passport must have a human approve ${cls} actions. The passport gate only ever tightens.`,
      handoff_to: null,
    };
  }
  return decision;
}
