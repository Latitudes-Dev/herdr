import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

const requests: unknown[] = []
const requestWaiters: Array<() => void> = []
const activeDisposers: Array<() => void> = []
let importCounter = 0
let delayResponses = false
const responses: Array<() => void> = []

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect?: () => void) {
      const handlers = new Map<string, () => void>()
      const client = {
        write(input: string, cb?: (error?: Error) => void) {
          requests.push(JSON.parse(input.trim()))
          requestWaiters.shift()?.()
          const respond = () => {
            cb?.()
            client.emit("data")
          }
          if (delayResponses) responses.push(respond)
          else queueMicrotask(respond)
        },
        setTimeout() {},
        on(event: string, handler: () => void) {
          handlers.set(event, handler)
        },
        once(event: string, handler: () => void) {
          handlers.set(event, handler)
        },
        destroy() {},
        emit(event: string) {
          handlers.get(event)?.()
        },
      }
      queueMicrotask(() => {
        onConnect?.()
        client.emit("connect")
      })
      return client
    },
  },
}))

beforeEach(() => {
  delayResponses = false
  responses.length = 0
  requests.length = 0
  requestWaiters.length = 0
  process.env.HERDR_ENV = "1"
  process.env.HERDR_SOCKET_PATH = "test.sock"
  process.env.HERDR_PANE_ID = "test:p1"
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.HERDR_LONGRUN_MS
})

afterEach(() => {
  for (const dispose of activeDisposers.splice(0)) dispose()
  for (const respond of responses.splice(0)) respond()
})

async function loadPlugin() {
  importCounter += 1
  const module = await import(`./tui.ts?test=${importCounter}`)
  return module.default
}

function waitForNextRequest(): Promise<void> {
  return new Promise((resolve) => requestWaiters.push(resolve))
}

function fakeTui() {
  const sessions = new Map<string, { id: string; parentID?: string }>()
  const statuses = new Map<string, "idle" | "running">()
  const permissions = new Map<string, Array<{ id: string; sessionID: string }>>()
  const forms = new Map<string, Array<{ id: string; sessionID: string }>>()
  let current: { type: string; sessionID?: string } = { type: "home" }
  const listeners: Array<(event: { details: unknown }) => void> = []
  let dispose: (() => void) | undefined
  activeDisposers.push(() => dispose?.())

  return {
    api: {
      options: { idleDelayMs: 0, longRunningDelayMs: 0 },
      data: {
        listen(handler: (event: { details: unknown }) => void) {
          listeners.push(handler)
          return () => {
            const index = listeners.indexOf(handler)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
        session: {
          status(sessionID: string): "idle" | "running" {
            return statuses.get(sessionID) ?? "idle"
          },
          permission: {
            list: (id: string) => permissions.get(id),
            sync: async (_id: string) => {},
          },
          form: {
            list: (id: string) => forms.get(id),
            sync: async (_id: string) => {},
          },
          get(sessionID: string) {
            return sessions.get(sessionID)
          },
          root(sessionID: string) {
            const session = sessions.get(sessionID)
            return session?.parentID ? this.root(session.parentID) : sessionID
          },
          family(sessionID: string) {
            const root = this.root(sessionID)
            return [...sessions.values()]
              .filter((session) => this.root(session.id) === root)
              .map((session) => session.id)
          },
        },
      },
      ui: {
        router: {
          current() {
            return current
          },
        },
      },
    },
    statuses,
    permissions,
    forms,
    home() { current = { type: "home" } },
    removeSession(id: string) {
      sessions.delete(id)
      permissions.delete(id)
      forms.delete(id)
    },
    addSession(session: { id: string; parentID?: string }) {
      sessions.set(session.id, session)
      permissions.set(session.id, [])
      forms.set(session.id, [])
    },
    select(sessionID: string) {
      current = { type: "session", sessionID }
    },
    emit(event: unknown) {
      for (const listener of listeners) listener({ details: event })
    },
    dispose() {
      dispose?.()
    },
    captureDispose(cleanup: (() => void) | void) {
      if (cleanup) {
        dispose = cleanup
      }
    },
  }
}

test("removed family members no longer keep the selected root blocked", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.addSession({ id: "child", parentID: "a" })
  tui.statuses.set("a", "running")
  tui.permissions.set("child", [{ id: "pending", sessionID: "child" }])
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await new Promise(resolve => setTimeout(resolve, 25))
  expect((requests.at(-1) as any).params.state).toBe("blocked")
  tui.removeSession("child")
  await new Promise(resolve => setTimeout(resolve, 350))
  const states = requests.filter((request: any) => request.method === "pane.report_agent") as any[]
  expect(states.at(-1).params.state).toBe("working")
})

test("TUI setup is a no-op without Herdr pane env", async () => {
  delete process.env.HERDR_ENV
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "session-a" })
  tui.select("session-a")
  const cleanup = plugin.setup(tui.api)
  expect(cleanup).toBeUndefined()
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(requests).toHaveLength(0)
})

test("reports a root session when the local TUI route selects it", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "session-a" })
  tui.captureDispose(plugin.setup(tui.api))

  const dispatched = waitForNextRequest()
  tui.select("session-a")
  await dispatched

  expect(requests).toHaveLength(1)
  expect(requestParam(requests[0], "agent_session_id")).toBe("session-a")
  expect(requestParam(requests[0], "session_start_source")).toBe("select")
  expect(requestMethod(requests[0])).toBe("pane.report_agent_session")
})

test("reports working, blocked, and idle for the selected root", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "session-a" })
  tui.select("session-a")
  const selected = waitForNextRequest()
  tui.captureDispose(plugin.setup(tui.api))
  await selected

  const working = waitForNextRequest()
  tui.emit({
    type: "session.execution.started",
    data: { sessionID: "session-a" },
  })
  await working
  expect(requestParam(requests.at(-1), "state")).toBe("working")

  const blocked = waitForNextRequest()
  tui.emit({
    type: "permission.asked",
    data: { sessionID: "session-a", id: "per_1" },
  })
  await blocked
  expect(requestParam(requests.at(-1), "state")).toBe("blocked")

  const unblocked = waitForNextRequest()
  tui.emit({
    type: "permission.replied",
    data: { sessionID: "session-a", requestID: "per_1" },
  })
  await unblocked
  expect(requestParam(requests.at(-1), "state")).toBe("working")

  const idle = waitForNextRequest()
  tui.emit({
    type: "session.execution.succeeded",
    data: { sessionID: "session-a" },
  })
  await idle
  expect(requestParam(requests.at(-1), "state")).toBe("idle")
})

test("shared-server case: ignores lifecycle from another root session", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "pane-session" })
  tui.addSession({ id: "other-pane-session" })
  tui.select("pane-session")
  const selected = waitForNextRequest()
  tui.captureDispose(plugin.setup(tui.api))
  await selected

  tui.emit({
    type: "session.execution.started",
    data: { sessionID: "other-pane-session" },
  })
  tui.emit({
    type: "permission.asked",
    data: { sessionID: "other-pane-session", id: "per_other" },
  })
  await new Promise((resolve) => setTimeout(resolve, 25))

  expect(requests.every((request) => requestParam(request, "agent_session_id") === "pane-session")).toBe(
    true,
  )
  expect(requests.some((request) => requestParam(request, "state") === "working")).toBe(false)
})

test("does not replace the root session with a selected child session", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "root-session" })
  tui.addSession({ id: "child-session", parentID: "root-session" })
  tui.select("root-session")
  tui.captureDispose(plugin.setup(tui.api))
  await waitForNextRequest()
  expect(requestParam(requests[0], "agent_session_id")).toBe("root-session")

  tui.select("child-session")
  await new Promise((resolve) => setTimeout(resolve, 125))
  expect(requests.filter((request) => requestMethod(request) === "pane.report_agent_session")).toHaveLength(1)

  const blocked = waitForNextRequest()
  tui.emit({
    type: "permission.asked",
    data: { sessionID: "child-session", id: "per_child" },
  })
  await blocked
  expect(requestParam(requests.at(-1), "state")).toBe("blocked")
  expect(requestParam(requests.at(-1), "agent_session_id")).toBe("root-session")
})

test("reports the shuvcode identity from the shuvcode config root", async () => {
  process.env.OPENCODE_CONFIG_DIR = "/home/user/.config/shuvcode"
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "session-a" })
  tui.select("session-a")
  const dispatched = waitForNextRequest()
  tui.captureDispose(plugin.setup(tui.api))
  await dispatched
  expect(requestParam(requests[0], "source")).toBe("herdr:shuvcode")
  expect(requestParam(requests[0], "agent")).toBe("shuvcode")
})

test("stops reporting when the TUI plugin is disposed", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "session-a" })
  tui.captureDispose(plugin.setup(tui.api))
  tui.dispose()
  tui.select("session-a")
  tui.emit({
    type: "session.execution.started",
    data: { sessionID: "session-a" },
  })
  await new Promise((resolve) => setTimeout(resolve, 125))
  expect(requests).toHaveLength(0)
})

test("shared-server split: TUI reports while server setup without pane env does not", async () => {
  const tuiPlugin = await loadPlugin()
  const serverModule = await import(`./index.ts?shared=${importCounter}`)
  const tui = fakeTui()
  tui.addSession({ id: "pane-session" })
  tui.select("pane-session")

  const previousEnv = process.env.HERDR_ENV
  const previousPane = process.env.HERDR_PANE_ID
  const previousSocket = process.env.HERDR_SOCKET_PATH
  delete process.env.HERDR_ENV
  delete process.env.HERDR_PANE_ID
  delete process.env.HERDR_SOCKET_PATH
  const serverCleanup = await serverModule.default.setup({
    options: { idleDelayMs: 0 },
    session: { async get(input: { sessionID: string }) { return { id: input.sessionID } } },
    tool: { async hook() { return { dispose: async () => {} } } },
    event: { subscribe() { return { async *[Symbol.asyncIterator]() { yield { type: "session.execution.started", data: { sessionID: "pane-session" } } } } } },
  })
  expect(serverCleanup).toBeUndefined()
  expect(requests).toHaveLength(0)

  process.env.HERDR_ENV = previousEnv
  process.env.HERDR_PANE_ID = previousPane
  process.env.HERDR_SOCKET_PATH = previousSocket
  const selected = waitForNextRequest()
  tui.captureDispose(tuiPlugin.setup(tui.api))
  await selected
  const working = waitForNextRequest()
  tui.emit({
    type: "session.execution.started",
    data: { sessionID: "pane-session" },
  })
  await working
  expect(requestParam(requests.at(-1), "state")).toBe("working")
  expect(requestParam(requests.at(-1), "agent_session_id")).toBe("pane-session")
})

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
const stateReports = () => requests.filter((request) => requestParam(request, "state") !== undefined)
const states = () => stateReports().map((request) => requestParam(request, "state"))

// Drive cache/route polls explicitly; only the state machine's idle callback
// and transport microtasks use real timers. No elapsed delay implies hydration.
function pollClock() {
  let now = Date.now()
  let poll = () => {}
  const realInterval = globalThis.setInterval
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const interval = spyOn(globalThis, "setInterval").mockImplementation((callback, _ms, ...args) => {
    poll = () => callback(...args)
    return realInterval(callback, 60_000, ...args)
  })
  activeDisposers.push(() => { clock.mockRestore(); interval.mockRestore() })
  return async (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 300
      poll()
      await settle(5)
    }
  }
}

test("attaching during execution seeds working and completion emits idle", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  expect(states()).toEqual(["working"])
  tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  await settle()
  expect(states()).toEqual(["working", "idle"])
})

for (const kind of ["permission", "form"] as const) {
  test(`attach seeds child ${kind} without transient working and deduplicates live events`, async () => {
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.addSession({ id: "a" })
    tui.addSession({ id: "child", parentID: "a" })
    tui.addSession({ id: "other" })
    tui.statuses.set("a", "running")
    const pending = kind === "permission" ? tui.permissions : tui.forms
    pending.set("child", [{ id: "req", sessionID: "child" }])
    pending.set("other", [{ id: "unrelated", sessionID: "other" }])
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await settle()
    expect(states()).toEqual(["blocked"])
    tui.emit(kind === "permission"
      ? { type: "permission.asked", data: { sessionID: "child", id: "req" } }
      : { type: "form.created", data: { form: { sessionID: "child", id: "req" } } })
    tui.emit({ type: kind === "permission" ? "permission.replied" : "form.replied", data: { sessionID: "child", ...(kind === "permission" ? { requestID: "req" } : { id: "req" }) } })
    await settle()
    expect(states()).toEqual(["blocked", "working"])
    tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
    await settle()
    expect(states()).toEqual(["blocked", "working", "idle"])
  })
}

test("switch away/back snapshots current status and blockers, including completion while away", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.addSession({ id: "b" })
  tui.statuses.set("a", "running")
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  tui.select("b")
  await settle(125)
  tui.permissions.set("a", [{ id: "req", sessionID: "a" }])
  tui.select("a")
  await settle(125)
  expect(states()).toEqual(["working", "idle", "blocked"])
  tui.select("b")
  await settle(125)
  tui.permissions.set("a", [])
  tui.statuses.set("a", "idle")
  tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  tui.select("a")
  await settle(125)
  // Retries intentionally repeat the current snapshot; preserve route transitions.
  const transitions = stateReports().filter((report, index, reports) =>
    index === 0 || requestParam(report, "state") !== requestParam(reports[index - 1], "state") ||
    requestParam(report, "agent_session_id") !== requestParam(reports[index - 1], "agent_session_id"))
  expect(transitions.map((report) => requestParam(report, "state"))).toEqual(["working", "idle", "blocked", "idle", "idle"])
  expect(requestParam(stateReports().at(-1), "agent_session_id")).toBe("a")
})

for (const destination of ["home", "missing"] as const) {
  test(`${destination} stops stale long-running timer after completion off-route`, async () => {
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.api.options.longRunningDelayMs = 200
    tui.addSession({ id: "a" })
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await settle()
    tui.emit({ type: "session.execution.started", data: { sessionID: "a" } })
    await settle()
    if (destination === "home") tui.home()
    else tui.select("missing")
    await settle(125)
    tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
    await settle(125)
    expect(states()).not.toContain("blocked")
  })
}

for (const kind of ["permission", "form"] as const) {
  test(`loads uncached ${kind} once and ignores replies that overtake the snapshot`, async () => {
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.addSession({ id: "a" })
    tui.statuses.set("a", "running")
    const pending = kind === "permission" ? tui.permissions : tui.forms
    pending.delete("a")
    let finish!: () => void
    let calls = 0
    tui.api.data.session[kind].sync = async () => {
      calls++
      await new Promise<void>((resolve) => { finish = resolve })
      pending.set("a", [{ id: "answered", sessionID: "a" }, { id: "pending", sessionID: "a" }])
    }
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await settle()
    expect(calls).toBe(1)
    tui.emit({ type: kind === "permission" ? "permission.replied" : "form.cancelled", data: { sessionID: "a", ...(kind === "permission" ? { requestID: "answered" } : { id: "answered" }) } })
    finish()
    await settle()
    expect(states().at(-1)).toBe("blocked")
    tui.emit({ type: kind === "permission" ? "permission.replied" : "form.replied", data: { sessionID: "a", ...(kind === "permission" ? { requestID: "pending" } : { id: "pending" }) } })
    tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
    await settle(150)
    expect(states().at(-1)).toBe("idle")
    expect(calls).toBe(1)
  })
}

for (const exit of ["home", "switch", "dispose"] as const) {
  test(`late snapshot cannot report after ${exit}`, async () => {
    const tick = pollClock()
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.addSession({ id: "a" })
    tui.addSession({ id: "b" })
    tui.forms.delete("a")
    let finish!: () => void
    tui.api.data.session.form.sync = async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      tui.forms.set("a", [{ id: "late", sessionID: "a" }])
    }
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await settle()
    if (exit === "home") tui.home()
    if (exit === "switch") tui.select("b")
    if (exit === "dispose") tui.dispose()
    finish()
    await tick(5)
    expect(states()).not.toContain("blocked")
  })
}

test("route guards prevent stale reports before the next route poll", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.api.options.longRunningDelayMs = 40
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle(10)
  tui.home()
  await settle(60)
  expect(states()).toEqual(["working"])
})

test("initial child selection seeds the root but never selects the child as pane identity", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.addSession({ id: "child", parentID: "a" })
  tui.statuses.set("a", "running")
  tui.select("child")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  expect(states()).toEqual(["working"])
  expect(requests.every((request) => requestParam(request, "agent_session_id") === "a")).toBe(true)
  expect(requestMethod(requests[0])).toBe("pane.report_agent_session")
  expect(Number(requestParam(requests[1], "seq"))).toBeGreaterThan(Number(requestParam(requests[0], "seq")))
})

test("selection retries reconcile cheaply without network hydration or stale blocker replay", async () => {
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.permissions.set("a", [{ id: "req", sessionID: "a" }])
  let scans = 0
  let hydrations = 0
  tui.api.data.session.permission.sync = async () => { hydrations++ }
  tui.api.data.session.form.sync = async () => { hydrations++ }
  const family = tui.api.data.session.family.bind(tui.api.data.session)
  tui.api.data.session.family = (id: string) => { scans++; return family(id) }
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  tui.emit({ type: "permission.replied", data: { sessionID: "a", requestID: "req" } })
  await settle(650)
  expect(states()[0]).toBe("blocked")
  expect(states().slice(1).length).toBeGreaterThanOrEqual(3)
  expect(states().slice(1).every((state) => state === "idle")).toBe(true)
  expect(scans).toBeGreaterThan(1)
  expect(scans).toBeLessThanOrEqual(4)
  expect(hydrations).toBe(0)
  expect(stateReports()).toHaveLength(requests.filter((request) => requestMethod(request) === "pane.report_agent_session").length + 1)
  expect(requests.filter((request) => requestMethod(request) === "pane.report_agent_session").length).toBeGreaterThanOrEqual(3)
})

for (const snapshot of ["working", "blocked"] as const) {
  test(`ordered selection replays unchanged ${snapshot} with a fresh sequence on retry`, async () => {
    delayResponses = true
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.addSession({ id: "b" })
    tui.statuses.set("b", "running")
    if (snapshot === "blocked") tui.permissions.set("b", [{ id: "req", sessionID: "b" }])
    tui.select("b")
    tui.captureDispose(plugin.setup(tui.api))
    await settle()
    expect(requests.map(requestMethod)).toEqual(["pane.report_agent_session"])
    responses.shift()?.()
    await settle()
    expect(states()).toEqual([snapshot])
    expect(Number(requestParam(requests[1], "seq"))).toBeGreaterThan(Number(requestParam(requests[0], "seq")))
    responses.shift()?.()
    await settle(225)
    expect(requestMethod(requests.at(-1))).toBe("pane.report_agent_session")
    expect(states()).toEqual([snapshot])
    responses.shift()?.()
    await settle()
    expect(states()).toEqual([snapshot, snapshot])
    expect(Number(requestParam(requests.at(-1), "seq"))).toBeGreaterThan(Number(requestParam(requests.at(-2), "seq")))
  })
}

test("in-flight selection replays current lifecycle, then serializes live reports and retry", async () => {
  delayResponses = true
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.permissions.set("a", [{ id: "req", sessionID: "a" }])
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  tui.emit({ type: "permission.replied", data: { sessionID: "a", requestID: "req" } })
  await settle()
  expect(states()).toEqual([])
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["working"])
  tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  await settle()
  expect(states()).toEqual(["working"])
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["working", "idle"])
  await settle(225)
  expect(requestMethod(requests.at(-1))).toBe("pane.report_agent")
  responses.shift()?.()
  await settle()
  expect(requestMethod(requests.at(-1))).toBe("pane.report_agent_session")
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["working", "idle", "idle"])
})

test("reply during a selection retry replaces blocked replay despite stale cache", async () => {
  delayResponses = true
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.permissions.set("a", [{ id: "req", sessionID: "a" }])
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["blocked"])
  responses.shift()?.()
  await settle(225)
  expect(requestMethod(requests.at(-1))).toBe("pane.report_agent_session")
  tui.emit({ type: "permission.replied", data: { sessionID: "a", requestID: "req" } })
  await settle()
  expect(states()).toEqual(["blocked"])
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["blocked", "working"])
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["blocked", "working"])
})

test("returning to the same root uses a new generation while the old selection is in flight", async () => {
  delayResponses = true
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await settle()
  tui.home()
  tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  tui.statuses.set("a", "idle")
  tui.select("a")
  tui.emit({ type: "session.idle", data: { sessionID: "a" } })
  await settle()
  expect(requests).toHaveLength(1)
  responses.shift()?.()
  await settle()
  expect(states()).toEqual([])
  expect(requests.map(requestMethod)).toEqual(["pane.report_agent_session", "pane.report_agent_session"])
  responses.shift()?.()
  await settle()
  expect(states()).toEqual(["idle"])
})

for (const exit of ["home", "switch", "dispose"] as const) {
  for (const phase of ["selection", "lifecycle"] as const) {
    test(`${exit} drops stale queued reports and late ${phase} completions`, async () => {
      delayResponses = true
      const plugin = await loadPlugin()
      const tui = fakeTui()
      tui.addSession({ id: "a" })
      tui.addSession({ id: "b" })
      tui.statuses.set("a", "running")
      tui.statuses.set("b", "running")
      tui.select("a")
      tui.captureDispose(plugin.setup(tui.api))
      await settle()
      expect(requestMethod(requests[0])).toBe("pane.report_agent_session")
      if (phase === "lifecycle") {
        responses.shift()?.()
        await settle()
      }
      tui.emit({ type: "permission.asked", data: { sessionID: "a", id: "req" } })
      await settle()
      const before = requests.length
      if (exit === "home") tui.home()
      if (exit === "switch") tui.select("b")
      if (exit === "dispose") tui.dispose()
      // Check dispatch-time route guards even before the next poll.
      responses.shift()?.()
      await settle(125)
      expect(requests.slice(before).some((r) => requestParam(r, "agent_session_id") === "a")).toBe(false)
      if (exit === "switch") {
        expect(requestMethod(requests.at(-1))).toBe("pane.report_agent_session")
        responses.shift()?.()
        await settle()
        expect(requestParam(requests.at(-1), "agent_session_id")).toBe("b")
        expect(requestParam(requests.at(-1), "state")).toBe("working")
      }
    })
  }
}

test("late status hydration follows running then idle without lifecycle events", async () => {
  const tick = pollClock()
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await tick(20)
  expect(states().at(-1)).toBe("idle")
  tui.statuses.set("a", "running")
  await tick()
  expect(states().at(-1)).toBe("working")
  tui.statuses.set("a", "idle")
  await tick()
  expect(states().at(-1)).toBe("idle")
})

for (const kind of ["permission", "form"] as const) {
  for (const lateChild of [false, true]) {
    test(`late ${kind} cache after empty selection (late child: ${lateChild})`, async () => {
      const tick = pollClock()
      const plugin = await loadPlugin()
      const tui = fakeTui()
      tui.addSession({ id: "a" })
      tui.select("a")
      tui.captureDispose(plugin.setup(tui.api))
      await tick(20)
      const id = lateChild ? "child" : "a"
      if (lateChild) tui.addSession({ id, parentID: "a" })
      const pending = kind === "permission" ? tui.permissions : tui.forms
      pending.set(id, [{ id: "late", sessionID: id }])
      await tick()
      expect(states().at(-1)).toBe("blocked")
      expect(requestParam(stateReports().at(-1), "agent_session_id")).toBe("a")
      tui.emit({ type: `${kind}.replied`, data: { sessionID: id, requestID: "late" } })
      // Leave the cache stale across multiple reconciliation passes.
      await tick(4)
      expect(states().at(-1)).toBe("idle")
      expect(states().slice(states().indexOf("blocked") + 1)).not.toContain("blocked")
    })
  }
}

for (const size of [1, 15]) {
  test(`reconciliation reads only ${size} selected-family members with no redundant reports`, async () => {
    const tick = pollClock()
    const plugin = await loadPlugin()
    const tui = fakeTui()
    const ids = Array.from({ length: size }, (_, index) => index === 0 ? "a" : `child-${index}`)
    for (const id of ids) tui.addSession({ id, ...(id === "a" ? {} : { parentID: "a" }) })
    for (let i = 0; i < 100; i++) tui.addSession({ id: `unrelated-${i}` })
    let families = 0
    let statuses = 0
    let lists = 0
    let hydrations = 0
    tui.api.data.session.family = (id) => { expect(id).toBe("a"); families++; return ids }
    tui.api.data.session.status = (id) => { expect(id).toBe("a"); statuses++; return "running" }
    for (const kind of ["permission", "form"] as const) {
      tui.api.data.session[kind].list = (id) => { expect(ids).toContain(id); lists++; return [] }
      tui.api.data.session[kind].sync = async () => { hydrations++ }
    }
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await tick(10) // Finish the bounded selection retries.
    families = statuses = lists = 0
    const reports = requests.length
    await tick(5)
    expect(families).toBe(5)
    expect(statuses).toBe(5)
    expect(lists).toBe(10 * size)
    expect(hydrations).toBe(0)
    expect(requests).toHaveLength(reports)
  })
}

test("unchanged running cache does not reset the long-running timer", async () => {
  const tick = pollClock()
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.api.options.longRunningDelayMs = 40
  tui.addSession({ id: "a" })
  tui.statuses.set("a", "running")
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await tick(20)
  expect(states()[0]).toBe("working")
  expect(states().at(-1)).toBe("blocked")
})

test("live completion overtakes delayed running cache and later executions still reconcile", async () => {
  const tick = pollClock()
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await tick()
  tui.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  tui.statuses.set("a", "running")
  await tick(4)
  expect(states()).not.toContain("working")
  tui.statuses.set("a", "idle")
  await tick()
  tui.statuses.set("a", "running")
  await tick()
  expect(states().at(-1)).toBe("working")
})

for (const kind of ["permission", "form"] as const) {
  test(`late child ${kind} sync cannot resurrect an overtaking reply`, async () => {
    const tick = pollClock()
    const plugin = await loadPlugin()
    const tui = fakeTui()
    tui.addSession({ id: "a" })
    tui.select("a")
    tui.captureDispose(plugin.setup(tui.api))
    await tick(10)
    tui.addSession({ id: "child", parentID: "a" })
    const pending = kind === "permission" ? tui.permissions : tui.forms
    pending.delete("child")
    let finish!: () => void
    let calls = 0
    tui.api.data.session[kind].sync = async (id) => {
      expect(id).toBe("child")
      calls++
      await new Promise<void>((resolve) => { finish = resolve })
      pending.set(id, [{ id: "answered", sessionID: id }])
    }
    await tick()
    tui.emit({ type: `${kind}.replied`, data: { sessionID: "child", requestID: "answered" } })
    await tick(4)
    finish()
    await tick(4)
    expect(calls).toBe(1)
    expect(states()).not.toContain("blocked")
  })
}

test("a clear still supersedes in-flight hydration after an empty cache acknowledgment", async () => {
  const tick = pollClock()
  const plugin = await loadPlugin()
  const tui = fakeTui()
  tui.addSession({ id: "a" })
  tui.forms.delete("a")
  let finish!: () => void
  tui.api.data.session.form.sync = async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    tui.forms.set("a", [{ id: "stale", sessionID: "a" }])
  }
  tui.select("a")
  tui.captureDispose(plugin.setup(tui.api))
  await tick()
  tui.emit({ type: "session.idle", data: { sessionID: "a" } })
  tui.forms.set("a", [])
  await tick()
  finish()
  await settle(5)
  await tick(4)
  expect(states()).not.toContain("blocked")
  tui.forms.set("a", [{ id: "fresh", sessionID: "a" }])
  await tick()
  expect(states().at(-1)).toBe("blocked")
  tui.forms.set("a", [])
  await tick()
  expect(states().at(-1)).toBe("idle")
})

function requestMethod(request: unknown): unknown {
  return isRecord(request) ? request.method : undefined
}

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) return undefined
  return request.params[name]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
