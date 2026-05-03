# Rel.AI apply format

Use `rel-ai-apply` metadata plus a separate `diff` block.

Do not put raw multiline diffs inside JSON strings.

````text
```rel-ai-apply
{
  "version": 1,
  "workspace": "myapp",
  "title": "Fix auth refresh bug",
  "prompt": "Fix the auth refresh bug. Keep the public API unchanged.",
  "context": ["src/auth.ts", "tests/auth.test.ts"],
  "testCommandKey": "unit",
  "fallback": {
    "enabled": true,
    "tool": "opencode",
    "instructions": "If the patch or tests fail, make the smallest safe repair."
  }
}
```

```diff
diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,1 +1,1 @@
-old
+new
```
````

The older JSON-with-`diff` format and raw diff blocks are still accepted for compatibility, but the two-block format is preferred.
