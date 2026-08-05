// installed by herdr
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=10

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
