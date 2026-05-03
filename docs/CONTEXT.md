# Workspace context requests

Rel.AI supports workspace context in two packing modes:

- **Readable text**: inserts selected file contents directly into the ChatGPT composer. This is the most reliable mode for small, precise changes.
- **ZIP attachment**: creates an actual `.zip` file from selected local files and attaches it to the open ChatGPT tab, while inserting instructions, a manifest, and a compact project file tree.

Rel.AI also supports three context scopes:

- **Focused**: compact project file tree + selected context + safe task-mentioned files. This is the recommended default.
- **Selected only**: compact project file tree + explicitly selected files/folders/globs + safe task-mentioned files.
- **Full repo archive**: advanced/slow ZIP mode that packages safe Git-visible workspace files while respecting excludes, `.gitignore`, secret-path blocking, binary detection, and file limits.

ChatGPT never receives direct filesystem access. Rel.AI reads local files only through the native host after you choose a workspace alias and context scope.

## Request format

```json
{
  "version": 1,
  "workspace": "myapp",
  "prompt": "What ChatGPT should do after receiving the files.",
  "include": ["src/auth.ts", "tests/**/*.test.ts"],
  "exclude": ["**/*.snap"],
  "maxFiles": 10,
  "maxChars": 60000,
  "contextMode": "readable",
  "contextScope": "focused"
}
```

Use `contextMode: "zip"` for real ZIP upload mode.

Use `contextScope: "full"` for full repo archive mode. Full repo archive mode automatically uses ZIP attachment and can omit `include`.

## Dashboard workflow

1. Open ChatGPT.
2. Open the Rel.AI dashboard.
3. Choose a workspace alias.
4. Choose a context scope.
5. Pick files/folders/globs unless using full repo archive mode.
6. Choose **Readable text** or **ZIP attachment**. Full repo archive always uses ZIP.
7. Click **Create ChatGPT request**.

In ZIP attachment mode, Rel.AI attaches a real `.zip` file when ChatGPT accepts the automated upload path, then inserts the task instructions into the composer. If attachment is not confirmed, Rel.AI offers a manual ZIP download/drag fallback.

## Follow-up context

If ChatGPT can see a path in the project file tree but does not have the file contents, it should ask for more context instead of guessing. The response should use a `rel-ai-context` block listing the needed files.

## Safety limits

- No absolute paths.
- No `..` traversal.
- No secret-looking paths.
- No binary-looking source files inside readable or ZIP context.
- No silent whole-workspace dump. Full repo archive must be explicitly selected.
- Uses `git ls-files --cached --others --exclude-standard` when available, so `.gitignore` is respected for glob/directory/full-repo requests.
- Oversized ZIP payloads are blocked before sending them to the browser.

## Recommendation

Use **Focused** scope and **Readable text** for precise fixes over a few files. Use **ZIP attachment** for larger selected folders. Use **Full repo archive** only when the task genuinely needs broad project context.
