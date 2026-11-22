import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PERMISSION_CLASSES = new Set([
  "READ", "WRITE_LOCAL", "EXECUTE", "NETWORK_WRITE",
  "DEPLOY", "PUBLISH", "COMMUNICATE", "SPEND", "DELETE",
]);

const INITIATORS = new Set(["person", "routine", "handoff", "memory", "system"]);

function fail(message) {
  throw new Error(`ghostguard-mcp config: ${message}`);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read ${what} at ${path}: ${e.message}`);
  }
}

/**
 * Load and validate a proxy config file. Relative file paths inside
 * the config (policyFile, overlayFile, auditFile, approvalsFile) are
 * resolved against the config file's own directory. Validation is
 * fail-closed: a bad classification, a missing policy, or a missing
 * upstream command is a startup error, never a silent pass-through.
 */
export function loadConfig(configPath) {
  if (!configPath) {
    fail("no config given — pass --config <path> or set GHOSTGUARD_MCP_CONFIG");
  }
  const absConfig = resolve(configPath);
  if (!existsSync(absConfig)) fail(`config file not found: ${absConfig}`);
  const baseDir = dirname(absConfig);
  const raw = readJson(absConfig, "config");

  const rel = (p) => (p ? resolve(baseDir, p) : p);

  const upstream = raw.upstream ?? {};
  if (typeof upstream.command !== "string" || upstream.command.trim() === "") {
    fail("upstream.command is required (the MCP server command to proxy)");
  }
  if (upstream.args !== undefined && !Array.isArray(upstream.args)) {
    fail("upstream.args must be an array of strings");
  }
  if (upstream.env !== undefined && (typeof upstream.env !== "object" || upstream.env === null)) {
    fail("upstream.env must be an object of string values");
  }

  let policyDoc = raw.policy ?? null;
  if (raw.policyFile) policyDoc = readJson(rel(raw.policyFile), "policy");
  if (!policyDoc || !Array.isArray(policyDoc.rules)) {
    fail("a policy is required: set policyFile or an inline policy { rules: [...] }");
  }

  let overlayDoc = null;
  if (raw.overlay) overlayDoc = raw.overlay;
  if (raw.overlayFile) overlayDoc = readJson(rel(raw.overlayFile), "policy overlay");

  const toolClasses = raw.toolClasses ?? {};
  if (typeof toolClasses !== "object" || toolClasses === null || Array.isArray(toolClasses)) {
    fail("toolClasses must be an object mapping tool name -> PermissionClass");
  }
  for (const [tool, cls] of Object.entries(toolClasses)) {
    if (!PERMISSION_CLASSES.has(cls)) {
      fail(`toolClasses.${tool}: "${cls}" is not a PermissionClass (${[...PERMISSION_CLASSES].join(", ")})`);
    }
  }

  const defaultClass = raw.defaultClass ?? "EXECUTE";
  if (!PERMISSION_CLASSES.has(defaultClass)) {
    fail(`defaultClass "${defaultClass}" is not a PermissionClass`);
  }

  const initiator = raw.initiator ?? "person";
  if (!INITIATORS.has(initiator)) {
    fail(`initiator "${initiator}" must be one of ${[...INITIATORS].join(", ")}`);
  }

  return {
    configPath: absConfig,
    upstream: {
      command: upstream.command,
      args: upstream.args ?? [],
      env: upstream.env ?? {},
      cwd: upstream.cwd ? rel(upstream.cwd) : undefined,
    },
    policyDoc,
    overlayDoc,
    toolClasses,
    defaultClass,
    auditFile: rel(raw.auditFile ?? "ghostguard-mcp-audit.jsonl"),
    approvalsFile: rel(raw.approvalsFile ?? "ghostguard-mcp-approvals.json"),
    actor: raw.actor ?? "mcp-client",
    projectId: raw.projectId ?? "ghostguard-mcp",
    initiator,
  };
}
