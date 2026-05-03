# Rel.AI ChatGPT Request Bridge

Rel.AI is now a full-page ChatGPT -> patch -> local apply bridge:

```text
You choose workspace alias + allowed files/folders/globs + task prompt
-> Rel.AI reads only that allowlisted local context
-> Rel.AI inserts a complete request into the open ChatGPT web composer
-> ChatGPT returns rel-ai-apply metadata plus a separate fenced diff
-> Rel.AI applies it with git apply
-> OpenCode is used only as fallback if patch/tests fail
```

ChatGPT cannot silently browse your disk. Rel.AI reads local files through the native host only after you choose the workspace alias and allowed paths in the extension dashboard.

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
3. Click **Load workspaces**.
4. Choose or type your workspace alias, for example `myapp`.
5. Type what you want ChatGPT to do.
6. Add allowed files, folders, or globs manually, or use the **Workspace picker**:

```text
src/auth.ts
src/session.ts
tests/**/*.test.ts
```

7. Optionally choose a local `testCommandKey`, such as `unit`.
8. Click **Insert request into ChatGPT**.
9. Review the inserted request, then send it to ChatGPT.
11. When ChatGPT returns the metadata block and diff block, click **Apply with Rel.AI**.

The dashboard has an experimental **Submit to ChatGPT after inserting** checkbox. Keep it off if you want to review before sending.

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

## Manual flows still included

The extension still supports:

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

## Troubleshooting apply buttons

Only one **Apply with Rel.AI** button should appear per valid apply response. If you still see duplicates after updating, reload the unpacked extension and refresh the ChatGPT tab. Existing old buttons from a previous content script can remain on already-open pages until refresh.

If the button says it is still applying, the native host is usually running `git apply`, a configured test command, or OpenCode fallback. In v0.9.4, fallback is disabled by default to avoid long accidental waits.


## v0.9.4 notes

- The extension action now opens a full-page Rel.AI dashboard tab instead of a small popup. You can bookmark `dashboard.html` from the extension page after opening it.
- Inline apply now opens a pre-apply preview showing workspace, affected files, fallback status, test key, and the unified diff before running `git apply`.
- The inline Apply button is placed near ChatGPT message/code action controls when possible, including next to the sprite icon `#f6d0e2`; it should no longer appear at the far left of the page.


## v0.9.8 real ZIP upload mode

The dashboard still has a **Context packing** selector:

- **Readable text**: the recommended default. Rel.AI inserts selected files as normal fenced code blocks so ChatGPT can reason over them.
- **Real ZIP upload**: Rel.AI packages selected readable files into an actual `.zip` attachment and inserts only instructions plus a manifest into the prompt.

ZIP mode still uses the same workspace alias, include/exclude rules, `.gitignore`-aware file discovery, secret-path blocking, max file count, and max byte limits. Oversized ZIP payloads are blocked before they are sent through the browser/native bridge.

## Real ZIP upload mode

Rel.AI 0.9.8 changes ZIP mode from "base64 pasted into the prompt" to a real `.zip` file attachment.

When you choose **Real ZIP upload** in the dashboard:

1. The native host reads only your selected allowlisted files/folders/globs.
2. It creates an actual ZIP archive in memory.
3. The browser extension injects that ZIP as a `File` object into ChatGPT's upload/drop handler.
4. The composer receives only the task instructions and manifest, not the full source text or base64 ZIP chunks.

This is shorter and cleaner than pasting base64, but it still depends on ChatGPT's current web upload UI. If upload injection fails, switch back to **Readable text** or select fewer files.

Because native messaging has practical message-size limits, Rel.AI blocks oversized ZIP responses by default. If the ZIP is too large, select fewer folders/files.

## v0.9.10 ZIP upload changes

Manual drag/drop works in ChatGPT because the browser supplies a trusted OS-backed file. Synthetic drag/drop from a normal content script may be ignored by ChatGPT.

Rel.AI 0.9.10 adds a stronger automatic upload path:

1. the native host writes the ZIP to a temporary real file under your OS temp directory;
2. the browser extension uses Chrome DevTools Protocol through the `debugger` permission;
3. it first tries `Input.dispatchDragEvent` with the real ZIP path, which is closer to a manual drag/drop;
4. if that fails, it tries file-chooser interception and `DOM.setFileInputFiles`;
5. if that fails, it falls back to the older page-level drag/drop, paste, and file-input attempts.

Chrome will show a debugger-permission warning for this version. That is expected. Rel.AI attaches only long enough to set the ZIP file input, then detaches.

If automatic ZIP upload still fails, use **Readable text** mode or manually drag the generated ZIP. This can happen if ChatGPT changes or blocks its upload UI.

## Extension context invalidated

If Chrome shows `Extension context invalidated`, refresh the ChatGPT tab after reloading or replacing the unpacked extension. Version 0.9.10 makes the content script exit safely instead of repeatedly throwing, but an already-open ChatGPT page can still contain an old script from the previous extension load.


## ZIP upload troubleshooting

ZIP mode now tries the closest automatic path to a real manual upload:

1. Chrome DevTools Protocol real-path drag/drop using `Input.dispatchDragEvent`.
2. Chrome DevTools Protocol file-chooser interception.
3. Direct file input setting.
4. Page drag/drop, paste, and menu/input fallbacks.

If ChatGPT still refuses the file, use the dashboard status output. It will report the failed method chain. Manual drag/drop remains the guaranteed fallback because browsers mark that as a real user/OS-backed file operation, while extensions may be treated as synthetic automation by the page.

## v0.9.12 assisted ZIP upload fallback

If ChatGPT accepts the ZIP when you manually drag/drop it but rejects every extension-driven upload method, Rel.AI now treats that as an expected browser trust boundary instead of a silent failure.

When ZIP mode inserts the request but upload is not confirmed, the dashboard shows a **ZIP upload fallback** panel with:

- **Show draggable ZIP in ChatGPT tab or Download generated ZIP**: downloads the exact ZIP Rel.AI built from the selected workspace files.
- **Copy temp path**: copies the native-host temp path when available.

Use it like this:

1. Build the request in ZIP mode.
2. If status says `ZIP upload not confirmed`, click **Show draggable ZIP in ChatGPT tab or Download generated ZIP**.
3. Drag the downloaded ZIP into the open ChatGPT tab.
4. Wait until ChatGPT shows the attachment.
5. Send the inserted prompt.

This is less automatic, but it uses the upload path you confirmed works: a real user drag/drop of a real ZIP file.


## ZIP assisted upload fallback

If ChatGPT rejects automatic ZIP upload, Rel.AI now places a draggable ZIP chip inside the open ChatGPT tab. Drag that chip into the ChatGPT composer/upload area, wait for the attachment to appear, then send the inserted prompt. This avoids downloading the ZIP first while still using a real user drag gesture.

## v0.9.15 diagnostics build

This build adds a Diagnostics panel to the Rel.AI dashboard and console logging with the prefix `[Rel.AI]` / `[Rel.AI Dashboard]` / `[Rel.AI Content]`.

When ZIP upload or the draggable chip fails:

1. Open the Rel.AI dashboard.
2. Run the ZIP request again.
3. Scroll to Diagnostics.
4. Click **Copy debug log**.
5. Share the copied log when reporting the bug.

If Chrome DevTools is open on the ChatGPT tab, Chrome debugger-based upload attempts may conflict. Close ChatGPT DevTools before testing automatic ZIP upload. The dashboard Diagnostics panel should still capture background-service-worker events.

## v0.9.16 diagnostic note

If Diagnostics shows only `relai.getConfigSummary` and repeated `relai.getDebugLog`, the request-builder action did not leave the dashboard. v0.9.16 logs dashboard button binding, clicks, validation failures, and compose sends into the same Diagnostics panel.

After clicking **Insert request into ChatGPT**, the Diagnostics panel should include:

- `dashboard.button.clicked`
- `dashboard.compose.validate.start`
- either `dashboard.compose.validate.fail` or `dashboard.compose.send`
- `background.message.received` with `relai.composeChatGPTRequest`

If you do not see `dashboard.button.clicked`, the dashboard page is stale or the extension was not fully reloaded.
