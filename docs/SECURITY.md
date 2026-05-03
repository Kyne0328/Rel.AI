# Security notes

Rel.AI treats ChatGPT output as untrusted. This includes both patch requests and workspace context requests.

## Main controls

- Workspace is selected by alias, never by arbitrary path from ChatGPT.
- Paths must be relative.
- Path traversal is rejected.
- Common sensitive paths are blocked.
- Normal workspace context reads require explicit include patterns; full repo archive must be explicitly selected and is still filtered.
- Context bundles are inserted into ChatGPT for review before sending.
- Context glob/directory reads use git ignored-file rules when possible.
- Direct test commands from ChatGPT are disabled by default.
- Test commands should be configured locally and referenced by key.
- OpenCode fallback is optional and only runs after patch or test failure.
- OpenCode fallback model is configured locally.

## Context reads

ChatGPT cannot silently read your local files. It can only produce a `rel-ai-context` request. You must click the Rel.AI button before files are read. Rel.AI then inserts the bundle into the composer instead of auto-submitting it.

Silent entire-workspace reads are blocked. Use explicit files, directories, or narrow globs for normal work. Full repo archive mode is available as an advanced option, but it still respects Git ignored-file rules, exclude patterns, binary detection, file limits, and secret-path blocking.

## Sensitive paths blocked

Rel.AI blocks common patterns such as:

- `.env`
- `.ssh`
- `id_rsa`
- `id_ed25519`
- `*.pem`
- `*.key`
- credential/secret paths

This is not a complete data-loss prevention system. Review patches before using them on sensitive repositories.

## Direct commands

`testCommand` in a ChatGPT block is rejected unless `allowDirectTestCommands` is manually set to `true` in `~/.rel-ai/opencode.json`.

Preferred approach:

```bash
npm run testcmd:add -- myapp unit "npm test -- --runInBand"
```

Then ChatGPT can use:

```json
{"testCommandKey":"unit"}
```
