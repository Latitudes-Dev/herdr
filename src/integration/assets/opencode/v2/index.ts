// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this package.
// add custom plugins beside this package instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=12

import { AgentStateMachine, applyLifecycleEvent, eventSessionID, pluginDelays } from "./state.js"
import { herdrPane, HerdrClient } from "./socket.js"

interface SessionRecord {
  id: string
  parentID?: string
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

export default {
  id: "herdr-agent-state",
  setup: async (ctx: PluginContext) => {
    const pane = herdrPane()
    if (!pane) return

    const client = new HerdrClient(pane)
    const roots = new Map<string, string>()
    const controller = new AbortController()
    const delays = pluginDelays(ctx.options)
    const state = new AgentStateMachine({
      idleDelayMs: delays.idleDelayMs,
      longRunningDelayMs: delays.longRunningDelayMs,
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
          const event = raw as { id?: string; type: string; data?: Record<string, unknown> }
          const id = eventSessionID(event)
          if (!id) continue

          if (event.type === "session.updated" || event.type === "session.deleted") roots.delete(id)
          const observed = await observeRoot(id, event.type === "session.created")
          applyLifecycleEvent(state, event, { sessionID: id, isRoot: observed.isRoot })
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
