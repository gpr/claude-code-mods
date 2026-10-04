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

export const newSessionFile = (sessionId: string, branch: string, now: number): SessionFile => ({
  version: 1,
  sessionId,
  branch,
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

const byUsdDesc = (a: UsageRow, b: UsageRow) => b.usd - a.usd

/** Folds every session file of a branch into the view the pane draws. */
export const aggregate = (
  files: readonly SessionFile[],
  branch: string,
  sessionId: string,
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
    sessions.push({ sessionId: file.sessionId, updatedAt: file.updatedAt, usd: sessionUsd })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    branch,
    sessionId,
    sessions,
    byModel: [...models.values()].sort(byUsdDesc),
    byAgent: [...agents.values()].sort(byUsdDesc),
    totalUsd,
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

export const tokenLine = (r: UsageRow): string =>
  `in ${formatTokens(r.input)} out ${formatTokens(r.output)} cr ${formatTokens(r.cacheRead)} cw ${formatTokens(r.cacheWrite)}`

/** Plain-text summary for the command and the model tool. */
export const summaryText = (view: BranchView): string => {
  if (view.branch === null) return 'branch-usage: not inside a git repository, nothing is tracked.'
  const lines = [
    `Branch ${view.branch}: ${formatUsd(view.totalUsd)} over ${view.sessions.length} session(s)`,
    '',
    'By model:',
    ...view.byModel.map(r => `  ${r.model}${r.isEstimated ? ' (~price)' : ''}  ${formatUsd(r.usd)}  ${r.requests} req  ${tokenLine(r)}`),
    '',
    'By agent:',
    ...view.byAgent.map(r => `  ${r.agent}  ${formatUsd(r.usd)}  ${r.requests} req  ${tokenLine(r)}`),
    '',
    'By session:',
    ...view.sessions.map(s => `  ${s.sessionId.slice(0, 8)}  ${new Date(s.updatedAt).toISOString()}  ${formatUsd(s.usd)}`),
  ]
  return lines.join('\n')
}
