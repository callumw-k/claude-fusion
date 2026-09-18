# AGENTS.md

claude-fusion is a Claude Code plugin: a `fusion` MCP tool runs a prompt against a panel of models in parallel, then a judge returns structured analysis. Ported from pi-fusion. Design: `docs/superpowers/specs/2026-09-18-claude-fusion-design.md`.

## Commands

- `npm run check` type-checks. There is no build step: Node ≥ 22.18 strips types natively, so `.mcp.json` and hooks run `node src/*.ts` directly. Source must stay erasable-syntax only (`erasableSyntaxOnly` in tsconfig).
- `npm test` runs every `src/__tests__/*.test.ts` with plain `node`. The runner is `src/__tests__/_harness.ts` (`test`, `eq`). There is no jest/vitest. One suite: `node src/__tests__/<name>.test.ts`.
- `npm run check:strict` catches unused imports and locals. Run it before finishing a change.
- `npm run validate` runs `claude plugin validate .`.
- Try it live: `npm install`, then `claude --plugin-dir /abs/path/to/claude-fusion`. `/reload-plugins` after edits.

## Architecture

- `src/server.ts` is the MCP entry (tools `fusion`, `fusion_report`). `src/cli.ts` is the entry for hooks and slash commands (`hook <event>`, `fusion <args>`, `status`, `init`).
- `src/fusion.ts` `runFusion` is the pipeline: resolve panel and judge (`models.ts`) → run the panel through `backends/*` concurrently (`utils.ts` `mapWithConcurrencyLimit`) → judge → `FusionDetails` (`types.ts`). `format.ts` renders the report.
- `src/backends/` has one implementation per model id prefix: `claude/*` spawns `claude -p` (`claude.ts`), `openrouter/*` calls the OpenRouter HTTP API (`openrouter.ts`). `registry.ts` parses ids. The `Backend` interface is in `backends/types.ts`.
- `src/config.ts` reads `<project>/.claude/fusion.json` then `~/.claude/fusion.json`. Panel and judge are always user configuration. The `fusion` tool exposes only `prompt`.
- `src/state.ts` keeps per-session mode (`available`/`forced`/`off`) and an armed named panel in `~/.claude/claude-fusion/sessions/<session_id>.json` (`FUSION_DATA_DIR` overrides the directory). Hooks get the session id from stdin. The server and commands read `CLAUDE_CODE_SESSION_ID`, falling back to the `current-session` pointer the `UserPromptSubmit` hook writes.
- `.claude-plugin/plugin.json` deliberately has no `hooks` key: Claude Code 2.1.276 auto-loads `hooks/hooks.json`, so don't add one.

## Conventions

- Tabs, double quotes, `.ts` import extensions. Keep the runtime dependency list to the MCP SDK and zod.
- Verify MCP SDK and Claude Code plugin APIs against the installed `.d.ts` and the docs at code.claude.com before using them.
