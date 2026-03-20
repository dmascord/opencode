import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"

const SSE_WATCHDOG_MS = 30_000

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
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
    const sdk = createOpencodeClient({
      baseUrl: props.url,
      signal: abort.signal,
      directory: props.directory,
      fetch: props.fetch,
      headers: props.headers,
    })

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

    onMount(async () => {
      // If an event source is provided, use it instead of SSE
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(() => {
          unsub()
          if (watchdog) clearTimeout(watchdog)
        })
        return
      }

      // Fall back to SSE
      watch = true
      touch()
      while (true) {
        if (abort.signal.aborted) break
        const cycle = new AbortController()
        live = cycle
        const signal = AbortSignal.any([abort.signal, cycle.signal])
        const events = await sdk.event.subscribe({}, { signal }).catch((error) => {
          if (abort.signal.aborted) return undefined
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
            handleEvent(event)
          }
        } catch (error) {
          if (abort.signal.aborted) break
          if (signal.aborted && stale) {
            touch()
            continue
          }
          if (!stale) throw error
        } finally {
          cycle.abort()
          if (live === cycle) live = undefined
        }

        // Flush any remaining events
        if (timer) clearTimeout(timer)
        if (queue.length > 0) {
          flush()
        }
        touch()
      }
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
    })

    return { client: sdk, event: emitter, url: props.url }
  },
})
