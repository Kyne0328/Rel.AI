(() => {
  const APPLY_BUTTON_CLASS = "relai-patch-button";
  const CONTEXT_BUTTON_CLASS = "relai-context-button";
  const STATUS_CLASS = "relai-patch-status";
  const APPLY_META_FENCE_RE = /```(?:rel-ai-apply|relai-apply|rel-ai-patch)\s*[\s\S]*?```/gi;
  const DIFF_FENCE_RE = /```(?:diff|rel-ai-diff|relai-diff)\s*[\s\S]*?```/gi;
  const CONTEXT_FENCE_RE = /```(?:rel-ai-context|relai-context|rel-ai-source|relai-source)\s*[\s\S]*?```/gi;
  function relaiContentLog(stage, details) {
    try { console.log("[Rel.AI Content]", stage, details || {}); } catch (_error) {}
  }

  relaiContentLog("loaded", { href: location.href, extensionId: chrome && chrome.runtime && chrome.runtime.id });

  const STABLE_MESSAGE_SELECTORS = [
    '[data-testid^="conversation-turn"]',
    'article',
    '[data-message-author-role]',
    'main div[class*="group"]'
  ];

  let relAiStopped = false;
  let observer = null;

  startRelAiContentScript();

  function startRelAiContentScript() {
    if (!isExtensionContextAlive()) {
      stopRelAiContentScript();
      return;
    }

    injectStyles();
    scanWhenEnabled();

    observer = new MutationObserver(() => {
      if (relAiStopped || !isExtensionContextAlive()) {
        stopRelAiContentScript();
        return;
      }
      window.clearTimeout(observer._relAiTimer);
      observer._relAiTimer = window.setTimeout(scanWhenEnabled, 700);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        relaiContentLog("message.received", { type: message && message.type });
        if (relAiStopped || !isExtensionContextAlive()) {
          sendResponse({ ok: false, error: "Rel.AI extension context was reloaded. Refresh this ChatGPT tab." });
          return true;
        }

        try {
          if (message && message.type === "relai.scanNow") {
            scanForBlocks(true);
            sendResponse({ ok: true, message: "Scanned page for Rel.AI blocks." });
            return true;
          }

          if (message && message.type === "relai.getBlockText") {
            const result = getBlockText(message.kind || "apply", message.mode || "auto");
            sendResponse(result);
            return true;
          }

          if (message && message.type === "relai.getApplyText") {
            const result = getBlockText("apply", message.mode || "auto");
            sendResponse(result);
            return true;
          }

          if (message && message.type === "relai.insertText") {
            const result = insertTextIntoComposer(String(message.text || ""), Boolean(message.submit));
            sendResponse(result);
            return true;
          }

          if (message && message.type === "relai.showArchiveChip") {
            relaiContentLog("showArchiveChip.message", { fileCount: Array.isArray(message.files) ? message.files.length : 0, names: Array.isArray(message.files) ? message.files.map((file) => file && file.name) : [] });
            const result = showArchiveChipFromMessage(Array.isArray(message.files) ? message.files : []);
            relaiContentLog("showArchiveChip.result", result);
            sendResponse(result);
            return true;
          }
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return true;
        }
        return false;
      });
    } catch (_error) {
      stopRelAiContentScript();
    }
  }

  function isExtensionContextAlive() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_error) {
      return false;
    }
  }

  function stopRelAiContentScript() {
    relAiStopped = true;
    if (observer) {
      try { observer.disconnect(); } catch (_error) {}
    }
  }

  function scanWhenEnabled() {
    if (relAiStopped || !isExtensionContextAlive()) {
      stopRelAiContentScript();
      return;
    }

    try {
      chrome.storage.sync.get({ inlineButtonsEnabled: true }, (stored) => {
        if (relAiStopped || !isExtensionContextAlive()) {
          stopRelAiContentScript();
          return;
        }
        if (stored.inlineButtonsEnabled) {
          scanForBlocks(false);
        }
      });
    } catch (_error) {
      stopRelAiContentScript();
    }
  }

  function scanForBlocks(_force) {
    const preBlocks = [...document.querySelectorAll("pre")];
    const messages = unique(preBlocks.map((block) => getMessageContainer(block)).filter(Boolean));

    for (const message of messages) {
      scanMessage(message);
    }

    for (const block of preBlocks) {
      if (!getMessageContainer(block)) {
        scanStandaloneBlock(block);
      }
    }
  }

  function scanMessage(message) {
    const blocks = [...message.querySelectorAll("pre")];
    if (blocks.length === 0) {
      removeApplyControls(message);
      return;
    }

    for (const block of blocks) {
      const text = normalizeBlockText(block.innerText || block.textContent || "");
      if (text && looksLikeContextBlock(text)) {
        addContextButton(block, text);
      }
    }

    const apply = collectApplyForMessage(blocks);
    if (apply) {
      addApplyButton(message, apply.text, apply.anchor);
    } else {
      removeApplyControls(message);
    }
  }

  function scanStandaloneBlock(block) {
    const text = normalizeBlockText(block.innerText || block.textContent || "");
    if (!text) {
      return;
    }

    if (looksLikeContextBlock(text)) {
      addContextButton(block, text);
      return;
    }

    const apply = collectApplyForMessage([block]);
    if (apply) {
      addApplyButton(block.parentElement || block, apply.text, apply.anchor);
    }
  }

  function collectApplyForMessage(blocks) {
    let meta = null;
    let diff = null;
    let singleApply = null;

    for (const block of blocks) {
      const text = normalizeBlockText(block.innerText || block.textContent || "");
      if (!text) {
        continue;
      }

      const parsed = parseJsonObjectFromBlockText(text);
      if (parsed && looksLikeApplyMetadataObject(parsed)) {
        const candidate = { block, text, parsed };
        if (typeof parsed.diff === "string" || Array.isArray(parsed.diffLines)) {
          singleApply = candidate;
        } else if (!meta) {
          meta = candidate;
        }
        continue;
      }

      if (!diff && looksLikeDiffBlock(text)) {
        diff = { block, text };
      }
    }

    if (meta && diff) {
      return {
        anchor: meta.block,
        text: `${ensureFence(meta.text, "rel-ai-apply")}\n\n${ensureFence(diff.text, "diff")}`
      };
    }

    if (singleApply) {
      return { anchor: singleApply.block, text: ensureFence(singleApply.text, "rel-ai-apply") };
    }

    return null;
  }

  function addApplyButton(containerTarget, text, anchorNode) {
    const message = getMessageContainer(containerTarget) || containerTarget;
    const id = `apply-${hashText(text)}`;
    const existing = [...message.querySelectorAll('.relai-patch-inline[data-relai-kind="apply"]')];

    if (message.dataset.relaiApplyButtonId === id && existing.length === 1) {
      return;
    }

    for (const node of existing) {
      node.remove();
    }

    message.dataset.relaiApplyButtonId = id;

    const container = document.createElement("div");
    container.className = "relai-patch-inline";
    container.dataset.relaiKind = "apply";
    container.dataset.relaiButtonId = id;

    const button = document.createElement("button");
    button.type = "button";
    button.className = APPLY_BUTTON_CLASS;
    button.textContent = "Apply with Rel.AI";

    const status = document.createElement("span");
    status.className = STATUS_CLASS;
    status.textContent = "";

    button.addEventListener("click", async () => {
      if (button.dataset.relaiBusy === "1") {
        return;
      }

      const decision = await showApplyPreview(text);
      if (!decision || decision.action === "cancel") {
        status.textContent = "Cancelled.";
        return;
      }

      button.dataset.relaiBusy = "1";
      button.disabled = true;
      status.textContent = decision.action === "dryRun" ? "Checking patch with git apply --check..." : "Applying with git apply...";

      const timers = [
        window.setTimeout(() => {
          status.textContent = decision.action === "dryRun"
            ? "Still checking with the native host..."
            : decision.fallbackEnabled
              ? "Still applying. OpenCode fallback may be running if git apply failed."
              : "Still applying with git apply...";
        }, 8000),
        window.setTimeout(() => {
          status.textContent = decision.fallbackEnabled
            ? "Still waiting for Rel.AI/OpenCode. OpenCode can take a while on fallback repairs."
            : "Still waiting for Rel.AI. Check the native host setup or your repo state.";
        }, 30000),
        window.setTimeout(() => {
          status.textContent = "This is taking unusually long. Check the extension service worker/native host logs and whether opencode is waiting for input.";
        }, 120000)
      ];

      try {
        const response = await runtimeMessageWithTimeout({
          type: "relai.applyInline",
          text,
          source: decision.action === "dryRun" ? "inline-preview-dry-run" : "inline-preview-apply",
          dryRun: decision.action === "dryRun",
          fallbackEnabled: decision.action === "dryRun" ? false : Boolean(decision.fallbackEnabled)
        }, 17 * 60 * 1000);

        if (!response || !response.ok) {
          status.textContent = describeApplyFailure(response);
          return;
        }
        status.textContent = summarizeApplyResult(response);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        for (const timer of timers) {
          window.clearTimeout(timer);
        }
        button.dataset.relaiBusy = "0";
        button.disabled = false;
      }
    });

    container.append(button, status);
    placeApplyControl(message, anchorNode || containerTarget, container);
  }

  function addContextButton(block, text) {
    const id = `context-${hashText(text)}`;
    if (hasInlineButton(block, id)) {
      return;
    }

    const container = document.createElement("div");
    container.className = "relai-patch-inline";
    container.dataset.relaiKind = "context";
    container.dataset.relaiButtonId = id;

    const button = document.createElement("button");
    button.type = "button";
    button.className = CONTEXT_BUTTON_CLASS;
    button.textContent = "Insert workspace context";

    const status = document.createElement("span");
    status.className = STATUS_CLASS;
    status.textContent = "";

    button.addEventListener("click", async () => {
      if (button.dataset.relaiBusy === "1") {
        return;
      }
      button.dataset.relaiBusy = "1";
      button.disabled = true;
      status.textContent = "Loading files...";
      try {
        const response = await runtimeMessageWithTimeout({
          type: "relai.contextInline",
          text,
          source: "inline-button"
        }, 60000);
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Rel.AI native bridge returned an error.");
        }
        status.textContent = response.inserted
          ? `Inserted ${response.fileCount || 0} file(s). Review and send.`
          : `Loaded ${response.fileCount || 0} file(s), but insertion failed: ${response.insertMessage || "unknown error"}`;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.dataset.relaiBusy = "0";
        button.disabled = false;
      }
    });

    container.append(button, status);
    placeInlineControl(block, container);
  }

  function runtimeMessageWithTimeout(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Rel.AI did not return before the browser timeout. If fallback was enabled, check .relai/fallback-latest.json in the workspace to see whether OpenCode is still running, failed, or timed out."));
      }, timeoutMs);

      if (relAiStopped || !isExtensionContextAlive()) {
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("Rel.AI extension was reloaded. Refresh this ChatGPT tab, then try again."));
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        settled = true;
        window.clearTimeout(timer);
        stopRelAiContentScript();
        reject(new Error("Rel.AI extension context was invalidated. Refresh this ChatGPT tab after reloading the extension."));
      }
    });
  }

  function placeApplyControl(message, anchorNode, container) {
    const toolbarTarget = findPreferredApplyToolbarTarget(message, anchorNode);
    if (toolbarTarget) {
      container.classList.add("relai-in-toolbar");
      toolbarTarget.insertAdjacentElement("afterend", container);
      return;
    }

    const block = anchorNode && anchorNode.closest ? anchorNode.closest("pre") : null;
    const codeWrapper = block && (block.closest('[data-testid="code-block"], .contain-inline-size, .overflow-y-auto') || block);
    if (codeWrapper) {
      codeWrapper.insertAdjacentElement("afterend", container);
      return;
    }

    message.insertAdjacentElement("beforeend", container);
  }

  function findPreferredApplyToolbarTarget(message, anchorNode) {
    if (!message || !message.querySelectorAll) {
      return null;
    }

    const exactIcons = [...message.querySelectorAll('svg.icon use[href*="#f6d0e2"]')].filter((node) => isVisible(node.ownerSVGElement || node));
    if (exactIcons.length > 0) {
      const icon = findNearestNodeToAnchor(exactIcons, anchorNode);
      return icon.closest('button, [role="button"], a') || icon.ownerSVGElement || icon;
    }

    const copyLikeButtons = [...message.querySelectorAll('button, [role="button"]')].filter((node) => {
      if (!isVisible(node)) {
        return false;
      }
      const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""} ${node.textContent || ""}`.toLowerCase();
      return /copy|clipboard/.test(label);
    });

    if (copyLikeButtons.length > 0) {
      return findNearestNodeToAnchor(copyLikeButtons, anchorNode);
    }

    return null;
  }

  function findNearestNodeToAnchor(nodes, anchorNode) {
    if (!anchorNode || !anchorNode.getBoundingClientRect) {
      return nodes[nodes.length - 1];
    }
    const anchorRect = anchorNode.getBoundingClientRect();
    let best = nodes[nodes.length - 1];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      const target = node.ownerSVGElement || node;
      if (!target.getBoundingClientRect) {
        continue;
      }
      const rect = target.getBoundingClientRect();
      const distance = Math.abs(rect.top - anchorRect.top) + Math.abs(rect.left - anchorRect.left);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  function placeInlineControl(target, container) {
    const block = target && target.closest ? target.closest("pre") : null;
    const codeWrapper = block && (block.closest('[data-testid="code-block"], .contain-inline-size, .overflow-y-auto') || block);
    if (codeWrapper) {
      codeWrapper.insertAdjacentElement("afterend", container);
      return;
    }

    const message = getMessageContainer(target) || target;
    message.insertAdjacentElement("beforeend", container);
  }

  function removeApplyControls(message) {
    for (const node of message.querySelectorAll('.relai-patch-inline[data-relai-kind="apply"]')) {
      node.remove();
    }
    delete message.dataset.relaiApplyButtonId;
  }

  function hasInlineButton(block, id) {
    const message = getMessageContainer(block) || block.parentElement;
    return Boolean(message && message.querySelector(`[data-relai-button-id="${id}"]`));
  }

  function getMessageContainer(node) {
    if (!node || !node.closest) {
      return null;
    }
    for (const selector of STABLE_MESSAGE_SELECTORS) {
      const match = node.closest(selector);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function ensureFence(text, lang) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("```")) {
      return trimmed;
    }
    return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
  }

  function hashText(text) {
    let hash = 0;
    const input = String(text || "");
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function getBlockText(kind, mode) {
    const selected = getSelectedText();
    const latest = getLatestBlock(kind);

    if (mode === "selection") {
      return { ok: Boolean(selected), text: selected, source: "selection" };
    }

    if (mode === "latest") {
      return { ok: Boolean(latest), text: latest, source: `latest-${kind}-block` };
    }

    const text = selected || latest;
    return { ok: Boolean(text), text, source: selected ? "selection" : `latest-${kind}-block` };
  }

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

  function getLatestBlock(kind) {
    const codeBlocks = [...document.querySelectorAll("pre")];

    if (kind === "apply") {
      const messages = unique(codeBlocks.map((block) => getMessageContainer(block)).filter(Boolean));
      const matches = [];
      for (const message of messages) {
        const collected = collectApplyForMessage([...message.querySelectorAll("pre")]);
        if (collected) {
          matches.push(collected.text);
        }
      }
      if (matches.length > 0) {
        return matches[matches.length - 1];
      }
    } else {
      const matches = [];
      for (const node of codeBlocks) {
        const text = normalizeBlockText(node.innerText || node.textContent || "");
        if (text && looksLikeContextBlock(text)) {
          matches.push(text);
        }
      }
      if (matches.length > 0) {
        return matches[matches.length - 1];
      }
    }

    const bodyText = document.body ? document.body.innerText : "";
    const fallbackMatches = bodyText.match(kind === "context" ? CONTEXT_FENCE_RE : APPLY_META_FENCE_RE) || [];
    if (kind === "apply" && fallbackMatches.length > 0) {
      const meta = fallbackMatches[fallbackMatches.length - 1].trim();
      const diffMatches = bodyText.match(DIFF_FENCE_RE) || [];
      return diffMatches.length > 0 ? `${meta}\n\n${diffMatches[diffMatches.length - 1].trim()}` : meta;
    }
    return fallbackMatches.length > 0 ? fallbackMatches[fallbackMatches.length - 1].trim() : "";
  }

  function normalizeBlockText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return "";
    }

    const withoutRenderedLabel = stripRenderedLanguageLabel(trimmed);
    if (withoutRenderedLabel !== trimmed) {
      return normalizeBlockText(withoutRenderedLabel);
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

  function stripRenderedLanguageLabel(text) {
    const lines = String(text || "").split(/\r?\n/);
    if (lines.length < 2) {
      return String(text || "").trim();
    }

    const first = lines[0].trim().toLowerCase();
    const labels = new Set([
      "rel-ai-apply",
      "relai-apply",
      "rel-ai-patch",
      "rel-ai-diff",
      "relai-diff",
      "diff",
      "json"
    ]);

    if (labels.has(first)) {
      return lines.slice(1).join("\n").trim();
    }

    return String(text || "").trim();
  }

  function looksLikeContextBlock(text) {
    const parsed = parseJsonObjectFromBlockText(text);
    return Boolean(parsed && parsed.version === 1 && typeof parsed.workspace === "string" && Array.isArray(parsed.include));
  }

  function looksLikeApplyMetadataObject(value) {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (value.version !== 1 || typeof value.workspace !== "string") {
      return false;
    }
    if (Array.isArray(value.include)) {
      return false;
    }

    const applyMarkers = [
      "diff",
      "diffLines",
      "prompt",
      "testCommandKey",
      "testCommand",
      "context",
      "fallback",
      "dryRun",
      "runTests"
    ];

    return applyMarkers.some((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function looksLikeDiffBlock(text) {
    const raw = stripRenderedLanguageLabel(String(text || "").trim());
    if (!raw) {
      return false;
    }
    if (/^```(?:diff|rel-ai-diff|relai-diff)\s/i.test(raw)) {
      return true;
    }
    return raw.startsWith("diff --git ") || raw.startsWith("--- a/");
  }

  function parseJsonObjectFromBlockText(text) {
    const body = stripRenderedLanguageLabel(stripFence(String(text || "").trim()));
    const candidate = extractJsonObjectText(body);
    if (!candidate) {
      return null;
    }
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function stripFence(text) {
    const match = String(text || "").trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : String(text || "").trim();
  }

  function extractJsonObjectText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed;
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1).trim();
    }
    return "";
  }

  function insertTextIntoComposer(text, submit) {
    if (!text.trim()) {
      return { ok: false, message: "No text to insert." };
    }

    const target = findComposer();
    if (!target) {
      copyToClipboard(text);
      return { ok: false, message: "Could not find ChatGPT composer. Context was copied to clipboard if browser permissions allowed it." };
    }

    target.focus();

    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      const start = typeof target.selectionStart === "number" ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === "number" ? target.selectionEnd : target.value.length;
      target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
      const cursor = start + text.length;
      target.selectionStart = cursor;
      target.selectionEnd = cursor;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return finishInsert(submit);
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    const inserted = document.execCommand && document.execCommand("insertText", false, text);
    if (!inserted) {
      target.textContent = `${target.textContent || ""}${text}`;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }

    return finishInsert(submit);
  }

  function finishInsert(submit) {
    if (!submit) {
      return { ok: true, message: "Inserted text into composer.", submitted: false };
    }

    const sendButton = findSendButton();
    if (!sendButton) {
      return { ok: true, message: "Inserted text, but could not find ChatGPT send button.", submitted: false };
    }

    sendButton.click();
    return { ok: true, message: "Inserted and submitted text to ChatGPT.", submitted: true };
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
      const candidates = [...document.querySelectorAll(selector)].filter((node) => !node.disabled && isVisible(node));
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }

    const buttons = [...document.querySelectorAll("button")].filter((node) => {
      const label = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`.toLowerCase();
      return !node.disabled && isVisible(node) && /send|submit/.test(label);
    });

    return buttons.length > 0 ? buttons[buttons.length - 1] : null;
  }

  function findComposer() {
    const selectors = [
      'textarea[data-testid="prompt-textarea"]',
      'div[data-testid="prompt-textarea"][contenteditable="true"]',
      'form textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const candidates = [...document.querySelectorAll(selector)].filter(isUsableComposer);
      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }

    return null;
  }

  function isUsableComposer(node) {
    if (!node || node.closest("pre, code")) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 100 && rect.height > 10 && getComputedStyle(node).visibility !== "hidden";
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_error) {
      // Browser clipboard access can fail without a direct user gesture.
    }
  }

  function showApplyPreview(text) {
    return new Promise((resolve) => {
      const preview = parseApplyPreview(text);
      const overlay = document.createElement("div");
      overlay.className = "relai-preview-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");

      const panel = document.createElement("div");
      panel.className = "relai-preview-panel";

      const header = document.createElement("div");
      header.className = "relai-preview-header";
      const title = document.createElement("h2");
      title.textContent = "Review Rel.AI patch before applying";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "relai-preview-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close Rel.AI preview");
      header.append(title, close);

      const metaGrid = document.createElement("div");
      metaGrid.className = "relai-preview-grid";
      addPreviewField(metaGrid, "Workspace", preview.workspace || "missing");
      addPreviewField(metaGrid, "Test command", preview.testCommandKey || preview.testCommand || "none");
      addPreviewField(metaGrid, "Fallback from patch", preview.fallbackEnabled ? "enabled" : "disabled");
      addPreviewField(metaGrid, "Files", preview.files.length ? preview.files.join("\n") : "No recognizable paths found");

      const fallbackControl = document.createElement("label");
      fallbackControl.className = "relai-preview-toggle";
      const fallbackCheckbox = document.createElement("input");
      fallbackCheckbox.type = "checkbox";
      fallbackCheckbox.checked = preview.fallbackEnabled;
      const fallbackText = document.createElement("span");
      fallbackText.textContent = "Use OpenCode fallback if git apply or tests fail";
      fallbackControl.append(fallbackCheckbox, fallbackText);

      const warning = document.createElement("p");
      warning.className = "relai-preview-warning";
      warning.textContent = "Rel.AI will run git apply inside the configured workspace alias. Review the diff below before continuing. Check only never runs OpenCode fallback.";

      const diffTitle = document.createElement("h3");
      diffTitle.textContent = "Unified diff";
      const diffBox = document.createElement("pre");
      diffBox.className = "relai-preview-diff";
      diffBox.textContent = preview.diff || "No diff detected.";

      const errorBox = document.createElement("div");
      errorBox.className = "relai-preview-error";
      if (preview.error) {
        errorBox.textContent = preview.error;
      }

      const actions = document.createElement("div");
      actions.className = "relai-preview-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const dryRun = document.createElement("button");
      dryRun.type = "button";
      dryRun.textContent = "Check only";
      dryRun.title = "Runs git apply --check. No files change.";
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "relai-preview-apply";
      apply.textContent = "Apply patch";

      if (preview.error) {
        dryRun.disabled = true;
        apply.disabled = true;
      }

      actions.append(cancel, dryRun, apply);
      panel.append(header, metaGrid, fallbackControl, warning, diffTitle, diffBox, errorBox, actions);
      overlay.append(panel);
      document.body.appendChild(overlay);

      function done(action) {
        const fallbackEnabled = Boolean(fallbackCheckbox.checked);
        overlay.remove();
        document.removeEventListener("keydown", onKeydown, true);
        resolve({ action, fallbackEnabled });
      }

      function onKeydown(event) {
        if (event.key === "Escape") {
          done("cancel");
        }
      }

      close.addEventListener("click", () => done("cancel"));
      cancel.addEventListener("click", () => done("cancel"));
      dryRun.addEventListener("click", () => done("dryRun"));
      apply.addEventListener("click", () => done("apply"));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          done("cancel");
        }
      });
      document.addEventListener("keydown", onKeydown, true);
      apply.focus();
    });
  }

  function addPreviewField(parent, label, value) {
    const item = document.createElement("div");
    item.className = "relai-preview-field";
    const labelNode = document.createElement("strong");
    labelNode.textContent = label;
    const valueNode = document.createElement("span");
    valueNode.textContent = String(value || "");
    item.append(labelNode, valueNode);
    parent.appendChild(item);
  }

  function parseApplyPreview(text) {
    const result = {
      workspace: "",
      testCommandKey: "",
      testCommand: "",
      fallbackEnabled: false,
      files: [],
      diff: "",
      error: ""
    };

    try {
      const metaMatches = [...String(text || "").matchAll(/```(?:rel-ai-apply|relai-apply|rel-ai-patch)\s*([\s\S]*?)```/gi)];
      const diffMatches = [...String(text || "").matchAll(/```(?:diff|rel-ai-diff|relai-diff)\s*([\s\S]*?)```/gi)];
      let metadata = null;
      if (metaMatches.length > 0) {
        metadata = JSON.parse(metaMatches[metaMatches.length - 1][1].trim());
      } else {
        metadata = parseJsonObjectFromBlockText(text);
      }

      if (metadata) {
        result.workspace = typeof metadata.workspace === "string" ? metadata.workspace : "";
        result.testCommandKey = typeof metadata.testCommandKey === "string" ? metadata.testCommandKey : "";
        result.testCommand = typeof metadata.testCommand === "string" ? metadata.testCommand : "";
        result.fallbackEnabled = Boolean(metadata.fallback && metadata.fallback.enabled);
        if (typeof metadata.diff === "string") {
          result.diff = metadata.diff.trim();
        } else if (Array.isArray(metadata.diffLines)) {
          result.diff = metadata.diffLines.map((line) => String(line)).join("\n").trim();
        }
      }

      if (!result.diff && diffMatches.length > 0) {
        result.diff = diffMatches[diffMatches.length - 1][1].trim();
      }
      if (!result.diff) {
        result.diff = extractRawDiffForPreview(text);
      }
      result.files = extractFilesFromDiff(result.diff);
      if (!result.workspace) {
        result.error = "The apply metadata is missing a workspace alias.";
      } else if (!result.diff) {
        result.error = "No unified diff block was found.";
      } else if (result.files.length === 0) {
        result.error = "The diff does not contain recognizable file paths.";
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  function extractRawDiffForPreview(text) {
    const raw = stripRenderedLanguageLabel(String(text || ""));
    const gitIndex = raw.indexOf("diff --git ");
    if (gitIndex !== -1) {
      return raw.slice(gitIndex).trim();
    }
    const simpleIndex = raw.indexOf("--- a/");
    if (simpleIndex !== -1) {
      return raw.slice(simpleIndex).trim();
    }
    return "";
  }

  function extractFilesFromDiff(diff) {
    const out = [];
    for (const line of String(diff || "").split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
        if (match) {
          out.push(match[1], match[2]);
        }
      }
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const raw = line.slice(4).trim().split(/\s+/)[0];
        if (raw.startsWith("a/") || raw.startsWith("b/")) {
          out.push(raw.slice(2));
        }
      }
    }
    return [...new Set(out.filter((item) => item && item !== "/dev/null"))];
  }

  function describeApplyFailure(response) {
    if (!response) {
      return "Rel.AI native bridge returned an empty error.";
    }
    const parts = [];
    if (response.message) parts.push(response.message);
    if (response.error) parts.push(response.error);
    if (response.gitCheck && !response.gitCheck.ok) {
      parts.push(formatCommandDetails("git apply --check", response.gitCheck));
    }
    if (response.gitApply && !response.gitApply.ok) {
      parts.push(formatCommandDetails("git apply", response.gitApply));
    }
    if (response.test && !response.test.ok) {
      parts.push(formatCommandDetails("test command", response.test));
    }
    if (response.fallback && !response.fallback.ok) {
      parts.push(formatCommandDetails("OpenCode fallback", response.fallback));
    }
    return parts.filter(Boolean).join(" | ") || "Rel.AI native bridge returned an error.";
  }

  function formatCommandDetails(label, result) {
    const details = [];
    if (result.exitCode !== undefined) details.push(`exit ${result.exitCode}`);
    if (result.signal) details.push(`signal ${result.signal}`);
    if (result.timedOut) details.push(`timed out after ${Math.round((result.timeoutMs || 0) / 1000)}s`);
    const output = result.stderr || result.stdout || result.error || "";
    const trimmed = String(output || "").trim();
    return `${label}${details.length ? ` (${details.join(", ")})` : ""}${trimmed ? `: ${trimmed.slice(0, 1200)}` : ""}`;
  }

  function summarizeApplyResult(response) {
    if (response.dryRun) {
      return "Dry run passed. No files changed.";
    }
    if (response.fallback) {
      const base = response.message || (response.fallback.ok ? "OpenCode fallback completed." : "OpenCode fallback failed.");
      const details = [];
      if (response.fallback.status) details.push(`status: ${response.fallback.status}`);
      if (response.fallback.exitCode !== undefined) details.push(`exit: ${response.fallback.exitCode}`);
      if (response.fallback.signal) details.push(`signal: ${response.fallback.signal}`);
      if (response.fallback.timedOut) details.push(`timed out after ${Math.round((response.fallback.timeoutMs || 0) / 1000)}s`);
      if (response.fallback.statusFile) details.push(`status: ${response.fallback.statusFile}`);
      if (response.fallback.promptFile) details.push(`prompt: ${response.fallback.promptFile}${response.fallback.promptFileRemoved ? " (removed after run)" : ""}`);
      if (!response.fallback.ok) {
        const detail = response.fallback.error || response.fallback.stderr || response.fallback.stdout || "";
        if (detail) details.push(String(detail).slice(0, 500));
      }
      return details.length ? `${base} ${details.join(" | ")}` : base;
    }
    if (response.test && response.test.exitCode !== undefined) {
      return response.test.ok ? "Patch applied; tests passed." : "Patch applied; tests failed.";
    }
    if (response.gitApply && response.gitApply.ok) {
      return response.message || "Patch applied to the workspace files.";
    }
    return response.message || "Rel.AI finished.";
  }

  function injectStyles() {
    if (document.getElementById("relai-patch-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "relai-patch-styles";
    style.textContent = `
      .relai-patch-inline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 10px 0 12px;
        vertical-align: middle;
      }
      .relai-patch-inline.relai-in-toolbar {
        margin: 0 0 0 6px;
      }
      .relai-patch-button,
      .relai-context-button {
        border: 1px solid rgba(127,127,127,.45);
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        background: rgba(127,127,127,.09);
        color: inherit;
      }
      .relai-patch-button:hover,
      .relai-context-button:hover {
        background: rgba(127,127,127,.16);
      }
      .relai-patch-button:disabled,
      .relai-context-button:disabled {
        opacity: .65;
        cursor: not-allowed;
      }
      .relai-patch-status {
        font-size: 12px;
        opacity: .8;
      }
      .relai-preview-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0,0,0,.45);
      }
      .relai-preview-panel {
        box-sizing: border-box;
        width: min(980px, 96vw);
        max-height: 92vh;
        overflow: auto;
        border: 1px solid rgba(127,127,127,.35);
        border-radius: 14px;
        padding: 16px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 20px 70px rgba(0,0,0,.35);
      }
      .relai-preview-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .relai-preview-header h2,
      .relai-preview-panel h3 {
        margin: 0;
        font-size: 16px;
      }
      .relai-preview-close {
        border: 0;
        background: transparent;
        color: inherit;
        font-size: 24px;
        cursor: pointer;
      }
      .relai-preview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
        margin: 10px 0;
      }
      .relai-preview-field {
        border: 1px solid rgba(127,127,127,.28);
        border-radius: 8px;
        padding: 8px;
        background: rgba(127,127,127,.06);
      }
      .relai-preview-field strong,
      .relai-preview-field span {
        display: block;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .relai-preview-field strong {
        font-size: 11px;
        opacity: .7;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      .relai-preview-warning {
        margin: 10px 0;
        font-size: 13px;
        opacity: .85;
      }
      .relai-preview-diff {
        max-height: 46vh;
        overflow: auto;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid rgba(127,127,127,.35);
        background: rgba(127,127,127,.08);
        font-size: 12px;
        line-height: 1.35;
        white-space: pre;
      }
      .relai-preview-error {
        color: #b00020;
        font-size: 13px;
        margin-top: 8px;
      }
      .relai-preview-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
      .relai-preview-actions button {
        border: 1px solid rgba(127,127,127,.45);
        border-radius: 8px;
        padding: 8px 12px;
        background: rgba(127,127,127,.08);
        color: inherit;
        cursor: pointer;
      }
      .relai-preview-actions button:disabled {
        opacity: .55;
        cursor: not-allowed;
      }
      .relai-preview-apply {
        font-weight: 700;
      }

    `;
    document.documentElement.appendChild(style);
  }


  function showArchiveChipFromMessage(files) {
    relaiContentLog("showArchiveChipFromMessage.start", { fileCount: Array.isArray(files) ? files.length : 0 });
    try {
      const items = Array.isArray(files) ? files.filter((item) => item && item.base64) : [];
      if (items.length === 0) {
        return { ok: false, error: "No ZIP data was provided for the drag chip." };
      }
      const item = items[0];
      const file = makeArchiveFile(item);
      removeArchiveChip();
      addArchiveChipStyles();

      const panel = document.createElement("div");
      panel.setAttribute("data-relai-archive-chip", "true");
      panel.setAttribute("aria-live", "polite");

      const header = document.createElement("div");
      header.className = "relai-chip-header";
      const title = document.createElement("div");
      title.className = "relai-chip-title";
      title.textContent = "Rel.AI ZIP ready";
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
      icon.textContent = "ZIP";

      const textWrap = document.createElement("div");
      textWrap.className = "relai-chip-text";
      const name = document.createElement("div");
      name.className = "relai-chip-name";
      name.textContent = file.name;
      const meta = document.createElement("div");
      meta.className = "relai-chip-meta";
      meta.textContent = `${formatArchiveBytes(file.size)} • drag into the message box`;
      textWrap.append(name, meta);
      chip.append(icon, textWrap);

      const setDragPayload = (event) => {
        panel.classList.add("relai-chip-dragging");
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "copy";
        try { event.dataTransfer.items.add(file); } catch (_error) {}
        try { event.dataTransfer.setData("text/plain", file.name); } catch (_error) {}
        try { event.dataTransfer.setData("DownloadURL", `application/zip:${file.name}:data:application/zip;base64,${String(item.base64 || "")}`); } catch (_error) {}
      };

      chip.addEventListener("dragstart", setDragPayload);
      chip.addEventListener("dragend", () => panel.classList.remove("relai-chip-dragging"));
      chip.addEventListener("keydown", (event) => {
        if (event.key === "Escape") panel.remove();
      });

      const help = document.createElement("div");
      help.className = "relai-chip-help";
      help.textContent = "Drag this ZIP card into ChatGPT's composer/upload area. If the composer is hidden, scroll to the bottom first.";

      const nudge = document.createElement("div");
      nudge.className = "relai-chip-nudge";
      nudge.textContent = "Tip: drag from the dashed card, not this panel header.";

      panel.append(header, chip, help, nudge);
      document.body.appendChild(panel);

      try { panel.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_error) {}
      try { chip.focus({ preventScroll: true }); } catch (_error) {}

      const success = { ok: true, message: `Draggable ZIP chip shown for ${file.name}. Drag it into ChatGPT's composer.` };
      relaiContentLog("showArchiveChipFromMessage.success", success);
      return success;
    } catch (error) {
      const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
      relaiContentLog("showArchiveChipFromMessage.failure", failure);
      return failure;
    }
  }

  function makeArchiveFile(item) {
    const clean = String(item.base64 || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], item.name || "rel-ai-context.zip", {
      type: item.mimeType || "application/zip",
      lastModified: Date.now()
    });
  }

  function formatArchiveBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "unknown size";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function removeArchiveChip() {
    for (const node of document.querySelectorAll('[data-relai-archive-chip="true"]')) {
      node.remove();
    }
  }

  function addArchiveChipStyles() {
    if (document.getElementById("relai-archive-chip-style")) return;
    const style = document.createElement("style");
    style.id = "relai-archive-chip-style";
    style.textContent = `
      [data-relai-archive-chip="true"] {
        position: fixed !important;
        right: 22px !important;
        top: 84px !important;
        z-index: 2147483647 !important;
        width: min(390px, calc(100vw - 44px)) !important;
        box-sizing: border-box !important;
        border: 2px solid #10a37f !important;
        border-radius: 16px !important;
        background: #ffffff !important;
        color: #111827 !important;
        box-shadow: 0 18px 48px rgba(0,0,0,.32) !important;
        padding: 14px !important;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        font-size: 13px !important;
      }
      @media (prefers-color-scheme: dark) {
        [data-relai-archive-chip="true"] {
          background: #171717 !important;
          color: #f5f5f5 !important;
          border-color: #19c37d !important;
        }
      }
      [data-relai-archive-chip="true"] .relai-chip-header {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 8px !important;
        margin-bottom: 10px !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-title {
        font-weight: 800 !important;
        font-size: 14px !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-close {
        border: 0 !important;
        background: transparent !important;
        color: inherit !important;
        cursor: pointer !important;
        font-size: 22px !important;
        line-height: 1 !important;
        padding: 0 4px !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-file {
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        width: 100% !important;
        border: 2px dashed #10a37f !important;
        border-radius: 14px !important;
        background: rgba(16, 163, 127, .12) !important;
        color: inherit !important;
        cursor: grab !important;
        padding: 14px !important;
        text-align: left !important;
        box-sizing: border-box !important;
        user-select: none !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-file:active { cursor: grabbing !important; }
      [data-relai-archive-chip="true"] .relai-chip-icon {
        width: 42px !important;
        height: 42px !important;
        border-radius: 12px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: #10a37f !important;
        color: #ffffff !important;
        flex: 0 0 auto !important;
        font-weight: 800 !important;
        font-size: 12px !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-text { min-width: 0 !important; }
      [data-relai-archive-chip="true"] .relai-chip-name {
        font-weight: 750 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-meta,
      [data-relai-archive-chip="true"] .relai-chip-help,
      [data-relai-archive-chip="true"] .relai-chip-nudge {
        color: inherit !important;
        opacity: .78 !important;
        font-size: 12px !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-help {
        margin-top: 10px !important;
        line-height: 1.35 !important;
      }
      [data-relai-archive-chip="true"] .relai-chip-nudge {
        margin-top: 6px !important;
        font-style: italic !important;
      }
      [data-relai-archive-chip="true"].relai-chip-dragging .relai-chip-file {
        outline: 3px solid rgba(16, 163, 127, .55) !important;
        background: rgba(16, 163, 127, .22) !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

})();
