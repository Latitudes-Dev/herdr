// installed by herdr
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=12

import net from "node:net"

function agentName(): string {
  return isShuvcodeHost() ? "shuvcode" : "opencode"
}

function sourceName(): string {
  return `herdr:${agentName()}`
}

function isShuvcodeHost(): boolean {
  if (/(?:^|[\\/])shuvcode[\\/]plugins[\\/]/i.test(import.meta.url)) return true
  const executablePattern = /(?:^|[\\/])shuvcode(?:\.(?:exe|cmd|bat|ps1))?$/i
  if ([process.execPath, process.argv0, process.argv?.[0], process.argv?.[1]].some(
    (value) => typeof value === "string" && executablePattern.test(value),
  )) return true
  const configDir = process.env.OPENCODE_CONFIG_DIR
  return typeof configDir === "string" && /(?:^|[\\/])shuvcode[\\/]?$/i.test(configDir)
}

export interface HerdrPane {
  paneID: string
  socketPath: string
}

export interface HerdrClientOptions extends HerdrPane {
  timeoutMs?: number
}

export function herdrPane(): HerdrPane | undefined {
  const paneID = process.env.HERDR_PANE_ID
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (process.env.HERDR_ENV !== "1" || !paneID || !socketPath) return undefined
  return { paneID, socketPath }
}

export class HerdrClient {
  private sequence = Date.now() * 1_000
  private readonly sockets = new Set<net.Socket>()
  private stopped = false

  constructor(private readonly options: HerdrClientOptions) {}

  reportSession(sessionID: string, source?: "new" | "select"): Promise<void> {
    return this.request("pane.report_agent_session", {
      agent_session_id: sessionID,
      ...(source ? { session_start_source: source } : {}),
    })
  }

  reportState(state: string, sessionID?: string): Promise<void> {
    return this.request("pane.report_agent", {
      state,
      ...(sessionID ? { agent_session_id: sessionID } : {}),
    })
  }

  close(): void {
    this.stopped = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  private request(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const id = `${sourceName()}:${Date.now()}:${++this.sequence}`
    const payload = JSON.stringify({
      id,
      method,
      params: {
        pane_id: this.options.paneID,
        source: sourceName(),
        agent: agentName(),
        seq: this.sequence,
        ...params,
      },
    })

    const socketPath = this.options.socketPath
    const socketEndpoint =
      process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\")
        ? `\\\\.\\pipe\\${socketPath}`
        : socketPath

    return new Promise((resolve) => {
      let settled = false
      const socket = net.createConnection(socketEndpoint)
      this.sockets.add(socket)

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.sockets.delete(socket)
        socket.destroy()
        resolve()
      }
      const timer = setTimeout(finish, this.options.timeoutMs ?? 750)

      socket.once("connect", () => socket.write(`${payload}\n`, (error) => error && finish()))
      socket.once("data", finish)
      socket.once("error", finish)
      socket.once("end", finish)
      socket.once("close", finish)
    })
  }
}
