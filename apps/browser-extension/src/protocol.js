(function attachRelAiProtocol(globalThis) {
  const PROTOCOL_VERSION = 7;
  const APPLY_VERSION = 1;
  const CONTEXT_VERSION = 1;
  const MAX_DIFF_CHARS = 500000;
  const MAX_CONTEXT_PATTERNS = 50;
  const APPLY_META_FENCE_RE = /```(?:rel-ai-apply|relai-apply|rel-ai-patch)\s*([\s\S]*?)```/gi;
  const DIFF_FENCE_RE = /```(?:diff|rel-ai-diff|relai-diff)\s*([\s\S]*?)```/gi;
  const APPLY_FENCE_RE = /```(?:rel-ai-apply|relai-apply|rel-ai-diff|relai-diff|rel-ai-patch|diff|json)\s*([\s\S]*?)```/gi;
  const CONTEXT_FENCE_RE = /```(?:rel-ai-context|relai-context|rel-ai-source|relai-source|json)\s*([\s\S]*?)```/gi;

  function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `relai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function extractJsonPayload(input, fenceRe, emptyMessage) {
    const text = String(input || "").trim();
    if (!text) {
      throw new Error(emptyMessage);
    }

    const matches = [...text.matchAll(fenceRe)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1].trim();
    }

    if (text.startsWith("{") && text.endsWith("}")) {
      return text;
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1).trim();
    }

    throw new Error("No JSON payload found.");
  }

  function parseApplyFromText(input) {
    const text = String(input || "").trim();
    if (!text) {
      throw new Error("No patch text provided.");
    }

    const compound = parseCompoundApply(text);
    if (compound) {
      return validateApply(compound);
    }

    const payload = extractApplyPayload(text);
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Invalid apply JSON: ${error && error.message ? error.message : String(error)}. Use the Phase 0.9 format: a JSON rel-ai-apply metadata block followed by a separate fenced diff block.`);
    }
    return validateApply(parsed);
  }

  function parseCompoundApply(text) {
    const metaMatches = [...text.matchAll(APPLY_META_FENCE_RE)];
    if (metaMatches.length === 0) {
      return null;
    }

    const metaMatch = metaMatches[metaMatches.length - 1];
    const metaText = metaMatch[1].trim();
    if (!metaText.startsWith("{")) {
      return null;
    }

    let metadata;
    try {
      metadata = JSON.parse(metaText);
    } catch (_error) {
      return null;
    }

    if (metadata && typeof metadata.diff === "string" && metadata.diff.trim()) {
      return metadata;
    }

    if (Array.isArray(metadata.diffLines) && metadata.diffLines.length > 0) {
      return { ...metadata, diff: metadata.diffLines.join("\n") };
    }

    const rest = text.slice(metaMatch.index + metaMatch[0].length);
    const diff = extractDiffFromText(rest) || extractDiffFromText(text);
    if (!diff) {
      return null;
    }
    return { ...metadata, diff };
  }

  function extractApplyPayload(input) {
    const text = String(input || "").trim();
    const matches = [...text.matchAll(APPLY_FENCE_RE)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      const langMatch = last[0].match(/^```([^\s]*)/);
      const lang = langMatch ? langMatch[1].toLowerCase() : "";
      const body = last[1].trim();
      if (isDiffLanguage(lang) || looksLikeRawDiff(body)) {
        return JSON.stringify({ version: APPLY_VERSION, diff: body });
      }
      return body;
    }

    if (text.startsWith("{") && text.endsWith("}")) {
      return text;
    }

    if (looksLikeRawDiff(text)) {
      return JSON.stringify({ version: APPLY_VERSION, diff: text });
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1).trim();
    }

    throw new Error("No rel-ai-apply metadata block, JSON object, or unified diff found.");
  }

  function extractDiffFromText(text) {
    const diffMatches = [...String(text || "").matchAll(DIFF_FENCE_RE)];
    if (diffMatches.length > 0) {
      return diffMatches[diffMatches.length - 1][1].trim();
    }

    const raw = String(text || "");
    const diffIndex = raw.indexOf("diff --git ");
    if (diffIndex !== -1) {
      return raw.slice(diffIndex).trim();
    }

    const simpleIndex = raw.indexOf("--- a/");
    if (simpleIndex !== -1) {
      return raw.slice(simpleIndex).trim();
    }

    return "";
  }

  function isDiffLanguage(lang) {
    return ["diff", "rel-ai-diff", "relai-diff"].includes(String(lang || "").toLowerCase());
  }

  function looksLikeRawDiff(text) {
    const raw = String(text || "").trim();
    return raw.startsWith("diff --git ") || raw.startsWith("--- a/") || raw.startsWith("--- ");
  }

  function parseContextFromText(input) {
    const payload = extractJsonPayload(input, CONTEXT_FENCE_RE, "No context request text provided.");
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Invalid context JSON: ${error && error.message ? error.message : String(error)}`);
    }
    return validateContextRequest(parsed);
  }

  function validateApply(value) {
    const candidate = requireObject(value, "Apply block must be a JSON object.");
    if (candidate.version !== APPLY_VERSION) {
      throw new Error(`Unsupported apply version. Expected ${APPLY_VERSION}.`);
    }

    const workspace = validateWorkspaceAlias(candidate.workspace, "workspace");
    const diff = normalizeDiff(candidate);
    if (!diff) {
      throw new Error("Apply block must include a unified diff string or a separate fenced diff block.");
    }
    if (diff.length > MAX_DIFF_CHARS) {
      throw new Error(`diff is too large. Limit is ${MAX_DIFF_CHARS} characters.`);
    }

    optionalString(candidate.title, "title must be a string when provided.");
    const prompt = optionalString(candidate.prompt, "prompt must be a string when provided.");
    const testCommandKey = optionalString(candidate.testCommandKey, "testCommandKey must be a string when provided.");
    const testCommand = optionalString(candidate.testCommand, "testCommand must be a string when provided.");
    const context = validatePathArray(candidate.context, "context", 50);
    const fallback = validateFallback(candidate.fallback);
    const dryRun = candidate.dryRun === undefined ? false : Boolean(candidate.dryRun);
    const runTests = candidate.runTests === undefined ? Boolean(testCommandKey || testCommand) : Boolean(candidate.runTests);

    return {
      version: APPLY_VERSION,
      ...(workspace ? { workspace } : {}),
      ...(prompt ? { prompt } : {}),
      diff,
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
    if (Array.isArray(candidate.diffLines)) {
      return candidate.diffLines.map((line) => String(line)).join("\n").trim();
    }
    return "";
  }

  function validateContextRequest(value) {
    const candidate = requireObject(value, "Context block must be a JSON object.");
    if (candidate.version !== CONTEXT_VERSION) {
      throw new Error(`Unsupported context version. Expected ${CONTEXT_VERSION}.`);
    }

    const workspace = validateWorkspaceAlias(candidate.workspace, "workspace");
    optionalString(candidate.title, "title must be a string when provided.");
    const prompt = optionalString(candidate.prompt, "prompt must be a string when provided.");
    const include = validatePathArray(candidate.include, "include", MAX_CONTEXT_PATTERNS);
    const exclude = validatePathArray(candidate.exclude, "exclude", MAX_CONTEXT_PATTERNS);
    const contextScope = validateContextScope(candidate.contextScope || candidate.scope);
    if (include.length === 0 && contextScope !== "full") {
      throw new Error("include must contain at least one file, directory, or safe glob unless contextScope is 'full'.");
    }

    const maxFiles = optionalPositiveInteger(candidate.maxFiles, "maxFiles must be a positive integer when provided.");
    const maxChars = optionalPositiveInteger(candidate.maxChars, "maxChars must be a positive integer when provided.");
    const contextMode = contextScope === "full" ? "zip" : validateContextMode(candidate.contextMode || candidate.bundleMode);

    return {
      version: CONTEXT_VERSION,
      ...(workspace ? { workspace } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 8000) } : {}),
      include,
      contextMode,
      contextScope,
      ...(exclude.length ? { exclude } : {}),
      ...(maxFiles ? { maxFiles } : {}),
      ...(maxChars ? { maxChars } : {})
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

  function validateContextScope(value) {
    if (value === undefined || value === null || value === "") {
      return "focused";
    }
    const scope = requireString(value, "contextScope must be a string when provided.").trim().toLowerCase();
    if (["focused", "selected", "full"].includes(scope)) {
      return scope;
    }
    throw new Error("contextScope must be 'focused', 'selected', or 'full'.");
  }

function validateFallback(value) {
    if (value === undefined || value === null) {
      return {
        enabled: false,
        tool: "opencode",
        instructions: "If the patch or tests fail, make the smallest safe repair. Do not refactor unrelated code."
      };
    }
    const candidate = requireObject(value, "fallback must be an object when provided.");
    const enabled = candidate.enabled === undefined ? true : Boolean(candidate.enabled);
    const tool = optionalString(candidate.tool, "fallback.tool must be a string when provided.") || "opencode";
    if (tool !== "opencode") {
      throw new Error("Only opencode fallback is supported.");
    }
    const instructions = optionalString(candidate.instructions, "fallback.instructions must be a string when provided.") || "If needed, make the smallest safe repair.";
    const model = optionalString(candidate.model, "fallback.model must be a string when provided.");
    const agent = optionalString(candidate.agent, "fallback.agent must be a string when provided.");
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
    if (workspace !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(workspace)) {
      throw new Error("workspace must be an allowlisted alias using letters, numbers, dots, underscores, or hyphens.");
    }
    return workspace;
  }

  function makeApplyMessage(apply, source) {
    return {
      type: "relai.apply",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: source || "browser",
      apply
    };
  }

  function makeContextMessage(context, source) {
    return {
      type: "relai.context",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: source || "browser",
      context
    };
  }

  function makeListWorkspaceMessage(workspace, dir) {
    return {
      type: "relai.listWorkspace",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: "browser",
      workspace,
      dir: dir || ""
    };
  }

  function makeOpenCodeServerStartMessage(workspace) {
    return {
      type: "relai.opencodeServerStart",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: "browser",
      workspace
    };
  }

  function makeOpenCodeServerStatusMessage(workspace) {
    return {
      type: "relai.opencodeServerStatus",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: "browser",
      workspace
    };
  }

  function makePingMessage() {
    return {
      type: "ping",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: "browser"
    };
  }

  function makeConfigSummaryMessage() {
    return {
      type: "relai.configSummary",
      protocolVersion: PROTOCOL_VERSION,
      requestId: uuid(),
      source: "browser"
    };
  }

  function looksLikeApply(text) {
    const raw = String(text || "");
    return /```(?:rel-ai-apply|relai-apply|rel-ai-diff|relai-diff|rel-ai-patch|diff|json)/i.test(raw)
      || (/'?"?version'?"?\s*:\s*1/.test(raw) && /"diff"\s*:/.test(raw))
      || looksLikeRawDiff(raw);
  }

  function looksLikeContext(text) {
    const raw = String(text || "");
    return /```(?:rel-ai-context|relai-context|rel-ai-source|relai-source)/i.test(raw)
      || (/'?"?version'?"?\s*:\s*1/.test(raw) && /"include"\s*:/.test(raw));
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
    return value.trim() || undefined;
  }

  globalThis.RelAiProtocol = {
    PROTOCOL_VERSION,
    APPLY_VERSION,
    CONTEXT_VERSION,
    parseApplyFromText,
    parseContextFromText,
    validateApply,
    validateContextRequest,
    validateRelativePathLike,
    makeApplyMessage,
    makeContextMessage,
    makeListWorkspaceMessage,
    makeOpenCodeServerStartMessage,
    makeOpenCodeServerStatusMessage,
    makePingMessage,
    makeConfigSummaryMessage,
    looksLikeApply,
    looksLikeContext
  };
})(self);
