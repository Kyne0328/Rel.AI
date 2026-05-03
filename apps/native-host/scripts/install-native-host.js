#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOST_NAME = "com.relai.request_builder";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = args.browser || "chrome";
  const extensionId = args["extension-id"] || args.extensionId;

  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Pass the browser extension ID: --extension-id abcdefghijklmnopqrstuvwxyzabcdef");
  }

  if (!["chrome", "edge"].includes(browser)) {
    throw new Error("--browser must be chrome or edge.");
  }

  const repoRoot = path.resolve(__dirname, "../../..");
  const hostScript = path.resolve(__dirname, "../src/index.js");
  if (!fs.existsSync(hostScript)) {
    throw new Error(`Native host script not found: ${hostScript}`);
  }

  const manifest = {
    name: HOST_NAME,
    description: "Rel.AI OpenCode native messaging host",
    path: process.execPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };

  const wrapperPath = createWrapper(repoRoot, hostScript);
  manifest.path = wrapperPath;

  const manifestPath = installManifest(browser, manifest);
  console.log(`Installed ${HOST_NAME} for ${browser}.`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Host: ${wrapperPath}`);
}

function createWrapper(repoRoot, hostScript) {
  const binDir = path.join(os.homedir(), ".rel-ai", "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });

  if (process.platform === "win32") {
    const wrapperPath = path.join(binDir, "relai-opencode-host.cmd");
    const contents = `@echo off\r\n"${process.execPath}" "${hostScript}"\r\n`;
    fs.writeFileSync(wrapperPath, contents, "utf8");
    return wrapperPath;
  }

  const wrapperPath = path.join(binDir, "relai-opencode-host");
  const contents = `#!/bin/sh\nexec "${process.execPath}" "${hostScript}"\n`;
  fs.writeFileSync(wrapperPath, contents, { mode: 0o700 });
  fs.chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

function installManifest(browser, manifest) {
  const manifestPath = getManifestPath(browser);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (process.platform === "win32") {
    const registryPath = browser === "chrome"
      ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
      : `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;
    const result = spawnSync("reg", ["add", registryPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
      stdio: "inherit"
    });
    if (result.status !== 0) {
      throw new Error("Failed to write Windows native messaging registry key.");
    }
  }

  return manifestPath;
}

function getManifestPath(browser) {
  if (process.platform === "darwin") {
    const appSupport = path.join(os.homedir(), "Library", "Application Support");
    if (browser === "chrome") {
      return path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`);
    }
    return path.join(appSupport, "Microsoft Edge", "NativeMessagingHosts", `${HOST_NAME}.json`);
  }

  if (process.platform === "win32") {
    const base = path.join(os.homedir(), ".rel-ai", "native-messaging-hosts");
    return path.join(base, browser, `${HOST_NAME}.json`);
  }

  if (browser === "chrome") {
    return path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`);
  }
  return path.join(os.homedir(), ".config", "microsoft-edge", "NativeMessagingHosts", `${HOST_NAME}.json`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
