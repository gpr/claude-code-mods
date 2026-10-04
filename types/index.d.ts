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
  /** Keyed `${agent}|${model}`. */
  rows: Record<string, UsageRow>
}

export type SessionSummary = {
  sessionId: string
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
  /** The engine's total for this session, to compare with ours. */
  engineUsd?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'branch-usage': { view: BranchView }
  }
}
