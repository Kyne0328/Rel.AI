importScripts("protocol.js");

const HOST_NAME = "com.relai.request_builder";
const EXTENSION_VERSION = "0.9.25";
const DEBUG_LOG_KEY = "relaiDebugLog";
let _debugLogGeneration = 0;
let _debugLogEnabled = false;

function relaiLog(stage, details) {
  const entry = {
    time: new Date().toISOString(),
    stage: String(stage || "event"),
    details: sanitizeDebugDetails(details)
  };

  try { console.debug("[Rel.AI]", entry.stage, entry.details); } catch (_error) {}

  if (!_debugLogEnabled) return;

  try {
    const gen = _debugLogGeneration;
    chrome.storage.local.get({ [DEBUG_LOG_KEY]: [] }, (stored) => {
      if (_debugLogGeneration !== gen || !_debugLogEnabled) return;
      const list = Array.isArray(stored[DEBUG_LOG_KEY]) ? stored[DEBUG_LOG_KEY] : [];
      list.push(entry);
      chrome.storage.local.set({ [DEBUG_LOG_KEY]: list.slice(-300) });
    });
  } catch (_error) {}
}

function sanitizeDebugDetails(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "string" && item.length > 1200) {
        return `${item.slice(0, 1200)}...[${item.length} chars]`;
      }
      return item;
    }));
  } catch (_error) {
    return String(value);
  }
}

function summarizeMessageForDebug(message) {
  if (!message || typeof message !== "object") return { type: typeof message };
  const summary = { type: message.type };
  if (message.context) {
    summary.context = {
      workspace: message.context.workspace,
      contextMode: message.context.contextMode,
      includeCount: Array.isArray(message.context.include) ? message.context.include.length : undefined,
      maxFiles: message.context.maxFiles,
      maxChars: message.context.maxChars
    };
  }
  if (message.task) {
    summary.task = {
      title: message.task.title,
      hasPrompt: Boolean(message.task.prompt),
      promptLength: String(message.task.prompt || "").length,
      fallbackEnabled: Boolean(message.task.fallbackEnabled),
      testCommandKey: message.task.testCommandKey
    };
  }
  if (Array.isArray(message.files)) {
    summary.files = message.files.map((file) => ({ name: file && file.name, hasBase64: Boolean(file && file.base64), hasPath: Boolean(file && file.path) }));
  }
  return summary;
}


chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ inlineButtonsEnabled: true }, (stored) => {
    const next = {};
    if (stored.inlineButtonsEnabled === undefined) {
      next.inlineButtonsEnabled = true;
    }
    if (Object.keys(next).length > 0) {
      chrome.storage.sync.set(next);
    }
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "relai-apply-selection",
      title: "Apply selected Rel.AI patch",
      contexts: ["selection"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });

    chrome.contextMenus.create({
      id: "relai-context-selection",
      title: "Insert workspace context from selected Rel.AI request",
      contexts: ["selection"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });

    chrome.contextMenus.create({
      id: "relai-apply-latest",
      title: "Apply latest Rel.AI patch block",
      contexts: ["page"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });

    chrome.contextMenus.create({
      id: "relai-context-latest",
      title: "Insert latest Rel.AI context block",
      contexts: ["page"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });

    chrome.contextMenus.create({
      id: "relai-scan-inline",
      title: "Show Rel.AI buttons",
      contexts: ["page"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });
  });
});

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  if (info.menuItemId === "relai-apply-selection") {
    const text = info.selectionText && info.selectionText.trim() ? info.selectionText.trim() : undefined;
    void applyFromTab(tab.id, text ? "selectionText" : "selection", text);
  }

  if (info.menuItemId === "relai-context-selection") {
    const text = info.selectionText && info.selectionText.trim() ? info.selectionText.trim() : undefined;
    void contextFromTab(tab.id, text ? "selectionText" : "selection", text);
  }

  if (info.menuItemId === "relai-apply-latest") {
    void applyFromTab(tab.id, "latest");
  }

  if (info.menuItemId === "relai-context-latest") {
    void contextFromTab(tab.id, "latest");
  }

  if (info.menuItemId === "relai-scan-inline") {
    void setInlineButtonsEnabled(true).then(() => scanTab(tab.id));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  const isDebugMetaMessage = message && (message.type === "relai.getDebugLog" || message.type === "relai.clearDebugLog" || message.type === "relai.setDebugLogging");
  if (!isDebugMetaMessage) {
    relaiLog("background.message.received", {
      message: summarizeMessageForDebug(message),
      senderTabId: sender && sender.tab && sender.tab.id,
      senderUrl: sender && sender.url
    });
  }

  if (!message || typeof message !== "object") {
    throw new Error("Invalid Rel.AI extension message.");
  }

  if (message.type === "relai.dashboardLog") {
    relaiLog(message.stage || "dashboard.event", message.details || {});
    return { ok: true, type: "relai.dashboardLog" };
  }

  if (message.type === "relai.setDebugLogging") {
    _debugLogEnabled = Boolean(message.enabled);
    return { ok: true, type: "relai.debugLogging", enabled: _debugLogEnabled };
  }

  if (message.type === "relai.applyManual") {
    return applyText(String(message.text || ""), "manual-dashboard", { dryRun: Boolean(message.dryRun) });
  }

  if (message.type === "relai.contextManual") {
    const tab = await getTargetChatGPTTab();
    return contextText(String(message.text || ""), "manual-dashboard", tab && tab.id);
  }

  if (message.type === "relai.applyInline") {
    return applyText(String(message.text || ""), message.source || "inline-button", {
      dryRun: Boolean(message.dryRun),
      fallbackEnabled: typeof message.fallbackEnabled === "boolean" ? message.fallbackEnabled : undefined
    });
  }

  if (message.type === "relai.contextInline") {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : undefined;
    return contextText(String(message.text || ""), message.source || "inline-button", tabId);
  }

  if (message.type === "relai.applyFromActiveTab") {
    const tab = await getTargetChatGPTTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No ChatGPT tab found. Open chatgpt.com before using this command.");
    }
    return applyFromTab(tab.id, message.mode || "auto", undefined, { dryRun: Boolean(message.dryRun) });
  }

  if (message.type === "relai.contextFromActiveTab") {
    const tab = await getTargetChatGPTTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No ChatGPT tab found. Open chatgpt.com before using this command.");
    }
    return contextFromTab(tab.id, message.mode || "auto");
  }

  if (message.type === "relai.getDebugLog") {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [DEBUG_LOG_KEY]: [] }, (stored) => {
        resolve({ ok: true, type: "relai.debugLog", events: Array.isArray(stored[DEBUG_LOG_KEY]) ? stored[DEBUG_LOG_KEY] : [] });
      });
    });
  }

  if (message.type === "relai.clearDebugLog") {
    _debugLogGeneration++;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [DEBUG_LOG_KEY]: [] }, () => resolve({ ok: true, type: "relai.debugLogCleared" }));
    });
  }

  if (message.type === "relai.ping") {
    return sendNativeMessage(RelAiProtocol.makePingMessage());
  }

  if (message.type === "relai.getConfigSummary") {
    return sendNativeMessage(RelAiProtocol.makeConfigSummaryMessage());
  }

  if (message.type === "relai.listWorkspace") {
    const workspace = String(message.workspace || "").trim();
    if (!workspace) {
      throw new Error("Workspace alias is required for browsing.");
    }
    return sendNativeMessage(RelAiProtocol.makeListWorkspaceMessage(workspace, String(message.dir || "")));
  }

  if (message.type === "relai.opencodeServerStart") {
    const workspace = String(message.workspace || "").trim();
    if (!workspace) {
      throw new Error("Workspace alias is required to start OpenCode server.");
    }
    return sendNativeMessage(RelAiProtocol.makeOpenCodeServerStartMessage(workspace));
  }

  if (message.type === "relai.opencodeServerStatus") {
    const workspace = String(message.workspace || "").trim();
    if (!workspace) {
      throw new Error("Workspace alias is required to check OpenCode server status.");
    }
    return sendNativeMessage(RelAiProtocol.makeOpenCodeServerStatusMessage(workspace));
  }

  if (message.type === "relai.openUrl") {
    const url = String(message.url || "").trim();
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/.*)?$/.test(url) && !/^https?:\/\/localhost(?::\d+)?(?:\/.*)?$/.test(url)) {
      throw new Error("Rel.AI only opens localhost OpenCode server URLs.");
    }
    const tab = await chrome.tabs.create({ url });
    return { ok: true, type: "relai.openUrl", url, tabId: tab && tab.id, message: `Opened ${url}.` };
  }

  if (message.type === "relai.composeChatGPTRequest") {
    const tab = await getTargetChatGPTTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("Open a ChatGPT tab before inserting a request.");
    }
    return composeChatGPTRequest(message.context, message.task || {}, Boolean(message.autoSubmit), tab.id);
  }

  if (message.type === "relai.showArchiveChip") {
    const tab = await getTargetChatGPTTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("Open a ChatGPT tab before showing the ZIP drag chip.");
    }
    const files = Array.isArray(message.files) ? message.files : [];
    return showArchiveDragChipInTab(tab.id, files);
  }

  if (message.type === "relai.getSettings") {
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "relai.setInlineButtonsEnabled") {
    const enabled = Boolean(message.enabled);
    await setInlineButtonsEnabled(enabled);
    const tab = await getTargetChatGPTTab(false);
    if (enabled && tab && typeof tab.id === "number") {
      await scanTab(tab.id);
    }
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "relai.scanActiveTab") {
    const tab = await getTargetChatGPTTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No ChatGPT tab found. Open chatgpt.com before scanning.");
    }
    return scanTab(tab.id);
  }

  throw new Error(`Unsupported extension message type: ${message.type}`);
}


async function composeChatGPTRequest(contextRequest, task, autoSubmit, tabId) {
  relaiLog("compose.start", { tabId, autoSubmit, contextRequest: sanitizeDebugDetails(contextRequest), task: sanitizeDebugDetails(task) });
  const context = RelAiProtocol.validateContextRequest(contextRequest);
  const message = RelAiProtocol.makeContextMessage(context, "browser:compose-request");
  const response = await sendNativeMessage(message);
  relaiLog("compose.native.response", {
    ok: Boolean(response && response.ok),
    contextMode: response && response.contextMode,
    fileCount: response && response.fileCount,
    archiveName: response && response.archiveName,
    archivePath: response && response.archivePath,
    hasArchiveBase64: Boolean(response && response.archiveBase64),
    archiveBase64Omitted: Boolean(response && response.archiveBase64Omitted),
    zipBytes: response && response.zipBytes,
    error: response && response.error,
    nativeHost: response && response.nativeHost
  });

  if (!response || !response.ok || !response.bundle) {
    return response || { ok: false, error: "Could not load workspace context." };
  }

  if (context.contextMode === "zip") {
    const hasArchive = response.contextMode === "zip" && (response.archiveBase64 || response.archivePath);
    if (!hasArchive) {
      const nativeVersion = response.nativeHost && response.nativeHost.version ? response.nativeHost.version : "unknown";
      const nativeRoot = response.nativeHost && response.nativeHost.root ? response.nativeHost.root : "unknown";
      return {
        ok: false,
        type: "relai.chatgptRequest",
        error: `ZIP mode was requested, but the native host did not return an archive path or base64 payload. Native host version=${nativeVersion}, root=${nativeRoot}. If version/root are unknown, Chrome is probably registered to an older Rel.AI folder or the native response is stale. Run npm run install:chrome-host -- --extension-id YOUR_EXTENSION_ID from the v${EXTENSION_VERSION} folder, then reload the extension and refresh ChatGPT.`,
        nativeHost: response.nativeHost || null,
        requestedContextMode: context.contextMode,
        returnedContextMode: response.contextMode || "missing",
        fileCount: response.fileCount || 0
      };
    }
  }

  const promptText = buildChatGPTRequestPrompt(context, task || {}, response);
  const attachedFiles = response.contextMode === "zip" && (response.archiveBase64 || response.archivePath)
    ? [{
      name: response.archiveName || "rel-ai-context.zip",
      mimeType: response.archiveMimeType || "application/zip",
      base64: response.archiveBase64 || "",
      path: response.archivePath || ""
    }]
    : [];

  relaiLog("compose.insert.start", {
    tabId,
    autoSubmit,
    promptLength: promptText.length,
    attachedFileCount: attachedFiles.length,
    attachedFiles: attachedFiles.map((file) => ({ name: file.name, hasPath: Boolean(file.path), hasBase64: Boolean(file.base64), base64Length: String(file.base64 || "").length }))
  });
  const inserted = await insertRequestIntoTab(tabId, promptText, autoSubmit, attachedFiles);
  relaiLog("compose.insert.result", inserted);

  return {
    ok: Boolean(inserted && inserted.ok),
    type: "relai.chatgptRequest",
    workspace: response.workspace,
    title: response.title || context.title || "",
    fileCount: response.fileCount || 0,
    totalChars: response.totalChars || 0,
    contextMode: response.contextMode || context.contextMode || "readable",
    zipBytes: response.zipBytes || 0,
    base64Chars: response.base64Chars || 0,
    archiveName: response.archiveName || "",
    archivePath: response.archivePath || "",
    archiveBase64: response.contextMode === "zip" && !(inserted && inserted.uploaded) ? (response.archiveBase64 || "") : "",
    archiveUploaded: Boolean(inserted && inserted.uploaded),
    uploadMethod: inserted && inserted.uploadMethod,
    uploadError: inserted && inserted.uploadError,
    dragChipShown: Boolean(inserted && inserted.dragChipShown),
    dragChipMessage: inserted && inserted.dragChipMessage,
    files: response.files || [],
    skipped: response.skipped || [],
    inserted: Boolean(inserted && inserted.ok),
    submitted: Boolean(inserted && inserted.submitted),
    insertMessage: inserted && inserted.message,
    nativeHost: response.nativeHost || null,
    extensionVersion: EXTENSION_VERSION,
    message: inserted && inserted.message ? inserted.message : "Built ChatGPT request."
  };
}


async function uploadFilesWithCdpDragDrop(tabId, files) {
  const paths = files.map((file) => file && file.path).filter(Boolean);
  const names = files.map((file) => file && file.name).filter(Boolean);
  if (paths.length === 0 || !chrome.debugger) {
    return { uploaded: false, uploadMethod: "cdp-drag-drop-unavailable", uploadError: "No archive path or debugger permission unavailable." };
  }

  const target = { tabId };
  let attached = false;

  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable", {}).catch(() => {});
    await debuggerSend(target, "Runtime.enable", {});
    await debuggerSend(target, "Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
    await debuggerSend(target, "Page.bringToFront", {}).catch(() => {});

    const point = await getChatGPTDropPoint(target);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { uploaded: false, uploadMethod: "cdp-drag-drop", uploadError: "Could not locate a ChatGPT composer/drop target." };
    }

    const data = {
      items: [],
      files: paths,
      dragOperationsMask: 1
    };

    await debuggerSend(target, "Input.dispatchDragEvent", { type: "dragEnter", x: point.x, y: point.y, data });
    await debuggerSend(target, "Input.dispatchDragEvent", { type: "dragOver", x: point.x, y: point.y, data });
    await sleepBackground(250);
    await debuggerSend(target, "Input.dispatchDragEvent", { type: "drop", x: point.x, y: point.y, data });

    if (await waitForAttachmentWithDebugger(target, names, 12000)) {
      return { uploaded: true, uploadMethod: `cdp-drag-drop:${point.reason || "composer"}` };
    }

    return { uploaded: false, uploadMethod: "cdp-drag-drop", uploadError: `Dispatched real-path CDP drag/drop at ${point.reason || "drop target"}, but ChatGPT did not show the ZIP attachment.` };
  } catch (error) {
    return { uploaded: false, uploadMethod: "cdp-drag-drop", uploadError: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached) {
      try { await debuggerDetach(target); } catch (_error) {}
    }
  }
}

async function getChatGPTDropPoint(target) {
  const expression = `(() => {
    function visible(node) {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none";
    }
    function center(node, reason) {
      const rect = node.getBoundingClientRect();
      return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2), reason };
    }
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[data-testid="composer-input"]',
      '[data-testid="composer"]',
      '[data-testid*="composer" i]',
      'form textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ];
    for (const selector of selectors) {
      const node = [...document.querySelectorAll(selector)].filter(visible).pop();
      if (node) {
        const form = node.closest('form');
        if (visible(form)) return center(form, 'composer-form');
        return center(node, selector);
      }
    }
    const main = document.querySelector('main');
    if (visible(main)) {
      const rect = main.getBoundingClientRect();
      return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(Math.min(rect.bottom - 80, innerHeight - 80)), reason: 'main-bottom' };
    }
    return { x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight - 140), reason: 'viewport-bottom' };
  })()`;
  const result = await debuggerSend(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result && result.result ? result.result.value : null;
}


async function uploadFilesWithFileChooserDebugger(tabId, files) {
  const paths = files.map((file) => file && file.path).filter(Boolean);
  const names = files.map((file) => file && file.name).filter(Boolean);
  if (paths.length === 0 || !chrome.debugger) {
    return { uploaded: false, uploadMethod: "debugger-file-chooser-unavailable", uploadError: "No archive path or debugger permission unavailable." };
  }

  const target = { tabId };
  let attached = false;
  let interceptEnabled = false;

  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable", {});
    await debuggerSend(target, "DOM.enable", {});
    await debuggerSend(target, "Runtime.enable", {});
    await debuggerSend(target, "Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
    await debuggerSend(target, "Page.bringToFront", {}).catch(() => {});
    await debuggerSend(target, "Page.setInterceptFileChooserDialog", { enabled: true });
    interceptEnabled = true;

    const chooserPromise = waitForDebuggerEvent(tabId, "Page.fileChooserOpened", null, 5500);
    const clickResult = await openChatGPTFileChooserViaCDP(target);
    const chooser = await chooserPromise.catch((error) => ({ __relAiError: error instanceof Error ? error.message : String(error) }));

    if (!chooser || chooser.__relAiError) {
      return {
        uploaded: false,
        uploadMethod: "debugger-file-chooser",
        uploadError: `File chooser did not open. Click path: ${clickResult && clickResult.message ? clickResult.message : JSON.stringify(clickResult || {})}. ${chooser && chooser.__relAiError ? chooser.__relAiError : ""}`.trim()
      };
    }

    let setFileResult = null;
    if (chooser.backendNodeId) {
      try {
        await debuggerSend(target, "DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files: paths });
        setFileResult = "backendNodeId";
      } catch (error) {
        setFileResult = `backendNodeId failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (!setFileResult || String(setFileResult).includes("failed")) {
      const nodeIds = await findFileInputNodeIds(target);
      let lastError = null;
      for (const nodeId of nodeIds.reverse()) {
        try {
          await debuggerSend(target, "DOM.setFileInputFiles", { nodeId, files: paths });
          setFileResult = `nodeId:${nodeId}`;
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (lastError && (!setFileResult || String(setFileResult).includes("failed"))) {
        return { uploaded: false, uploadMethod: "debugger-file-chooser", uploadError: `Chooser opened, but setting files failed: ${lastError}` };
      }
    }

    await fireFileInputEventsWithDebugger(target);
    if (await waitForAttachmentWithDebugger(target, names, 12000)) {
      return { uploaded: true, uploadMethod: `debugger-file-chooser:${setFileResult || "setFileInputFiles"}` };
    }

    return {
      uploaded: false,
      uploadMethod: "debugger-file-chooser",
      uploadError: `Chooser accepted file path via ${setFileResult || "setFileInputFiles"}, but ChatGPT did not show the ZIP attachment.`
    };
  } catch (error) {
    return { uploaded: false, uploadMethod: "debugger-file-chooser", uploadError: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached && interceptEnabled) {
      try { await debuggerSend(target, "Page.setInterceptFileChooserDialog", { enabled: false }); } catch (_error) {}
    }
    if (attached) {
      try { await debuggerDetach(target); } catch (_error) {}
    }
  }
}

function waitForDebuggerEvent(tabId, expectedMethod, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error(`Timed out waiting for ${expectedMethod}.`));
    }, timeoutMs);

    function listener(source, method, params) {
      if (!source || source.tabId !== tabId || method !== expectedMethod) {
        return;
      }
      if (predicate && !predicate(params || {})) {
        return;
      }
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(params || {});
    }

    chrome.debugger.onEvent.addListener(listener);
  });
}

async function openChatGPTFileChooserViaCDP(target) {
  const menuCenter = await getUploadElementCenter(target, "menu");
  if (menuCenter && menuCenter.found) {
    await cdpClick(target, menuCenter.x, menuCenter.y);
    return { ok: true, message: `clicked visible Add photos & files menu item via ${menuCenter.reason}` };
  }

  const triggerCenter = await getUploadElementCenter(target, "trigger");
  if (triggerCenter && triggerCenter.found) {
    await cdpClick(target, triggerCenter.x, triggerCenter.y);
    await sleepBackground(500);
    const menuAfterTrigger = await getUploadElementCenter(target, "menu");
    if (menuAfterTrigger && menuAfterTrigger.found) {
      await cdpClick(target, menuAfterTrigger.x, menuAfterTrigger.y);
      return { ok: true, message: `clicked upload trigger via ${triggerCenter.reason}, then Add photos & files via ${menuAfterTrigger.reason}` };
    }
    return { ok: true, message: `clicked upload trigger via ${triggerCenter.reason}, but menu item was not found after opening` };
  }

  const inputCenter = await getUploadElementCenter(target, "input-label");
  if (inputCenter && inputCenter.found) {
    await cdpClick(target, inputCenter.x, inputCenter.y);
    return { ok: true, message: `clicked file input/label via ${inputCenter.reason}` };
  }

  return { ok: false, message: "No visible ChatGPT upload trigger, Add photos & files menu item, or input label found." };
}

async function getUploadElementCenter(target, mode) {
  const expression = `(() => {
    const mode = ${JSON.stringify(mode)};
    function visible(node) {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
    }
    function center(node, reason) {
      const rect = node.getBoundingClientRect();
      return { found: true, reason, x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2), text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 120) };
    }
    function closestClickable(node) {
      return node && node.closest('button,[role="button"],[role="menuitem"],label,input[type="file"],div');
    }
    function byText(pattern) {
      const nodes = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],label,div,span')].filter(visible);
      return nodes.find((node) => pattern.test(node.textContent || node.getAttribute('aria-label') || '')) || null;
    }
    function composerForm() {
      const composer = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,form [contenteditable="true"],[contenteditable="true"][role="textbox"]');
      return composer && composer.closest('form');
    }

    if (mode === "menu") {
      const icon = document.querySelector('use[href*="#712359"], use[xlink\\:href*="#712359"]');
      const iconTarget = closestClickable(icon);
      if (visible(iconTarget)) return center(iconTarget, 'svg#712359');
      const item = byText(/add photos\s*&\s*files|add photos and files|upload file|upload files|attach files/i);
      if (visible(item)) return center(item, 'menu-text');
      return { found: false };
    }

    if (mode === "trigger") {
      const selectors = [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
        'button[aria-label*="Add photos" i]',
        '[data-testid*="attach" i]',
        '[data-testid*="upload" i]',
        '[data-testid*="plus" i]'
      ];
      for (const selector of selectors) {
        const node = [...document.querySelectorAll(selector)].filter(visible).pop();
        if (node) return center(node, selector);
      }
      const form = composerForm();
      if (form) {
        const buttons = [...form.querySelectorAll('button,[role="button"]')].filter(visible)
          .filter((node) => !/send|voice|dictate|stop|submit/i.test(node.getAttribute('aria-label') || node.textContent || ''));
        const plusLike = buttons.find((node) => /attach|upload|add|file|\+|photo/i.test(node.getAttribute('aria-label') || node.textContent || '')) || buttons[0];
        if (plusLike) return center(plusLike, 'composer-form-button');
      }
      return { found: false };
    }

    if (mode === "input-label") {
      const input = [...document.querySelectorAll('input[type="file"]')].pop();
      if (visible(input)) return center(input, 'visible-file-input');
      const label = input && input.id ? document.querySelector('label[for=\"' + CSS.escape(input.id) + '\"]') : null;
      if (visible(label)) return center(label, 'file-input-label');
      return { found: false };
    }

    return { found: false };
  })()`;
  const result = await debuggerSend(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  return result && result.result ? result.result.value : { found: false };
}

async function cdpClick(target, x, y) {
  await debuggerSend(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await debuggerSend(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await debuggerSend(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}


async function uploadFilesWithDebugger(tabId, files) {
  const paths = files.map((file) => file && file.path).filter(Boolean);
  const names = files.map((file) => file && file.name).filter(Boolean);
  if (paths.length === 0 || !chrome.debugger) {
    return { uploaded: false, uploadMethod: "debugger-unavailable", uploadError: "No archive path or debugger permission unavailable." };
  }

  const target = { tabId };
  let attached = false;

  try {
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "DOM.enable", {});
    await debuggerSend(target, "Runtime.enable", {});

    let nodeIds = await findFileInputNodeIds(target);
    if (nodeIds.length === 0) {
      await clickUploadTriggerWithDebugger(target);
      await sleepBackground(350);
      nodeIds = await findFileInputNodeIds(target);
    }

    if (nodeIds.length === 0) {
      return { uploaded: false, uploadMethod: "debugger-file-input", uploadError: "No file input found after opening ChatGPT upload controls." };
    }

    let lastError = null;
    for (const nodeId of nodeIds.reverse()) {
      try {
        await debuggerSend(target, "DOM.setFileInputFiles", { nodeId, files: paths });
        await fireFileInputEventsWithDebugger(target);
        if (await waitForAttachmentWithDebugger(target, names, 7000)) {
          return { uploaded: true, uploadMethod: "debugger-set-file-input" };
        }
        lastError = "File input was set, but ChatGPT did not show the attachment.";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return { uploaded: false, uploadMethod: "debugger-set-file-input", uploadError: lastError || "ChatGPT did not accept the file input." };
  } catch (error) {
    return { uploaded: false, uploadMethod: "debugger", uploadError: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached) {
      try { await debuggerDetach(target); } catch (_error) {}
    }
  }
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function debuggerSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

async function findFileInputNodeIds(target) {
  const root = await debuggerSend(target, "DOM.getDocument", { depth: -1, pierce: true });
  const rootNodeId = root && root.root && root.root.nodeId;
  if (!rootNodeId) {
    return [];
  }
  const result = await debuggerSend(target, "DOM.querySelectorAll", { nodeId: rootNodeId, selector: 'input[type="file"]' });
  return Array.isArray(result.nodeIds) ? result.nodeIds : [];
}

async function clickUploadTriggerWithDebugger(target) {
  const expression = `(() => {
    function visible(node) {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }
    const selectors = [
      'button[aria-label*=\"Attach\" i]',
      'button[aria-label*=\"Upload\" i]',
      'button[aria-label*=\"Add photos\" i]',
      '[data-testid*=\"attach\" i]',
      '[data-testid*=\"upload\" i]',
      '[data-testid*=\"plus\" i]'
    ];
    for (const selector of selectors) {
      const node = [...document.querySelectorAll(selector)].filter(visible).pop();
      if (node) { node.click(); return { clicked: true, selector }; }
    }
    const nodes = [...document.querySelectorAll('button,[role=\"button\"],[role=\"menuitem\"],div')].filter(visible);
    const textNode = nodes.find((node) => /add photos\s*&\s*files|add photos and files|upload file|upload files|attach files|attach|upload/i.test(node.textContent || node.getAttribute('aria-label') || ''));
    if (textNode) { textNode.click(); return { clicked: true, selector: 'text' }; }
    const icon = document.querySelector('use[href*=\"#712359\"], use[xlink\\:href*=\"#712359\"]');
    const iconTarget = icon && icon.closest('[role=\"menuitem\"],button,[role=\"button\"],div');
    if (iconTarget) { iconTarget.click(); return { clicked: true, selector: '#712359' }; }
    return { clicked: false };
  })()`;
  await debuggerSend(target, "Runtime.evaluate", { expression, awaitPromise: true, userGesture: true });
}

async function fireFileInputEventsWithDebugger(target) {
  const expression = `(() => {
    for (const input of document.querySelectorAll('input[type="file"]')) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`;
  try { await debuggerSend(target, "Runtime.evaluate", { expression, awaitPromise: true, userGesture: true }); } catch (_error) {}
}

async function waitForAttachmentWithDebugger(target, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const safeNames = JSON.stringify(names || []);
  while (Date.now() < deadline) {
    const expression = `(() => {
      const names = ${safeNames};
      const text = document.body ? document.body.innerText || '' : '';
      return names.length > 0 && names.every((name) => text.includes(name));
    })()`;
    try {
      const result = await debuggerSend(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result && result.result && result.result.value === true) {
        return true;
      }
    } catch (_error) {}
    await sleepBackground(300);
  }
  return false;
}

function sleepBackground(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showArchiveDragChipInTab(tabId, files) {
  const safeFiles = Array.isArray(files) ? files.filter((file) => file && file.base64 && file.name) : [];
  if (safeFiles.length === 0) {
    return { ok: false, error: "No generated ZIP bytes are available for the drag chip." };
  }

  const errors = [];
  await focusTab(tabId).catch((error) => errors.push(`focus: ${error instanceof Error ? error.message : String(error)}`));

  // Prefer the persistent content script, but do not trust it as the only path. Tabs
  // opened before an extension reload often keep stale scripts that reject messages.
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "relai.showArchiveChip", files: safeFiles });
    relaiLog("showArchiveDragChipInTab.contentMessage.result", result);
    if (result && result.ok) {
      await focusTab(tabId).catch(() => {});
      return { ...result, message: `${result.message || "Draggable ZIP chip shown."} Switched to the ChatGPT tab.` };
    }
    errors.push(`content-script: ${(result && (result.error || result.message)) || "returned not ok"}`);
  } catch (error) {
    errors.push(`content-script: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Try both worlds. MAIN can be required for page layout quirks; ISOLATED is safer
  // when page CSP or app internals interfere. Do not stop on the first failure.
  const attempts = [
    { world: "MAIN", label: "main-world" },
    { world: "ISOLATED", label: "isolated-world" }
  ];

  for (const attempt of attempts) {
    try {
      const details = {
        target: { tabId },
        func: showRelAiArchiveDragChipInPage,
        args: [safeFiles]
      };
      if (attempt.world) {
        details.world = attempt.world;
      }
      relaiLog("scripting.chip.execute", { tabId, world: attempt.world, filesPassed: safeFiles.length });
      const results = await chrome.scripting.executeScript(details);
      const result = results && results[0] && results[0].result
        ? results[0].result
        : { ok: false, error: "ZIP drag chip script returned no result." };
      result.executionWorld = attempt.label;
      if (result.ok) {
        await focusTab(tabId).catch(() => {});
        result.message = `${result.message || "Draggable ZIP chip shown."} Switched to the ChatGPT tab.`;
        return result;
      }
      errors.push(`${attempt.label}: ${result.error || result.message || "not ok"}`);
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: false, error: `Could not render ZIP chip in ChatGPT. ${errors.join(" | ")}` };
}

function showRelAiArchiveDragChipInPage(files) {
  function decodeBase64(base64) {
    const clean = String(base64 || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function makeFile(item) {
    const bytes = decodeBase64(item.base64);
    return new File([bytes], item.name || "rel-ai-context.zip", {
      type: item.mimeType || "application/zip",
      lastModified: Date.now()
    });
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "unknown size";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function removeExisting() {
    for (const node of document.querySelectorAll('[data-relai-archive-chip="true"]')) {
      node.remove();
    }
  }

  function addStyles() {
    if (document.getElementById("relai-archive-chip-style")) return;
    const style = document.createElement("style");
    style.id = "relai-archive-chip-style";
    style.textContent = `
      [data-relai-archive-chip="true"] {
        position: fixed;
        right: 18px;
        bottom: 96px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 36px));
        box-sizing: border-box;
        border: 1px solid rgba(120, 120, 120, .35);
        border-radius: 14px;
        background: color-mix(in srgb, Canvas 94%, #ffffff 6%);
        color: CanvasText;
        box-shadow: 0 10px 32px rgba(0,0,0,.18);
        padding: 12px;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
      }
      [data-relai-archive-chip="true"] .relai-chip-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      [data-relai-archive-chip="true"] .relai-chip-title {
        font-weight: 750;
      }
      [data-relai-archive-chip="true"] .relai-chip-close {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 0 3px;
      }
      [data-relai-archive-chip="true"] .relai-chip-file {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        border: 1px dashed rgba(130,130,130,.65);
        border-radius: 12px;
        background: rgba(127,127,127,.08);
        color: inherit;
        cursor: grab;
        padding: 10px;
        text-align: left;
        box-sizing: border-box;
        user-select: none;
      }
      [data-relai-archive-chip="true"] .relai-chip-file:active { cursor: grabbing; }
      [data-relai-archive-chip="true"] .relai-chip-icon {
        width: 34px;
        height: 34px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(88, 101, 242, .16);
        flex: 0 0 auto;
        font-size: 20px;
      }
      [data-relai-archive-chip="true"] .relai-chip-name {
        font-weight: 650;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-relai-archive-chip="true"] .relai-chip-meta,
      [data-relai-archive-chip="true"] .relai-chip-help {
        color: color-mix(in srgb, CanvasText 68%, transparent);
        font-size: 12px;
      }
      [data-relai-archive-chip="true"] .relai-chip-help {
        margin-top: 8px;
        line-height: 1.35;
      }
      [data-relai-archive-chip="true"].relai-chip-dragging .relai-chip-file {
        outline: 2px solid rgba(88, 101, 242, .75);
        background: rgba(88, 101, 242, .12);
      }
    `;
    document.documentElement.appendChild(style);
  }

  try {
    const items = Array.isArray(files) ? files.filter((item) => item && item.base64) : [];
    if (items.length === 0) {
      return { ok: false, error: "No ZIP data was provided for the drag chip." };
    }
    const item = items[0];
    const file = makeFile(item);

    removeExisting();
    addStyles();

    const panel = document.createElement("div");
    panel.setAttribute("data-relai-archive-chip", "true");

    const header = document.createElement("div");
    header.className = "relai-chip-header";
    const title = document.createElement("div");
    title.className = "relai-chip-title";
    title.textContent = "Rel.AI generated ZIP";
    const close = document.createElement("button");
    close.className = "relai-chip-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close Rel.AI ZIP chip");
    close.textContent = "×";
    close.addEventListener("click", () => panel.remove());
    header.append(title, close);

    const chip = document.createElement("div");
    chip.className = "relai-chip-file";
    chip.draggable = true;
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.setAttribute("aria-label", `Drag ${file.name} into the ChatGPT composer`);

    const icon = document.createElement("div");
    icon.className = "relai-chip-icon";
    icon.textContent = "📦";

    const textWrap = document.createElement("div");
    textWrap.style.minWidth = "0";
    const name = document.createElement("div");
    name.className = "relai-chip-name";
    name.textContent = file.name;
    const meta = document.createElement("div");
    meta.className = "relai-chip-meta";
    meta.textContent = `${formatBytes(file.size)} • drag this into the message box`;
    textWrap.append(name, meta);
    chip.append(icon, textWrap);

    chip.addEventListener("dragstart", (event) => {
      panel.classList.add("relai-chip-dragging");
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "copy";
      try { event.dataTransfer.items.add(file); } catch (_error) {}
      try { event.dataTransfer.setData("text/plain", file.name); } catch (_error) {}
      try { event.dataTransfer.setData("application/x-relai-archive-name", file.name); } catch (_error) {}
    });

    chip.addEventListener("dragend", () => {
      panel.classList.remove("relai-chip-dragging");
    });

    const help = document.createElement("div");
    help.className = "relai-chip-help";
    help.textContent = "Drag the ZIP chip into ChatGPT's composer/upload area, wait until the attachment appears, then send the inserted prompt.";

    panel.append(header, chip, help);
    document.body.appendChild(panel);

    try {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (_error) {}

    return { ok: true, message: `Draggable ZIP chip shown for ${file.name}. Drag it into ChatGPT's composer.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function insertRequestIntoTab(tabId, text, submit, files) {
  const safeFiles = Array.isArray(files) ? files : [];
  relaiLog("insertRequestIntoTab.start", {
    tabId,
    submit: Boolean(submit),
    textLength: String(text || "").length,
    fileCount: safeFiles.length,
    mode: "fast-main-world-drag-drop",
    files: safeFiles.map((file) => ({
      name: file && file.name,
      hasPath: Boolean(file && file.path),
      hasBase64: Boolean(file && file.base64)
    }))
  });

  // Optimized path: the user's logs showed ChatGPT accepts MAIN-world drag/drop,
  // while debugger/file-picker fallbacks add long delays and can leave the upload overlay stuck.
  // Keep one fast MAIN-world attempt. If it cannot confirm upload, show the draggable ZIP fallback.
  try {
    const details = {
      target: { tabId },
      world: "MAIN",
      func: insertRelAiRequestInPage,
      args: [text, Boolean(submit), safeFiles, null]
    };
    relaiLog("scripting.insert.execute", { tabId, world: "MAIN", filesPassed: safeFiles.length, fastPath: true });
    const results = await chrome.scripting.executeScript(details);
    const result = results && results[0] && results[0].result
      ? results[0].result
      : { ok: false, message: "Insert/upload script returned no result." };

    result.executionWorld = "main-world";

    if (safeFiles.length > 0 && !result.uploaded) {
      relaiLog("chip.auto.start", { tabId, reason: "fast-upload-not-confirmed", result });
      const chip = await showArchiveDragChipInTab(tabId, safeFiles);
      relaiLog("chip.auto.result", chip);
      result.dragChipShown = Boolean(chip && chip.ok);
      result.dragChipMessage = chip && (chip.message || chip.error);
      if (!result.uploadError && chip && chip.ok) {
        result.uploadError = "Automatic upload was not confirmed; a draggable ZIP chip was added to the ChatGPT tab.";
      }
    }

    return result;
  } catch (mainError) {
    const mainMessage = mainError instanceof Error ? mainError.message : String(mainError);
    relaiLog("scripting.insert.mainWorld.failed", { tabId, error: mainMessage });

    // Last-resort insertion only. Do not attempt file upload in ISOLATED world because it is slower
    // and usually cannot reach ChatGPT's React/dropzone handlers reliably.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: insertRelAiRequestInPage,
        args: [text, Boolean(submit), [], null]
      });
      const result = results && results[0] && results[0].result
        ? results[0].result
        : { ok: false, message: "Fallback insert script returned no result." };
      result.executionWorld = "isolated-world-text-only";

      if (safeFiles.length > 0) {
        const chip = await showArchiveDragChipInTab(tabId, safeFiles);
        result.dragChipShown = Boolean(chip && chip.ok);
        result.dragChipMessage = chip && (chip.message || chip.error);
        result.uploaded = false;
        result.uploadMethod = "manual-chip";
        result.uploadError = "Automatic upload could not run in MAIN world. A draggable ZIP chip was added instead.";
      }
      return result;
    } catch (isolatedError) {
      const isolatedMessage = isolatedError instanceof Error ? isolatedError.message : String(isolatedError);
      return { ok: false, message: `Could not insert request. MAIN world failed: ${mainMessage}; fallback failed: ${isolatedMessage}` };
    }
  }
}

async function uploadFilesWithDebuggerFallbacks(tabId, files) {
  const safeFiles = Array.isArray(files) ? files.filter((file) => file && file.path) : [];
  if (safeFiles.length === 0) {
    return { uploaded: false, uploadMethod: "debugger-unavailable", uploadError: "No file path available for debugger fallback." };
  }

  const errors = [];

  relaiLog("upload.setFileInput.start", { tabId });
  const setInputAttempt = await uploadFilesWithDebugger(tabId, safeFiles);
  relaiLog("upload.setFileInput.result", setInputAttempt);
  if (setInputAttempt && setInputAttempt.uploaded) return setInputAttempt;
  if (setInputAttempt) errors.push(`${setInputAttempt.uploadMethod || "debugger-set-file-input"}: ${setInputAttempt.uploadError || "not accepted"}`);

  relaiLog("upload.fileChooser.start", { tabId });
  const chooserAttempt = await uploadFilesWithFileChooserDebugger(tabId, safeFiles);
  relaiLog("upload.fileChooser.result", chooserAttempt);
  if (chooserAttempt && chooserAttempt.uploaded) return chooserAttempt;
  if (chooserAttempt) errors.push(`${chooserAttempt.uploadMethod || "debugger-file-chooser"}: ${chooserAttempt.uploadError || "not accepted"}`);

  relaiLog("upload.cdpDragDrop.start", { tabId, files: safeFiles.map((file) => ({ name: file.name, path: file.path })) });
  const dragDropAttempt = await uploadFilesWithCdpDragDrop(tabId, safeFiles);
  relaiLog("upload.cdpDragDrop.result", dragDropAttempt);
  if (dragDropAttempt && dragDropAttempt.uploaded) return dragDropAttempt;
  if (dragDropAttempt) errors.push(`${dragDropAttempt.uploadMethod || "cdp-drag-drop"}: ${dragDropAttempt.uploadError || "not accepted"}`);

  return { uploaded: false, uploadMethod: "debugger-fallbacks", uploadError: errors.join(" | ") || "Debugger fallback upload did not confirm an attachment." };
}

async function insertTextIntoTab(tabId, text, submit) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "relai.insertText",
      text,
      submit
    });
    if (response && response.ok) {
      return response;
    }
  } catch (_error) {
    // The content script may not be loaded in tabs that were open before the extension was installed/reloaded.
    // Fall through to one-shot script injection.
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: insertRelAiTextInPage,
      args: [text, Boolean(submit)]
    });
    return results && results[0] && results[0].result
      ? results[0].result
      : { ok: false, message: "Insert script returned no result." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function insertRelAiTextInPage(text, submit) {
  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[data-testid="composer-input"]',
      'textarea[data-testid="prompt-textarea"]',
      'div[data-testid="prompt-textarea"][contenteditable="true"]',
      'form textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isUsableComposer);
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }

    return null;
  }

  function isUsableComposer(node) {
    if (!node || node.closest('pre, code')) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 80 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function fireInput(target, data) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data }));
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertText(target, value) {
    target.focus();

    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
      const next = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
      setNativeValue(target, next);
      const cursor = start + value.length;
      target.selectionStart = cursor;
      target.selectionEnd = cursor;
      fireInput(target, value);
      return true;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = Boolean(document.execCommand && document.execCommand('insertText', false, value));
    } catch (_error) {
      inserted = false;
    }

    if (!inserted) {
      target.textContent = `${target.textContent || ''}${value}`;
    }

    fireInput(target, value);
    return true;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'form button[type="submit"]'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => !node.disabled && isVisible(node));
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }

    return null;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  const target = findComposer();
  if (!target) {
    try {
      navigator.clipboard.writeText(String(text || ''));
    } catch (_error) {
      // Ignore clipboard fallback errors.
    }
    return { ok: false, message: 'Could not find the ChatGPT composer. The request was copied to clipboard if permission allowed it.' };
  }

  insertText(target, String(text || ''));

  if (!submit) {
    return { ok: true, message: 'Inserted text into composer.', submitted: false };
  }

  const sendButton = findSendButton();
  if (!sendButton) {
    return { ok: true, message: 'Inserted text, but could not find ChatGPT send button.', submitted: false };
  }

  sendButton.click();
  return { ok: true, message: 'Inserted and submitted text to ChatGPT.', submitted: true };
}

function insertRelAiRequestInPage(text, submit, files, preUploaded) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function decodeBase64(base64) {
    const clean = String(base64 || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function makeFile(item) {
    const bytes = decodeBase64(item.base64);
    return new File([bytes], item.name || "rel-ai-context.zip", {
      type: item.mimeType || "application/zip",
      lastModified: Date.now()
    });
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[data-testid="composer-input"]',
      'textarea[data-testid="prompt-textarea"]',
      'div[data-testid="prompt-textarea"][contenteditable="true"]',
      'form textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isUsableComposer);
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }
    return null;
  }

  function isUsableComposer(node) {
    if (!node || node.closest('pre, code')) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 80 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function fireInput(target, data) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data }));
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertText(target, value) {
    target.focus();
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
      const next = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
      setNativeValue(target, next);
      const cursor = start + value.length;
      target.selectionStart = cursor;
      target.selectionEnd = cursor;
      fireInput(target, value);
      return true;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = Boolean(document.execCommand && document.execCommand('insertText', false, value));
    } catch (_error) {
      inserted = false;
    }
    if (!inserted) {
      target.textContent = `${target.textContent || ''}${value}`;
    }
    fireInput(target, value);
    return true;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'form button[type="submit"]'
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => !node.disabled && isVisible(node));
      if (candidates.length > 0) return candidates[candidates.length - 1];
    }
    return null;
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (inputs.length === 0) return null;
    const composer = findComposer();
    const form = composer && composer.closest('form');
    if (form) {
      const scoped = inputs.filter((input) => form.contains(input));
      if (scoped.length > 0) return scoped[scoped.length - 1];
    }
    return inputs[inputs.length - 1];
  }

  function findAttachTrigger() {
    const selectors = [
      'button[aria-label*="Attach" i]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Add photos" i]',
      '[data-testid*="attach" i]',
      '[data-testid*="upload" i]',
      '[data-testid*="plus" i]'
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      if (candidates.length > 0) return candidates[candidates.length - 1];
    }

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisible);
    return buttons.find((button) => /attach|upload|add photos|files|\+/i.test(button.getAttribute('aria-label') || button.textContent || "")) || null;
  }

  function findAddPhotosMenuItem() {
    const byText = Array.from(document.querySelectorAll('[role="menuitem"],button,div')).filter(isVisible)
      .find((node) => /add photos\s*&\s*files|add photos and files|upload file|upload files|attach files/i.test(node.textContent || ""));
    if (byText) return byText;
    const icon = document.querySelector('use[href*="#712359"], use[xlink\\:href*="#712359"]');
    return icon ? icon.closest('[role="menuitem"],button,[role="button"],div') : null;
  }

  function setFilesOnInput(input, fileObjects) {
    const dt = new DataTransfer();
    for (const file of fileObjects) dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function makeDataTransfer(fileObjects) {
    const dt = new DataTransfer();
    for (const file of fileObjects) {
      dt.items.add(file);
    }
    return dt;
  }

  function eventInitForTarget(target, dataTransfer) {
    let rect = null;
    try {
      rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    } catch (_error) {
      rect = null;
    }
    const x = rect ? Math.floor(rect.left + Math.max(1, rect.width / 2)) : Math.floor(window.innerWidth / 2);
    const y = rect ? Math.floor(rect.top + Math.max(1, rect.height / 2)) : Math.floor(window.innerHeight / 2);
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    };
  }

  function dispatchDragSequenceToTarget(fileObjects, target) {
    if (!target || !target.dispatchEvent) return false;
    const dt = makeDataTransfer(fileObjects);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      let event;
      try {
        event = new DragEvent(type, eventInitForTarget(target, dt));
      } catch (_error) {
        event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
      }
      target.dispatchEvent(event);
    }
    return true;
  }

  function getDropTargets() {
    const composer = findComposer();
    const form = composer && composer.closest('form');
    const candidates = [
      composer,
      form,
      document.querySelector('main'),
      document.querySelector('[data-testid="composer"]'),
      document.querySelector('[data-testid*="composer" i]'),
      document.querySelector('[data-testid*="upload" i]'),
      document.body,
      document.documentElement,
      document
    ].filter(Boolean);

    for (const selector of [
      '[aria-label*="Message" i]',
      '[aria-label*="Prompt" i]',
      '[data-testid*="prompt" i]',
      '[data-testid*="conversation" i]'
    ]) {
      for (const node of document.querySelectorAll(selector)) {
        candidates.push(node);
      }
    }

    return [...new Set(candidates)].filter((node) => node === document || isVisible(node));
  }

  async function waitForAttachmentConfirmation(fileObjects, timeoutMs) {
    const names = fileObjects.map((file) => file.name).filter(Boolean);
    if (names.length === 0) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = document.body ? document.body.innerText || "" : "";
      if (names.every((name) => text.includes(name))) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  function makeEmptyTransfer() {
    try { return new DataTransfer(); } catch (_error) { return null; }
  }

  function dispatchLightDragExit() {
    const targets = [findComposer(), document.body, document.documentElement, document].filter(Boolean);
    for (const target of [...new Set(targets)]) {
      try {
        const dt = makeEmptyTransfer();
        const init = { bubbles: true, cancelable: true, composed: true };
        if (dt) init.dataTransfer = dt;
        target.dispatchEvent(new DragEvent('dragleave', init));
      } catch (_error) {
        try { target.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true, composed: true })); } catch (__error) {}
      }
    }
  }

  function pressEscape() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    } catch (_error) {}
  }

  function hideStuckDropOverlays() {
    const phrases = [
      /drop any file here to add it to the conversation/i,
      /add anything/i,
      /drop\s+.*file\s+.*conversation/i,
      /drop.*file.*here/i
    ];

    function textMatches(node) {
      const text = String(node && node.textContent || '').replace(/\s+/g, ' ').trim();
      return text && text.length < 1000 && phrases.some((pattern) => pattern.test(text));
    }

    function overlayScore(node) {
      if (!node || node === document.body || node === document.documentElement || !node.getBoundingClientRect) return -1;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      let score = 0;
      if (style.position === 'fixed') score += 50;
      if (style.position === 'absolute') score += 20;
      if (Number(style.zIndex || 0) >= 10) score += 10;
      if (area / viewportArea > 0.20) score += 30;
      if (rect.top <= 80 && rect.left <= 80 && rect.bottom >= innerHeight * 0.5) score += 20;
      return score;
    }

    const candidates = [];
    const matchingNodes = Array.from(document.querySelectorAll('body *')).filter((node) => {
      try { return textMatches(node) && isVisible(node); } catch (_error) { return false; }
    });

    for (const node of matchingNodes) {
      let best = node;
      let bestScore = overlayScore(node);
      let current = node.parentElement;
      let steps = 0;
      while (current && current !== document.body && current !== document.documentElement && steps < 8) {
        const score = overlayScore(current);
        if (score > bestScore) {
          best = current;
          bestScore = score;
        }
        current = current.parentElement;
        steps += 1;
      }
      candidates.push(best);
    }

    let hidden = 0;
    for (const node of [...new Set(candidates)]) {
      try {
        node.setAttribute('data-relai-hidden-stuck-upload-overlay', 'true');
        node.style.setProperty('display', 'none', 'important');
        node.style.setProperty('pointer-events', 'none', 'important');
        node.style.setProperty('opacity', '0', 'important');
        node.style.setProperty('visibility', 'hidden', 'important');
        hidden += 1;
      } catch (_error) {}
    }
    return hidden;
  }

  async function dismissUploadOverlay() {
    // Fast cleanup: a single dragleave plus Escape is usually enough. The targeted overlay hide
    // remains as a safety net, but repeated dragend/drop/pointer/mouse storms were removed.
    dispatchLightDragExit();
    pressEscape();
    hideStuckDropOverlays();
    await sleep(50);
  }

  async function tryDragDropUpload(fileObjects, label) {
    const targets = getDropTargets().slice(0, 4);
    for (const target of targets) {
      try {
        dispatchDragSequenceToTarget(fileObjects, target);
        if (await waitForAttachmentConfirmation(fileObjects, 1800)) {
          await dismissUploadOverlay();
          setTimeout(() => { dismissUploadOverlay().catch(() => {}); }, 350);
          return { uploaded: true, uploadMethod: label };
        }
      } catch (_error) {
        // Try the next candidate target.
      }
    }
    await dismissUploadOverlay();
    return { uploaded: false, uploadMethod: label, uploadError: "ChatGPT did not show the ZIP attachment after drag/drop." };
  }

  async function tryPasteUpload(fileObjects) {
    const composer = findComposer();
    if (!composer) {
      return { uploaded: false, uploadMethod: "paste", uploadError: "No composer found for paste upload." };
    }
    try {
      const dt = makeDataTransfer(fileObjects);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
      composer.dispatchEvent(event);
      if (await waitForAttachmentConfirmation(fileObjects, 2200)) {
        return { uploaded: true, uploadMethod: "paste" };
      }
      return { uploaded: false, uploadMethod: "paste", uploadError: "ChatGPT did not show the ZIP attachment after paste." };
    } catch (error) {
      return { uploaded: false, uploadMethod: "paste", uploadError: error instanceof Error ? error.message : String(error) };
    }
  }

  async function tryFileInputUpload(fileObjects, method) {
    const input = findFileInput();
    if (!input) {
      return { uploaded: false, uploadMethod: method, uploadError: "No file input found." };
    }
    try {
      setFilesOnInput(input, fileObjects);
      if (await waitForAttachmentConfirmation(fileObjects, 2500)) {
        return { uploaded: true, uploadMethod: method };
      }
      return { uploaded: false, uploadMethod: method, uploadError: "File input changed, but ChatGPT did not show the ZIP attachment." };
    } catch (error) {
      return { uploaded: false, uploadMethod: method, uploadError: error instanceof Error ? error.message : String(error) };
    }
  }

  async function uploadFiles(fileItems) {
    if (!Array.isArray(fileItems) || fileItems.length === 0) {
      return { uploaded: false, uploadMethod: "none" };
    }

    const fileObjects = fileItems.map(makeFile);
    const result = await tryDragDropUpload(fileObjects, "main-world-drag-drop");
    if (result.uploaded) return result;

    return {
      uploaded: false,
      uploadMethod: "main-world-drag-drop",
      uploadError: result.uploadError || "ChatGPT did not confirm the ZIP attachment. Use the draggable ZIP chip fallback."
    };
  }

  return (async () => {
    const upload = await uploadFiles(files || []);
    await dismissUploadOverlay();
    const target = findComposer();
    if (!target) {
      try { navigator.clipboard.writeText(String(text || '')); } catch (_error) {}
      return { ok: false, uploaded: upload.uploaded, uploadMethod: upload.uploadMethod, uploadError: upload.uploadError, message: 'Could not find the ChatGPT composer. The request was copied to clipboard if permission allowed it.' };
    }

    insertText(target, String(text || ''));

    if (!submit) {
      await dismissUploadOverlay();
      setTimeout(() => { dismissUploadOverlay().catch(() => {}); }, 800);
      return { ok: true, uploaded: upload.uploaded, uploadMethod: upload.uploadMethod, uploadError: upload.uploadError, message: upload.uploaded ? `Uploaded ${files.length} file(s) and inserted request.` : 'Inserted request text.', submitted: false };
    }

    if (upload.uploaded) {
      await sleep(1500);
    }
    const sendButton = findSendButton();
    if (!sendButton) {
      return { ok: true, uploaded: upload.uploaded, uploadMethod: upload.uploadMethod, uploadError: upload.uploadError, message: 'Inserted request, but could not find ChatGPT send button.', submitted: false };
    }
    sendButton.click();
    return { ok: true, uploaded: upload.uploaded, uploadMethod: upload.uploadMethod, uploadError: upload.uploadError, message: upload.uploaded ? `Uploaded ${files.length} file(s), inserted, and submitted request.` : 'Inserted and submitted text to ChatGPT.', submitted: true };
  })();
}

function buildChatGPTRequestPrompt(context, task, response) {
  const title = String(task.title || context.title || "Rel.AI code request").trim();
  const userPrompt = String(task.prompt || context.prompt || "").trim();
  const testCommandKey = String(task.testCommandKey || "").trim();
  const fallbackEnabled = task.fallbackEnabled === true;
  const workspace = context.workspace;
  const contextMode = response.contextMode || context.contextMode || "readable";
  const metadataTemplate = {
    version: 1,
    workspace,
    title,
    prompt: userPrompt.slice(0, 1000),
    ...(testCommandKey ? { testCommandKey } : {}),
    fallback: {
      enabled: fallbackEnabled,
      tool: "opencode",
      instructions: "If the patch or tests fail, make the smallest safe repair. Do not refactor unrelated code."
    }
  };

  const baseInstructions = `Rel.AI code request

Task title: ${title}
Workspace alias: ${workspace}
Context mode: ${contextMode}

User task:
${userPrompt}

Instructions for your response:
- Produce code changes as a unified git diff.
- Do NOT put the diff inside a JSON string. Raw multiline diffs inside JSON break parsing.
- When ready to apply, reply with exactly two fenced code blocks and no extra prose:

First block: rel-ai-apply metadata JSON only, no diff field:
\`\`\`rel-ai-apply
${JSON.stringify(metadataTemplate, null, 2)}
\`\`\`

Second block: the unified diff:
\`\`\`diff
diff --git a/path/to/file b/path/to/file
--- a/path/to/file
+++ b/path/to/file
@@ -1,1 +1,1 @@
-old
+new
\`\`\`

Rules:
- Keep paths relative to the workspace.
- Do not include absolute paths or ../ paths.
- Do not include a raw testCommand. Use testCommandKey only if provided.
- Prefer the smallest safe change. Do not refactor unrelated code.
- If more context is required, reply with a \`\`\`rel-ai-context block listing the additional files needed instead of guessing.
`;

  if (contextMode === "zip") {
    const archiveName = response.archiveName || "rel-ai-context.zip";
    return `${baseInstructions}
Attached ZIP context:
- I have attached a real ZIP file named ${archiveName} through ChatGPT's file upload UI.
- Inspect the uploaded archive contents and use them as the source context.
- If the ZIP is unavailable or you cannot inspect it, do not guess. Ask me to resend in Readable text mode or select a narrower file list.

${response.bundle}`;
  }

  return `${baseInstructions}
Use only the readable workspace context below unless you explicitly ask for more files. Do not assume unseen files.

${response.bundle}`;
}

async function getSettings() {
  return chrome.storage.sync.get({ inlineButtonsEnabled: true });
}

async function setInlineButtonsEnabled(enabled) {
  await chrome.storage.sync.set({ inlineButtonsEnabled: enabled });
}

function isChatGPTUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(String(url || ""));
}

async function getTargetChatGPTTab(requireTab = true) {
  const active = await getActiveTab();
  if (active && typeof active.id === "number" && isChatGPTUrl(active.url)) {
    return active;
  }

  const currentWindowTabs = await chrome.tabs.query({
    currentWindow: true,
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
  if (currentWindowTabs.length > 0) {
    return currentWindowTabs[currentWindowTabs.length - 1];
  }

  const allTabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
  if (allTabs.length > 0) {
    return allTabs[allTabs.length - 1];
  }

  if (requireTab) {
    throw new Error("Open ChatGPT in a browser tab first.");
  }
  return null;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.windowId === "number") {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_error) {}
    }
    try { await chrome.tabs.update(tabId, { active: true }); } catch (_error) {}
  } catch (_error) {}
}

async function scanTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "relai.scanNow" });
    return { ok: true, message: "Scanned the active page for Rel.AI blocks." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function applyFromTab(tabId, mode, providedText, options) {
  const textResult = providedText
    ? { ok: true, text: providedText, source: "selection" }
    : await getTextFromTab(tabId, "apply", mode);

  if (!textResult.ok || !textResult.text || !textResult.text.trim()) {
    throw new Error(textResult.error || "No Rel.AI patch text found. Select a patch block, click an inline button, or use manual paste.");
  }

  return applyText(textResult.text, textResult.source || mode || "active-tab", options || {});
}

async function contextFromTab(tabId, mode, providedText) {
  const textResult = providedText
    ? { ok: true, text: providedText, source: "selection" }
    : await getTextFromTab(tabId, "context", mode);

  if (!textResult.ok || !textResult.text || !textResult.text.trim()) {
    throw new Error(textResult.error || "No Rel.AI context request found. Select a rel-ai-context block, click an inline button, or use manual paste.");
  }

  return contextText(textResult.text, textResult.source || mode || "active-tab", tabId);
}

async function getTextFromTab(tabId, kind, mode) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "relai.getBlockText", kind, mode });
    if (response && response.ok) {
      return response;
    }
  } catch (_error) {
    // Fall through to script injection.
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractRelAiTextInPage,
    args: [kind, mode]
  });

  const result = results && results[0] ? results[0].result : undefined;
  if (!result) {
    return { ok: false, error: "Could not read text from the active page." };
  }
  return result;
}

function extractRelAiTextInPage(kind, mode) {
  const applyFenceRe = /```(?:rel-ai-apply|relai-apply|rel-ai-diff|relai-diff|rel-ai-patch|diff|json)\s*[\s\S]*?```/gi;
  const contextFenceRe = /```(?:rel-ai-context|relai-context|rel-ai-source|relai-source|json)\s*[\s\S]*?```/gi;

  function getSelectedText() {
    const selected = String(window.getSelection ? window.getSelection() : "").trim();
    if (selected) {
      return selected;
    }

    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      const start = active.selectionStart || 0;
      const end = active.selectionEnd || 0;
      if (end > start) {
        return active.value.slice(start, end).trim();
      }
    }

    return "";
  }

  function normalizeBlockText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("{") || trimmed.startsWith("diff --git ") || trimmed.startsWith("--- a/")) {
      return trimmed;
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1).trim();
    }
    return trimmed;
  }

  function looksLike(text) {
    const raw = String(text || "");
    if (kind === "context") {
      return /```(?:rel-ai-context|relai-context|rel-ai-source|relai-source)/i.test(raw)
        || (/"version"\s*:\s*1/.test(raw) && /"include"\s*:/.test(raw));
    }
    return /```(?:rel-ai-apply|relai-apply|rel-ai-diff|relai-diff|rel-ai-patch|diff|json)/i.test(raw)
      || (/"version"\s*:\s*1/.test(raw) && (/"diff"\s*:/.test(raw) || /"workspace"\s*:/.test(raw)))
      || raw.trim().startsWith("diff --git ")
      || raw.trim().startsWith("--- a/");
  }

  function getMessageContainer(block) {
    return block.closest('article, [data-message-author-role], [data-testid^="conversation-turn"], main div[class*="group"]');
  }

  function ensureFence(text, lang) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("```")) {
      return trimmed;
    }
    return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
  }

  function collectApplyTextForBlock(block, text) {
    const message = getMessageContainer(block);
    if (!message) {
      return text;
    }
    const blocks = [...message.querySelectorAll("pre")].map((node) => normalizeBlockText(node.innerText || node.textContent || ""));
    const meta = blocks.find((item) => /```(?:rel-ai-apply|relai-apply|rel-ai-patch)/i.test(item) || (item.startsWith("{") && /"version"\s*:\s*1/.test(item)));
    const diff = blocks.find((item) => /```(?:diff|rel-ai-diff|relai-diff)/i.test(item) || item.startsWith("diff --git ") || item.startsWith("--- a/"));
    if (meta && diff && meta !== diff) {
      return `${ensureFence(meta, "rel-ai-apply")}\n\n${ensureFence(diff, "diff")}`;
    }
    return text;
  }

  function getLatestBlock() {
    const codeBlocks = [...document.querySelectorAll("pre")];
    const matches = [];
    for (const node of codeBlocks) {
      const text = normalizeBlockText(node.innerText || node.textContent || "");
      if (text && looksLike(text)) {
        matches.push(kind === "apply" ? collectApplyTextForBlock(node, text) : text);
      }
    }

    if (matches.length > 0) {
      return matches[matches.length - 1];
    }

    const text = document.body ? document.body.innerText : "";
    const fallbackMatches = text.match(kind === "context" ? contextFenceRe : applyFenceRe) || [];
    return fallbackMatches.length > 0 ? fallbackMatches[fallbackMatches.length - 1].trim() : "";
  }

  const selectedText = getSelectedText();
  const latestBlock = getLatestBlock();

  if (mode === "selection") {
    return { ok: Boolean(selectedText), text: selectedText, source: "selection" };
  }

  if (mode === "latest") {
    return { ok: Boolean(latestBlock), text: latestBlock, source: `latest-${kind}-block` };
  }

  const text = selectedText || latestBlock;
  return { ok: Boolean(text), text, source: selectedText ? "selection" : `latest-${kind}-block` };
}

async function applyText(text, source, options) {
  const apply = RelAiProtocol.parseApplyFromText(text);
  if (typeof (options && options.fallbackEnabled) === "boolean") {
    apply.fallback = {
      ...(apply.fallback || { tool: "opencode", instructions: "If the patch or tests fail, make the smallest safe repair. Do not refactor unrelated code." }),
      enabled: options.fallbackEnabled
    };
  }
  if (options && options.dryRun) {
    apply.dryRun = true;
    apply.runTests = false;
    if (apply.fallback) {
      apply.fallback = { ...apply.fallback, enabled: false };
    }
  }
  const message = RelAiProtocol.makeApplyMessage(apply, `browser:${source}`);
  return sendNativeMessage(message);
}

async function contextText(text, source, tabId) {
  const context = RelAiProtocol.parseContextFromText(text);
  const message = RelAiProtocol.makeContextMessage(context, `browser:${source}`);
  const response = await sendNativeMessage(message);

  if (response && response.ok && response.bundle && typeof tabId === "number") {
    const attachedFiles = response.contextMode === "zip" && response.archiveBase64
      ? [{
        name: response.archiveName || "rel-ai-context.zip",
        mimeType: response.archiveMimeType || "application/zip",
        base64: response.archiveBase64
      }]
      : [];
    const inserted = await insertRequestIntoTab(tabId, response.bundle, false, attachedFiles);
    return {
      ...response,
      inserted: Boolean(inserted && inserted.ok),
      archiveUploaded: Boolean(inserted && inserted.uploaded),
      archiveBase64: response.contextMode === "zip" && !(inserted && inserted.uploaded) ? (response.archiveBase64 || "") : "",
      archivePath: response.archivePath || "",
      uploadMethod: inserted && inserted.uploadMethod,
      uploadError: inserted && inserted.uploadError,
      insertMessage: inserted && inserted.message
    };
  }

  return response;
}

function sendNativeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        const result = { ok: false, requestId: message.requestId, error: lastError.message, hostName: HOST_NAME };
        relaiLog("native.response.error", { requestType: message && message.type, hostName: HOST_NAME, error: lastError.message });
        resolve(result);
        return;
      }
      const result = response || { ok: false, requestId: message.requestId, error: "Native host returned an empty response.", hostName: HOST_NAME };
      relaiLog("native.response", {
        requestType: message && message.type,
        hostName: HOST_NAME,
        ok: Boolean(result && result.ok),
        responseType: result && result.type,
        contextMode: result && result.contextMode,
        archiveName: result && result.archiveName,
        archivePath: result && result.archivePath,
        hasArchiveBase64: Boolean(result && result.archiveBase64),
        nativeHost: result && result.nativeHost,
        error: result && result.error
      });
      resolve(result);
    });
  });
}
