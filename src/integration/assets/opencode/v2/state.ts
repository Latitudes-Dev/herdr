// installed by herdr
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=12

export type AgentState = "working" | "idle" | "blocked"

export interface StateReport {
  state: AgentState
  sessionID?: string
}

export interface StateMachineOptions {
  idleDelayMs: number
  // When > 0, a working state that stays quiescent (no begin/end/block/unblock)
  // for this many ms is downgraded to "blocked" — a long-running tool op that is
  // really waiting on external input must not report "working" indefinitely.
  // 0 (or absent) disables the downgrade.
  longRunningDelayMs?: number
  report: (report: StateReport) => void | Promise<void>
}

export interface AgentEvent {
  id?: string
  type: string
  data?: Record<string, unknown>
}

export class AgentStateMachine {
  private readonly operations = new Set<string>()
  private readonly blockers = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private longRunTimer: ReturnType<typeof setTimeout> | undefined
  private readonly longRunningDelayMs: number
  private lastReport: string | undefined
  private rootSessionID: string | undefined
  private stopped = false

  constructor(private readonly options: StateMachineOptions) {
    this.longRunningDelayMs =
      typeof options.longRunningDelayMs === "number" && options.longRunningDelayMs > 0
        ? options.longRunningDelayMs
        : 0
  }

  setRootSession(sessionID: string): boolean {
    if (this.stopped || this.rootSessionID === sessionID) return false
    this.rootSessionID = sessionID
    return true
  }

  begin(operation: string): void {
    if (this.stopped || this.operations.has(operation)) return
    this.operations.add(operation)
    this.clearIdleTimer()
    this.emitCurrent()
  }

  end(operation: string): void {
    if (this.stopped || !this.operations.delete(operation)) return
    this.emitCurrent()
  }

  block(request: string): void {
    if (this.stopped || this.blockers.has(request)) return
    this.blockers.add(request)
    this.clearIdleTimer()
    this.emitCurrent()
  }

  unblock(request: string): void {
    if (this.stopped || !this.blockers.delete(request)) return
    this.emitCurrent()
  }

  clearSession(sessionID: string): void {
    if (this.stopped) return
    const prefix = `${sessionID}:`
    for (const key of this.operations) {
      if (key.startsWith(prefix)) this.operations.delete(key)
    }
    for (const key of this.blockers) {
      if (key.startsWith(prefix)) this.blockers.delete(key)
    }
    this.emitCurrent()
  }

  stop(): void {
    this.stopped = true
    this.operations.clear()
    this.blockers.clear()
    this.clearIdleTimer()
    this.clearLongRunTimer()
  }

  private emitCurrent(): void {
    this.clearLongRunTimer()
    if (this.blockers.size > 0) {
      this.clearIdleTimer()
      this.emit("blocked")
      return
    }
    if (this.operations.size > 0) {
      this.clearIdleTimer()
      this.emit("working")
      this.armLongRunTimer()
      return
    }
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (!this.stopped && this.blockers.size === 0 && this.operations.size === 0) {
        this.emit("idle")
      }
    }, this.options.idleDelayMs)
  }

  private armLongRunTimer(): void {
    if (this.longRunningDelayMs <= 0) return
    this.longRunTimer = setTimeout(() => {
      this.longRunTimer = undefined
      if (!this.stopped && this.blockers.size === 0 && this.operations.size > 0) {
        this.emit("blocked")
      }
    }, this.longRunningDelayMs)
  }

  private clearLongRunTimer(): void {
    if (this.longRunTimer) clearTimeout(this.longRunTimer)
    this.longRunTimer = undefined
  }

  private emit(state: AgentState): void {
    const signature = `${this.rootSessionID ?? ""}:${state}`
    if (this.lastReport === signature) return
    this.lastReport = signature
    void Promise.resolve(this.options.report({ state, sessionID: this.rootSessionID })).catch(() => {})
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

export function pluginDelays(options: Record<string, unknown>): {
  idleDelayMs: number
  longRunningDelayMs: number
} {
  const idleDelayMs =
    typeof options.idleDelayMs === "number" && options.idleDelayMs >= 0 ? options.idleDelayMs : 3_000
  const envLongRun = Number(process.env.HERDR_LONGRUN_MS)
  const longRunningDelayMs =
    Number.isFinite(envLongRun) && envLongRun >= 0
      ? envLongRun
      : typeof options.longRunningDelayMs === "number" && options.longRunningDelayMs >= 0
        ? options.longRunningDelayMs
        : 120_000
  return { idleDelayMs, longRunningDelayMs }
}

export function eventSessionID(event: AgentEvent): string | undefined {
  if (typeof event.data?.sessionID === "string") return event.data.sessionID
  const form = event.data?.form
  if (isRecord(form) && typeof form.sessionID === "string") return form.sessionID
  return undefined
}

export function applyLifecycleEvent(
  state: AgentStateMachine,
  event: AgentEvent,
  opts: { sessionID: string; isRoot: boolean },
): void {
  const op = `${opts.sessionID}:execution`
  const blocker = `${opts.sessionID}:blocked:${blockerID(event)}`
  switch (event.type) {
    case "session.execution.started":
    case "session.retry.scheduled":
      if (opts.isRoot) state.begin(op)
      return
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.error":
    case "session.idle":
      if (opts.isRoot) state.end(op)
      if (event.type === "session.error" || event.type === "session.idle") state.clearSession(opts.sessionID)
      return
    case "permission.asked":
    case "permission.v2.asked":
    case "question.asked":
    case "question.v2.asked":
    case "form.created":
      state.block(blocker)
      return
    case "permission.replied":
    case "permission.v2.replied":
    case "question.replied":
    case "question.rejected":
    case "question.v2.replied":
    case "question.v2.rejected":
    case "form.replied":
    case "form.cancelled": {
      const reply = replyID(event)
      if (reply) state.unblock(`${opts.sessionID}:blocked:${reply}`)
    }
  }
}

function blockerID(event: AgentEvent): string {
  const form = event.data?.form
  const value =
    event.data?.requestID ?? event.data?.id ?? (isRecord(form) ? form.id : undefined) ?? event.id
  return typeof value === "string" ? value : `${event.type}:${Date.now()}`
}

function replyID(event: AgentEvent): string | undefined {
  const value = event.data?.requestID ?? event.data?.id
  return typeof value === "string" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
