# Rel.AI architecture

```text
ChatGPT web UI
  -> Chrome/Edge extension
  -> native messaging host: com.relai.request_builder
  -> allowlisted workspace alias
  -> git apply --check
  -> git apply
  -> optional allowlisted test command
  -> optional OpenCode fallback
```

The browser extension only transports a validated apply request. It does not read local files or edit anything.

The native host is launched by the browser through native messaging. It does not require a VS Code extension, local server, or manual development-mode runtime.

The native host owns all local trust boundaries:

- workspace alias lookup
- path validation
- secret path blocking
- patch application
- test-command lookup
- OpenCode fallback launch

OpenCode is intentionally not the primary patch applicator. The primary applicator is Git.
