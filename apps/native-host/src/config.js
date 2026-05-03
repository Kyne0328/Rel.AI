const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_VERSION = 3;

function getRelAiDir() {
  return path.join(os.homedir(), ".rel-ai");
}

function getConfigPath() {
  return path.join(getRelAiDir(), "opencode.json");
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    opencodeCommand: "opencode",
    fallbackModel: "",
    fallbackAgent: "",
    defaultWorkspace: "default",
    timeoutMs: 15 * 60 * 1000,
    fallbackTimeoutMs: 4 * 60 * 1000,
    opencodeServerUrl: "http://127.0.0.1:4096",
    opencodeServerArgs: ["serve"],
    maxOutputBytes: 1024 * 1024,
    maxPromptChars: 120000,
    maxDiffChars: 500000,
    maxContextFiles: 25,
    maxFullRepoFiles: 500,
    maxContextChars: 120000,
    maxContextFileBytes: 80000,
    allowDirectTestCommands: false,
    workspaces: {}
  };
}

function ensureConfigDir() {
  fs.mkdirSync(getRelAiDir(), { recursive: true, mode: 0o700 });
}

function readConfig() {
  const file = getConfigPath();
  if (!fs.existsSync(file)) {
    return defaultConfig();
  }

  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error && error.message ? error.message : String(error)}`);
  }

  return normalizeConfig(parsed);
}

function writeConfig(config) {
  ensureConfigDir();
  const normalized = normalizeConfig(config);
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function normalizeConfig(config) {
  const base = defaultConfig();
  const candidate = config && typeof config === "object" ? config : {};
  const workspaces = candidate.workspaces && typeof candidate.workspaces === "object" && !Array.isArray(candidate.workspaces)
    ? candidate.workspaces
    : {};

  const normalizedWorkspaces = {};
  for (const [alias, entry] of Object.entries(workspaces)) {
    if (!isValidAlias(alias)) {
      continue;
    }
    const workspace = normalizeWorkspaceEntry(entry);
    if (workspace) {
      normalizedWorkspaces[alias] = workspace;
    }
  }

  return {
    version: CONFIG_VERSION,
    opencodeCommand: typeof candidate.opencodeCommand === "string" && candidate.opencodeCommand.trim()
      ? candidate.opencodeCommand.trim()
      : base.opencodeCommand,
    fallbackModel: typeof candidate.fallbackModel === "string" ? candidate.fallbackModel.trim() : base.fallbackModel,
    fallbackAgent: typeof candidate.fallbackAgent === "string" ? candidate.fallbackAgent.trim() : base.fallbackAgent,
    opencodeServerUrl: typeof candidate.opencodeServerUrl === "string" && candidate.opencodeServerUrl.trim()
      ? candidate.opencodeServerUrl.trim()
      : base.opencodeServerUrl,
    opencodeServerArgs: Array.isArray(candidate.opencodeServerArgs) && candidate.opencodeServerArgs.every((item) => typeof item === "string" && item.trim())
      ? candidate.opencodeServerArgs.map((item) => item.trim())
      : base.opencodeServerArgs,
    defaultWorkspace: typeof candidate.defaultWorkspace === "string" && isValidAlias(candidate.defaultWorkspace)
      ? candidate.defaultWorkspace
      : base.defaultWorkspace,
    timeoutMs: Number.isInteger(candidate.timeoutMs) && candidate.timeoutMs >= 10000
      ? candidate.timeoutMs
      : base.timeoutMs,
    fallbackTimeoutMs: Number.isInteger(candidate.fallbackTimeoutMs) && candidate.fallbackTimeoutMs >= 10000
      ? candidate.fallbackTimeoutMs
      : base.fallbackTimeoutMs,
    maxOutputBytes: Number.isInteger(candidate.maxOutputBytes) && candidate.maxOutputBytes >= 65536
      ? candidate.maxOutputBytes
      : base.maxOutputBytes,
    maxPromptChars: Number.isInteger(candidate.maxPromptChars) && candidate.maxPromptChars >= 1000
      ? candidate.maxPromptChars
      : base.maxPromptChars,
    maxDiffChars: Number.isInteger(candidate.maxDiffChars) && candidate.maxDiffChars >= 10000
      ? candidate.maxDiffChars
      : base.maxDiffChars,
    maxContextFiles: Number.isInteger(candidate.maxContextFiles) && candidate.maxContextFiles >= 1
      ? candidate.maxContextFiles
      : base.maxContextFiles,
    maxFullRepoFiles: Number.isInteger(candidate.maxFullRepoFiles) && candidate.maxFullRepoFiles >= 1
      ? candidate.maxFullRepoFiles
      : base.maxFullRepoFiles,
    maxContextChars: Number.isInteger(candidate.maxContextChars) && candidate.maxContextChars >= 1000
      ? candidate.maxContextChars
      : base.maxContextChars,
    maxContextFileBytes: Number.isInteger(candidate.maxContextFileBytes) && candidate.maxContextFileBytes >= 1000
      ? candidate.maxContextFileBytes
      : base.maxContextFileBytes,
    allowDirectTestCommands: Boolean(candidate.allowDirectTestCommands),
    workspaces: normalizedWorkspaces
  };
}

function normalizeWorkspaceEntry(entry) {
  if (typeof entry === "string" && entry.trim()) {
    return {
      path: path.resolve(expandHome(entry.trim())),
      testCommands: {}
    };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const workspacePath = typeof entry.path === "string" && entry.path.trim()
    ? path.resolve(expandHome(entry.path.trim()))
    : "";
  if (!workspacePath) {
    return null;
  }

  const testCommands = {};
  if (entry.testCommands && typeof entry.testCommands === "object" && !Array.isArray(entry.testCommands)) {
    for (const [key, command] of Object.entries(entry.testCommands)) {
      if (isValidAlias(key) && typeof command === "string" && command.trim()) {
        testCommands[key] = command.trim();
      }
    }
  }

  return {
    path: workspacePath,
    testCommands
  };
}

function isValidAlias(alias) {
  return typeof alias === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(alias);
}

function expandHome(input) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveWorkspace(config, requestedAlias) {
  const alias = requestedAlias || config.defaultWorkspace;
  if (!isValidAlias(alias)) {
    throw new Error("Invalid workspace alias.");
  }

  const entry = config.workspaces[alias];
  if (!entry || !entry.path) {
    const known = Object.keys(config.workspaces).sort();
    throw new Error(
      `Workspace alias '${alias}' is not configured. Add it with: npm run workspace:add -- ${alias} /absolute/path/to/project. Known aliases: ${known.length ? known.join(", ") : "none"}.`
    );
  }

  const real = fs.realpathSync(entry.path);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace alias '${alias}' does not point to a directory.`);
  }

  return {
    alias,
    path: real,
    testCommands: entry.testCommands || {}
  };
}

module.exports = {
  CONFIG_VERSION,
  getRelAiDir,
  getConfigPath,
  defaultConfig,
  ensureConfigDir,
  readConfig,
  writeConfig,
  normalizeConfig,
  isValidAlias,
  resolveWorkspace
};
