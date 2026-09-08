import { beforeEach, expect, mock, test } from "bun:test"

const requests: unknown[] = []
const requestWaiters: Array<() => void> = []
let importCounter = 0
let hooked = 0

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect?: () => void) {
      const handlers = new Map<string, () => void>()
      const client = {
        write(input: string, cb?: (error?: Error) => void) {
          requests.push(JSON.parse(input.trim()))
          requestWaiters.shift()?.()
          queueMicrotask(() => {
            cb?.()
            client.emit("data")
          })
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
  requests.length = 0
  requestWaiters.length = 0
  hooked = 0
  process.env.HERDR_ENV = "1"
  process.env.HERDR_SOCKET_PATH = "test.sock"
  process.env.HERDR_PANE_ID = "test:p1"
  delete process.env.OPENCODE_CONFIG_DIR
})

async function loadPlugin() {
  importCounter += 1
  const module = await import(`./index.ts?test=${importCounter}`)
  return module.default
}

function waitForNextRequest(): Promise<void> {
  return new Promise((resolve) => requestWaiters.push(resolve))
}

async function waitForRequest(predicate: (request: unknown) => boolean): Promise<unknown> {
  const existing = requests.find(predicate)
  if (existing) return existing
  while (true) {
    await waitForNextRequest()
    const matched = requests.find(predicate)
    if (matched) return matched
  }
}

function liveEvents() {
  const queue: unknown[] = []
  const waiters: Array<(result: IteratorResult<unknown>) => void> = []
  return {
    push(event: unknown) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value: event, done: false })
      else queue.push(event)
    },
    subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift(), done: false })
              }
              return new Promise((resolve) => waiters.push(resolve))
            },
          }
        },
      }
    },
  }
}

function fakeServer(sessions: Record<string, { id: string; parentID?: string }> = {}) {
  const events = liveEvents()
  return {
    events,
    ctx: {
      options: { idleDelayMs: 0, longRunningDelayMs: 0 },
      session: {
        async get(input: { sessionID: string }) {
          return sessions[input.sessionID] ?? { id: input.sessionID }
        },
      },
      tool: {
        async hook() {
          hooked += 1
          return { dispose: async () => {} }
        },
      },
      event: {
        subscribe() {
          return events.subscribe()
        },
      },
    },
  }
}

test("server setup is a no-op without Herdr pane env", async () => {
  delete process.env.HERDR_ENV
  const plugin = await loadPlugin()
  const server = fakeServer()
  const cleanup = await plugin.setup(server.ctx)
  expect(cleanup).toBeUndefined()
  expect(hooked).toBe(0)
  expect(requests).toHaveLength(0)
})

test("server setup is a no-op without pane id", async () => {
  delete process.env.HERDR_PANE_ID
  const plugin = await loadPlugin()
  const server = fakeServer()
  const cleanup = await plugin.setup(server.ctx)
  expect(cleanup).toBeUndefined()
  expect(hooked).toBe(0)
  expect(requests).toHaveLength(0)
})

test("server setup is a no-op without socket path", async () => {
  delete process.env.HERDR_SOCKET_PATH
  const plugin = await loadPlugin()
  const server = fakeServer()
  const cleanup = await plugin.setup(server.ctx)
  expect(cleanup).toBeUndefined()
  expect(hooked).toBe(0)
  expect(requests).toHaveLength(0)
})

test("shared-server case: missing pane env must not report even if events arrive", async () => {
  delete process.env.HERDR_ENV
  delete process.env.HERDR_PANE_ID
  delete process.env.HERDR_SOCKET_PATH
  const plugin = await loadPlugin()
  const server = fakeServer({ "root-session": { id: "root-session" } })
  await plugin.setup(server.ctx)
  server.events.push({
    type: "session.execution.started",
    data: { sessionID: "root-session" },
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(requests).toHaveLength(0)
})

test("in-pane server reports working for a root execution", async () => {
  const plugin = await loadPlugin()
  const server = fakeServer({ "root-session": { id: "root-session" } })
  await plugin.setup(server.ctx)
  const working = waitForRequest(
    (request) => requestMethod(request) === "pane.report_agent" && requestParam(request, "state") === "working",
  )
  server.events.push({
    type: "session.execution.started",
    data: { sessionID: "root-session" },
  })
  await working
  expect(requestParam(requests.at(-1), "agent_session_id")).toBe("root-session")
})

test("in-pane server does not replace the pane root with a child session", async () => {
  const plugin = await loadPlugin()
  const server = fakeServer({
    "root-session": { id: "root-session" },
    "child-session": { id: "child-session", parentID: "root-session" },
  })
  await plugin.setup(server.ctx)
  const working = waitForRequest(
    (request) => requestMethod(request) === "pane.report_agent" && requestParam(request, "state") === "working",
  )
  server.events.push({
    type: "session.execution.started",
    data: { sessionID: "root-session" },
  })
  await working
  const blocked = waitForRequest(
    (request) => requestMethod(request) === "pane.report_agent" && requestParam(request, "state") === "blocked",
  )
  server.events.push({
    type: "permission.asked",
    data: { sessionID: "child-session", id: "per_1" },
  })
  await blocked
  expect(requests.every((request) => requestSessionID(request) === "root-session")).toBe(true)
})

test("reports the shuvcode identity from the shuvcode config root", async () => {
  process.env.OPENCODE_CONFIG_DIR = "/home/user/.config/shuvcode"
  const plugin = await loadPlugin()
  const server = fakeServer({ "root-session": { id: "root-session" } })
  await plugin.setup(server.ctx)
  const dispatched = waitForNextRequest()
  server.events.push({
    type: "session.execution.started",
    data: { sessionID: "root-session" },
  })
  await dispatched
  expect(requestParam(requests[0], "source")).toBe("herdr:shuvcode")
  expect(requestParam(requests[0], "agent")).toBe("shuvcode")
})

function requestMethod(request: unknown): unknown {
  return isRecord(request) ? request.method : undefined
}

function requestSessionID(request: unknown): unknown {
  return requestParam(request, "agent_session_id")
}

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) return undefined
  return request.params[name]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
