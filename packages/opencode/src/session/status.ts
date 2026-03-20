import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"
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
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Info>
    readonly list: () => Effect.Effect<Map<SessionID, Info>>
    readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionStatus") {}

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

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const state = yield* InstanceState.make(Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())))

      const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        return data.get(sessionID) ?? { type: "idle" as const }
      })

      const list = Effect.fn("SessionStatus.list")(function* () {
        return new Map(yield* InstanceState.get(state))
      })

      const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
        const data = yield* InstanceState.get(state)
        yield* bus.publish(Event.Status, { sessionID, status })
        if (status.type === "idle") {
          yield* bus.publish(Event.Idle, { sessionID })
          data.delete(sessionID)
          return
        }
        data.set(sessionID, status)
      })

      return Service.of({ get, list, set })
    }),
  )

  const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function set(sessionID: SessionID, status: Info) {
    await runPromise((svc) => svc.set(sessionID, status))
    Bus.publish(Event.Status, {
      sessionID: SessionID.make("__global__"),
      status: await global(),
    })
  }
}
