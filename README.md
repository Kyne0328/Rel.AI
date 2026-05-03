# Rel.AI

Rel.AI turns selected local workspace context into ChatGPT coding requests, then applies ChatGPT's returned patch through your local bridge:

```text
You choose workspace alias + allowed files/folders/globs + task prompt
-> Rel.AI reads only that allowlisted local context
-> Rel.AI inserts a complete request into the open ChatGPT web composer
-> ChatGPT returns rel-ai-apply metadata plus a separate fenced diff
-> Rel.AI applies it with git apply
-> OpenCode is used only as fallback if patch/tests fail
```

ChatGPT cannot silently browse your disk. Rel.AI reads local files through the native host only after you choose the workspace alias and allowed paths in the Rel.AI dashboard.

## Requirements

- Node.js 18+
- Git available on PATH
- Chrome or Edge
- OpenCode installed only if you want fallback repair

## Install

From the project root:

```bash
npm run check
```

Load the browser extension:

```text
chrome://extensions
-> Developer mode
-> Load unpacked
-> select apps/browser-extension
```

Copy the extension ID, then install the native host:

```bash
npm run install:chrome-host -- --extension-id YOUR_EXTENSION_ID
```

For Edge:

```bash
npm run install:edge-host -- --extension-id YOUR_EXTENSION_ID
```

Add a workspace alias:

```bash
npm run workspace:add -- myapp /absolute/path/to/project
```

Optional: add a locally approved test command:

```bash
npm run testcmd:add -- myapp unit "npm test -- --runInBand"
```

Optional: choose a cheaper OpenCode fallback model locally:

```bash
npm run model:set -- openai/gpt-4.1-mini
```

Rel.AI intentionally keeps the fallback model configured locally. ChatGPT does not get to choose your local OpenCode model.

## Main workflow

1. Open ChatGPT in Chrome or Edge.
2. Click the Rel.AI extension icon. It opens the full-page dashboard in a new tab.
3. Click **Refresh workspaces**.
4. Choose or type your workspace alias, for example `myapp`.
5. Type what you want ChatGPT to do.
6. Add allowed files, folders, or globs manually, or use the **Workspace picker**:

```text
src/auth.ts
src/session.ts
tests/**/*.test.ts
```

7. Optionally choose a local `testCommandKey`, such as `unit`.
8. Click **Create ChatGPT request**.
9. Review the inserted request, then send it to ChatGPT.
11. When ChatGPT returns the metadata block and diff block, click **Apply with Rel.AI**.

The dashboard has an optional **Submit to ChatGPT after inserting** checkbox. Keep it off if you want to review before sending.

## Workspace picker

The dashboard has a workspace browser backed by the native host. It lists safe visible folders/files inside the selected workspace alias and lets you add paths to the include list without typing them.

It hides common sensitive or noisy entries such as `.env`, `.ssh`, `.git`, `node_modules`, binary files, and credential-looking paths.

## Output format

Rel.AI 0.9 avoids raw multiline diffs inside JSON strings. That was the cause of errors like:

```text
Invalid apply JSON: Expected ',' or '}' after property value
```

ChatGPT is now instructed to return two separate blocks.

First block: metadata only:

````text
```rel-ai-apply
{
  "version": 1,
  "workspace": "myapp",
  "title": "Fix auth refresh bug",
  "prompt": "Fix the auth refresh bug. Keep the public API unchanged.",
  "testCommandKey": "unit",
  "fallback": {
    "enabled": true,
    "tool": "opencode",
    "instructions": "If the patch or tests fail, make the smallest safe repair. Do not refactor unrelated code."
  }
}
```
````

Second block: unified diff:

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

The browser extension combines these two blocks when you click **Apply with Rel.AI**.

The older JSON-with-`diff` format is still accepted for compatibility, but the two-block format is preferred.

## Advanced flows

Rel.AI also supports:

- inline **Apply with Rel.AI** buttons placed near ChatGPT message/code action controls
- inline **Insert workspace context** buttons under context blocks
- selected-text apply/context actions
- manual paste of metadata + diff blocks, raw JSON, or raw unified diff

## Pre-apply preview

When ChatGPT returns a `rel-ai-apply` block plus a `diff` block, the inline **Apply with Rel.AI** button opens a confirmation panel first. It shows:

- workspace alias
- title
- affected files
- configured test command key
- whether OpenCode fallback is enabled
- the unified diff that will be sent to `git apply`

Use **Check only** to run `git apply --check` without changing files, or **Apply patch** to modify the workspace.

## Safety behavior

Rel.AI blocks:

- absolute paths
- `..` traversal
- paths outside the allowlisted workspace
- common secret paths such as `.env`, `.ssh`, `.npmrc`, `*.pem`, `*.key`, and credential files
- binary-looking files in context bundles
- direct test commands from ChatGPT unless you explicitly enable them
- full workspace reads without explicit include patterns

Rel.AI prefers locally configured test commands:

```json
{
  "workspaces": {
    "myapp": {
      "path": "/absolute/path/to/project",
      "testCommands": {
        "unit": "npm test -- --runInBand"
      }
    }
  }
}
```

Config path:

```text
~/.rel-ai/opencode.json
```

## Native host message types

Config summary:

```json
{
  "type": "relai.configSummary",
  "protocolVersion": 7,
  "requestId": "uuid",
  "source": "browser"
}
```

Workspace browser:

```json
{
  "type": "relai.listWorkspace",
  "protocolVersion": 7,
  "requestId": "uuid",
  "source": "browser",
  "workspace": "myapp",
  "dir": "src"
}
```

Context request:

```json
{
  "type": "relai.context",
  "protocolVersion": 7,
  "requestId": "uuid",
  "source": "browser:compose-request",
  "context": {
    "version": 1,
    "workspace": "myapp",
    "include": ["src/**/*.ts"]
  }
}
```

Patch request:

```json
{
  "type": "relai.apply",
  "protocolVersion": 7,
  "requestId": "uuid",
  "source": "browser:inline-button",
  "apply": {
    "version": 1,
    "workspace": "myapp",
    "diff": "diff --git ..."
  }
}
```

## How Rel.AI changes your original code

When you click **Apply with Rel.AI**, the browser extension sends the `rel-ai-apply` metadata and the separate `diff` block to the native host `com.relai.request_builder`.

The native host resolves the workspace alias from `~/.rel-ai/opencode.json`, writes the diff to a temporary file, then runs these commands inside that workspace:

```bash
git apply --check /tmp/relai-diff-*/patch.diff
git apply --whitespace=warn /tmp/relai-diff-*/patch.diff
```

So the actual file modifications are done by Git patch application, not by ChatGPT and not by the browser extension. OpenCode only runs if fallback is enabled and patch application or tests fail.

## Troubleshooting

Only one **Apply with Rel.AI** button should appear per valid apply response. If an old ChatGPT tab still shows duplicates, reload the unpacked extension and refresh the ChatGPT tab.

If patch application takes longer than expected, the native host is usually running `git apply`, a configured test command, or OpenCode fallback. Fallback runs only when enabled.

## ZIP attachment mode

The dashboard has a **Context packing** selector:

- **Readable context**: recommended for precise fixes across a small number of files. Rel.AI inserts selected files as fenced code blocks.
- **ZIP attachment**: recommended for larger folder context. Rel.AI packages selected readable files into a real `.zip` attachment and inserts only instructions plus a manifest.

ZIP attachment mode still uses workspace aliases, include/exclude rules, `.gitignore`-aware file discovery, secret-path blocking, max file count, and size limits.

If ChatGPT does not confirm the automatic attachment, Rel.AI offers a draggable ZIP card fallback. Manual drag/drop remains available as a last resort because it uses the browser's trusted OS-backed file path.

## Extension context invalidated

If Chrome shows `Extension context invalidated`, refresh the ChatGPT tab after reloading or replacing the unpacked extension. Rel.AI exits stale content scripts safely, but an already-open ChatGPT page can still contain an old script from the previous extension load.


## ZIP attachment behavior

ZIP attachment mode keeps the ChatGPT prompt compact by attaching a real `.zip` archive and inserting only the request instructions plus a manifest. Rel.AI first tries the upload method that has proven most reliable in current ChatGPT web sessions: `main-world-drag-drop`. Debugger and file-input paths remain available as fallbacks.

If ChatGPT does not confirm the attachment, Rel.AI shows a ZIP attachment fallback. You can show a draggable ZIP card in the ChatGPT tab or download the generated ZIP and drag it into ChatGPT manually.

## Diagnostics

Diagnostics are hidden by default. Open the Rel.AI dashboard and press **Ctrl+Shift+D** to show or hide the local diagnostics panel.

Use diagnostics only when troubleshooting bridge, ZIP attachment, or patch-apply behavior. The log is stored locally by the extension and is not sent anywhere unless you copy it.

## Version 0.9.23

- Dismisses ChatGPT's stuck drag-and-drop upload overlay after ZIP attachment attempts.
- Keeps diagnostics hidden by default; press Ctrl+Shift+D in the dashboard to reveal them.
- Updates dashboard copy to use release-ready product language.


## v0.9.23

- Uses ChatGPT MAIN-world drag/drop as the primary ZIP upload path.
- Moves Chrome debugger/CDP upload methods behind the page-context upload path.
- Improves cleanup for stuck ChatGPT upload overlays after ZIP upload.
- Keeps diagnostics hidden behind Ctrl+Shift+D in the Rel.AI dashboard.


## v0.9.23

- Optimizes ZIP upload for the confirmed MAIN-world drag/drop path.
- Removes debugger permission and slow CDP/file-picker upload attempts from the default flow.
- Reduces upload overlay cleanup to a lightweight dragleave/Escape pass plus targeted overlay hiding.
- Keeps the draggable ZIP chip as the fallback when automatic upload is not confirmed.
- Disables persistent debug-log writes unless the hidden diagnostics panel is enabled.
