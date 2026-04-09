import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Event } from "@opencode-ai/sdk/v2"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"
import { WorkspaceID } from "@/control-plane/schema"
import { Heap } from "@/cli/heap"

const fetchFn = (url: string, init?: RequestInit) => Server.Default().fetch(url, init)

const SSE_WATCHDOG_MS = Flag.OPENCODE_EXPERIMENTAL_TUI_SSE_WATCHDOG_MS || 300_000

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

const eventStream = {
  abort: undefined as AbortController | undefined,
  live: undefined as AbortController | undefined,
}

function startEventStream(directory: string) {
  if (eventStream.abort) eventStream.abort.abort()
  const id = crypto.randomUUID()
  let run = 0

  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal
  let watchdog: Timer | undefined
  let stale = false
  let watch = false
  let last = Date.now()
  let kind = "startup"

  Log.Default.info("event stream start", {
    id,
    directory,
    watchdog: SSE_WATCHDOG_MS,
  })

  const touch = (next = "activity") => {
    const now = Date.now()
    const idle = now - last
    if (!watch) return
    stale = false
    last = now
    kind = next
    if (watchdog) clearTimeout(watchdog)
    if (next === "server.heartbeat") {
      Log.Default.debug("event stream heartbeat", {
        id,
        directory,
        run,
        idle,
      })
    }
    if (next !== "server.heartbeat" && idle > 10_000) {
      Log.Default.info("event stream gap", {
        id,
        directory,
        run,
        idle,
        kind: next,
      })
    }
    watchdog = setTimeout(() => {
      stale = true
      const err = new Error("Worker event stream heartbeat timed out")
      Log.Default.warn("event stream watchdog timeout", {
        id,
        directory,
        watchdog: SSE_WATCHDOG_MS,
        idle: Date.now() - last,
        kind,
        run,
      })
      eventStream.live?.abort(err)
    }, SSE_WATCHDOG_MS)
  }

  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    directory,
    fetch: fetchFn,
    signal,
  })

  ;(async () => {
    watch = true
    touch("boot")
    try {
      while (!signal.aborted) {
        run += 1
        const cycle = new AbortController()
        eventStream.live = cycle
        const combined = AbortSignal.any([signal, cycle.signal])
        Log.Default.debug("event stream subscribe", {
          id,
          directory,
          run,
        })
        const events = await Promise.resolve(sdk.event.subscribe({}, { signal: combined })).catch((error) => {
          if (signal.aborted) return undefined
          Log.Default.warn("event stream subscribe failed", {
            id,
            directory,
            run,
            stale,
            idle: Date.now() - last,
            kind,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })
          if (!stale) {
            Log.Default.error("event stream non-stale failure - will retry", {
              id,
              directory,
              run,
              idle: Date.now() - last,
              kind,
            })
          }
          return undefined
        })

        if (!events) {
          touch(stale ? "retry" : "idle")
          await sleep(250)
          continue
        }

        Log.Default.info("event stream subscribed", {
          id,
          directory,
          run,
        })

        try {
          for await (const event of events.stream) {
            const type = event.type as string
            touch(type)
            if (type === "server.heartbeat" || type === "server.connected") continue
            Rpc.emit("event", event as Event)
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          const errStack = error instanceof Error ? error.stack : undefined
          if (signal.aborted) {
            Log.Default.warn("event stream loop exiting - signal aborted", {
              id,
              directory,
              run,
              idle: Date.now() - last,
              kind,
            })
            break
          }
          if (combined.aborted && stale) {
            Log.Default.warn("event stream aborted after watchdog", {
              id,
              directory,
              run,
              idle: Date.now() - last,
              kind,
              error: errMsg,
              stack: errStack,
            })
            touch("retry")
            continue
          }
          Log.Default.error("event stream cycle failed - non-watchdog error", {
            id,
            directory,
            run,
            stale,
            idle: Date.now() - last,
            kind,
            error: errMsg,
            stack: errStack,
            combinedAborted: combined.aborted,
          })
          // Don't throw - try to reconnect instead
          touch("retry")
          continue
        } finally {
          Log.Default.debug("event stream cycle end", {
            id,
            directory,
            run,
            stale,
            aborted: signal.aborted,
            live: eventStream.live === cycle,
          })
          cycle.abort()
          if (eventStream.live === cycle) eventStream.live = undefined
        }

        if (!signal.aborted) {
          touch("cycle-end")
          await sleep(250)
        }
      }
    } finally {
      if (watchdog) clearTimeout(watchdog)
      Log.Default.info("event stream stop", {
        id,
        directory,
        run,
        aborted: signal.aborted,
        stale,
        idle: Date.now() - last,
        kind,
      })
    }
  })().catch((error) => {
    Log.Default.error("event stream error", {
      id,
      directory,
      run,
      stale,
      idle: Date.now() - last,
      kind,
      error: error instanceof Error ? error.message : error,
    })
  })

  return id
}

function stopEventStream(id: string) {
  Log.Default.info("event stream unsubscribe", { id })
  eventStream.abort?.abort()
  eventStream.abort = undefined
}

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await Config.invalidate(true)
  },
  async subscribe(input: { directory: string | undefined }) {
    return startEventStream(input.directory || process.cwd())
  },
  async unsubscribe(input: { id: string }) {
    stopEventStream(input.id)
  },
  async shutdown() {
    Log.Default.info("worker shutting down")

    eventStream.live?.abort()
    if (eventStream.abort) eventStream.abort.abort()
    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
