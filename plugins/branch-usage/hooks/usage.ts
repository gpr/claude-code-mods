import type { BranchView, SessionFile, SessionSummary, UsageRow } from '../types'

export type Price = { in: number; out: number; cacheRead: number; cacheWrite: number }
export type PriceTable = Record<string, Price>
export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// $ per million tokens. Cache write = 1.25x input and cache read = 0.1x input
// unless the model's row says otherwise.
const tier = (input: number, output: number, cacheRead = input * 0.1): Price => ({
  in: input,
  out: output,
  cacheRead,
  cacheWrite: input * 1.25,
})

export const DEFAULT_PRICES: PriceTable = {
  'claude-fable': tier(10, 50, 0.25),
  'claude-mythos': tier(10, 50, 0.25),
  'claude-opus-5-5': tier(4, 20, 0.2),
  'claude-opus-5': tier(5, 25),
  'claude-opus-4-1': tier(15, 75),
  'claude-opus-4-2': tier(15, 75),
  'claude-opus-4': tier(5, 25),
  'claude-sonnet-5': tier(2, 10, 0.2),
  'claude-sonnet-4': tier(3, 15),
  'claude-sonnet-3': tier(3, 15),
  'claude-haiku-4': tier(1, 5),
  'claude-haiku-3-5': tier(0.8, 4),
  'claude-haiku-3': tier(0.25, 1.25),
}

const FALLBACK_PRICE: Price = tier(3, 15)

/** Parses the `prices` option over the defaults; throws with the reason on bad JSON. */
export const buildPrices = (raw: string): PriceTable => {
  if (raw.trim() === '') return DEFAULT_PRICES
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`branch-usage: option "prices" is not valid JSON (${String(err)}); fix it in /config`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('branch-usage: option "prices" must be an object keyed by model id prefix')
  }
  const table: PriceTable = { ...DEFAULT_PRICES }
  for (const [prefix, value] of Object.entries(parsed)) {
    const v = value as Partial<Price>
    if (typeof v?.in !== 'number' || typeof v?.out !== 'number') {
      throw new Error(`branch-usage: prices["${prefix}"] needs numeric "in" and "out"`)
    }
    table[prefix] = {
      in: v.in,
      out: v.out,
      cacheRead: v.cacheRead ?? v.in * 0.1,
      cacheWrite: v.cacheWrite ?? v.in * 1.25,
    }
  }
  return table
}

/** Longest matching prefix wins; no match gives the fallback tier, flagged. */
export const priceFor = (model: string, table: PriceTable): { price: Price; isKnown: boolean } => {
  let best: string | undefined
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (best === undefined || prefix.length > best.length)) best = prefix
  }
  return best === undefined
    ? { price: FALLBACK_PRICE, isKnown: false }
    : { price: table[best], isKnown: true }
}

export const costUsd = (u: TokenUsage, p: Price): number =>
  (u.input_tokens * p.in +
    u.output_tokens * p.out +
    u.cache_read_input_tokens * p.cacheRead +
    u.cache_creation_input_tokens * p.cacheWrite) /
  1e6

/** Short tag for a starting point, used in file names. */
export const baseTag = (base: string | null): string => (base === null ? 'local' : base.slice(0, 12))

export const sessionFileName = (sessionId: string, base: string | null): string =>
  `${sessionId}@${baseTag(base)}.json`

/** File name of the snapshot a new branch takes from the branch it came from. */
export const carriedFileName = (from: string, base: string | null): string =>
  sessionFileName(`carried-${encodeURIComponent(from)}`, base)

/**
 * Whether a file counts toward a view anchored at `base`. Legacy files (no
 * `base` field) keep counting on feature branches and are hidden on the
 * default branch once a remote exists, whose view only covers the cost since the starting point.
 */
export const matchesBase = (file: SessionFile, base: string | null, isDefault: boolean): boolean =>
  file.base === undefined ? !isDefault || base === null : file.base === base

export const newSessionFile = (
  sessionId: string,
  branch: string,
  now: number,
  base: string | null = null,
): SessionFile => ({
  version: 1,
  sessionId,
  branch,
  base,
  startedAt: now,
  updatedAt: now,
  rows: {},
})

/** Returns a copy of `file` with one model response added. */
export const addUsage = (
  file: SessionFile,
  entry: { agent: string; model: string; usage: TokenUsage },
  table: PriceTable,
  now: number,
): SessionFile => {
  const key = `${entry.agent}|${entry.model}`
  const { price, isKnown } = priceFor(entry.model, table)
  const prev = file.rows[key]
  const row: UsageRow = {
    model: entry.model,
    agent: entry.agent,
    requests: (prev?.requests ?? 0) + 1,
    input: (prev?.input ?? 0) + entry.usage.input_tokens,
    output: (prev?.output ?? 0) + entry.usage.output_tokens,
    cacheRead: (prev?.cacheRead ?? 0) + entry.usage.cache_read_input_tokens,
    cacheWrite: (prev?.cacheWrite ?? 0) + entry.usage.cache_creation_input_tokens,
    usd: (prev?.usd ?? 0) + costUsd(entry.usage, price),
    isEstimated: (prev?.isEstimated ?? false) || !isKnown,
  }
  return { ...file, updatedAt: now, rows: { ...file.rows, [key]: row } }
}

const merge = (into: Map<string, UsageRow>, key: string, row: UsageRow, label: Partial<UsageRow>) => {
  const prev = into.get(key)
  into.set(key, {
    model: label.model ?? row.model,
    agent: label.agent ?? row.agent,
    requests: (prev?.requests ?? 0) + row.requests,
    input: (prev?.input ?? 0) + row.input,
    output: (prev?.output ?? 0) + row.output,
    cacheRead: (prev?.cacheRead ?? 0) + row.cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + row.cacheWrite,
    usd: (prev?.usd ?? 0) + row.usd,
    isEstimated: (prev?.isEstimated ?? false) || row.isEstimated,
  })
}

/** Snapshot of `from`'s cost at `base`, as a session file of `branch`; null when it has none. */
export const carryOver = (
  files: readonly SessionFile[],
  from: string,
  branch: string,
  base: string | null,
  now: number,
): SessionFile | null => {
  const rows = new Map<string, UsageRow>()
  for (const file of files) {
    for (const row of Object.values(file.rows)) merge(rows, `${row.agent}|${row.model}`, row, {})
  }
  if (rows.size === 0) return null
  return {
    ...newSessionFile(`carried:${from}`, branch, now, base),
    carriedFrom: from,
    rows: Object.fromEntries(rows),
  }
}

const byUsdDesc = (a: UsageRow, b: UsageRow) => b.usd - a.usd

/** Folds every session file of a branch into the view the pane draws. */
export const aggregate = (
  files: readonly SessionFile[],
  branch: string,
  sessionId: string,
  anchor: { base: string | null; baseRef: string | null; isDefault: boolean } = {
    base: null,
    baseRef: null,
    isDefault: false,
  },
): BranchView => {
  const models = new Map<string, UsageRow>()
  const agents = new Map<string, UsageRow>()
  const sessions: SessionSummary[] = []
  let totalUsd = 0
  for (const file of files) {
    let sessionUsd = 0
    for (const row of Object.values(file.rows)) {
      merge(models, row.model, row, { agent: '' })
      merge(agents, row.agent, row, { model: '' })
      sessionUsd += row.usd
    }
    totalUsd += sessionUsd
    sessions.push({
      sessionId: file.sessionId,
      updatedAt: file.updatedAt,
      usd: sessionUsd,
      ...(file.carriedFrom === undefined ? {} : { label: `↳ from ${file.carriedFrom}` }),
    })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    branch,
    sessionId,
    sessions,
    byModel: [...models.values()].sort(byUsdDesc),
    byAgent: [...agents.values()].sort(byUsdDesc),
    totalUsd,
    ...anchor,
    engineUsd: files.find(f => f.sessionId === sessionId)?.engineUsd,
  }
}

export const emptyView = (sessionId: string, branch: string | null, error?: string): BranchView => ({
  branch,
  sessionId,
  sessions: [],
  byModel: [],
  byAgent: [],
  totalUsd: 0,
  error,
})

/** Directory name for a branch: `feat/x` becomes `feat%2Fx`. */
export const branchDirName = (branch: string): string => encodeURIComponent(branch)

export const usageDir = (repoRoot: string, branch: string): string =>
  `${repoRoot}/.claude/branch-usage/${branchDirName(branch)}`

export const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)

export const formatUsd = (n: number): string => `$${n < 10 ? n.toFixed(3) : n.toFixed(2)}`

/** Pane label for a model id: `claude-sonnet-5-5` becomes `sonnet-5-5`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, '')

export const relativeTime = (ms: number, now: number): string => {
  const mins = Math.floor((now - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export const sharePct = (usd: number, total: number): string =>
  total === 0 ? '0%' : `${Math.round((usd / total) * 100)}%`

export const tokenLine = (r: UsageRow): string =>
  `in ${formatTokens(r.input)} out ${formatTokens(r.output)} cr ${formatTokens(r.cacheRead)} cw ${formatTokens(r.cacheWrite)}`

const TOKEN_HEAD = '| Req | In | Out | Cache read | Cache write | Cost |'
const TOKEN_ALIGN = '| ---: | ---: | ---: | ---: | ---: | ---: |'

const tokenCells = (r: UsageRow): string =>
  `${r.requests} | ${formatTokens(r.input)} | ${formatTokens(r.output)} | ${formatTokens(r.cacheRead)} | ${formatTokens(r.cacheWrite)} | ${formatUsd(r.usd)}`

const usageTable = (label: string, rows: readonly UsageRow[], name: (r: UsageRow) => string): string[] => [
  `| ${label} ${TOKEN_HEAD}`,
  `| --- ${TOKEN_ALIGN}`,
  ...rows.map(r => `| ${name(r)} | ${tokenCells(r)} |`),
]

/** First line of the PR comment; marks the one comment the mod owns. */
export const PR_COMMENT_MARKER = '<!-- branch-usage -->'

// `gh pr create` or `git [opts] push` at the start of a command or after && ; | newline.
const PR_SYNC_COMMAND = /(^|[;&|\n]\s*)(gh\s+pr\s+create|git(\s+-\S+(\s+[^\s-]\S*)?)*\s+push)(\s|$)/

/** True when a Bash command creates a PR or pushes a branch. */
export const isPrSyncCommand = (command: string): boolean => PR_SYNC_COMMAND.test(command)

/** PR comment text: the marker, then the report without the "this session" mark. */
export const prCommentBody = (view: BranchView): string =>
  `${PR_COMMENT_MARKER}\n${summaryText({ ...view, sessionId: '' })}`

/** One line saying where the cost starts counting. */
export const sinceText = (view: BranchView): string | null => {
  if (view.base === undefined) return null
  if (view.base === null) return 'no remote yet: counting everything until the first push'
  const ref = view.isDefault ? (view.baseRef ?? 'remote') : 'branch start'
  return `since ${view.base.slice(0, 7)} (${ref})`
}

/** Markdown summary for the command and the model tool. */
export const summaryText = (view: BranchView): string => {
  if (view.branch === null) return 'branch-usage: not inside a git repository, nothing is tracked.'
  const lines = [
    `## Branch \`${view.branch}\``,
    '',
    `**${formatUsd(view.totalUsd)}** over ${view.sessions.length} session${view.sessions.length === 1 ? '' : 's'}`,
    ...(sinceText(view) === null ? [] : [`_${sinceText(view)}_`, '']),
    '### By model',
    '',
    ...usageTable('Model', view.byModel, r => `\`${r.model}\`${r.isEstimated ? ' (~price)' : ''}`),
    '',
    '### By agent',
    '',
    ...usageTable('Agent', view.byAgent, r => r.agent),
    '',
    '### By session',
    '',
    '| Session | Updated | Cost |',
    '| --- | --- | ---: |',
    ...view.sessions.map(
      s =>
        `| ${s.label ?? `\`${s.sessionId.slice(0, 8)}\``}${s.sessionId === view.sessionId ? ' ●' : ''} | ${new Date(s.updatedAt).toISOString()} | ${formatUsd(s.usd)} |`,
    ),
  ]
  return lines.join('\n')
}
