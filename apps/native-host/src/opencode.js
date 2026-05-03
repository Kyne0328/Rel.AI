const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { appendLimited, summarizeCommand } = require("./patchApply");

function buildFallbackPrompt(applyRequest, workspace, failure) {
  const lines = [];
  lines.push("You are OpenCode running from Rel.AI patch-first mode.");
  lines.push("");
  lines.push("ChatGPT already produced the code patch. Your job is not to redesign the feature.");
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- Work only inside the current workspace.");
  lines.push("- Apply or repair the provided patch with the smallest possible changes.");
  lines.push("- Do not refactor unrelated code.");
  lines.push("- Do not install packages.");
  lines.push("- Do not access secrets, .env files, private keys, credential stores, or files outside the workspace.");
  lines.push("- If the patch is unsafe or impossible, stop and explain why.");
  lines.push("- At the end, summarize changed files and any checks run.");
  lines.push("");
  lines.push(`Workspace alias: ${workspace.alias}`);
  if (applyRequest.title) {
    lines.push(`Title: ${applyRequest.title}`);
  }
  if (applyRequest.prompt) {
    lines.push("");
    lines.push("Original ChatGPT task summary:");
    lines.push(applyRequest.prompt);
  }
  if (applyRequest.context && applyRequest.context.length) {
    lines.push("");
    lines.push("Relevant paths mentioned by ChatGPT:");
    for (const file of applyRequest.context) {
      lines.push(`- ${file}`);
    }
  }
  if (applyRequest.fallback && applyRequest.fallback.instructions) {
    lines.push("");
    lines.push("Fallback instructions:");
    lines.push(applyRequest.fallback.instructions);
  }
  lines.push("");
  lines.push("Failure that triggered fallback:");
  lines.push(JSON.stringify({
    phase: failure.phase,
    command: failure.command,
    exitCode: failure.exitCode,
    stdout: truncateForPrompt(failure.stdout || "", 12000),
    stderr: truncateForPrompt(failure.stderr || "", 12000)
  }, null, 2));
  lines.push("");
  lines.push("Unified diff from ChatGPT:");
  lines.push("```diff");
  lines.push(applyRequest.diff);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

async function runOpenCodeFallback(applyRequest, workspace, config, failure) {
  const prompt = buildFallbackPrompt(applyRequest, workspace, failure);
  const promptFile = writeFallbackPromptFile(workspace.path, prompt);
  const command = config.opencodeCommand || "opencode";
  const args = ["run"];

  const model = selectModel(applyRequest, config);
  if (model) {
    args.push("--model", model);
  }

  const agent = selectAgent(applyRequest, config);
  if (agent) {
    args.push("--agent", agent);
  }

  if (applyRequest.title) {
    args.push("--title", `Rel.AI fallback: ${applyRequest.title}`.slice(0, 120));
  }

  args.push(`Read ${promptFile.relativePath} and execute the Rel.AI fallback instructions. Do not modify files under .relai unless explicitly necessary.`);

  let result;
  try {
    result = await runProcess(command, args, workspace.path, config);
  } finally {
    cleanupFallbackPromptFile(promptFile.absolutePath);
  }

  return {
    ok: result.exitCode === 0,
    command: makeCommandLabel(command, args),
    promptFile: promptFile.relativePath,
    model: model || undefined,
    agent: agent || undefined,
    ...summarizeCommand(result)
  };
}

function writeFallbackPromptFile(workspacePath, prompt) {
  const relaiDir = path.join(workspacePath, ".relai");
  fs.mkdirSync(relaiDir, { recursive: true });
  const filename = `fallback-${process.pid}-${Date.now()}.md`;
  const absolutePath = path.join(relaiDir, filename);
  fs.writeFileSync(absolutePath, prompt, { mode: 0o600 });
  return {
    absolutePath,
    relativePath: `.relai/${filename}`
  };
}

function cleanupFallbackPromptFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Ignore cleanup failures. The prompt contains only the patch/failure context already approved for fallback.
  }
}

function selectModel(applyRequest, config) {
  if (config.fallbackModel) {
    return config.fallbackModel;
  }
  // ChatGPT may include a model hint, but Rel.AI intentionally ignores it unless the user set a local fallbackModel.
  return "";
}

function selectAgent(applyRequest, config) {
  if (config.fallbackAgent) {
    return config.fallbackAgent;
  }
  if (applyRequest.fallback && applyRequest.fallback.agent) {
    return applyRequest.fallback.agent;
  }
  return "";
}

function runProcess(command, args, cwd, config) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxOutputBytes = config.maxOutputBytes || 1024 * 1024;
    const timeoutMs = config.timeoutMs || 15 * 60 * 1000;

    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        REL_AI: "1",
        REL_AI_PATCH_FIRST: "1"
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

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
      resolve({ exitCode: -1, signal: undefined, stdout, stderr, error: error.message });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal || undefined,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function truncateForPrompt(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n[Rel.AI truncated failure output]`;
}

function makeCommandLabel(command, args) {
  const publicArgs = args.map((arg) => {
    const text = String(arg);
    if (text.length > 120) {
      return `${text.slice(0, 117)}...`;
    }
    return text;
  });
  return [command, ...publicArgs].join(" ");
}

module.exports = {
  buildFallbackPrompt,
  runOpenCodeFallback
};
