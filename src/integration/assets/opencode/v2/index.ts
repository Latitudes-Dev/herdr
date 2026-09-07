// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this package.
// add custom plugins beside this package instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=11

import { AgentStateMachine } from "./state.js"
import { HerdrClient } from "./socket.js"

interface SessionRecord {
  id: string
  parentID?: string
}

interface EventRecord {
  id?: string
  type: string
  data?: Record<string, unknown>
}

// OpenCode v2 Plugin.define is identity; export the plugin object directly so
// the managed package does not need a host @opencode-ai/plugin install.
interface PluginContext {
  options: Record<string, unknown>
  session: {
    get: (
      input: { sessionID: string },
      opts?: { signal?: AbortSignal },
    ) => Promise<SessionRecord>
  }
  tool: {
    hook: (
      name: string,
      handler: (event: { sessionID: string; toolCallID: string }) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> | void }>
  }
  event: {
    subscribe: (opts: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

const sessionID = (event: EventRecord): string | undefined =>
  typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined

const requestID = (event: EventRecord): string => {
  const value = event.data?.requestID ?? event.data?.id ?? event.id
  return typeof value === "string" ? value : `${event.type}:${Date.now()}`
}

export default {
  id: "herdr-agent-state",
  setup: async (ctx: PluginContext) => {
    const paneID = process.env.HERDR_PANE_ID
    const socketPath = process.env.HERDR_SOCKET_PATH
    if (process.env.HERDR_ENV !== "1" || !paneID || !socketPath) return

    const client = new HerdrClient({ paneID, socketPath })
    const roots = new Map<string, string>()
    const controller = new AbortController()
    const idleDelayMs =
      typeof ctx.options.idleDelayMs === "number" && (ctx.options.idleDelayMs as number) >= 0
        ? (ctx.options.idleDelayMs as number)
        : 3_000
    const envLongRun = Number(process.env.HERDR_LONGRUN_MS)
    const longRunningDelayMs = Number.isFinite(envLongRun) && envLongRun >= 0
      ? envLongRun
      : typeof ctx.options.longRunningDelayMs === "number" &&
          (ctx.options.longRunningDelayMs as number) >= 0
        ? (ctx.options.longRunningDelayMs as number)
        : 120_000

    const state = new AgentStateMachine({
      idleDelayMs,
      longRunningDelayMs,
      report: ({ state: next, sessionID: root }) => client.reportState(next, root),
    })

    const resolveRoot = async (id: string): Promise<string> => {
      const cached = roots.get(id)
      if (cached) return cached
      const visited = new Set<string>()
      let current = id
      for (let depth = 0; depth < 16; depth += 1) {
        if (visited.has(current)) break
        visited.add(current)
        try {
          const record = (await ctx.session.get(
            { sessionID: current },
            { signal: AbortSignal.timeout(1_000) },
          )) as SessionRecord
          if (!record.parentID) {
            for (const member of visited) roots.set(member, record.id)
            return record.id
          }
          current = record.parentID
        } catch {
          break
        }
      }
      roots.set(id, id)
      return id
    }

    const observeRoot = async (id: string, isNew = false): Promise<{ root: string; isRoot: boolean }> => {
      const root = await resolveRoot(id)
      const changed = state.setRootSession(root)
      if (changed) await client.reportSession(root, isNew && root === id ? "new" : undefined)
      return { root, isRoot: root === id }
    }

    const before = await ctx.tool.hook("execute.before", async (event) => {
      const { isRoot } = await observeRoot(event.sessionID)
      if (isRoot) state.begin(`${event.sessionID}:tool:${event.toolCallID}`)
    })
    const after = await ctx.tool.hook("execute.after", async (event) => {
      const { isRoot } = await observeRoot(event.sessionID)
      if (isRoot) state.end(`${event.sessionID}:tool:${event.toolCallID}`)
    })

    const eventTask = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as EventRecord
          const id = sessionID(event)
          if (!id) continue

          if (event.type === "session.updated" || event.type === "session.deleted") roots.delete(id)
          const observed = await observeRoot(id, event.type === "session.created")
          const op = `${id}:execution`
          const blocker = `${id}:blocked:${requestID(event)}`

          switch (event.type) {
            case "session.execution.started":
            case "session.retry.scheduled":
              if (observed.isRoot) state.begin(op)
              break
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.error":
            case "session.idle":
              if (observed.isRoot) state.end(op)
              if (event.type === "session.error" || event.type === "session.idle") state.clearSession(id)
              break
            case "permission.asked":
            case "permission.v2.asked":
            case "question.asked":
            case "question.v2.asked":
              state.block(blocker)
              break
            case "permission.replied":
            case "permission.v2.replied":
            case "question.replied":
            case "question.rejected":
            case "question.v2.replied":
            case "question.v2.rejected": {
              const reply = event.data?.requestID
              if (typeof reply === "string") state.unblock(`${id}:blocked:${reply}`)
              break
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && process.env.HERDR_DEBUG === "1") {
          console.error("[herdr-agent-state] event stream ended", error instanceof Error ? error.message : error)
        }
      }
    })()

    return async () => {
      controller.abort()
      state.stop()
      client.close()
      await Promise.allSettled([before.dispose(), after.dispose()])
      await Promise.race([eventTask, new Promise((resolve) => setTimeout(resolve, 1_000))])
    }
  },
}
