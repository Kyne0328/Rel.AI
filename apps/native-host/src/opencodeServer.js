const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getRelAiDir } = require("./config");

function startOpenCodeServer(workspace, config) {
  const existing = getOpenCodeServerStatus(workspace, config);
  if (existing.running) {
    return {
      ok: true,
      type: "relai.opencodeServer",
      workspace: workspace.alias,
      alreadyRunning: true,
      running: true,
      pid: existing.pid,
      url: existing.url,
      statusFile: existing.statusFile,
      opencodeServer: existing,
      message: `OpenCode server is already running for ${workspace.alias} (pid ${existing.pid}).`
    };
  }

  const command = config.opencodeCommand || "opencode";
  const args = Array.isArray(config.opencodeServerArgs) && config.opencodeServerArgs.length
    ? config.opencodeServerArgs
    : ["serve"];
  const url = config.opencodeServerUrl || "http://127.0.0.1:4096";
  const statusFile = getStatusFile(workspace.alias);
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: workspace.path,
        detached: true,
        stdio: "ignore",
        shell: false,
        env: {
          ...process.env,
          REL_AI: "1",
          REL_AI_OPENCODE_SERVER: "1"
        }
      });
    } catch (error) {
      resolve({
        ok: false,
        type: "relai.opencodeServer",
        workspace: workspace.alias,
        running: false,
        url,
        statusFile,
        error: error instanceof Error ? error.message : String(error),
        message: "Could not start OpenCode server."
      });
      return;
    }

    const snapshot = {
      status: "starting",
      workspace: workspace.alias,
      workspacePath: workspace.path,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      command: [command, ...args].join(" "),
      url,
      startedAt,
      statusFile
    };
    writeStatus(statusFile, snapshot);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      const failed = {
        ...snapshot,
        status: "failed",
        running: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      writeStatus(statusFile, failed);
      resolve({
        ok: false,
        type: "relai.opencodeServer",
        workspace: workspace.alias,
        running: false,
        pid: child.pid,
        url,
        statusFile,
        opencodeServer: failed,
        error: failed.error,
        message: "OpenCode server failed to start."
      });
    });

    child.unref();

    setTimeout(() => {
      if (settled) return;
      settled = true;
      const running = isPidRunning(child.pid);
      const ready = {
        ...snapshot,
        status: running ? "running" : "unknown",
        running,
        updatedAt: new Date().toISOString()
      };
      writeStatus(statusFile, ready);
      resolve({
        ok: running,
        type: "relai.opencodeServer",
        workspace: workspace.alias,
        running,
        pid: child.pid,
        url,
        statusFile,
        opencodeServer: ready,
        message: running
          ? `Started OpenCode server for ${workspace.alias} (pid ${child.pid}).`
          : "OpenCode server process did not stay running. Check your OpenCode install or server arguments."
      });
    }, 800);
  });
}

function getOpenCodeServerStatus(workspace, config) {
  const statusFile = getStatusFile(workspace.alias);
  const url = config.opencodeServerUrl || "http://127.0.0.1:4096";
  const status = readStatus(statusFile) || {
    status: "not_started",
    workspace: workspace.alias,
    workspacePath: workspace.path,
    url,
    statusFile
  };
  const pid = Number(status.pid || 0);
  const running = pid > 0 ? isPidRunning(pid) : false;
  const snapshot = {
    ...status,
    url: status.url || url,
    statusFile,
    running,
    status: running ? "running" : status.status === "not_started" ? "not_started" : "stopped",
    checkedAt: new Date().toISOString()
  };
  if (status.pid) {
    writeStatus(statusFile, snapshot);
  }
  return {
    ok: true,
    type: "relai.opencodeServer",
    workspace: workspace.alias,
    running,
    pid: snapshot.pid,
    url: snapshot.url,
    statusFile,
    opencodeServer: snapshot,
    message: running
      ? `OpenCode server appears to be running for ${workspace.alias} (pid ${snapshot.pid}).`
      : `OpenCode server is not running for ${workspace.alias}.`
  };
}

function getStatusFile(alias) {
  const safeAlias = String(alias || "workspace").replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = getRelAiDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `opencode-server-${safeAlias}.json`);
}

function writeStatus(file, value) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch (_error) {}
}

function readStatus(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function isPidRunning(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  startOpenCodeServer,
  getOpenCodeServerStatus
};
