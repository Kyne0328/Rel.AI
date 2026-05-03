#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { startNativeMessagingLoop } = require("./nativeMessaging");
const { readConfig, resolveWorkspace } = require("./config");
const { validateNativeMessage, makeResponse } = require("./protocol");
const { applyPatchFirst } = require("./patchApply");
const { runOpenCodeFallback } = require("./opencode");
const { buildContextBundle } = require("./contextBundle");
const { listWorkspaceDirectory } = require("./workspaceList");

startNativeMessagingLoop(process.stdin, process.stdout, async (rawMessage) => {
  try {
    const config = readConfig();
    const message = validateNativeMessage(rawMessage, config);

    if (message.type === "ping") {
      return makeResponse({
        ok: true,
        type: "ping",
        requestId: message.requestId,
        nativeHost: getNativeHostInfo(),
        message: `Rel.AI bridge is installed. Workspaces: ${Object.keys(config.workspaces).sort().join(", ") || "none configured"}.`
      });
    }

    if (message.type === "relai.configSummary") {
      return makeResponse({
        ok: true,
        type: "relai.config",
        requestId: message.requestId,
        workspaces: summarizeWorkspaces(config),
        limits: {
          maxContextFiles: config.maxContextFiles,
          maxContextChars: config.maxContextChars,
          maxContextFileBytes: config.maxContextFileBytes,
          maxDiffChars: config.maxDiffChars
        },
        fallbackModel: config.fallbackModel || "",
        fallbackAgent: config.fallbackAgent || "",
        nativeHost: getNativeHostInfo(),
        message: `Loaded ${Object.keys(config.workspaces).length} workspace alias(es).`
      });
    }

    if (message.type === "relai.apply") {
      const workspace = resolveWorkspace(config, message.apply.workspace);
      const result = await applyPatchFirst(message.apply, workspace, config, runOpenCodeFallback);
      return makeResponse({
        ...result,
        requestId: message.requestId,
        nativeHost: getNativeHostInfo()
      });
    }

    if (message.type === "relai.context") {
      const workspace = resolveWorkspace(config, message.context.workspace);
      const result = buildContextBundle(message.context, workspace, config);
      return makeResponse({
        ...result,
        requestId: message.requestId,
        nativeHost: getNativeHostInfo(),
        message: `Loaded ${result.fileCount} file(s) from workspace ${workspace.alias}.`
      });
    }

    if (message.type === "relai.listWorkspace") {
      const workspace = resolveWorkspace(config, message.workspace);
      const result = listWorkspaceDirectory({ dir: message.dir }, workspace);
      return makeResponse({
        ...result,
        requestId: message.requestId,
        nativeHost: getNativeHostInfo()
      });
    }

    return makeResponse({
      ok: false,
      requestId: message.requestId,
      nativeHost: getNativeHostInfo(),
      error: `Unsupported message type: ${message.type}`
    });
  } catch (error) {
    return makeResponse({
      ok: false,
      requestId: rawMessage && rawMessage.requestId ? rawMessage.requestId : undefined,
      nativeHost: getNativeHostInfo(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

function summarizeWorkspaces(config) {
  return Object.entries(config.workspaces)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, entry]) => ({
      alias,
      path: entry.path,
      testCommands: Object.entries(entry.testCommands || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, command]) => ({ key, command }))
    }));
}

function getNativeHostInfo() {
  const root = path.resolve(__dirname, "../../..");
  let version = "unknown";
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    version = packageJson.version || version;
  } catch (_error) {}
  return {
    hostName: "com.relai.request_builder",
    version,
    root,
    entrypoint: __filename,
    pid: process.pid
  };
}
