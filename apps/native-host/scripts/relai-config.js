#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  getConfigPath,
  readConfig,
  writeConfig,
  isValidAlias
} = require("../src/config");

function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "show") {
    console.log(JSON.stringify(readConfig(), null, 2));
    return;
  }

  if (command === "workspace" && subcommand === "list") {
    listWorkspaces();
    return;
  }

  if (command === "workspace" && subcommand === "add") {
    addWorkspace(rest);
    return;
  }

  if (command === "workspace" && subcommand === "remove") {
    removeWorkspace(rest);
    return;
  }

  if (command === "test-command" && subcommand === "add") {
    addTestCommand(rest);
    return;
  }

  if (command === "test-command" && subcommand === "remove") {
    removeTestCommand(rest);
    return;
  }

  if (command === "set" && subcommand === "opencode-command") {
    setConfigString("opencodeCommand", rest, "opencode command");
    return;
  }

  if (command === "set" && subcommand === "opencode-model") {
    setConfigString("fallbackModel", rest, "OpenCode fallback model");
    return;
  }

  if (command === "set" && subcommand === "opencode-agent") {
    setConfigString("fallbackAgent", rest, "OpenCode fallback agent");
    return;
  }

  if (command === "set" && subcommand === "allow-direct-test-commands") {
    setBoolean("allowDirectTestCommands", rest);
    return;
  }

  throw new Error("Unknown Rel.AI config command. Run: node apps/native-host/scripts/relai-config.js help");
}

function addWorkspace(args) {
  const [alias, workspacePath] = args;
  if (!alias || !workspacePath) {
    throw new Error("Usage: npm run workspace:add -- <alias> <absolute-or-relative-project-path>");
  }
  if (!isValidAlias(alias)) {
    throw new Error("Workspace alias must use letters, numbers, dots, underscores, or hyphens, max 64 chars.");
  }

  const resolved = path.resolve(workspacePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path must exist and be a directory: ${resolved}`);
  }

  const real = fs.realpathSync(resolved);
  const config = readConfig();
  const existing = config.workspaces[alias] && typeof config.workspaces[alias] === "object" ? config.workspaces[alias] : {};
  config.workspaces[alias] = {
    path: real,
    testCommands: existing.testCommands || {}
  };
  if (!config.defaultWorkspace || config.defaultWorkspace === "default" || !config.workspaces[config.defaultWorkspace]) {
    config.defaultWorkspace = alias;
  }
  writeConfig(config);
  console.log(`Added workspace '${alias}': ${real}`);
  console.log(`Config: ${getConfigPath()}`);
}

function removeWorkspace(args) {
  const [alias] = args;
  if (!alias) {
    throw new Error("Usage: node apps/native-host/scripts/relai-config.js workspace remove <alias>");
  }
  const config = readConfig();
  delete config.workspaces[alias];
  if (config.defaultWorkspace === alias) {
    config.defaultWorkspace = Object.keys(config.workspaces)[0] || "default";
  }
  writeConfig(config);
  console.log(`Removed workspace '${alias}'.`);
}

function listWorkspaces() {
  const config = readConfig();
  const entries = Object.entries(config.workspaces).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    console.log("No workspaces configured.");
    return;
  }
  for (const [alias, entry] of entries) {
    const marker = alias === config.defaultWorkspace ? "*" : " ";
    console.log(`${marker} ${alias}: ${entry.path}`);
    const tests = Object.entries(entry.testCommands || {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, command] of tests) {
      console.log(`    test ${key}: ${command}`);
    }
  }
}

function addTestCommand(args) {
  const [workspaceAlias, key, ...commandParts] = args;
  const command = commandParts.join(" ").trim();
  if (!workspaceAlias || !key || !command) {
    throw new Error("Usage: npm run testcmd:add -- <workspace-alias> <key> <command>");
  }
  if (!isValidAlias(workspaceAlias) || !isValidAlias(key)) {
    throw new Error("Workspace alias and test key must use letters, numbers, dots, underscores, or hyphens.");
  }
  const config = readConfig();
  if (!config.workspaces[workspaceAlias]) {
    throw new Error(`Workspace '${workspaceAlias}' is not configured.`);
  }
  config.workspaces[workspaceAlias].testCommands = config.workspaces[workspaceAlias].testCommands || {};
  config.workspaces[workspaceAlias].testCommands[key] = command;
  writeConfig(config);
  console.log(`Added test command '${key}' for workspace '${workspaceAlias}': ${command}`);
}

function removeTestCommand(args) {
  const [workspaceAlias, key] = args;
  if (!workspaceAlias || !key) {
    throw new Error("Usage: node apps/native-host/scripts/relai-config.js test-command remove <workspace-alias> <key>");
  }
  const config = readConfig();
  if (config.workspaces[workspaceAlias] && config.workspaces[workspaceAlias].testCommands) {
    delete config.workspaces[workspaceAlias].testCommands[key];
  }
  writeConfig(config);
  console.log(`Removed test command '${key}' from workspace '${workspaceAlias}'.`);
}

function setConfigString(field, args, label) {
  const value = args.join(" ").trim();
  const config = readConfig();
  config[field] = value;
  writeConfig(config);
  console.log(`Set ${label} to '${value || ""}'.`);
}

function setBoolean(field, args) {
  const [value] = args;
  if (!value || !["true", "false"].includes(value)) {
    throw new Error(`Usage: node apps/native-host/scripts/relai-config.js set ${field} <true|false>`);
  }
  const config = readConfig();
  config[field] = value === "true";
  writeConfig(config);
  console.log(`Set ${field} to ${config[field]}.`);
}

function printHelp() {
  console.log(`Rel.AI patch-first config

Commands:
  show
  workspace list
  workspace add <alias> <path>
  workspace remove <alias>
  test-command add <workspace-alias> <key> <command>
  test-command remove <workspace-alias> <key>
  set opencode-command <command>
  set opencode-model <provider/model>
  set opencode-agent <agent>
  set allow-direct-test-commands <true|false>

Common setup:
  npm run workspace:add -- myapp /path/to/my/project
  npm run testcmd:add -- myapp unit "npm test -- --runInBand"
  npm run model:set -- openai/gpt-4.1-mini
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
