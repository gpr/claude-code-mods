import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BranchView, PrLink, SessionFile } from '../types'
import {
  DEFAULT_PRICES,
  addUsage,
  aggregate,
  buildPrices,
  emptyView,
  formatUsd,
  isPrSyncCommand,
  newSessionFile,
  prCommentBody,
  PR_COMMENT_MARKER,
  relativeTime,
  sharePct,
  shortModel,
  summaryText,
  tokenLine,
  usageDir,
  type PriceTable,
  type TokenUsage,
} from './usage'

const PANE = 'branch-usage'
const TOOL = 'mcp__branch-usage__get_branch_usage'
const REFRESH_MS = 10_000
const MIN_REFRESH_GAP_MS = 2_000
const PR_COLOR = 'blue'

const view = atom({ plugin: 'branch-usage', key: 'view' } as const, emptyView('', null))
const prLink = atom({ plugin: 'branch-usage', key: 'pr' } as const, null as PrLink | null)

// Module variables start over on a hot reload; everything here is rebuilt
// from the session files on disk.
let prices: PriceTable = DEFAULT_PRICES
let writes: Promise<unknown> = Promise.resolve()
let lastRefresh = 0
let prBranch: string | null = null
const agentTypes = new Map<string, string>()
const files = new Map<string, SessionFile>()

async function git($: EngineInterface, ...args: string[]): Promise<string | null> {
  const ran = await $.process.run(['git', ...args], { cwd: await $.session.root() })
  return ran.exitCode === 0 ? ran.stdout.trim() : null
}

async function currentBranch($: EngineInterface): Promise<string | null> {
  const name = await git($, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (name === null) return null
  if (name !== 'HEAD') return name
  const sha = await git($, 'rev-parse', '--short', 'HEAD')
  return `detached@${sha ?? 'unknown'}`
}

async function readBranchFiles($: EngineInterface, root: string, branch: string): Promise<SessionFile[]> {
  const dir = usageDir(root, branch)
  if (!(await $.fs.exists(dir))) return []
  const found: SessionFile[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      found.push(JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as SessionFile)
    } catch (err) {
      $.ui.log(`branch-usage: skipped unreadable ${dir}/${entry.name}: ${String(err)}`)
    }
  }
  return found
}

async function compute($: EngineInterface, branchName?: string): Promise<BranchView> {
  const sessionId = await $.session.id()
  const repo = await $.session.repo()
  if (repo === null) return emptyView(sessionId, null)
  const branch = branchName ?? (await currentBranch($))
  if (branch === null) return emptyView(sessionId, null)
  return aggregate(await readBranchFiles($, repo.root, branch), branch, sessionId)
}

async function refresh($: EngineInterface): Promise<void> {
  lastRefresh = Date.now()
  try {
    const next = await compute($)
    await update($, view, () => next)
    if (next.branch !== prBranch) await refreshPr($)
  } catch (err) {
    $.ui.log(`branch-usage: refresh failed: ${String(err)}`)
  }
}

async function agentLabel($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return 'main'
  if (!agentTypes.has(agentId)) {
    for (const agent of await $.agent.list()) agentTypes.set(agent.id, agent.type)
  }
  return agentTypes.get(agentId) ?? 'subagent'
}

type Attached = { key: string; path: string; file: SessionFile; isNew: boolean }

/** Finds this session's file on the current branch, creating it in memory when absent. */
async function loadSessionFile($: EngineInterface): Promise<Attached | null> {
  const repo = await $.session.repo()
  const branch = await currentBranch($)
  if (repo === null || branch === null) return null
  const sessionId = await $.session.id()
  const key = `${branch}/${sessionId}`
  const path = `${usageDir(repo.root, branch)}/${sessionId}.json`
  const known = files.get(key)
  if (known !== undefined) return { key, path, file: known, isNew: false }
  if (await $.fs.exists(path)) {
    return { key, path, file: JSON.parse(await $.fs.read(path)) as SessionFile, isNew: false }
  }
  return { key, path, file: newSessionFile(sessionId, branch, Date.now()), isNew: true }
}

// Attaches the session to its branch: its file exists from the first turn on,
// and again under the new branch after a checkout or a new id after /clear.
async function attachNow($: EngineInterface): Promise<void> {
  const attached = await loadSessionFile($)
  if (attached === null) return
  files.set(attached.key, attached.file)
  if (attached.isNew) {
    await $.fs.write(attached.path, JSON.stringify(attached.file, null, 2))
    await refresh($)
  }
}

async function recordNow(
  $: EngineInterface,
  agentId: string | undefined,
  model: string,
  usage: TokenUsage,
): Promise<void> {
  const attached = await loadSessionFile($)
  if (attached === null) return
  const now = Date.now()
  const file = addUsage(attached.file, { agent: await agentLabel($, agentId), model, usage }, prices, now)
  files.set(attached.key, file)
  await $.fs.write(attached.path, JSON.stringify(file, null, 2))
  if (now - lastRefresh >= MIN_REFRESH_GAP_MS) await refresh($)
}

async function gh($: EngineInterface, args: string[], stdin?: string): Promise<string> {
  const ran = await $.process.run(['gh', ...args], { cwd: await $.session.root(), stdin })
  if (ran.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} exited ${ran.exitCode}: ${ran.stderr.trim()}`)
  }
  return ran.stdout.trim()
}

/** The open PR of the current branch, or null when there is none or `gh` fails (logged). */
async function lookupPr($: EngineInterface, branch: string): Promise<PrLink | null> {
  try {
    const json = await gh($, ['pr', 'view', '--json', 'number,url'])
    const { number, url } = JSON.parse(json) as { number: number; url: string }
    return { branch, number, url }
  } catch (err) {
    if (!String(err).includes('no pull requests found')) {
      $.ui.log(`branch-usage: could not look up the PR of ${branch}: ${String(err)}`)
    }
    return null
  }
}

// Sets prBranch first, so a failing lookup is not retried on every refresh tick.
async function refreshPr($: EngineInterface): Promise<PrLink | null> {
  const branch = await currentBranch($)
  prBranch = branch
  const found = branch === null ? null : await lookupPr($, branch)
  await update($, prLink, () => found)
  return found
}

// Creates the PR comment, or edits it when the marker comment already exists.
async function syncPrCommentNow($: EngineInterface): Promise<void> {
  const repo = await $.session.repo()
  const branch = await currentBranch($)
  if (repo === null || branch === null) return
  const link = await refreshPr($)
  if (link === null) return
  const pr = link.number
  const body = prCommentBody(aggregate(await readBranchFiles($, repo.root, branch), branch, ''))
  const found = await gh($, [
    'api',
    `repos/{owner}/{repo}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `[.[] | select(.body | startswith("${PR_COMMENT_MARKER}")) | .id][0] // empty`,
  ])
  const id = found.split('\n')[0]
  if (id === '') {
    await gh($, ['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${pr}/comments`, '-F', 'body=@-'], body)
  } else {
    await gh($, ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '-F', 'body=@-'], body)
  }
  $.ui.toast(`branch-usage: PR #${pr} comment ${id === '' ? 'created' : 'updated'}`)
}

// One write at a time, so parallel subagent steps never lose an update.
function queue($: EngineInterface, job: () => Promise<void>): Promise<unknown> {
  writes = writes.then(job).catch(err => $.ui.log(`branch-usage: could not write usage: ${String(err)}`))
  return writes
}

function attach($: EngineInterface): Promise<unknown> {
  return queue($, () => attachNow($))
}

function record(
  $: EngineInterface,
  agentId: string | undefined,
  model: string,
  usage: TokenUsage,
): Promise<unknown> {
  return queue($, () => recordNow($, agentId, model, usage))
}

export const register: Register = (on, options) => {
  prices = buildPrices(String(options.prices ?? ''))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branch-usage',
      description: 'Show token usage and cost of all sessions on this branch',
    })
    await $.tool.register({
      name: 'get_branch_usage',
      description:
        'Tokens (in/out/cache read/cache write) and $ cost per model, agent and session for all Claude Code sessions on a git branch. Defaults to the current branch.',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string', description: 'Branch name; default is the current branch.' } },
      },
    })
    await attach($)
    await refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
    void $.ui.open({ id: PANE, title: 'Branch usage' })

    return next(e)
  })

  // /clear starts a new session id without session.start; attach it now so
  // the pane lists it before the first prompt.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await attach($)

    return next(e)
  })

  // A checkout moves the branch: each turn re-attaches to the current branch.
  on('turn.start', async ($, e, next) => {
    await attach($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage !== null) {
      const { model, ...usage } = result.usage
      await record($, e.agentId, model, usage)
    }

    return result
  })

  // After a PR is created or the branch is pushed, post or refresh the usage comment.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && isPrSyncCommand(e.command)) {
      void queue($, () => syncPrCommentNow($))
    }

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const cost = e.cost
    if (cost !== undefined) {
      const sessionId = await $.session.id()
      for (const [key, file] of files) {
        if (key.endsWith(`/${sessionId}`)) files.set(key, { ...file, engineUsd: cost.usd })
      }
      await update($, view, v => ({ ...v, engineUsd: cost.usd }))
    }

    return next(e)
  })

  on('command.run', { command: 'branch-usage' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Branch usage', focus: true })
    await refreshPr($)
    await refresh($)

    return { text: summaryText(await compute($)) }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const asked = (e as { branch?: unknown }).branch
    const branch = typeof asked === 'string' && asked !== '' ? asked : undefined

    return { result: summaryText(await compute($, branch)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { branch, totalUsd } = await read($, view)
    if (e.props.hasSurvey || branch === null) return next(e)

    const { Box, Link, Text } = $.ui.resolve(e)
    const link = await read($, prLink)

    return (
      <Box>
        <Text dimColor>
          {formatUsd(totalUsd)} · {branch}
          {link?.branch === branch ? ' ' : ''}
        </Text>
        {link?.branch === branch && (
          <Link href={link.url}>
            <Text color={PR_COLOR} underline>(#{link.number})</Text>
          </Link>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Link, Text } = $.ui.resolve(e)
    const { branch, sessionId, sessions, byModel, byAgent, totalUsd, engineUsd, error } = await read($, view)
    const link = await read($, prLink)
    const rows = Math.max(1, (e.viewport?.rows ?? 30) - 4)

    if (error !== undefined) return <Text color="red">{error}</Text>
    if (branch === null) return <Text dimColor>Not inside a git repository.</Text>

    const now = Date.now()
    // Label shrinks and truncates; the right part keeps its width, so the
    // cost column stays on the right edge.
    const line = (label: string, usd: number, share: string | null, props: { bold?: boolean; color?: string } = {}) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end" {...props}>{label}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {share !== null && <Text dimColor>{share} </Text>}
          <Text {...props}>{formatUsd(usd)}</Text>
        </Box>
      </Box>
    )
    // The PR link sits right of the branch name and outside the truncating
    // label, so a long branch name never cuts it off.
    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end" bold>{branch}</Text>
          </Box>
          {link?.branch === branch && (
            <Box flexShrink={0}>
              <Text> </Text>
              <Link href={link.url}>
                <Text color={PR_COLOR} underline>(#{link.number})</Text>
              </Link>
            </Box>
          )}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text bold>{formatUsd(totalUsd)}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </Text>
        {engineUsd !== undefined && <Text dimColor>this session, engine total {formatUsd(engineUsd)}</Text>}
        <Box marginTop={1}>
          <Text bold>By model</Text>
        </Box>
        {byModel.map(r => (
          <Box flexDirection="column">
            {line(`${shortModel(r.model)}${r.isEstimated ? ' ~' : ''}`, r.usd, sharePct(r.usd, totalUsd))}
            <Text dimColor wrap="truncate-end">  {tokenLine(r)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text bold>By agent</Text>
        </Box>
        {byAgent.map(r => (
          <Box flexDirection="column">
            {line(`${r.agent} · ${r.requests} req`, r.usd, sharePct(r.usd, totalUsd))}
            <Text dimColor wrap="truncate-end">  {tokenLine(r)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text bold>By session</Text>
        </Box>
        {sessions.slice(0, rows).map(s => {
          const active = s.sessionId === sessionId
          return (
            line(
              `${active ? '● ' : '  '}${s.sessionId.slice(0, 8)}  ${relativeTime(s.updatedAt, now)}`,
              s.usd,
              null,
              active ? { bold: true, color: 'cyan' } : {},
            )
          )
        })}
      </Box>
    )
  })
}
