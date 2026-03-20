import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"

const SSE_WATCHDOG_MS = 30_000

export type EventSource = {
  subscribe: (directory: string | undefined, handler: (event: Event) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0
    let watchdog: Timer | undefined
    let stale = false
    let live: AbortController | undefined
    let watch = false

    const touch = () => {
      if (!watch) return
      stale = false
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stale = true
        live?.abort(new Error("Event stream heartbeat timed out"))
      }, SSE_WATCHDOG_MS)
    }

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      const type = event.type as string
      touch()
      if (type === "server.heartbeat" || type === "server.connected") return
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const cycle = new AbortController()
          live = cycle
          const signal = AbortSignal.any([ctrl.signal, cycle.signal])
          const events = await sdk.event.subscribe({}, { signal }).catch((error) => {
            if (abort.signal.aborted || ctrl.signal.aborted) return undefined
            if (!stale) throw error
            return undefined
          })
          if (!events) {
            touch()
            await Bun.sleep(250)
            continue
          }

          try {
            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              handleEvent(event)
            }
          } catch (error) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            if (signal.aborted && stale) {
              touch()
              continue
            }
            if (!stale) throw error
          } finally {
            cycle.abort()
            if (live === cycle) live = undefined
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          touch()
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(props.directory, handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }

      // Fall back to SSE
      watch = true
      touch()
      startSSE()
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
