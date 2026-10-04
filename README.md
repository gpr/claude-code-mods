# claude-code-mods

**See what each git branch really costs you in Claude Code, across every session, model and subagent.**

A Claude Code plugin marketplace. It currently ships one plugin, [`branch-usage`](plugins/branch-usage), which adds a live cost pane, a cost line above the prompt, a `/branch-usage` report, and an optional cost comment on your pull request.

```
/plugin marketplace add gpr/claude-code-mods
/plugin install branch-usage@claude-code-mods
```

---

## Why

Claude Code tells you what *this session* cost. A feature branch takes many sessions: a first attempt, a `/clear`, a review pass the next morning, subagents fanning out in between. `branch-usage` adds them all up per branch, so you can answer "what did this feature cost?" and "which model or agent spent the money?" without a spreadsheet.

## What you get

### A live pane

It opens on the right when a session starts and refreshes every 10 seconds. When it opens on its own, Claude Code only places it if the terminal is wide enough; `/branch-usage` opens it at any width.

```
feat/pricing-api (#42)                       $3.418
  3 sessions
  this session, engine total $1.198

By model
  - opus-5-5                            83% $2.840
    in 310.0k out 32.5k cr 3.0M cw 70.0k
  - haiku-4-5                           17% $0.578
    in 210.0k out 41.5k cr 1.2M cw 32.4k

By agent
  - main · 31 req                       83% $2.840
    in 310.0k out 32.5k cr 3.0M cw 70.0k
  - Explore · 12 req                    17% $0.578
    in 210.0k out 41.5k cr 1.2M cw 32.4k

By session
  - ● 3f9a2c1d  just now                     $1.204
  -   8b7e0a44  2h ago                       $1.650
  -   c01d9e5f  1d ago                       $0.564
```

- `cr` / `cw` = cache read / cache write tokens.
- `●` marks the current session.
- `~` after a model name means its price is estimated (see [Pricing](#pricing)).
- `(#42)` is a clickable link to the branch's open PR.

### A line above the prompt

```
$3.418 · feat/pricing-api (#42)
```

### `/branch-usage`

Focuses the pane and prints a markdown report: the total, plus tables by model, agent and session with requests, input, output, cache read, cache write and cost.

### A tool Claude can call

`get_branch_usage` lets Claude answer questions like *"how much has this branch cost so far?"* or *"compare with `main`"*. It takes an optional `branch` and defaults to the current one.

### A cost comment on your PR

After Claude runs `gh pr create` or `git push` successfully through its Bash tool, the plugin posts the branch report as a comment on the branch's open PR. Later pushes **edit that same comment** (found by its `<!-- branch-usage -->` marker) instead of adding new ones.

> [!IMPORTANT]
> This publishes your branch's token counts and costs to everyone who can see the PR. It runs automatically and there is currently no setting to turn it off. Pushes you run in your own terminal don't trigger it.

## Requirements

- Claude Code with plugin hooks-module support (mods).
- A git repository. Outside one, the plugin shows *Not inside a git repository* and records nothing.
- [`gh`](https://cli.github.com/), authenticated, **only** for the PR link and PR comment. Without it, everything else works and the failure is logged.

## How it works

1. **Every model response is recorded.** That covers the main agent and every subagent, labelled with the subagent type (`Explore`, `Plan`, …). The plugin adds the response's input, output, cache-read and cache-write tokens to the session's file, and prices them at that moment.
2. **One file per session, per branch**, in your repo:
   ```
   .claude/branch-usage/<url-encoded branch>/<session id>.json
   ```
   `feat/x` is stored as `feat%2Fx`.
3. **Sessions follow your branch.** At each turn the session re-attaches to the branch currently checked out. A `git checkout` mid-session starts a file under the new branch, and `/clear` starts a new session file.
4. **The pane adds up** all session files of the current branch: by model, by agent and by session.

Writes are serialized, so parallel subagents never lose an update. Because the data lives in plain files, every session on the branch sees the same totals, including several Claude Code windows open at once.

## Pricing

Costs are computed from a built-in price table in **$ per million tokens**. The longest matching model-id prefix wins, so `claude-opus-5-5` uses its own row, not `claude-opus-5`.

| Model prefix | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| `claude-fable`, `claude-mythos` | 10 | 50 | 0.25 | 12.50 |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5.00 |
| `claude-opus-5` | 5 | 25 | 0.50 | 6.25 |
| `claude-opus-4-1`, `claude-opus-4-2` | 15 | 75 | 1.50 | 18.75 |
| `claude-opus-4` | 5 | 25 | 0.50 | 6.25 |
| `claude-sonnet-5` | 2 | 10 | 0.20 | 2.50 |
| `claude-sonnet-4`, `claude-sonnet-3` | 3 | 15 | 0.30 | 3.75 |
| `claude-haiku-4` | 1 | 5 | 0.10 | 1.25 |
| `claude-haiku-3-5` | 0.80 | 4 | 0.08 | 1.00 |
| `claude-haiku-3` | 0.25 | 1.25 | 0.025 | 0.3125 |

A model that matches no prefix is priced at **$3 / $15** and flagged `~` in the pane and `(~price)` in the report.

### Overriding prices

Set the plugin's **Price overrides** option in `/config` to a JSON object keyed by model-id prefix:

```json
{
  "claude-haiku-4": { "in": 2, "out": 9 },
  "my-custom-model": { "in": 1, "out": 4, "cacheRead": 0.1, "cacheWrite": 1.25 }
}
```

- `in` and `out` are required.
- `cacheRead` defaults to 0.1 × `in`, and `cacheWrite` to 1.25 × `in`.
- Overrides are merged over the built-in table.
- Invalid JSON is reported with the option's name.

Prices are applied when usage is recorded, so a change affects new usage only, not history already on disk.

## Data and privacy

- All data stays on your machine, in `.claude/branch-usage/` at the repo root. The one exception is the [PR comment](#a-cost-comment-on-your-pr).
- Add that folder to your `.gitignore` so session files don't get committed:
  ```
  .claude/branch-usage/
  ```
- To reset a branch's history, delete its folder.

## Accuracy and limitations

- **Estimates, not your bill.** Costs use list prices from the table above. Discounts, batch pricing and plan-based billing aren't modelled. To sanity-check, the pane shows Claude Code's own total for the current session (*engine total*) beside the plugin's figure.
- **Only sessions with the plugin installed are counted.** Earlier sessions, and teammates without the plugin, don't show up.
- **Branch renames split history**, because data is keyed by branch name. A detached HEAD is tracked as `detached@<short sha>`.
- **The PR comment is updated only on a push or PR creation by Claude.** Usage after the last push appears at the next one.

## Development

There is no `package.json`; everything runs through the `claude` CLI, per plugin folder:

```sh
claude plugin validate plugins/branch-usage   # manifest + hooks, as the engine checks them
claude plugin test plugins/branch-usage       # runs hooks/*.test.ts
claude --plugin-dir plugins/branch-usage      # try it in a real session
tsc -p plugins/branch-usage                   # type-check (after the plugin has loaded once)
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code generates when it loads the plugin, so type-checking works only after a first `--plugin-dir` run.

The architecture is described in [`CLAUDE.md`](CLAUDE.md). In short:

- `hooks/register.tsx` wires events, UI and `gh`.
- `hooks/usage.ts` holds the pure, tested logic: pricing, aggregation and formatting.
- `types/index.d.ts` holds the data types and the plugin's state contract.

### Layout

```
.claude-plugin/marketplace.json     marketplace manifest (lists every plugin)
plugins/branch-usage/
  .claude-plugin/plugin.json        plugin manifest + the "prices" option
  hooks/hooks.json                  points at register.tsx
  hooks/register.tsx                hooks: recording, pane, band, command, tool, PR sync
  hooks/usage.ts                    pricing, aggregation, report formatting
  hooks/usage.test.ts               tests for usage.ts
  types/index.d.ts                  shared types + PluginState contract
```

### Adding a plugin

Create `plugins/<name>/`, then list it in `.claude-plugin/marketplace.json` and in this README.
