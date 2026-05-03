const PROTOCOL_VERSION = 7;
const APPLY_VERSION = 1;
const CONTEXT_VERSION = 1;
const MAX_CONTEXT_FILES = 50;
const MAX_CONTEXT_PATTERNS = 50;

function validateNativeMessage(value, config) {
  const candidate = requireObject(value, "Message must be a JSON object.");
  const type = requireString(candidate.type, "Message type must be a string.");

  if (candidate.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported Rel.AI protocol version. Expected ${PROTOCOL_VERSION}.`);
  }

  const requestId = requireString(candidate.requestId, "Message requestId must be a string.");
  if (requestId.length > 128) {
    throw new Error("Message requestId is too long.");
  }

  const source = optionalString(candidate.source, "Message source must be a string when provided.");

  if (type === "ping" || type === "relai.configSummary") {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ...(source ? { source } : {})
    };
  }

  if (type === "relai.apply") {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ...(source ? { source } : {}),
      apply: validateApplyRequest(candidate.apply, config)
    };
  }

  if (type === "relai.context") {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ...(source ? { source } : {}),
      context: validateContextRequest(candidate.context, config)
    };
  }

  if (type === "relai.listWorkspace") {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ...(source ? { source } : {}),
      workspace: validateWorkspaceAlias(candidate.workspace, "Workspace browser alias"),
      dir: validateOptionalRelativeDir(candidate.dir)
    };
  }

  if (type === "relai.opencodeServerStart" || type === "relai.opencodeServerStatus") {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ...(source ? { source } : {}),
      workspace: validateWorkspaceAlias(candidate.workspace, "OpenCode server workspace")
    };
  }

  throw new Error(`Unsupported message type: ${type}`);
}

function validateApplyRequest(value, config) {
  const candidate = requireObject(value, "Apply request must be a JSON object.");

  if (candidate.version !== APPLY_VERSION) {
    throw new Error(`Unsupported apply version. Expected ${APPLY_VERSION}.`);
  }

  const workspace = validateWorkspaceAlias(candidate.workspace, "Apply workspace");
  const trimmedDiff = normalizeDiff(candidate);
  if (!trimmedDiff) {
    throw new Error("Apply request must include a unified diff string.");
  }

  const maxDiffChars = config && Number.isInteger(config.maxDiffChars) ? config.maxDiffChars : 500000;
  if (trimmedDiff.length > maxDiffChars) {
    throw new Error(`Diff is too large. Limit is ${maxDiffChars} characters.`);
  }

  optionalString(candidate.title, "Apply title must be a string when provided.");
  const prompt = optionalString(candidate.prompt, "Apply prompt must be a string when provided.");
  const testCommandKey = optionalString(candidate.testCommandKey, "testCommandKey must be a string when provided.");
  if (testCommandKey !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(testCommandKey)) {
    throw new Error("testCommandKey must use letters, numbers, dots, underscores, or hyphens.");
  }

  const testCommand = optionalString(candidate.testCommand, "testCommand must be a string when provided.");
  const context = validatePathArray(candidate.context, "Context", MAX_CONTEXT_FILES);
  const fallback = validateFallback(candidate.fallback);
  const dryRun = candidate.dryRun === undefined ? false : Boolean(candidate.dryRun);
  const runTests = candidate.runTests === undefined ? Boolean(testCommandKey || testCommand) : Boolean(candidate.runTests);

  return {
    version: APPLY_VERSION,
    workspace,
    ...(prompt ? { prompt } : {}),
    diff: trimmedDiff,
    ...(testCommandKey ? { testCommandKey } : {}),
    ...(testCommand ? { testCommand } : {}),
    ...(context.length ? { context } : {}),
    fallback,
    dryRun,
    runTests
  };
}

function normalizeDiff(candidate) {
  if (typeof candidate.diff === "string" && candidate.diff.trim()) {
    return candidate.diff.trim();
  }
  if (Array.isArray(candidate.diffLines) && candidate.diffLines.length > 0) {
    return candidate.diffLines.map((line) => String(line)).join("\n").trim();
  }
  return "";
}

function validateContextRequest(value, config) {
  const candidate = requireObject(value, "Context request must be a JSON object.");

  if (candidate.version !== CONTEXT_VERSION) {
    throw new Error(`Unsupported context version. Expected ${CONTEXT_VERSION}.`);
  }

  const workspace = validateWorkspaceAlias(candidate.workspace, "Context workspace");
  optionalString(candidate.title, "Context title must be a string when provided.");
  const prompt = optionalString(candidate.prompt, "Context prompt must be a string when provided.");
  const include = validatePathArray(candidate.include, "include", MAX_CONTEXT_PATTERNS);
  const exclude = validatePathArray(candidate.exclude, "exclude", MAX_CONTEXT_PATTERNS);

  if (include.length === 0) {
    throw new Error("Context request must include at least one explicit file, directory, or safe glob. Entire workspace reads are blocked.");
  }

  const maxFiles = optionalPositiveInteger(candidate.maxFiles, "maxFiles must be a positive integer when provided.");
  const maxChars = optionalPositiveInteger(candidate.maxChars, "maxChars must be a positive integer when provided.");
  const contextMode = validateContextMode(candidate.contextMode || candidate.bundleMode);

  const hardMaxFiles = config && Number.isInteger(config.maxContextFiles) ? config.maxContextFiles : 25;
  const hardMaxChars = config && Number.isInteger(config.maxContextChars) ? config.maxContextChars : 120000;

  return {
    version: CONTEXT_VERSION,
    workspace,
    ...(prompt ? { prompt: prompt.slice(0, 8000) } : {}),
    include,
    contextMode,
    ...(exclude.length ? { exclude } : {}),
    maxFiles: Math.min(maxFiles || hardMaxFiles, hardMaxFiles),
    maxChars: Math.min(maxChars || hardMaxChars, hardMaxChars)
  };
}

function validateContextMode(value) {
  if (value === undefined || value === null || value === "") {
    return "readable";
  }
  const mode = requireString(value, "contextMode must be a string when provided.").trim().toLowerCase();
  if (["readable", "text"].includes(mode)) {
    return "readable";
  }
  if (["zip", "compressed", "archive"].includes(mode)) {
    return "zip";
  }
  throw new Error("contextMode must be 'readable' or 'zip'.");
}

function validateFallback(value) {
  const defaultFallback = {
    enabled: false,
    tool: "opencode",
    instructions: "If the patch or tests fail, make the smallest safe repair. Do not refactor unrelated code."
  };

  if (value === undefined || value === null) {
    return defaultFallback;
  }

  const candidate = requireObject(value, "Fallback must be an object when provided.");
  const enabled = candidate.enabled === undefined ? true : Boolean(candidate.enabled);
  const tool = optionalString(candidate.tool, "Fallback tool must be a string when provided.") || "opencode";
  if (tool !== "opencode") {
    throw new Error("Only opencode fallback is supported.");
  }

  const instructions = optionalString(candidate.instructions, "Fallback instructions must be a string when provided.")
    || defaultFallback.instructions;
  const model = optionalString(candidate.model, "Fallback model must be a string when provided.");
  const agent = optionalString(candidate.agent, "Fallback agent must be a string when provided.");

  return {
    enabled,
    tool,
    instructions: instructions.slice(0, 4000),
    ...(model ? { model: model.slice(0, 160) } : {}),
    ...(agent ? { agent: agent.slice(0, 80) } : {})
  };
}

function validatePathArray(value, label, limit) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of relative file paths or safe globs when provided.`);
  }
  if (value.length > limit) {
    throw new Error(`${label} contains too many entries. Limit is ${limit}.`);
  }
  return value.map((item, index) => validateRelativePathLike(item, `${label} entry ${index + 1}`));
}

function validateRelativePathLike(item, label) {
  const file = requireString(item, `${label} must be a string.`).trim().replace(/\\/g, "/");
  if (!file) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (file.length > 512) {
    throw new Error(`${label} is too long.`);
  }
  const safeProbe = file.replace(/\*\*/g, "safe").replace(/\*/g, "safe").replace(/\?/g, "s");
  if (safeProbe.startsWith("/") || safeProbe.startsWith("\\") || safeProbe.includes("..") || /^[A-Za-z]:[\/]/.test(safeProbe)) {
    throw new Error(`${label} must be relative and must not contain traversal.`);
  }
  return file.replace(/^\.\//, "");
}

function validateWorkspaceAlias(value, label) {
  const workspace = optionalString(value, `${label} must be a string when provided.`);
  if (workspace === undefined) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(workspace)) {
    throw new Error("Workspace must be an allowlisted alias using letters, numbers, dots, underscores, or hyphens.");
  }
  return workspace;
}

function validateOptionalRelativeDir(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return validateRelativePathLike(value, "Workspace browser dir").replace(/\/+$/g, "");
}

function optionalPositiveInteger(value, message) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(message);
  }
  return parsed;
}

function makeResponse(input) {
  return {
    ok: Boolean(input.ok),
    ...(input.type ? { type: input.type } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.dir !== undefined ? { dir: input.dir } : {}),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.entries ? { entries: input.entries } : {}),
    ...(input.workspaces ? { workspaces: input.workspaces } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.fallbackModel !== undefined ? { fallbackModel: input.fallbackModel } : {}),
    ...(input.fallbackAgent !== undefined ? { fallbackAgent: input.fallbackAgent } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
    ...(input.gitCheck ? { gitCheck: input.gitCheck } : {}),
    ...(input.gitApply ? { gitApply: input.gitApply } : {}),
    ...(input.test ? { test: input.test } : {}),
    ...(input.fallback ? { fallback: input.fallback } : {}),
    ...(input.fileCount !== undefined ? { fileCount: input.fileCount } : {}),
    ...(input.totalChars !== undefined ? { totalChars: input.totalChars } : {}),
    ...(input.contextMode ? { contextMode: input.contextMode } : {}),
    ...(input.archiveEncoding ? { archiveEncoding: input.archiveEncoding } : {}),
    ...(input.archiveName ? { archiveName: input.archiveName } : {}),
    ...(input.archivePath ? { archivePath: input.archivePath } : {}),
    ...(input.archiveMimeType ? { archiveMimeType: input.archiveMimeType } : {}),
    ...(input.archiveBase64 ? { archiveBase64: input.archiveBase64 } : {}),
    ...(input.archiveBase64Omitted !== undefined ? { archiveBase64Omitted: input.archiveBase64Omitted } : {}),
    ...(input.zipBytes !== undefined ? { zipBytes: input.zipBytes } : {}),
    ...(input.base64Chars !== undefined ? { base64Chars: input.base64Chars } : {}),
    ...(input.compressionRatio !== undefined ? { compressionRatio: input.compressionRatio } : {}),
    ...(input.nativeHost ? { nativeHost: input.nativeHost } : {}),
    ...(input.files ? { files: input.files } : {}),
    ...(input.skipped ? { skipped: input.skipped } : {}),
    ...(input.bundle ? { bundle: input.bundle } : {}),
    ...(input.opencodeServer ? { opencodeServer: input.opencodeServer } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.running !== undefined ? { running: input.running } : {}),
    ...(input.alreadyRunning !== undefined ? { alreadyRunning: input.alreadyRunning } : {}),
    ...(input.statusFile ? { statusFile: input.statusFile } : {}),
    ...(input.stdout ? { stdout: input.stdout } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {})
  };
}

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function requireString(value, message) {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function optionalString(value, message) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(message);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

module.exports = {
  PROTOCOL_VERSION,
  APPLY_VERSION,
  CONTEXT_VERSION,
  validateNativeMessage,
  validateApplyRequest,
  validateContextRequest,
  makeResponse
};
