export type UsageRow = {
  model: string
  /** 'main' or the subagent type. */
  agent: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  /** True when no price matched the model and the default tier was used. */
  isEstimated: boolean
}

export type SessionFile = {
  version: 1
  sessionId: string
  branch: string
  startedAt: number
  updatedAt: number
  /** The engine's own session total at the last measurement. */
  engineUsd?: number
  /** Starting point (merge-base with the remote default branch); null = no remote yet. Absent in legacy files. */
  base?: string | null
  /** Set on a snapshot of another branch's cost taken when this branch was created. */
  carriedFrom?: string
  /** Keyed `${agent}|${model}`. */
  rows: Record<string, UsageRow>
}

/** `.branch.json`: the sticky starting point of a non-default branch. */
export type BranchMeta = {
  version: 1
  branch: string
  base: string | null
  createdAt: number
}

export type SessionSummary = {
  sessionId: string
  /** Shown instead of the short id, e.g. for a carried-over snapshot. */
  label?: string
  updatedAt: number
  usd: number
}

export type BranchView = {
  /** Null when the directory is not in a git repository. */
  branch: string | null
  sessionId: string
  sessions: SessionSummary[]
  byModel: UsageRow[]
  byAgent: UsageRow[]
  totalUsd: number
  /** Starting point the cost counts from; null = no remote yet. */
  base?: string | null
  /** The remote ref the starting point comes from, e.g. `origin/main`. */
  baseRef?: string | null
  isDefault?: boolean
  /** The engine's total for this session, to compare with ours. */
  engineUsd?: number
  error?: string
}

export type PrLink = {
  branch: string
  number: number
  url: string
}

declare module 'claude-code' {
  interface PluginState {
    'branch-usage': { view: BranchView; pr: PrLink | null }
  }
}
