# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Each plugin lives in `plugins/<name>/` and must also be listed in the marketplace file and the README. Currently one plugin: `branch-usage`, which tracks tokens and $ cost per model, agent and session for all sessions on a git branch.

## Commands

There is no package.json; everything runs through the `claude` CLI and `tsc`, per plugin folder:

- Validate manifest + hooks (what the engine would refuse): `claude plugin validate plugins/branch-usage`
- Run tests (`*.test.ts`, using `claude-code/testing`): `claude plugin test plugins/branch-usage`
- Type-check: `tsc -p plugins/branch-usage`. Its `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine generates (with the `claude-code` API types) only after it has loaded the plugin, e.g. via `claude --plugin-dir plugins/branch-usage` or a hot-reload session. It is not committed.
- Try it locally: `claude --plugin-dir plugins/branch-usage`

## Plugin anatomy (branch-usage)

- `.claude-plugin/plugin.json`: manifest. `userConfig.prices` (JSON price overrides) arrives as `options.prices` in `register`. `types` points at `types/index.d.ts`.
- `hooks/hooks.json` → `hooks/register.tsx`: the hooks module, `export const register: Register = (on, options) => …`. Every hook is `($, e, next)`; `$` is the engine interface (`$.fs`, `$.process`, `$.ui`, `$.session`, …), with no Node or DOM. JSX compiles against the engine's `h`; elements come from `$.ui.resolve(e)`.
- `hooks/usage.ts`: pure logic (pricing, aggregation, formatting, markdown report, PR-command regex). Keep engine-independent code here; it is what `usage.test.ts` covers.
- `types/index.d.ts`: shared data types and the `PluginState` contract for `$.state` atoms (`view`, `pr`). `claude plugin validate` checks every atom key against it, so add new atoms there first.

## branch-usage architecture

- **Storage**: one JSON `SessionFile` per session at `<repo>/.claude/branch-usage/<encodeURIComponent(branch)>/<sessionId>.json` (gitignored). Rows are keyed `${agent}|${model}`; cost is computed at record time with the price table (longest model-id prefix wins; unknown models use a fallback tier and are flagged `isEstimated`).
- **Recording**: the `turn.step` hook reads `result.usage` and adds it to the session file. `session.start`, `turn.start` and `classic.SessionStart` (source `clear`) re-attach the session to the *current* branch, so checkouts and `/clear` create new files. All writes go through a single promise queue (`queue`) so parallel subagent steps don't lose updates.
- **Display**: `refresh` re-reads all files of the branch, `aggregate`s them into a `BranchView`, and stores it in the `view` atom; a 10s clock plus post-record refreshes (min 2s gap) keep it current. A right `Pane` and an `AbovePrompt` band render from atoms.
- **Surfaces**: the `/branch-usage` command and the `get_branch_usage` MCP tool both return `summaryText` markdown.
- **PR sync**: after a successful Bash `gh pr create` / `git push` (`isPrSyncCommand`), it creates or PATCHes one PR comment identified by `PR_COMMENT_MARKER`, via `gh api`. The open PR (`gh pr view`) is cached in the `pr` atom and shown beside the branch name.
- **Hot reload**: a reload re-runs `register`; module-level variables (`prices`, `files`, queue, caches) reset while atoms persist. Anything important must be rebuildable from the files on disk.
