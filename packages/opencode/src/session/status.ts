import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { Instance } from "@/project/instance"
import z from "zod"

export namespace SessionStatus {
  export const Quota = z
    .object({
      account: z.string().optional(),
      cooldownUntil: z.number().optional(),
      lastStatusCode: z.number().optional(),
      lastErrorAt: z.number().optional(),
      successCount: z.number().optional(),
      failureCount: z.number().optional(),
    })
    .strict()

  export const Provider = z.record(z.string(), Quota)

  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
        provider: Provider.optional(),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
        provider: Provider.optional(),
      }),
      z.object({
        type: z.literal("busy"),
        provider: Provider.optional(),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: z.string(),
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const state = Instance.state(() => {
    const data: Record<string, Info> = {}
    return data
  })

  export function get(sessionID: string) {
    return (
      state()[sessionID] ?? {
        type: "idle",
      }
    )
  }

  export function list() {
    return state()
  }

  export async function global(): Promise<Info> {
    const auth = await Auth.all()
    const provider = Object.fromEntries(
      await Promise.all(
        Object.entries(auth)
          .filter(([, info]) => info.type === "oauth")
          .map(async ([id]) => {
            const pool = await Auth.OAuthPool.snapshot(id)
            const rid = pool.orderedIDs[0]
            const rec = rid ? pool.records.find((item) => item.id === rid) : undefined
            if (!rec) return []
            return [
              id,
              {
                account: rec.accountId ?? rec.label ?? rec.id,
                cooldownUntil: rec.health.cooldownUntil,
                lastStatusCode: rec.health.lastStatusCode,
                lastErrorAt: rec.health.lastErrorAt,
                successCount: rec.health.successCount,
                failureCount: rec.health.failureCount,
              },
            ]
          }),
      ),
    )
    if (!Object.keys(provider).length) return { type: "idle" }
    return { type: "idle", provider }
  }

  export function set(sessionID: string, status: Info) {
    Bus.publish(Event.Status, {
      sessionID,
      status,
    })
    void global().then((status) => {
      Bus.publish(Event.Status, {
        sessionID: "__global__",
        status,
      })
    })
    if (status.type === "idle") {
      // deprecated
      Bus.publish(Event.Idle, {
        sessionID,
      })
      delete state()[sessionID]
      return
    }
    state()[sessionID] = status
  }
}
