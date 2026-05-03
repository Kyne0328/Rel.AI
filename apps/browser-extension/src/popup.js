const statusEl = document.getElementById("status");
const manualEl = document.getElementById("manual");
const contextManualEl = document.getElementById("contextManual");
const inlineButtonsEl = document.getElementById("inlineButtons");
const workspaceEl = document.getElementById("workspace");
const workspaceManualEl = document.getElementById("workspaceManual");
const taskPromptEl = document.getElementById("taskPrompt");
const geminiModelEl = document.getElementById("geminiModel");
const geminiApiKeyEl = document.getElementById("geminiApiKey");
const geminiInfoEl = document.getElementById("geminiInfo");
const responseModeEl = document.getElementById("responseMode");
const includePathsEl = document.getElementById("includePaths");
const excludePathsEl = document.getElementById("excludePaths");
const maxFilesEl = document.getElementById("maxFiles");
const maxCharsEl = document.getElementById("maxChars");
const contextScopeEl = document.getElementById("contextScope");
const contextModeEl = document.getElementById("contextMode");
const testCommandKeyEl = document.getElementById("testCommandKey");
const testCommandManualEl = document.getElementById("testCommandManual");
const fallbackEnabledEl = document.getElementById("fallbackEnabled");
const autoSubmitEl = document.getElementById("autoSubmit");
const browseWorkspaceEl = document.getElementById("browseWorkspace");
const pickerUpEl = document.getElementById("pickerUp");
const pickerRefreshEl = document.getElementById("pickerRefresh");
const pickerPathEl = document.getElementById("pickerPath");
const pickerListEl = document.getElementById("pickerList");
const archiveFallbackEl = document.getElementById("archiveFallback");
const archiveFallbackTextEl = document.getElementById("archiveFallbackText");
const archivePathTextEl = document.getElementById("archivePathText");
const downloadArchiveEl = document.getElementById("downloadArchive");
const copyArchivePathEl = document.getElementById("copyArchivePath");
const debugLogEl = document.getElementById("debugLog");
const debugCardEl = document.getElementById("debugCard");
const opencodeServerInfoEl = document.getElementById("opencodeServerInfo");

let configSummary = null;
let pickerDir = "";
let lastArchive = null;
let debugVisible = false;
let debugRefreshTimer = null;

bind("ping", () => sendMessage({ type: "relai.ping" }));
bind("loadConfig", () => loadConfig(true));
bind("composeRequest", () => composeRequest());
bind("sendLatest", () => sendMessage({ type: "relai.applyFromActiveTab", mode: "latest" }));
bind("sendSelected", () => sendMessage({ type: "relai.applyFromActiveTab", mode: "selection" }));
bind("contextLatest", () => sendMessage({ type: "relai.contextFromActiveTab", mode: "latest" }));
bind("contextSelected", () => sendMessage({ type: "relai.contextFromActiveTab", mode: "selection" }));
bind("scan", () => sendMessage({ type: "relai.scanActiveTab" }));
bind("sendManual", () => sendMessage({ type: "relai.applyManual", text: manualEl.value }));
bind("sendContextManual", () => sendMessage({ type: "relai.contextManual", text: contextManualEl.value }));
bind("browseWorkspace", () => loadWorkspaceDir(""));
bind("pickerRefresh", () => loadWorkspaceDir(pickerDir));
bind("pickerUp", () => loadWorkspaceDir(parentDir(pickerDir)));
bind("downloadArchive", () => downloadLastArchive());
bind("copyArchivePath", () => copyLastArchivePath());
bind("copyDebugLog", () => copyDebugLog());
bind("clearDebugLog", () => clearDebugLog());
bind("opencodeServerStart", () => opencodeServerStart());
bind("opencodeServerStatus", () => opencodeServerStatus());
bind("opencodeServerOpen", () => opencodeServerOpen());
bind("saveGeminiSettings", () => saveGeminiSettings());
bind("improvePrompt", () => improvePromptWithGemini());


document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    setDebugVisible(!debugVisible, true);
  }
});

inlineButtonsEl.addEventListener("change", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "relai.setInlineButtonsEnabled",
    enabled: inlineButtonsEl.checked
  });
  renderResponse(response);
});

workspaceEl.addEventListener("change", () => {
  if (workspaceEl.value) {
    workspaceManualEl.value = workspaceEl.value;
    pickerDir = "";
    populateTestCommandOptions();
    saveDraft();
  }
});

testCommandKeyEl.addEventListener("change", () => {
  if (testCommandKeyEl.value) {
    testCommandManualEl.value = testCommandKeyEl.value;
    saveDraft();
  }
});

if (contextScopeEl) {
  contextScopeEl.addEventListener("change", () => {
    if (contextScopeEl.value === "full") {
      contextModeEl.value = "zip";
      const currentMaxFiles = positiveInteger(maxFilesEl.value) || 0;
      if (currentMaxFiles < 200) {
        maxFilesEl.value = "300";
      }
    }
    saveDraft();
  });
}

for (const el of [workspaceManualEl, taskPromptEl, geminiModelEl, responseModeEl, includePathsEl, excludePathsEl, maxFilesEl, maxCharsEl, contextScopeEl, contextModeEl, testCommandManualEl, fallbackEnabledEl, autoSubmitEl].filter(Boolean)) {
  el.addEventListener("change", saveDraft);
  el.addEventListener("input", debounce(saveDraft, 300));
}

init();

async function init() {
  chrome.runtime.sendMessage({ type: "relai.getSettings" }, (response) => {
    if (response && response.ok && response.settings) {
      inlineButtonsEl.checked = Boolean(response.settings.inlineButtonsEnabled);
    }
  });

  const stored = await chrome.storage.local.get({ relaiComposeDraft: null, relaiDebugVisible: false });
  if (stored && stored.relaiComposeDraft) {
    restoreDraft(stored.relaiComposeDraft);
  }

  setDebugVisible(Boolean(stored && stored.relaiDebugVisible), false);
  hideArchiveFallback();
  await loadConfig(false);
}

function setDebugVisible(visible, persist) {
  debugVisible = Boolean(visible);
  document.body.classList.toggle("debug-enabled", debugVisible);

  if (persist) {
    chrome.storage.local.set({ relaiDebugVisible: debugVisible }).catch(() => {});
  }

  chrome.runtime.sendMessage({ type: "relai.setDebugLogging", enabled: debugVisible }).catch(() => {});

  if (debugVisible) {
    refreshDebugLog(true).catch(() => {});
    if (!debugRefreshTimer) {
      debugRefreshTimer = window.setInterval(() => refreshDebugLog(false).catch(() => {}), 2500);
    }
  } else if (debugRefreshTimer) {
    window.clearInterval(debugRefreshTimer);
    debugRefreshTimer = null;
  }
}

async function loadConfig(showResult) {
  const response = await sendMessage({ type: "relai.getConfigSummary" });
  if (!response || !response.ok) {
    if (showResult) {
      renderResponse(response);
    }
    return response;
  }

  configSummary = response;
  populateWorkspaceOptions(response.workspaces || []);
  populateTestCommandOptions();
  renderGeminiStatus(response);

  if (showResult) {
    setStatus(`Loaded ${response.workspaces ? response.workspaces.length : 0} workspace alias(es).`);
  }

  return response;
}

async function loadWorkspaceDir(dir) {
  const workspace = clean(workspaceManualEl.value || workspaceEl.value);
  if (!workspace) {
    throw new Error("Choose a workspace alias before browsing.");
  }

  const response = await sendMessage({
    type: "relai.listWorkspace",
    workspace,
    dir: dir || ""
  });

  if (!response || !response.ok) {
    renderWorkspaceList(response);
    return response;
  }

  pickerDir = response.dir || "";
  renderWorkspaceList(response);
  return response;
}

async function composeRequest() {
  const workspace = clean(workspaceManualEl.value || workspaceEl.value);
  const prompt = clean(taskPromptEl.value);
  const responseMode = clean(responseModeEl && responseModeEl.value) || "apply";
  const include = lines(includePathsEl.value);
  const exclude = lines(excludePathsEl.value);
  const testCommandKey = clean(testCommandManualEl.value || testCommandKeyEl.value);
  const maxFiles = positiveInteger(maxFilesEl.value);
  const maxChars = positiveInteger(maxCharsEl.value);
  const contextScope = clean(contextScopeEl && contextScopeEl.value) || "focused";
  const contextMode = contextScope === "full" ? "zip" : (clean(contextModeEl.value) || "readable");

  dashboardLog("compose.validate.start", {
    workspace,
    promptLength: prompt.length,
    responseMode,
    contextScope,
    includeCount: include.length,
    excludeCount: exclude.length,
    testCommandKey,
    maxFiles,
    maxChars,
    contextMode
  });

  if (!workspace) {
    dashboardLog("compose.validate.fail", { reason: "missing_workspace" });
    throw new Error("Choose or type a workspace alias first.");
  }
  if (!prompt) {
    dashboardLog("compose.validate.fail", { reason: "missing_prompt" });
    throw new Error("Type what you want ChatGPT to do.");
  }
  if (include.length === 0 && contextScope !== "full") {
    dashboardLog("compose.validate.fail", { reason: "missing_include_paths" });
    throw new Error("Choose at least one allowed file, folder, or glob, or switch Context scope to Full repo archive.");
  }

  const contextRequest = {
    version: 1,
    workspace,
    prompt,
    include,
    ...(exclude.length ? { exclude } : {}),
    ...(maxFiles ? { maxFiles } : {}),
    ...(maxChars ? { maxChars } : {}),
    contextMode,
    contextScope
  };

  await saveDraft();

  dashboardLog("compose.send", {
    workspace,
    contextMode,
    contextScope,
    includeCount: include.length,
    excludeCount: exclude.length,
    fallbackEnabled: Boolean(fallbackEnabledEl.checked),
    responseMode,
    autoSubmit: Boolean(autoSubmitEl.checked)
  });

  return sendMessage({
    type: "relai.composeChatGPTRequest",
    context: contextRequest,
    task: {
      prompt,
      testCommandKey,
      fallbackEnabled: fallbackEnabledEl.checked,
      responseMode
    },
    autoSubmit: autoSubmitEl.checked
  });
}


async function saveGeminiSettings() {
  const model = clean(geminiModelEl && geminiModelEl.value);
  const apiKey = clean(geminiApiKeyEl && geminiApiKeyEl.value);
  const response = await sendMessage({
    type: "relai.saveGeminiSettings",
    gemini: {
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {})
    }
  });
  if (response && response.ok && geminiApiKeyEl) {
    geminiApiKeyEl.value = "";
  }
  renderGeminiStatus(response);
  if (response && response.ok) {
    await loadConfig(false).catch(() => {});
  }
  return response;
}

async function improvePromptWithGemini() {
  const prompt = clean(taskPromptEl.value);
  if (!prompt) {
    throw new Error("Type a task before improving it with Gemini.");
  }

  const workspace = clean(workspaceManualEl.value || workspaceEl.value);
  const response = await sendMessage({
    type: "relai.improvePrompt",
    promptRequest: {
      prompt,
      ...(workspace ? { workspace } : {}),
      responseMode: clean(responseModeEl && responseModeEl.value) || "apply",
      contextScope: clean(contextScopeEl && contextScopeEl.value) || "focused",
      contextMode: clean(contextModeEl && contextModeEl.value) || "readable",
      include: lines(includePathsEl.value),
      exclude: lines(excludePathsEl.value)
    }
  });

  if (response && response.ok && response.improvedPrompt) {
    taskPromptEl.value = response.improvedPrompt;
    await saveDraft();
  }
  renderGeminiStatus(response);
  return response;
}

function renderGeminiStatus(response) {
  if (!geminiInfoEl) return;
  if (!response) {
    geminiInfoEl.textContent = "Gemini not checked.";
    return;
  }
  const model = response.geminiModel || (configSummary && configSummary.geminiModel) || "gemini-2.5-flash";
  const configured = response.geminiConfigured !== undefined
    ? Boolean(response.geminiConfigured)
    : Boolean(configSummary && configSummary.geminiConfigured);
  if (geminiModelEl && !geminiModelEl.value) {
    geminiModelEl.value = model;
  }
  geminiInfoEl.textContent = configured
    ? `Gemini configured. Model: ${model}`
    : `Gemini API key not configured. Model: ${model}`;
}

function getSelectedWorkspaceAlias() {
  return clean(workspaceManualEl.value || workspaceEl.value);
}

async function opencodeServerStart() {
  const workspace = getSelectedWorkspaceAlias();
  if (!workspace) {
    throw new Error("Choose a workspace alias before starting OpenCode server.");
  }
  return sendMessage({ type: "relai.opencodeServerStart", workspace });
}

async function opencodeServerStatus() {
  const workspace = getSelectedWorkspaceAlias();
  if (!workspace) {
    throw new Error("Choose a workspace alias before checking OpenCode server status.");
  }
  return sendMessage({ type: "relai.opencodeServerStatus", workspace });
}

async function opencodeServerOpen() {
  const status = await opencodeServerStatus();
  if (!status || !status.ok || !status.url) {
    return status || { ok: false, error: "OpenCode server URL is unavailable." };
  }
  const opened = await sendMessage({ type: "relai.openUrl", url: status.url });
  return opened && opened.ok ? { ...status, message: `Opened OpenCode server at ${status.url}.` } : opened;
}

function populateWorkspaceOptions(workspaces) {
  const current = clean(workspaceManualEl.value || workspaceEl.value);
  workspaceEl.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = workspaces.length ? "Choose workspace" : "No workspaces configured";
  workspaceEl.appendChild(empty);

  for (const workspace of workspaces) {
    const option = document.createElement("option");
    option.value = workspace.alias;
    option.textContent = `${workspace.alias} - ${workspace.path}`;
    workspaceEl.appendChild(option);
  }

  if (current) {
    workspaceManualEl.value = current;
    const match = [...workspaceEl.options].find((option) => option.value === current);
    if (match) {
      workspaceEl.value = current;
    }
  }
}

function populateTestCommandOptions() {
  const currentWorkspace = clean(workspaceManualEl.value || workspaceEl.value);
  const current = clean(testCommandManualEl.value || testCommandKeyEl.value);
  const workspace = configSummary && Array.isArray(configSummary.workspaces)
    ? configSummary.workspaces.find((item) => item.alias === currentWorkspace)
    : null;
  const commands = workspace && Array.isArray(workspace.testCommands) ? workspace.testCommands : [];

  testCommandKeyEl.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = commands.length ? "No test command" : "No configured test commands";
  testCommandKeyEl.appendChild(empty);

  for (const command of commands) {
    const option = document.createElement("option");
    option.value = command.key;
    option.textContent = `${command.key} - ${command.command}`;
    testCommandKeyEl.appendChild(option);
  }

  if (current) {
    testCommandManualEl.value = current;
    const match = [...testCommandKeyEl.options].find((option) => option.value === current);
    if (match) {
      testCommandKeyEl.value = current;
    }
  }
}

function renderWorkspaceList(response) {
  pickerListEl.innerHTML = "";
  if (!response || !response.ok) {
    pickerPathEl.textContent = pickerDir ? `/${pickerDir}` : "/";
    const error = document.createElement("div");
    error.className = "picker-muted";
    error.textContent = response && response.error ? response.error : "Could not load workspace entries.";
    pickerListEl.appendChild(error);
    return;
  }

  pickerPathEl.textContent = response.dir ? `/${response.dir}` : "/";
  const entries = Array.isArray(response.entries) ? response.entries : [];
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "picker-muted";
    empty.textContent = "No visible files or folders here.";
    pickerListEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "picker-row";

    const name = document.createElement("span");
    name.className = "picker-name";
    name.textContent = `${entry.type === "directory" ? "[dir]" : "[file]"} ${entry.name}`;
    name.title = entry.path;

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = entry.type === "directory" ? "Add folder" : "Add file";
    add.addEventListener("click", () => appendIncludePath(entry.path));

    if (entry.type === "directory") {
      name.addEventListener("click", () => loadWorkspaceDir(entry.path));
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open";
      open.addEventListener("click", () => loadWorkspaceDir(entry.path));
      row.append(name, open, add);
    } else {
      row.append(name, add);
    }

    pickerListEl.appendChild(row);
  }
}

function appendIncludePath(path) {
  const item = clean(path);
  if (!item) {
    return;
  }
  const existing = lines(includePathsEl.value);
  if (!existing.includes(item)) {
    existing.push(item);
    includePathsEl.value = existing.join("\n");
    saveDraft();
  }
}

function parentDir(dir) {
  const cleanDir = clean(dir).replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!cleanDir) {
    return "";
  }
  const parts = cleanDir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function dashboardLog(stage, details) {
  const payload = {
    type: "relai.dashboardLog",
    stage: `dashboard.${stage}`,
    details: details || {}
  };
  try { console.log("[Rel.AI Dashboard]", payload.stage, payload.details); } catch (_error) {}
  try {
    chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; });
  } catch (_error) {}
}

function summarizeDashboardState() {
  return {
    workspaceSelect: clean(workspaceEl && workspaceEl.value),
    workspaceManual: clean(workspaceManualEl && workspaceManualEl.value),
    promptLength: String(taskPromptEl && taskPromptEl.value || "").length,
    responseMode: clean(responseModeEl && responseModeEl.value) || "apply",
    includeCount: lines(includePathsEl && includePathsEl.value || "").length,
    excludeCount: lines(excludePathsEl && excludePathsEl.value || "").length,
    contextMode: clean(contextModeEl && contextModeEl.value),
    contextScope: clean(contextScopeEl && contextScopeEl.value),
    maxFiles: maxFilesEl && maxFilesEl.value,
    maxChars: maxCharsEl && maxCharsEl.value,
    testCommandKey: clean(testCommandManualEl && testCommandManualEl.value || testCommandKeyEl && testCommandKeyEl.value),
    fallbackEnabled: Boolean(fallbackEnabledEl && fallbackEnabledEl.checked),
    autoSubmit: Boolean(autoSubmitEl && autoSubmitEl.checked)
  };
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (!el) {
    dashboardLog("bind.missingElement", { id });
    return;
  }
  dashboardLog("bind.attached", { id });
  el.addEventListener("click", async () => {
    dashboardLog("button.clicked", { id, state: summarizeDashboardState() });
    el.disabled = true;
    setStatus("Preparing request...");
    try {
      const response = await fn();
      dashboardLog("button.response", { id, ok: Boolean(response && response.ok), type: response && response.type, error: response && response.error });
      renderResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dashboardLog("button.error", { id, error: message, state: summarizeDashboardState() });
      setStatus(message, true);
    } finally {
      el.disabled = false;
      dashboardLog("button.finished", { id });
    }
  });
}

function sendMessage(message) {
  try { console.log("[Rel.AI Dashboard] sending", message && message.type, message); } catch (_error) {}
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ ok: false, error: lastError.message || "Rel.AI extension background is not reachable. Reload the extension and refresh ChatGPT." });
        return;
      }
      try { console.log("[Rel.AI Dashboard] response", message && message.type, response); } catch (_error) {}
      if (debugVisible) refreshDebugLog(false).catch(() => {});
      resolve(response || { ok: false, error: "No response from Rel.AI background service worker." });
    });
  });
}

async function refreshDebugLog(force) {
  if (!debugLogEl || (!force && !debugVisible)) return;
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "relai.getDebugLog" }, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ ok: false, error: lastError.message });
        return;
      }
      resolve(result);
    });
  });
  if (!response || !response.ok) {
    debugLogEl.textContent = response && response.error ? `Could not load debug log: ${response.error}` : "Could not load debug log.";
    return;
  }
  const events = Array.isArray(response.events) ? response.events : [];
  debugLogEl.textContent = events.length
    ? events.map((event) => `${event.time} ${event.stage} ${JSON.stringify(event.details)}`).join("\n")
    : "No debug events yet.";
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

async function copyDebugLog() {
  await refreshDebugLog(true);
  const text = debugLogEl ? debugLogEl.textContent || "" : "";
  await navigator.clipboard.writeText(text);
  return { ok: true, message: "Copied Rel.AI debug log to clipboard." };
}

async function clearDebugLog() {
  const response = await sendMessage({ type: "relai.clearDebugLog" });
  await refreshDebugLog(true);
  return response && response.ok ? { ok: true, message: "Cleared Rel.AI debug log." } : response;
}

function renderResponse(response) {
  if (debugVisible) refreshDebugLog(false).catch(() => {});
  if (!response || !response.ok) {
    setStatus(response && response.error ? response.error : "Rel.AI request failed.", true);
    return;
  }

  if (response.type === "ping") {
    setStatus(response.message || "Bridge is available.");
    return;
  }

  if (response.type === "relai.config") {
    renderGeminiStatus(response);
    setStatus(`Loaded ${response.workspaces ? response.workspaces.length : 0} workspace alias(es).`);
    return;
  }

  if (response.type === "relai.geminiConfig" || response.type === "relai.geminiPrompt") {
    renderGeminiStatus(response);
    setStatus(response.message || (response.type === "relai.geminiPrompt" ? "Improved task prompt with Gemini." : "Saved Gemini settings."));
    return;
  }

  if (response.type === "relai.workspaceList") {
    setStatus(`Loaded ${response.entries ? response.entries.length : 0} item(s).`);
    return;
  }

  if (response.type === "relai.opencodeServer") {
    renderOpenCodeServerInfo(response);
    setStatus(response.message || (response.running ? "OpenCode server is running." : "OpenCode server is not running."), !response.ok);
    return;
  }

  if (response.type === "relai.chatgptRequest") {
    const mode = response.contextMode === "zip" ? "ZIP attachment" : "readable context";
    const size = response.contextMode === "zip" && response.zipBytes ? `, zip ${response.zipBytes} bytes` : "";
    const upload = response.contextMode === "zip" ? (response.archiveUploaded ? `, uploaded ${response.archiveName || "rel-ai-context.zip"}` : `, ZIP attachment not confirmed${response.uploadError ? `: ${response.uploadError}` : ""}`) : "";

    if (response.contextMode === "zip" && !response.archiveUploaded && response.archiveBase64) {
      showArchiveFallback(response);
    } else {
      hideArchiveFallback();
    }

    if (response.inserted) {
      setStatus(response.submitted ? `Sent ${mode} request with ${response.fileCount || 0} file(s)${size}${upload} to ChatGPT.` : `Inserted ${mode} request with ${response.fileCount || 0} file(s)${size}${upload}. Review and send.`);
    } else {
      setStatus(`Built ${mode} request with ${response.fileCount || 0} file(s), but composer insert/upload failed.`, true);
    }
    return;
  }

  if (response.type === "relai.context") {
    if (response.inserted) {
      setStatus(`Inserted ${response.fileCount || 0} file(s) into ChatGPT.`);
    } else {
      setStatus(`Loaded ${response.fileCount || 0} file(s), but composer insert failed.`, true);
    }
    return;
  }

  if (response.dryRun) {
    setStatus("Dry run passed. No files changed.");
    return;
  }

  if (response.fallback) {
    const details = [];
    if (response.fallback.status) details.push(`status: ${response.fallback.status}`);
    if (response.fallback.exitCode !== undefined) details.push(`exit: ${response.fallback.exitCode}`);
    if (response.fallback.signal) details.push(`signal: ${response.fallback.signal}`);
    if (response.fallback.timedOut) details.push(`timed out after ${Math.round((response.fallback.timeoutMs || 0) / 1000)}s`);
    if (response.fallback.statusFile) details.push(`status file: ${response.fallback.statusFile}`);
    setStatus(`${response.fallback.ok ? "OpenCode fallback completed." : "OpenCode fallback failed."}${details.length ? ` ${details.join(" | ")}` : ""}`, !response.fallback.ok);
    return;
  }

  if (response.test) {
    setStatus(response.test.ok ? "Patch applied; tests passed." : "Patch applied; tests failed.", !response.test.ok);
    return;
  }

  setStatus(response.message || "Patch applied.");
}

function renderOpenCodeServerInfo(response) {
  if (!opencodeServerInfoEl) return;
  const parts = [];
  parts.push(`workspace: ${response.workspace || "unknown"}`);
  parts.push(`running: ${response.running ? "yes" : "no"}`);
  if (response.pid) parts.push(`pid: ${response.pid}`);
  if (response.url) parts.push(`url: ${response.url}`);
  if (response.statusFile) parts.push(`status: ${response.statusFile}`);
  if (response.error) parts.push(`error: ${response.error}`);
  opencodeServerInfoEl.textContent = parts.join(" | ");
}

function showArchiveFallback(response) {
  lastArchive = {
    name: response.archiveName || "rel-ai-context.zip",
    base64: response.archiveBase64 || "",
    path: response.archivePath || "",
    zipBytes: response.zipBytes || 0,
    fileCount: response.fileCount || 0
  };

  if (archiveFallbackEl) {
    archiveFallbackEl.classList.remove("hidden");
  }
  if (archiveFallbackTextEl) {
    archiveFallbackTextEl.textContent = `Automatic attachment was not confirmed. Download ${lastArchive.name}, drag it into the open ChatGPT tab, wait for the attachment, then send the inserted prompt.`;
  }
  if (archivePathTextEl) {
    archivePathTextEl.textContent = lastArchive.path ? `Temp path: ${lastArchive.path}` : "Temp path unavailable; use Download ZIP.";
  }
  setStatus(`ZIP attachment was not confirmed. Download ${lastArchive.name} and drag it into the open ChatGPT tab, then send the inserted prompt.`, true);
}

function hideArchiveFallback() {
  lastArchive = null;
  if (archiveFallbackEl) {
    archiveFallbackEl.classList.add("hidden");
  }
  if (archivePathTextEl) {
    archivePathTextEl.textContent = "";
  }
}

async function downloadLastArchive() {
  if (!lastArchive || !lastArchive.base64) {
    throw new Error("No generated ZIP is available to download. Build the request again in ZIP mode.");
  }

  const blob = base64ToBlob(lastArchive.base64, "application/zip");
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = lastArchive.name || "rel-ai-context.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus(`Downloaded ${link.download}. Drag it into the open ChatGPT tab, then send the inserted prompt.`);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function copyLastArchivePath() {
  if (!lastArchive || !lastArchive.path) {
    throw new Error("No temp ZIP path is available. Use Download generated ZIP instead.");
  }
  await navigator.clipboard.writeText(lastArchive.path);
  setStatus("Copied generated ZIP temp path.");
}

function base64ToBlob(base64, mimeType) {
  let binary;
  try {
    binary = atob(base64);
  } catch (_error) {
    throw new Error("ZIP data is corrupted and cannot be decoded. Build the request again.");
  }
  const chunkSize = 32768;
  const chunks = [];
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType || "application/octet-stream" });
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? "err" : "ok";
  statusEl.setAttribute("role", isError ? "alert" : "status");
  statusEl.setAttribute("aria-live", isError ? "assertive" : "polite");
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value) {
  return String(value || "").trim();
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function saveDraft() {
  const draft = {
    workspace: workspaceManualEl.value,
    geminiModel: geminiModelEl ? geminiModelEl.value : "",
    prompt: taskPromptEl.value,
    responseMode: responseModeEl ? responseModeEl.value : "apply",
    contextScope: contextScopeEl ? contextScopeEl.value : "focused",
    include: includePathsEl.value,
    exclude: excludePathsEl.value,
    maxFiles: maxFilesEl.value,
    maxChars: maxCharsEl.value,
    contextMode: contextModeEl.value,
    testCommandKey: testCommandManualEl.value,
    fallbackEnabled: fallbackEnabledEl.checked,
    autoSubmit: autoSubmitEl.checked
  };
  await chrome.storage.local.set({ relaiComposeDraft: draft });
}

function restoreDraft(draft) {
  workspaceManualEl.value = draft.workspace || "";
  if (geminiModelEl) geminiModelEl.value = draft.geminiModel || "";
  taskPromptEl.value = draft.prompt || "";
  if (responseModeEl) responseModeEl.value = draft.responseMode || "apply";
  if (contextScopeEl) contextScopeEl.value = draft.contextScope || "focused";
  includePathsEl.value = draft.include || "";
  excludePathsEl.value = draft.exclude || "";
  maxFilesEl.value = draft.maxFiles || maxFilesEl.defaultValue || "25";
  maxCharsEl.value = draft.maxChars || "90000";
  contextModeEl.value = draft.contextMode || "readable";
  testCommandManualEl.value = draft.testCommandKey || "";
  fallbackEnabledEl.checked = draft.fallbackEnabled === true;
  autoSubmitEl.checked = Boolean(draft.autoSubmit);
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}
