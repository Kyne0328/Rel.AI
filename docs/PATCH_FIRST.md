# Patch-first mode

Patch-first mode is the main Rel.AI workflow.

## Flow

1. ChatGPT generates `rel-ai-apply` metadata and a separate unified `diff` block.
2. The browser extension combines both blocks and sends the patch to the native host.
3. The native host resolves the workspace alias from local config.
4. Rel.AI validates paths and blocks sensitive files.
5. Rel.AI runs `git apply --check`.
6. If the check passes, Rel.AI runs `git apply`.
7. If configured, Rel.AI runs an allowlisted test command.
8. If patch application or tests fail, Rel.AI can call `opencode run` as a fallback repair agent.

## Apply metadata schema

```json
{
  "version": 1,
  "workspace": "myapp",
  "prompt": "Short explanation of what the patch is meant to fix.",
  "context": ["src/auth.ts", "tests/auth.test.ts"],
  "testCommandKey": "unit",
  "runTests": true,
  "dryRun": false,
  "fallback": {
    "enabled": true,
    "tool": "opencode",
    "instructions": "Repair only if needed."
  }
}
```

## Diff block

````text
```diff
diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,1 +1,1 @@
-old
+new
```
````

## Test commands

Direct test commands from ChatGPT are blocked by default. Configure local test commands instead:

```bash
npm run testcmd:add -- myapp unit "npm test -- --runInBand"
```

Then ChatGPT only references the key:

```json
{
  "testCommandKey": "unit"
}
```

## OpenCode fallback

OpenCode is only called if:

- `git apply --check` fails,
- `git apply` fails, or
- the configured test command fails.

The fallback prompt tells OpenCode to apply or repair the exact patch with the smallest possible changes. Rel.AI does not send OpenCode a vague feature request unless ChatGPT included one as a short summary.

Configure a cheaper fallback model locally:

```bash
npm run model:set -- provider/model
```

Rel.AI passes it as:

```bash
opencode run --model provider/model "...fallback prompt..."
```
