import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "../../util/queue"

const log = Log.create({ service: "server" })

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(BusEvent.payloads()),
            },
          },
        },
      },
    }),
    async (c) => {
      const id = crypto.randomUUID()
      let queued = 0
      let written = 0
      let beats = 0
      let last = Date.now()
      log.info("event connected", { id })
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let done = false

        const push = (data: string | null, kind: string) => {
          if (data !== null) {
            queued += 1
            if (kind === "server.heartbeat") {
              beats += 1
              log.debug("event heartbeat queued", { id, queued, written, beats })
            }
          }
          q.push(data)
        }

        push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
          "server.connected",
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
            "server.heartbeat",
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          push(null, "stop")
          log.info("event disconnected", {
            id,
            queued,
            written,
            beats,
            idle: Date.now() - last,
          })
        }

        const unsub = Bus.subscribeAll((event) => {
          push(JSON.stringify(event), event.type)
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            const next = Date.now()
            const idle = next - last
            last = next
            if (idle > 10_000) {
              log.info("event stream write gap", {
                id,
                idle,
                queued,
                written,
                beats,
              })
            }
            await stream.writeSSE({ data })
            written += 1
          }
        } finally {
          stop()
        }
      })
    },
  )
