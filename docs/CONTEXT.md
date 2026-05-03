# Workspace context requests

Rel.AI supports workspace context in two modes:

- **Readable text**: inserts selected file contents directly into the ChatGPT composer. This is the most reliable mode for reasoning.
- **ZIP attachment**: creates an actual `.zip` file from selected local files and attaches it to the open ChatGPT tab, while inserting only instructions and a manifest.

ChatGPT never receives direct filesystem access. Rel.AI reads local files only through the native host after you choose a workspace alias and explicit include paths.

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
  "contextMode": "readable"
}
```

Use `contextMode: "zip"` for real ZIP upload mode.

## Dashboard workflow

1. Open ChatGPT.
2. Open the Rel.AI dashboard.
3. Choose a workspace alias.
4. Pick files/folders/globs.
5. Choose **Readable text** or **ZIP attachment**.
6. Click **Create ChatGPT request**.

In ZIP attachment mode, Rel.AI attaches a real `.zip` file when ChatGPT accepts the automated upload path, then inserts the task instructions into the composer. If attachment is not confirmed, Rel.AI offers a draggable ZIP fallback.

## Safety limits

- No absolute paths.
- No `..` traversal.
- No secret-looking paths.
- No binary-looking source files inside the generated context ZIP.
- No whole-workspace dump without explicit include patterns.
- Uses `git ls-files --cached --others --exclude-standard` when available, so `.gitignore` is respected for glob/directory requests.
- Oversized ZIP payloads are blocked before sending them to the browser.

## Recommendation

Use **Readable text** for precise fixes over a few files. Use **ZIP attachment** when you need to pass a folder tree with many small text files and want to keep the prompt short.
