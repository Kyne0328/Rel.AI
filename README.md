# Rel.AI

<p align="center">
  <img src="docs/images/relai-hero.png" alt="Rel.AI native host connector header" width="100%">
</p>

Rel.AI creates ChatGPT coding requests from selected local workspace context, attaches ZIP context when useful, and applies returned patches through a local native bridge.

It is designed for this flow:

```text
You choose a workspace alias, allowed files/folders/globs, and a task
-> Rel.AI reads only the selected local context
-> Rel.AI inserts a complete request into the open ChatGPT web composer
-> ChatGPT either returns a reviewable rel-ai-plan or an apply-ready rel-ai-apply block plus a separate unified diff
-> The user approves the plan or reviews the diff
-> Rel.AI checks and applies the diff locally with git apply
-> OpenCode can be used as a fallback if patch application or tests fail
```

ChatGPT cannot silently browse your disk. Rel.AI reads local files through the native host only after you choose the workspace alias and allowed paths in the dashboard.

## Why I made this

Rel.AI was created to make the ChatGPT web experience usable for real local coding work. The original problem was simple: Codex-style workflows were either unavailable or too expensive to rely on, while the models available through OpenCode were not strong enough for the heavier reasoning tasks I wanted to solve.

I had access to ChatGPT 5.5 Thinking on the web, and I wanted to use that reasoning capability to plan fixes, solve bugs, and produce code changes without manually copying patches back and forth into local files. Rel.AI bridges that gap: ChatGPT does the heavy reasoning, while local tools apply and verify changes safely.

OpenCode still matters in this design, but it is not the main thinker. Rel.AI uses OpenCode as an optional local fallback when a patch or test run fails, while Git remains the deterministic path for applying clean diffs.

---

## Dashboard

<img src="docs/images/dashboard-full.png" alt="Rel.AI dashboard full page" width="900">

The dashboard opens as a full browser tab when you click the Rel.AI extension icon.

### 1. Bridge and workspace controls

<img src="docs/images/dashboard-top.png" alt="Rel.AI bridge controls" width="900">

- **Check bridge** verifies that the browser extension can reach the native host.
- **Refresh workspaces** reloads your configured workspace aliases.
- The status label shows whether the bridge is ready.

### 2. Request builder

<img src="docs/images/dashboard-request-builder.png" alt="Rel.AI request builder" width="900">

Use this section to define the request that will be sent to ChatGPT.

- **Workspace alias** chooses the local project Rel.AI may read from.
- **Task** is the user prompt. Rel.AI no longer uses a separate title field; the task is the task.
- **Response mode** chooses whether ChatGPT should produce an apply-ready patch immediately or first return a reviewable plan.
- **Context scope** chooses how much of the workspace Rel.AI may package. Focused is the recommended default. Full repo upload is available as an advanced/slow option.
- **Files and folders to include** controls what local context ChatGPT receives in Focused and Selected modes.
- **Browse workspace** lets you add folders/files without typing paths manually.
- **Exclude paths** removes noisy or generated files from the context, including in full repo upload mode.

### 3. Context packing, tests, and OpenCode

<img src="docs/images/dashboard-context-opencode.png" alt="Rel.AI context packing and OpenCode controls" width="900">

- **Readable context** inserts selected files directly into the ChatGPT prompt. Use this for small, precise changes.
- **ZIP attachment** creates a real `.zip` file and attaches it to ChatGPT, keeping the prompt shorter for larger context.
- **Full repo upload** uses ZIP attachment automatically, respects Git ignore rules, blocks secret-looking paths, and should be reserved for tasks that genuinely require broad repository context.
- **Test command key** selects a locally allowlisted test command. ChatGPT cannot directly provide arbitrary shell commands by default.
- **OpenCode fallback** can repair failed patches/tests when enabled.
- **OpenCode server** starts or opens an OpenCode server for direct local interaction.

### 4. ChatGPT actions and advanced tools

<img src="docs/images/dashboard-actions-advanced.png" alt="Rel.AI ChatGPT actions and advanced tools" width="900">

- **Create ChatGPT request** inserts the generated request into the open ChatGPT tab.
- **Show Rel.AI actions on ChatGPT responses** controls inline buttons under valid ChatGPT patch responses.
- Quick actions can insert context or apply patch blocks from the current ChatGPT page.
- Advanced tools are available for manual context and patch testing.
- Diagnostics are hidden by default. Press **Ctrl+Shift+D** on the dashboard to show or hide them.

---

## Requirements

- Node.js 18+
- Git available on `PATH`
- Chrome or Edge
- OpenCode installed only if you want fallback repair or server interaction

---

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

Rel.AI intentionally keeps the fallback model configured locally. ChatGPT does not choose your local OpenCode model.

Optional: configure Gemini prompt improvement:

```bash
npm run gemini:key -- YOUR_GEMINI_API_KEY
npm run gemini:model -- gemini-2.5-flash
```

You can also save the key and model from the dashboard under **Prompt improvement**. The Gemini API key is stored in your local Rel.AI config file and is not inserted into ChatGPT. Use **Improve task with Gemini** when you want Gemini to tighten the task wording before Rel.AI sends the final request to ChatGPT.

---

## Main workflow

1. Open ChatGPT in Chrome or Edge.
2. Click the Rel.AI extension icon to open the dashboard.
3. Click **Refresh workspaces**.
4. Choose or type a workspace alias, such as `myapp`.
5. Describe the task.
6. Optional: click **Improve task with Gemini** to polish the task before sending it to ChatGPT.
7. Choose a **Response mode**. Use Apply-ready patch for small changes and Plan first for larger or uncertain work.
8. Choose a **Context scope**. Use Focused for normal tasks, Selected when you want strict selected-path context, or Full repo upload only for broad repository work.
9. Add allowed files, folders, or globs manually, or use the workspace browser. Full repo upload can run without selected include paths.
10. Choose **Readable context** for small tasks or **ZIP attachment** for larger context. Full repo upload always uses ZIP.
11. Optionally select a `testCommandKey`.
12. Click **Create ChatGPT request**.
13. Review the inserted request in ChatGPT, then send it.
14. If Plan first is enabled, review the returned `rel-ai-plan` block and click **Approve plan** when it matches your intent.
15. When ChatGPT returns a `rel-ai-apply` metadata block plus a separate `diff` block, click **Apply with Rel.AI**.
16. Review the pre-apply panel, then run **Check only** or **Apply patch**.

The dashboard has an optional **Submit to ChatGPT after inserting** checkbox. Keep it off if you want to review the final prompt before sending.

---

## Gemini prompt improvement

Rel.AI can optionally use Gemini through the official Gemini API to improve the user task before it is sent to ChatGPT. This is only a prompt-polishing step: Gemini does not receive the workspace ZIP or apply patches.

Use it when the original task is rough, ambiguous, or too short. Gemini rewrites the task into a clearer coding request while preserving the original intent, paths, constraints, and selected context settings.

The Gemini API key is stored locally in `~/.rel-ai/opencode.json` and is not shown in the dashboard after saving. `npm run config:show` masks the key.

Dashboard controls:

- **Gemini model** chooses the model used for prompt improvement.
- **API key** saves a local Gemini API key. Leave it blank to keep the saved key.
- **Save Gemini settings** stores the key/model locally.
- **Improve task with Gemini** replaces the task textarea with the improved version.

CLI equivalents:

```bash
npm run gemini:key -- YOUR_GEMINI_API_KEY
npm run gemini:model -- gemini-2.5-flash
```

---

## Context strategy

Rel.AI now uses a layered context strategy instead of trying to upload the whole repo by default.

1. **Compact project file tree is always included** so ChatGPT can see what exists and preserve exact path casing. This helps avoid duplicate files such as `readme.md` when `README.md` already exists.
2. **Task-mentioned files are auto-included when they already exist**, such as `README.md`, `package.json`, or `src/auth.ts`, even when they were outside the selected folder.
3. **Selected folders/files stay under user control** through the include list and workspace browser. Rel.AI reads only the selected paths plus safe task-mentioned files in normal modes.
4. **ChatGPT can ask for more context** by returning a `rel-ai-context` block when a required file is only visible in the tree or is missing from the selected contents.
5. **Full repo upload mode exists as an advanced/slow option**. It packages safe filtered workspace files into a ZIP while still respecting ignored folders, exclude rules, file limits, binary detection, and secret-path blocking.

### Context scope options

- **Focused (recommended)**: file tree + selected context + safe task-mentioned files. Best default for most tasks.
- **Selected only**: file tree + explicitly selected files/folders/globs + safe task-mentioned files. Use when you want tighter control.
- **Full repo upload**: filtered repository-wide ZIP attachment. Use only when a task genuinely needs broad project context. It is slower and can still omit large, binary, ignored, or secret-looking files.

The project file tree is an index of known workspace paths, not full file contents. If ChatGPT needs to edit a tree-only file whose contents were not included, Rel.AI instructs it to ask for more context instead of guessing.

Rel.AI also warns ChatGPT to treat the attached/readable context as the current repo state and to avoid creating files with `/dev/null` or `new file mode` unless the file is absent from the file tree, manifest, and task-mentioned file check.

---

## Plan-first mode

Plan-first mode is for larger or ambiguous changes. Instead of asking ChatGPT to produce a patch immediately, Rel.AI asks for a single `rel-ai-plan` block first. The plan should explain:

- what will change
- which files are expected to change
- what risks or assumptions exist
- what validation should run
- whether additional `rel-ai-context` is needed before implementation

When the plan looks correct, click **Approve plan** under the ChatGPT response. Rel.AI inserts an approval message into the composer asking ChatGPT to generate the normal `rel-ai-apply` block and unified diff. This mirrors the Plan/Build split used by local coding agents: ChatGPT plans first, then only builds after user approval.

If ChatGPT lacks required file contents, it is instructed to request them automatically with `rel-ai-context` instead of guessing. The user should not need to explicitly tell ChatGPT to ask for missing files.

### Follow-up context requests

When ChatGPT needs files that were not included in the current request, it should return a `rel-ai-context` block. Rel.AI turns that block into an interactive action inside the ChatGPT page.

Click **Provide requested files** under the ChatGPT response. Rel.AI will read only the requested allowlisted workspace paths, insert the resulting context into the ChatGPT composer, and tell you to review/send it. This makes the follow-up step explicit instead of leaving the user with a raw block and no next action.

If the button does not appear, use the Rel.AI dashboard's manual context box or the browser context menu action **Insert latest Rel.AI context block**.

---

## Output format

Rel.AI avoids putting raw multiline diffs inside JSON strings. ChatGPT is instructed to return exactly two fenced blocks.

First block: metadata only, no `diff` field and no `title` field. The optional `summary` field is shown in the pre-apply preview so the user understands what changed:

````text
```rel-ai-apply
{
  "version": 1,
  "workspace": "myapp",
  "prompt": "Fix the auth refresh bug. Keep the public API unchanged.",
  "summary": "Fixes refresh-token handling without changing the public API.",
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

---

## Pre-apply preview

When ChatGPT returns a valid apply response, the inline **Apply with Rel.AI** button opens a confirmation panel first. It shows:

- workspace alias
- brief patch summary, when provided
- affected files
- configured test command key
- whether OpenCode fallback is enabled
- the unified diff that will be sent to `git apply`

Use **Check only** to run `git apply --check` without changing files. Use **Apply patch** to modify the workspace.

If a patch fails, Rel.AI surfaces the real `git apply --check` / `git apply` stdout and stderr so you can see the exact cause.

---

## How Rel.AI changes your original code

When you click **Apply with Rel.AI**, the browser extension sends the metadata and diff to the native host `com.relai.request_builder`.

The native host resolves the workspace alias from `~/.rel-ai/opencode.json`, writes the diff to a temporary file, then runs these commands inside the workspace:

```bash
git apply --check /tmp/relai-diff-*/patch.diff
git apply --whitespace=warn /tmp/relai-diff-*/patch.diff
```

The actual file modifications are done by Git patch application. ChatGPT does not write files directly, and the browser extension does not write files directly.

OpenCode only runs if fallback is enabled and patch application or tests fail.

---

## OpenCode fallback and server

Rel.AI can use OpenCode in two ways:

- **Fallback repair**: if Git patch application or tests fail, OpenCode can attempt the smallest safe local repair.
- **Server interaction**: the dashboard can start, check, or open an OpenCode server for the selected workspace.

Fallback status is written under `.relai/` in the workspace, including `fallback-latest.json`, so you can verify whether OpenCode started, completed, failed, or timed out.

Optional server config:

```bash
node apps/native-host/scripts/relai-config.js set opencode-server-url http://127.0.0.1:4096
node apps/native-host/scripts/relai-config.js set opencode-server-args serve
```

---

## Safety behavior

Rel.AI blocks:

- absolute paths
- `..` traversal
- paths outside the allowlisted workspace
- common secret paths such as `.env`, `.ssh`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, `.aws/`, `.azure/`, `gcloud/credentials`, `firebase-adminsdk*.json`, `service-account*.json`, and credential files
- binary-looking files in context bundles
- direct test commands from ChatGPT unless you explicitly enable them
- silent full workspace reads; full repo upload mode must be explicitly selected and still applies ignore, size, binary, and secret-path filters

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

---


## Debug mode

Diagnostics are hidden in normal use so the dashboard stays release-ready. To open the debug panel, press **Ctrl+Shift+D** while the Rel.AI dashboard is focused.

Debug mode shows recent bridge events, request-building steps, ZIP upload status, native-host responses, and apply/fallback details. Use **Copy debug log** when reporting issues, then press **Ctrl+Shift+D** again to hide diagnostics.

---

## Troubleshooting

### Native host not found

Run the installer from the current project folder:

```bash
npm run install:chrome-host -- --extension-id YOUR_EXTENSION_ID
```

Then reload the extension and refresh ChatGPT.

### Patch failed to apply

Run **Check only** first. Rel.AI will show the exact `git apply --check` error.

Common causes:

- ChatGPT generated a patch against stale context.
- A file already exists but the diff used `/dev/null` or `new file mode`.
- The file casing is wrong, such as `readme.md` instead of `README.md`.
- A file was omitted from the selected context.

### Extension context invalidated

If Chrome shows `Extension context invalidated`, refresh the ChatGPT tab after reloading or replacing the unpacked extension.

### ZIP upload fails

ZIP upload uses the page-context drag/drop path first. If ChatGPT does not confirm the attachment, download the generated ZIP from Rel.AI and drag it into the open ChatGPT tab manually. The previous draggable ZIP-card fallback was removed because it was not reliable across ChatGPT page states.

---

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

---

## Version history

### 0.9.48

- Raises `MAX_ZIP_FILE_BYTES` from 5 MB to 50 MB so large individual files are no longer rejected when building ZIP context bundles.
- Raises `MAX_ZIP_UPLOAD_BYTES` from 25 MB to 100 MB so larger workspace ZIPs can be uploaded to ChatGPT. ChatGPT's per-file upload limit is 512 MB; the previous 25 MB cap was unnecessarily conservative.
- Raises `DEFAULT_MAX_FILE_BYTES` from 80 KB to 200 KB so more source files pass the per-file size check in readable context mode.
- Fixes "All matched context files were skipped" error to include the specific file paths and skip reasons (e.g. `src/api.ts (larger than 200000 bytes)`) instead of the generic message that gave no actionable information.
- Fixes readable bundle error to also report file details and suggest switching to ZIP context mode when all files exceed the bundle character limit.
- Canvas diff support: Rel.AI now reads the unified diff from the ChatGPT Canvas document when the diff is not present in the chat message. ChatGPT is instructed to write long diffs (80+ lines) to Canvas to avoid hitting the response length limit. The inline Apply button shows "Diff will be read from Canvas." when only a metadata block is detected in the chat. The pre-apply preview shows a "Diff source: Canvas" badge when the diff came from Canvas. Both the inline button path and the popup "Apply latest" path augment with Canvas content automatically.
- Improves Gemini prompt improvement card: "Improve with Gemini" button is always visible in the card header; model and API key settings are collapsed into a `<details>` block; status changes to a green pill badge when a key is configured.
- Fixes `input[type="password"]` missing from popup CSS input selectors so the Gemini API key field matches all other inputs.
- Groups popup action buttons into labeled Context and Apply patch sections.

### 0.9.47

- Fixes `input[type="password"]` missing from the CSS input selector, so the Gemini API key field now matches all other inputs (border, border-radius, padding, font).
- Redesigns the Gemini prompt improvement card: moves the **Improve with Gemini** button into the card header so it is always visible; collapses model and API key settings into a `<details>` block; replaces the plain `<code>` status line with a pill badge that turns green when a key is configured; uses a purple/violet button color matching the card theme.

### 0.9.46

- Improves popup UI: adds CSS custom properties for consistent theming, groups action buttons into labeled **Context** and **Apply patch** sections, adds status indicator color states (green/red), improves button hierarchy with a bolder primary action, adds focus rings on inputs, and refines section spacing.
- Improves the pre-apply patch preview dialog: panel now uses a sticky header and footer so the title and action buttons stay visible while the diff is scrolled; diff is syntax-highlighted with green backgrounds for added lines, red for removed lines, blue-italic for hunk headers, and bold for file headers; the **Apply patch** button is now green and visually distinct from **Cancel** and **Check only**; the fallback toggle has a bordered card style; the warning note is an amber callout box instead of plain text; the overlay adds a blur backdrop.
- Adds `relai-preview-body` and `relai-preview-footer` layout wrappers to the patch preview panel for the sticky layout.
- Adds `relai-diff-add`, `relai-diff-remove`, `relai-diff-hunk`, and `relai-diff-header` CSS classes for diff syntax coloring.
- Adds `.relai-preview-toggle` CSS class for the fallback checkbox label.
- Updates `setStatus` in `popup.js` to set `className` (`ok`/`err`) instead of an inline `style.color` so status color is driven by CSS variables.

### 0.9.45

- Fixes follow-up context ZIP upload failing silently: raises the inline base64 size limit from 250 KB to 32 MB so virtually all follow-up ZIPs include a base64 payload and upload automatically instead of being dropped.
- Fixes `contextText()` to include the archive path in the attached file object (matching the main compose flow), so large ZIPs that still exceed the base64 threshold have a path available for CDP fallback upload.
- Fixes `uploadFiles()` in the MAIN-world insert script to skip files with no base64 content instead of creating 0-byte File objects that always fail ChatGPT attachment confirmation; surfaces a clear download-and-drag message in that case.
- Adds automatic tech-stack detection for full repo upload: reads root-level manifest files once per request and applies stack-specific exclusions beyond the generic defaults. Detected stacks: Node/JS/TS (`.nyc_output`, `storybook-static`, `*.snap`), Python (`.eggs`, `.tox`, `htmlcov`, `*.pyc`), Rust (`*.rlib`, `*.rmeta`), Java/Kotlin (`.gradle`, `*.class`, `*.jar`), PHP (`storage/logs`, `bootstrap/cache`), Ruby (`.bundle`, `public/assets`), iOS/macOS (`DerivedData`, `xcuserdata`), Flutter (`*.freezed.dart`, `*.g.dart`), and .NET (`bin`, `obj`, `*.dll`).
- Updates context scope guidance sent to ChatGPT to mention stack-aware filtering so the model understands why certain file types are absent.
- Renames and clarifies quick action buttons in the dashboard and popup: "Insert latest context request" becomes "Provide latest context request", adds hover tooltips (`title` attributes) explaining exactly what each button reads, reads from, and inserts.
- Renames "Manual blocks" panel to "Manual paste tools" with explanatory notes describing when each tool is needed.
- Updates dashboard context scope description to list the tech stacks that full repo upload auto-detects.

### 0.9.44

- Fixes `EXTENSION_VERSION` to read from the extension manifest instead of a stale hardcoded string, so version mismatch error messages show the correct installed version.
- Fixes native messaging buffer accumulation from O(N²) chunk-by-chunk concat to a single allocation, and raises the inbound message size limit from 8 MB to 64 MB so large ZIP context payloads are never silently dropped.
- Fixes file read race in context bundle collection: `statSync`/`readFileSync` pairs are now wrapped in try/catch so files removed between the two calls are added to `skipped` instead of crashing the request.
- Fixes O(N²) task-mentioned file filter when building the prioritized file list; now uses a `Set` for O(1) membership checks.
- Adds automatic cleanup of temp ZIP archives older than 4 hours so `os.tmpdir()/rel-ai-archives/` does not accumulate stale ZIPs across sessions.
- Expands secret path blocking in both context bundle and patch apply to cover `.aws/`, `.azure/`, `gcloud/credentials`, `firebase-adminsdk*.json`, `service-account*.json`, `.npmrc`, `.pypirc`, and `.netrc`. Previously patchApply and contextBundle had divergent lists; they are now unified.
- Fixes `stripQuotedPath` to decode git octal escape sequences (`\303\251` → `é`) so diffs against non-ASCII filenames pass path validation.
- Improves the protocol version mismatch error to show both the version the extension sent and the version the host expects, making host/extension version skew easier to diagnose.
- Fixes Gemini model validation to allow `/` so provider-namespaced model paths such as `models/gemini-pro` are accepted.
- Adds Gemini API key validation for control characters and embedded whitespace before the key reaches the HTTP header.
- Guards against `child.pid` being `undefined` when the OpenCode server process fails to assign a PID on spawn.
- Fixes textarea composer insert to use the React-compatible native value setter so React's internal state is updated and the ChatGPT Send button is no longer left disabled after insertion.
- Removes the dead `formatBytes` helper from popup.js (defined but never called).
- Adds a try/catch around `atob()` in `base64ToBlob` so corrupted ZIP data shows a user-facing error instead of an unhandled exception.
- Fixes `restoreDraft` to use the HTML element's `defaultValue` as the maxFiles fallback instead of a hardcoded `"15"`, so the dashboard's own `value="25"` default is respected on first use.
- Adds `role` and `aria-live` attributes to the dashboard status element so error and success states are announced to screen readers.

### 0.9.43

- Detects raw JSON rel-ai-context requests even when ChatGPT returns them as plain text after a long prompt with other JSON blocks.
- Manual context extraction now scans JSON objects from newest to oldest and accepts the first valid context request.


### 0.9.42

- Tells ChatGPT to keep follow-up requested-file lists short by using safe subdirectory globs such as `lib/data/services/**` when several files from one folder are needed.
- Validates context include/exclude globs so only `subdir/**` directory globs are accepted; broad workspace globs, filename wildcards, absolute paths, and traversal are rejected.
- Adds native-host smoke coverage for preserving safe directory globs and rejecting unsafe wildcard requests.

### 0.9.41

- Wraps follow-up context insertions with explicit Rel.AI follow-up instructions instead of inserting only the raw context bundle.
- Lists requested paths and included files in follow-up prompts so ChatGPT can detect stale or wrong ZIP attachments.
- Adds a request boundary to new prompts so older Rel.AI tasks, workspaces, manifests, and ZIPs in the same chat are ignored.
- Extends browser-side raw JSON detection to `requestedFiles` context requests.


### 0.9.40

- Gives every ZIP context upload a content fingerprint in the visible archive name so follow-up requests cannot be confused with an earlier upload that had the same task prompt.
- Strengthens ChatGPT instructions to treat the current ZIP as authoritative and ignore older Rel.AI ZIP attachments.
- Clarifies that follow-up context requests should include only additional files, not repeat the previous bundle.


### v0.9.39

- Detects raw JSON context requests that use `requestedFiles` instead of `include`.
- Maps `requestedFiles` into the normal Rel.AI context include list in both browser-side and native-host validation.
- Generated prompts now explicitly tell ChatGPT to use `include` for new `rel-ai-context` requests.
- Bumps package and extension versions to `0.9.39`.

### v0.9.38

- Follow-up `rel-ai-context` requests now inherit the original request packing mode by workspace. If the original request used ZIP mode, requested follow-up files are returned as a ZIP; if it used readable text, follow-up files are returned as readable text.
- Generated prompts now tell ChatGPT to keep the same `contextMode` when asking for more context.
- Bumps package and extension versions to `0.9.38`.

### v0.9.37

- Detects raw JSON context requests that use `neededFiles` instead of `include`.
- Shows **Provide requested files** for ChatGPT responses that are not fenced as `rel-ai-context` but clearly request more workspace files.
- Maps `neededFiles` into the normal Rel.AI context include list before sending to the native host.
- Raises the context request pattern limit so larger follow-up file lists can be parsed.
- Bumps package and extension versions to `0.9.37`.

### v0.9.36

- Improves `rel-ai-context` follow-up UX with a clear **Provide requested files** inline action.
- Adds a visible context callout explaining that ChatGPT requested more workspace files and that the inserted context should be reviewed and sent.
- Adds fallback detection for context requests rendered as regular message text instead of a standard code block.
- Extends context insertion timeout for ZIP/readable follow-ups.
- Bumps package and extension versions to `0.9.36`.

### v0.9.35

- Adds optional Gemini prompt improvement before sending requests to ChatGPT.
- Adds local Gemini API key/model settings in the dashboard and CLI.
- Keeps the Gemini API key in local Rel.AI config and masks it in `config:show`.
- Adds native-host Gemini API integration through `generateContent`.
- Bumps package and extension versions to `0.9.35`.

### v0.9.34

- Adds a clearer **Full repo upload (filtered)** option for broad context tasks.
- Full repo mode now filters dependency folders, build outputs, caches, temporary files, logs, source maps, minified artifacts, binary files, and secret-looking paths before building the ZIP.
- Updates UI and docs to make clear that full repo upload is advanced/slow and still excludes unnecessary files.
- Bumps package and extension versions to `0.9.34`.

### v0.9.33

- Adds Plan-first response mode for reviewable `rel-ai-plan` output before patch generation.
- Adds inline **Approve plan** action that inserts an approval prompt back into ChatGPT.
- Adds `summary` support in `rel-ai-apply` metadata and the pre-apply preview so users understand proposed changes before applying.
- Strengthens missing-context instructions so ChatGPT should request `rel-ai-context` automatically when file contents are unavailable.
- Bumps package and extension versions to `0.9.33`.

### v0.9.32

- Adds context scope selection: Focused, Selected only, and advanced Full repo upload.
- Keeps compact project file tree included by default for exact path casing.
- Keeps task-mentioned files auto-included when they exist in the workspace.
- Allows ChatGPT to request follow-up files with `rel-ai-context` instead of guessing.
- Adds advanced full repo upload mode with Git-ignore, dependency/build/cache/log filtering, secret-path, binary, size, and file-count safeguards.
- Bumps package and extension versions to `0.9.32`.

### v0.9.31

- Adds a professional **Why I made this** section explaining the ChatGPT 5.5 Thinking, Codex cost/access, and OpenCode fallback motivation.
- Removes the unreliable draggable ZIP-card fallback from the dashboard and upload flow.
- Keeps manual ZIP download/drag as the reliable fallback when automatic ChatGPT upload is not confirmed.
- Bumps package and extension versions to `0.9.31`.

### v0.9.30

- Includes a compact project file tree by default in generated context so ChatGPT can preserve exact path casing and avoid duplicate files.
- Documents hidden debug mode and how to copy diagnostics when troubleshooting.
- Bumps package and extension versions to `0.9.30`.

### v0.9.29

- Adds README hero artwork and dashboard screenshots.
- Adds cropped dashboard documentation for bridge controls, request builder, context/OpenCode controls, and advanced tools.
- Rewrites README copy for a release-ready project overview.
- Bumps package and extension versions to `0.9.29`.

### v0.9.28

- Automatically includes existing files explicitly mentioned in the task prompt, such as `README.md`, even when the selected folder context would otherwise omit them.
- Adds task-mentioned file checks so generated diffs use existing paths and filename casing instead of creating duplicate files.

### v0.9.27

- Improves inline apply detection for two-block ChatGPT responses where rendered language labels appear as visible text.

### v0.9.26

- Removes title from generated ChatGPT requests and `rel-ai-apply` metadata.
- Strengthens patch instructions so ChatGPT treats the uploaded/readable context as the current repository state.

### v0.9.25

- Shows exact `git apply --check`, `git apply`, test, or fallback stdout/stderr when an apply fails.
- Adds OpenCode server controls in the dashboard.

### v0.9.24

- Adds OpenCode fallback status tracking and timeout reporting.

### v0.9.23

- Optimizes ZIP upload for the confirmed MAIN-world drag/drop path.
- Removes debugger permission and slow CDP/file-picker upload attempts from the default flow.
- Keeps diagnostics hidden behind **Ctrl+Shift+D**.
