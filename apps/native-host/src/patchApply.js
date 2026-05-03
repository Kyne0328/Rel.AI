const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|[./-])/i,
  /(^|\/)\.ssh($|\/)/i,
  /(^|\/)(id_rsa|id_ed25519|known_hosts)$/i,
  /(^|\/).*\.(pem|key|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc)$/i,
  /(^|\/)firebase-adminsdk[^/]*\.json$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.azure\//i,
  /(^|\/)gcloud\/credentials/i
];

async function applyPatchFirst(applyRequest, workspace, config, runOpenCodeFallback) {
  validateDiffPaths(applyRequest.diff, workspace.path);
  validateContextFiles(applyRequest, workspace.path);

  const diffPath = writeTempDiff(applyRequest.diff);
  const result = {
    ok: false,
    type: "relai.apply",
    workspace: workspace.alias,
    ...(applyRequest.summary ? { summary: applyRequest.summary } : {})
  };

  try {
    const check = await runCommand("git", ["apply", "--check", diffPath], workspace.path, config);
    result.gitCheck = summarizeCommand(check);

    if (check.exitCode !== 0) {
      if (applyRequest.dryRun) {
        result.ok = false;
        result.dryRun = true;
        result.error = formatCommandFailure("git apply --check", check);
        result.message = "Dry run failed. git apply --check did not pass; no files were changed and fallback was not run.";
        return result;
      }
      if (applyRequest.fallback && applyRequest.fallback.enabled) {
        result.fallback = await runOpenCodeFallback(applyRequest, workspace, config, {
          phase: "git apply --check",
          stdout: check.stdout,
          stderr: check.stderr,
          exitCode: check.exitCode
        });
        result.ok = Boolean(result.fallback.ok);
        result.message = result.ok ? "OpenCode fallback completed after patch check failed." : "Patch check failed and OpenCode fallback failed.";
        return result;
      }
      result.error = formatCommandFailure("git apply --check", check);
      result.message = "Patch did not apply cleanly and fallback is disabled.";
      return result;
    }

    if (applyRequest.dryRun) {
      result.ok = true;
      result.dryRun = true;
      result.message = "Dry run succeeded. git apply --check passed; no files were changed.";
      return result;
    }

    const apply = await runCommand("git", ["apply", "--whitespace=warn", diffPath], workspace.path, config);
    result.gitApply = summarizeCommand(apply);

    if (apply.exitCode !== 0) {
      if (applyRequest.fallback && applyRequest.fallback.enabled) {
        result.fallback = await runOpenCodeFallback(applyRequest, workspace, config, {
          phase: "git apply",
          stdout: apply.stdout,
          stderr: apply.stderr,
          exitCode: apply.exitCode
        });
        result.ok = Boolean(result.fallback.ok);
        result.message = result.ok ? "OpenCode fallback completed after patch apply failed." : "Patch apply failed and OpenCode fallback failed.";
        return result;
      }
      result.error = formatCommandFailure("git apply", apply);
      result.message = "Patch check passed but git apply failed. Fallback is disabled.";
      return result;
    }

    const testCommand = resolveTestCommand(applyRequest, workspace, config);
    if (applyRequest.runTests && testCommand) {
      const test = await runShellCommand(testCommand.command, workspace.path, config);
      result.test = {
        key: testCommand.key,
        command: testCommand.safeLabel,
        ...summarizeCommand(test)
      };

      if (test.exitCode !== 0) {
        if (applyRequest.fallback && applyRequest.fallback.enabled) {
          result.fallback = await runOpenCodeFallback(applyRequest, workspace, config, {
            phase: "test command",
            command: testCommand.safeLabel,
            stdout: test.stdout,
            stderr: test.stderr,
            exitCode: test.exitCode
          });
          result.ok = Boolean(result.fallback.ok);
          result.message = result.ok ? "Patch applied, tests failed, and OpenCode fallback completed." : "Patch applied, tests failed, and OpenCode fallback failed.";
          return result;
        }
        result.ok = false;
        result.error = formatCommandFailure(`test command${testCommand.safeLabel ? ` (${testCommand.safeLabel})` : ""}`, test);
        result.message = "Patch applied, but tests failed and fallback is disabled.";
        return result;
      }
    }

    result.ok = true;
    result.message = testCommand && applyRequest.runTests
      ? "Patch applied and configured tests passed."
      : "Patch applied. No configured tests were run.";
    return result;
  } finally {
    try {
      fs.unlinkSync(diffPath);
    } catch (_error) {
      // Ignore temp cleanup errors.
    }
  }
}

function validateDiffPaths(diff, workspacePath) {
  const paths = extractPathsFromDiff(diff);
  if (paths.length === 0) {
    throw new Error("Diff does not contain recognizable file paths.");
  }

  const realWorkspace = fs.realpathSync(workspacePath);
  for (const relativePath of paths) {
    if (relativePath === "/dev/null") {
      continue;
    }
    validateRelativePath(relativePath, "Diff path");
    if (isSecretPath(relativePath)) {
      throw new Error(`Diff touches a blocked sensitive path: ${relativePath}`);
    }
    const absolute = path.resolve(realWorkspace, relativePath);
    if (!isPathInside(absolute, realWorkspace)) {
      throw new Error(`Diff path escapes workspace: ${relativePath}`);
    }
  }
}

function extractPathsFromDiff(diff) {
  const out = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (match) {
        out.push(stripQuotedPath(match[1]));
        out.push(stripQuotedPath(match[2]));
      }
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const raw = line.slice(4).trim().split(/\s+/)[0];
      if (raw === "/dev/null") {
        continue;
      }
      if (raw.startsWith("a/") || raw.startsWith("b/")) {
        out.push(stripQuotedPath(raw.slice(2)));
      }
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function stripQuotedPath(input) {
  let value = String(input || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return decodeGitOctalEscapes(value);
}

function decodeGitOctalEscapes(value) {
  return value.replace(/(\\[0-7]{3})+/g, (run) => {
    const bytes = run.match(/\\([0-7]{3})/g).map((m) => parseInt(m.slice(1), 8));
    return Buffer.from(bytes).toString("utf8");
  });
}

function validateContextFiles(applyRequest, workspacePath) {
  const context = applyRequest.context || [];
  const realWorkspace = fs.realpathSync(workspacePath);
  for (const relativePath of context) {
    validateRelativePath(relativePath, "Context path");
    if (isSecretPath(relativePath)) {
      throw new Error(`Context includes a blocked sensitive path: ${relativePath}`);
    }
    const absolute = path.resolve(realWorkspace, relativePath);
    const realCandidate = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    if (!isPathInside(realCandidate, realWorkspace)) {
      throw new Error(`Context path escapes workspace: ${relativePath}`);
    }
  }
}

function validateRelativePath(relativePath, label) {
  const file = String(relativePath || "").trim();
  if (!file) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (file.startsWith("/") || file.startsWith("\\") || file.includes("..") || /^[A-Za-z]:[\\/]/.test(file)) {
    throw new Error(`${label} must be relative and must not contain traversal: ${file}`);
  }
  if (file.length > 512) {
    throw new Error(`${label} is too long: ${file}`);
  }
}

function isSecretPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveTestCommand(applyRequest, workspace, config) {
  if (applyRequest.testCommandKey) {
    const command = workspace.testCommands && workspace.testCommands[applyRequest.testCommandKey];
    if (!command) {
      throw new Error(`Test command key '${applyRequest.testCommandKey}' is not configured for workspace '${workspace.alias}'.`);
    }
    return {
      key: applyRequest.testCommandKey,
      command,
      safeLabel: command
    };
  }

  if (applyRequest.testCommand) {
    if (!config.allowDirectTestCommands) {
      throw new Error("Direct testCommand from ChatGPT is disabled. Use a locally configured testCommandKey instead, or enable allowDirectTestCommands in ~/.rel-ai/opencode.json.");
    }
    return {
      key: "direct",
      command: applyRequest.testCommand,
      safeLabel: applyRequest.testCommand
    };
  }

  return null;
}

function writeTempDiff(diff) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relai-diff-"));
  const file = path.join(dir, "patch.diff");
  fs.writeFileSync(file, `${diff.trim()}\n`, { mode: 0o600 });
  return file;
}

function runCommand(command, args, cwd, config) {
  return runProcess(command, args, { cwd, shell: false }, config);
}

function runShellCommand(command, cwd, config) {
  return runProcess(command, [], { cwd, shell: true, commandString: command }, config);
}

function runProcess(command, args, options, config) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const maxOutputBytes = config.maxOutputBytes || 1024 * 1024;
    const timeoutMs = config.timeoutMs || 15 * 60 * 1000;
    const child = options.shell
      ? spawn(options.commandString || command, { cwd: options.cwd, shell: true, env: makeEnv() })
      : spawn(command, args, { cwd: options.cwd, shell: false, env: makeEnv() });

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    const forceKillTimer = setTimeout(() => {
      if (!settled && timedOut) {
        child.kill("SIGKILL");
      }
    }, timeoutMs + 5000);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), maxOutputBytes);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), maxOutputBytes);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({ exitCode: -1, signal: undefined, stdout, stderr, error: error.message, timedOut, timeoutMs });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal || undefined,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        timeoutMs
      });
    });
  });
}

function makeEnv() {
  return {
    ...process.env,
    REL_AI: "1",
    REL_AI_PATCH_FIRST: "1"
  };
}

function summarizeCommand(result) {
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.timedOut ? { timedOut: true, timeoutMs: result.timeoutMs } : {}),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {})
  };
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function appendLimited(current, next, maxBytes) {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }
  const marker = "\n[Rel.AI truncated output]\n";
  const allowed = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  return combined.slice(Math.max(0, combined.length - allowed)) + marker;
}

function formatCommandFailure(label, result) {
  const parts = [];
  parts.push(`${label} failed with exit code ${result && result.exitCode !== undefined ? result.exitCode : "unknown"}.`);
  if (result && result.signal) {
    parts.push(`signal: ${result.signal}`);
  }
  if (result && result.timedOut) {
    parts.push(`timed out after ${Math.round((result.timeoutMs || 0) / 1000)}s`);
  }
  if (result && result.stderr) {
    parts.push(`stderr:\n${truncateForError(result.stderr, 6000)}`);
  }
  if (result && result.stdout) {
    parts.push(`stdout:\n${truncateForError(result.stdout, 6000)}`);
  }
  if (result && result.error) {
    parts.push(`error: ${result.error}`);
  }
  return parts.join("\n\n");
}

function truncateForError(value, limit) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Rel.AI truncated ${text.length - limit} more characters]`;
}

module.exports = {
  applyPatchFirst,
  validateDiffPaths,
  extractPathsFromDiff,
  resolveTestCommand,
  runCommand,
  runShellCommand,
  summarizeCommand,
  formatCommandFailure,
  appendLimited
};
