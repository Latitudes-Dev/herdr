// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this package.
// add custom plugins beside this package instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=12
//
// V2 TUI/client entry. OpenCode loads `./tui` in the terminal process, which has
// pane identity when the TUI runs inside Herdr. Shared background servers do not.

import {
  AgentStateMachine,
  applyLifecycleEvent,
  eventSessionID,
  pluginDelays,
  type AgentEvent,
  type StateReport,
} from "./state.js"
import { herdrPane, HerdrClient } from "./socket.js"

const ROUTE_POLL_INTERVAL_MS = 100
const CACHE_POLL_INTERVAL_MS = 250
const SELECTION_RETRY_DELAYS_MS = [100, 400, 1_000]

interface SessionRecord {
  id: string
  parentID?: string
}

interface TuiContext {
  options: Record<string, unknown>
  data: {
    listen: (handler: (event: { details: AgentEvent }) => void) => () => void
    session: {
      get: (sessionID: string) => SessionRecord | undefined
      root: (sessionID: string) => string
      family: (sessionID: string) => string[]
      status: (sessionID: string) => "idle" | "running"
      permission: PendingRequests
      form: PendingRequests
    }
  }
  ui: {
    router: {
      current: () => { type: string; sessionID?: string } | undefined
    }
  }
}

interface PendingRequests {
  list: (sessionID: string) => Array<{ id: string }> | undefined
  sync: (sessionID: string) => Promise<void>
}

// OpenCode v2 Plugin.define is identity; export the plugin object directly so
// the managed package does not need a host @opencode-ai/plugin install.
export default {
  id: "herdr-agent-state",
  setup: (ctx: TuiContext) => {
    const pane = herdrPane()
    if (!pane) return

    const client = new HerdrClient(pane)
    const delays = pluginDelays(ctx.options)
    let selectedRoot: string | undefined
    let disposed = false
    const newDelivery = () => ({
      latest: undefined as StateReport | undefined,
      sent: undefined as StateReport | undefined,
      attempted: false,
      pending: false,
      retryIndex: 0,
      nextReportAt: 0,
    })
    let delivery = newDelivery()
    // All requests share the client's sequence watermark, even across routes.
    let queue = Promise.resolve()
    const enqueue = (task: () => Promise<void>) => {
      queue = queue.then(task).catch(() => {
        // Best effort; a later selection attempt replays the current snapshot.
      })
      return queue
    }
    const isSelected = (target: typeof delivery) =>
      !disposed && target === delivery && selectedRoot !== undefined && selectedRoot === paneRoot()
    const sendLatest = async (target: typeof delivery, replay = false) => {
      if (!isSelected(target) || !target.attempted) return
      const report = target.latest
      if (!report || (!replay && report === target.sent)) return
      await client.reportState(report.state, report.sessionID)
      if (isSelected(target)) target.sent = report
    }
    const newState = () => {
      const target = delivery
      return new AgentStateMachine({
        ...delays,
        report: (report) => {
          if (!isSelected(target)) return
          target.latest = report
          // Selection owns replay while in flight; read the cache after its response.
          if (target.attempted) return enqueue(() => sendLatest(target))
        },
      })
    }
    let state = newState()
    const newCache = () => ({
      requests: new Map<string, Map<PendingRequests, {
        observed: Set<string>
        settled: Set<string>
        hydrated: boolean
        cleared: boolean
        clearVersion: number
      }>>(),
      status: undefined as "idle" | "running" | undefined,
      liveStatus: undefined as "idle" | "running" | undefined,
      nextPollAt: 0,
    })
    let cache = newCache()

    const selectedRouteSession = (): string | undefined => {
      const route = ctx.ui.router.current()
      return route?.type === "session" && typeof route.sessionID === "string"
        ? route.sessionID
        : undefined
    }

    const paneRoot = (): string | undefined => {
      const sessionID = selectedRouteSession()
      if (!sessionID || !ctx.data.session.get(sessionID)) return undefined
      return ctx.data.session.root(sessionID)
    }

    const inSelectedFamily = (sessionID: string): boolean => {
      const root = selectedRoot
      if (!root) return false
      if (sessionID === root) return true
      if (ctx.data.session.root(sessionID) === root) return true
      return (ctx.data.session.family(root) ?? []).includes(sessionID)
    }

    const requestCache = (collection: PendingRequests, id: string) => {
      let session = cache.requests.get(id)
      if (!session) cache.requests.set(id, session = new Map())
      let entry = session.get(collection)
      if (!entry) session.set(collection, entry = {
        observed: new Set(), settled: new Set(), hydrated: false, cleared: false, clearVersion: 0,
      })
      return entry
    }

    const reconcileRequests = (collection: PendingRequests, id: string) => {
      const entry = requestCache(collection, id)
      const cached = collection.list(id)
      if (cached === undefined) {
        if (entry.hydrated) return
        entry.hydrated = true
        const target = cache
        const clearVersion = entry.clearVersion
        // At most one network hydration per collection/session/selection.
        void collection.sync(id).then(() => {
          if (disposed || target !== cache || paneRoot() !== selectedRoot) return
          if (target.requests.get(id)?.get(collection) !== entry) return
          if (entry.clearVersion !== clearVersion) {
            for (const request of collection.list(id) ?? []) entry.settled.add(request.id)
          }
          reconcileRequests(collection, id)
        }).catch(() => {
          // Keep observing the host cache even when this best-effort sync fails.
        })
        return
      }
      const current = new Set(cached.map((request) => request.id))
      // A clear can overtake a snapshot with previously unknown request IDs.
      // Ignore that stale batch until the cache acknowledges the clear.
      if (entry.cleared) {
        for (const requestID of current) entry.settled.add(requestID)
        if (current.size === 0) entry.cleared = false
      }
      for (const requestID of current) {
        if (!entry.observed.has(requestID) && !entry.settled.has(requestID)) {
          state.block(`${id}:blocked:${requestID}`)
        }
      }
      for (const requestID of entry.observed) {
        if (!current.has(requestID)) state.unblock(`${id}:blocked:${requestID}`)
      }
      entry.observed = current
    }

    const reconcileCache = (root: string, sessionID: string) => {
      if (Date.now() < cache.nextPollAt) return
      cache.nextPollAt = Date.now() + CACHE_POLL_INTERVAL_MS
      // Only cached selected-family IDs, never all server sessions. Hydration has
      // no completion signal in the plugin API, so observe for the whole selection.
      // Blockers precede execution to avoid a transient working report.
      const family = new Set([root, sessionID, ...ctx.data.session.family(root)])
      for (const id of cache.requests.keys()) {
        if (family.has(id)) continue
        state.clearSession(id)
        cache.requests.delete(id)
      }
      for (const id of family) {
        reconcileRequests(ctx.data.session.permission, id)
        reconcileRequests(ctx.data.session.form, id)
      }
      const status = ctx.data.session.status(root)
      // Live execution events win until the async cache acknowledges them.
      if (cache.liveStatus !== undefined) {
        if (status !== cache.liveStatus) return
        cache.liveStatus = undefined
      }
      if (status === cache.status) return
      cache.status = status
      if (status === "running") state.begin(`${root}:execution`)
      else state.end(`${root}:execution`)
    }

    const observeEvent = (event: AgentEvent, id: string) => {
      const cleared = ["session.idle", "session.error", "session.deleted"].includes(event.type)
      for (const kind of ["permission", "form"] as const) {
        const entry = requestCache(ctx.data.session[kind], id)
        if (cleared) {
          entry.clearVersion++
          entry.cleared = true
          for (const requestID of entry.observed) entry.settled.add(requestID)
        }
        if (!event.type.startsWith(kind + ".") || !/\.(replied|cancelled)$/.test(event.type)) continue
        const requestID = event.data?.requestID ?? event.data?.id
        // Retain tombstones for this selection, even after a sync has completed.
        if (typeof requestID === "string") entry.settled.add(requestID)
      }
      if (id !== selectedRoot) return
      if (["session.execution.started", "session.retry.scheduled"].includes(event.type)) {
        cache.status = cache.liveStatus = "running"
      } else if (cleared || ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) {
        cache.status = cache.liveStatus = "idle"
      }
    }

    const syncSelectedSession = async () => {
      if (disposed) return
      const sessionID = selectedRouteSession()
      const session = sessionID ? ctx.data.session.get(sessionID) : undefined
      const root = sessionID ? ctx.data.session.root(sessionID) : undefined
      if (!sessionID || !session || !root) {
        state.stop()
        cache = newCache()
        selectedRoot = undefined
        delivery = newDelivery()
        return
      }
      if (root !== selectedRoot) {
        selectedRoot = root
        state.stop()
        cache = newCache()
        delivery = newDelivery()
        state = newState()
        state.setRootSession(root)
        // Schedule idle for an empty snapshot, cancelled by any work/blockers.
        state.clearSession(root)
      }
      reconcileCache(root, sessionID)
      // A first child route still needs the root anchor before any lifecycle.
      // Moving within an already selected family does not replace that identity.
      if (session.parentID && delivery.attempted) return
      if (delivery.pending || Date.now() < delivery.nextReportAt) return

      const target = delivery
      target.pending = true
      await enqueue(async () => {
        if (!isSelected(target)) return
        try {
          await client.reportSession(root, "select")
        } catch {
          // The transport is best effort; replay after every completed attempt.
        }
        if (!isSelected(target)) return
        target.attempted = true
        // Atomic queue entry: no live request can overtake selection or replay.
        await sendLatest(target, true)
        if (!isSelected(target)) return
        target.pending = false
        const retryDelay = SELECTION_RETRY_DELAYS_MS[target.retryIndex++]
        target.nextReportAt = retryDelay === undefined ? Number.POSITIVE_INFINITY : Date.now() + retryDelay
      })
    }

    const stopListen = ctx.data.listen(({ details }) => {
      // Route changes can precede the next poll; don't deliver to the old machine.
      void syncSelectedSession()
      const event = details
      const id = eventSessionID(event)
      if (!id || !inSelectedFamily(id)) return
      observeEvent(event, id)
      if (event.type === "session.deleted" && id === selectedRoot) {
        selectedRoot = undefined
        state.stop()
        cache = newCache()
        delivery = newDelivery()
        state = newState()
        return
      }
      applyLifecycleEvent(state, event, { sessionID: id, isRoot: id === selectedRoot })
      const toolID = typeof event.data?.id === "string" ? event.data.id : undefined
      if (!toolID || id !== selectedRoot) return
      if (event.type === "session.tool.called") state.begin(`${id}:tool:${toolID}`)
      if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        state.end(`${id}:tool:${toolID}`)
      }
    })

    void syncSelectedSession()
    const routePoll = setInterval(() => void syncSelectedSession(), ROUTE_POLL_INTERVAL_MS)

    return () => {
      disposed = true
      clearInterval(routePoll)
      stopListen()
      cache = newCache()
      state.stop()
      client.close()
    }
  },
}
