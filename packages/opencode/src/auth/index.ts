import path from "path"
import fs from "fs/promises"
import z from "zod"
import { ulid } from "ulid"
import { Effect, Layer, Record, Result, Schema, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "../filesystem"
import { Filesystem } from "../util/filesystem"
import { getOAuthRecordID } from "./context"
import { Log } from "../util/log"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new Auth.AuthError({ message, cause })

export namespace Auth {
  export class Oauth extends Schema.Class<Oauth>("OAuth")({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
    enterpriseUrl: Schema.optional(Schema.String),
  }) {}

  export class Api extends Schema.Class<Api>("ApiAuth")({
    type: Schema.Literal("api"),
    key: Schema.String,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }) {}

  export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
    type: Schema.Literal("wellknown"),
    key: Schema.String,
    token: Schema.String,
  }) {}

  const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
  export const Info = Object.assign(_Info, { zod: zod(_Info) })
  export type Info = Schema.Schema.Type<typeof _Info>

  export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export interface Interface {
    readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
    readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
    readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
    readonly remove: (key: string) => Effect.Effect<void, AuthError>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Auth") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const decode = Schema.decodeUnknownOption(Info)

      const all = Effect.fn("Auth.all")(function* () {
        const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
        return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
      })

      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        return (yield* all())[providerID]
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        const norm = key.replace(/\/+$/, "")
        const data = yield* all()
        if (norm !== key) delete data[key]
        delete data[norm + "/"]
        yield* fsys
          .writeJson(file, { ...data, [norm]: info }, 0o600)
          .pipe(Effect.mapError(fail("Failed to write auth data")))
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        const norm = key.replace(/\/+$/, "")
        const data = yield* all()
        delete data[key]
        delete data[norm]
        yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      })

      return Service.of({ get, all, set, remove })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  const filepath = path.join(Global.Path.data, "auth.json")
  const lockpath = `${filepath}.lock`
  const STORE_LOCK_TIMEOUT_MS = 5_000
  const STORE_LOCK_STALE_MS = 30_000
  const STORE_LOCK_RETRY_MS = 25
  const STORE_LOCK_BEST_EFFORT_TIMEOUT_MS = 250
  const STORE_LOCK_BEST_EFFORT_RETRY_MS = 10

  const log = Log.create({ service: "auth.store" })

  class StoreLockTimeoutError extends Error {
    constructor() {
      super("Timed out waiting for auth store lock")
      this.name = "StoreLockTimeoutError"
    }
  }

  const Health = z
    .object({
      cooldownUntil: z.number().optional(),
      lastStatusCode: z.number().optional(),
      lastErrorAt: z.number().optional(),
      successCount: z.number().default(0),
      failureCount: z.number().default(0),
    })
    .strict()
    .default(() => ({ successCount: 0, failureCount: 0 }))
  type Health = z.infer<typeof Health>

  const OAuthRecord = z
    .object({
      id: z.string(),
      namespace: z.string().default("default"),
      label: z.string().optional(),
      accountId: z.string().optional(),
      email: z.string().optional(),
      enterpriseUrl: z.string().optional(),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      createdAt: z.number(),
      updatedAt: z.number(),
      health: Health,
    })
    .strict()
  type OAuthRecord = z.infer<typeof OAuthRecord>

  export type OAuthRecordMeta = Omit<OAuthRecord, "refresh" | "access" | "expires">

  const OAuthProvider = z
    .object({
      type: z.literal("oauth"),
      active: z.record(z.string(), z.string()).default({}),
      order: z.record(z.string(), z.array(z.string())).default({}),
      records: z.array(OAuthRecord).default([]),
    })
    .strict()
  type OAuthProvider = z.infer<typeof OAuthProvider>

  const ApiProvider = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .strict()

  const WellKnownProvider = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .strict()

  const ProviderEntry = z.union([OAuthProvider, ApiProvider, WellKnownProvider])
  type ProviderEntry = z.infer<typeof ProviderEntry>

  const StoreFile = z
    .object({
      version: z.literal(2),
      providers: z.record(z.string(), ProviderEntry).default({}),
    })
    .strict()
  type StoreFile = z.infer<typeof StoreFile>
  const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  const OPENAI_OAUTH_ISSUER = "https://auth.openai.com"

  function toMeta(record: OAuthRecord): OAuthRecordMeta {
    const { refresh: _refresh, access: _access, expires: _expires, ...meta } = record
    return meta
  }

  function claims(token: string) {
    const parts = token.split(".")
    if (parts.length !== 3) return
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
        email?: string
      }
    } catch {
      return
    }
  }

  async function refreshOpenAIToken(refresh: string) {
    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: OPENAI_OAUTH_CLIENT_ID,
      }).toString(),
    })
    if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
    return (await response.json()) as {
      refresh_token: string
      access_token: string
      expires_in?: number
    }
  }

  async function ensureDataDir(): Promise<void> {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  }

  async function withStoreLock<T>(
    fn: () => Promise<T>,
    options: { timeoutMs?: number; staleMs?: number; retryMs?: number } = {},
  ): Promise<T> {
    await ensureDataDir()
    const timeoutMs = options.timeoutMs ?? STORE_LOCK_TIMEOUT_MS
    const staleMs = options.staleMs ?? STORE_LOCK_STALE_MS
    const retryMs = options.retryMs ?? STORE_LOCK_RETRY_MS
    const start = Date.now()
    while (true) {
      try {
        const handle = await fs.open(lockpath, "wx")
        await handle.close()
        break
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== "EEXIST") throw error
        const stat = await fs.stat(lockpath).catch(() => undefined)
        if (stat && Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockpath).catch(() => {})
          continue
        }
        if (Date.now() - start > timeoutMs) {
          throw new StoreLockTimeoutError()
        }
        await Bun.sleep(retryMs + Math.random() * retryMs)
      }
    }

    try {
      return await fn()
    } finally {
      await fs.rm(lockpath).catch(() => {})
    }
  }

  async function writeStoreFile(store: StoreFile): Promise<void> {
    await ensureDataDir()
    const tempPath = `${filepath}.tmp`
    const tempFile = Bun.file(tempPath)
    await Bun.write(tempFile, JSON.stringify(store, null, 2))
    await fs.rename(tempPath, filepath)
    await fs.chmod(filepath, 0o600).catch(() => {})
  }

  async function readStoreFile(): Promise<{ store: StoreFile; needsWrite: boolean }> {
    const file = Bun.file(filepath)
    const exists = await file.exists()
    const raw = await file.json().catch(() => undefined)

    const parsed = StoreFile.safeParse(raw)
    if (parsed.success) return { store: parsed.data, needsWrite: false }

    const legacyParsed = z.record(z.string(), Info).safeParse(raw)
    if (legacyParsed.success) {
      const now = Date.now()
      const next: StoreFile = { version: 2, providers: {} }

      for (const [providerID, info] of Object.entries(legacyParsed.data)) {
        if (info.type === "api") {
          next.providers[providerID] = { type: "api", key: info.key }
          continue
        }

        if (info.type === "wellknown") {
          next.providers[providerID] = { type: "wellknown", key: info.key, token: info.token }
          continue
        }

        const recordID = ulid()
        next.providers[providerID] = {
          type: "oauth",
          active: { default: recordID },
          order: { default: [recordID] },
          records: [
            {
              id: recordID,
              namespace: "default",
              label: "default",
              accountId: info.accountId,
              enterpriseUrl: info.enterpriseUrl,
              refresh: info.refresh,
              access: info.access,
              expires: info.expires,
              createdAt: now,
              updatedAt: now,
              health: { successCount: 0, failureCount: 0 },
            },
          ],
        }
      }

      return { store: next, needsWrite: true }
    }

    return { store: { version: 2, providers: {} }, needsWrite: exists }
  }

  async function loadStoreFile(): Promise<StoreFile> {
    const result = await readStoreFile()
    return result.store
  }

  type StoreUpdateResult<T> = {
    value: T
    changed: boolean
  }

  async function updateStoreWithLock<T>(
    fn: (store: StoreFile) => Promise<StoreUpdateResult<T>> | StoreUpdateResult<T>,
    lockOptions?: { timeoutMs?: number; staleMs?: number; retryMs?: number },
  ) {
    return withStoreLock(async () => {
      const { store, needsWrite } = await readStoreFile()
      const result = await fn(store)
      if (result.changed || needsWrite) {
        await writeStoreFile(store)
      }
      return result.value
    }, lockOptions)
  }

  async function updateStore<T>(fn: (store: StoreFile) => Promise<StoreUpdateResult<T>> | StoreUpdateResult<T>) {
    return updateStoreWithLock(fn)
  }

  async function updateStoreBestEffort(
    fn: (store: StoreFile) => Promise<StoreUpdateResult<void>> | StoreUpdateResult<void>,
  ): Promise<void> {
    try {
      await updateStoreWithLock(fn, {
        timeoutMs: STORE_LOCK_BEST_EFFORT_TIMEOUT_MS,
        retryMs: STORE_LOCK_BEST_EFFORT_RETRY_MS,
      })
    } catch (error) {
      if (error instanceof StoreLockTimeoutError) {
        log.warn("auth store lock busy, skipping update", { timeoutMs: STORE_LOCK_BEST_EFFORT_TIMEOUT_MS })
        return
      }
      throw error
    }
  }

  function ensureOAuthProvider(store: StoreFile, providerID: string): OAuthProvider {
    const existing = store.providers[providerID]
    if (existing && existing.type === "oauth") return existing

    const next: OAuthProvider = {
      type: "oauth",
      active: {},
      order: {},
      records: [],
    }
    store.providers[providerID] = next
    return next
  }

  function findOAuthRecord(provider: OAuthProvider, recordID: string): OAuthRecord | undefined {
    return provider.records.find((record) => record.id === recordID)
  }

  function pickRecord(providerID: string, provider: OAuthProvider, namespace: string, preferred?: string) {
    const recordID = availableRecordID(provider, namespace, preferred ?? getOAuthRecordID(providerID) ?? provider.active[namespace])
    if (!recordID) return
    const record = provider.records.find((item) => item.id === recordID && item.namespace === namespace)
    if (!record) return
    return { recordID, record }
  }

  function normalizeOrder(ids: string[], order: string[]): string[] {
    const ordered: string[] = []
    for (const id of order) {
      if (ids.includes(id) && !ordered.includes(id)) ordered.push(id)
    }
    for (const id of ids) {
      if (!ordered.includes(id)) ordered.push(id)
    }
    return ordered
  }

  function recordIDsForNamespace(provider: OAuthProvider, namespace: string): string[] {
    const ids = provider.records.filter((record) => record.namespace === namespace).map((record) => record.id)
    const order = provider.order[namespace] ?? []
    return normalizeOrder(ids, order)
  }

  function availableRecordID(
    provider: OAuthProvider,
    namespace: string,
    preferred?: string,
  ): string | undefined {
    const ordered = recordIDsForNamespace(provider, namespace)
    const now = Date.now()
    const ready = (id?: string) => {
      if (!id) return false
      const record = provider.records.find((item) => item.id === id && item.namespace === namespace)
      if (!record) return false
      const cooldown = record.health.cooldownUntil
      return !cooldown || cooldown <= now
    }

    if (ready(preferred)) return preferred
    return ordered.find((id) => ready(id)) ?? preferred ?? ordered[0]
  }

  async function findOAuthRecordIDByRefreshToken(input: {
    providerID: string
    namespace: string
    refresh: string
    provider: OAuthProvider
  }): Promise<string | undefined> {
    for (const record of input.provider.records) {
      if (record.namespace !== input.namespace) continue
      if (record.refresh === input.refresh) return record.id
    }
    return undefined
  }

  export async function all(): Promise<Record<string, Info>> {
    log.debug("Auth.all called")
    const store = await loadStoreFile()
    log.debug("Auth.all loaded store", { providers: Object.keys(store.providers) })
    const result: Record<string, Info> = {}
    for (const [providerID, entry] of Object.entries(store.providers)) {
      if (entry.type === "api") {
        result[providerID] = { type: "api", key: entry.key }
        continue
      }
      if (entry.type === "wellknown") {
        result[providerID] = { type: "wellknown", key: entry.key, token: entry.token }
        continue
      }

      const namespace = "default"
      const choice = pickRecord(providerID, entry, namespace)
      log.debug("Auth.all processing oauth provider", {
        providerID,
        contextID: getOAuthRecordID(providerID),
        recordID: choice?.recordID,
      })
      if (!choice) {
        log.debug("Auth.all no recordID found", { providerID, active: entry.active[namespace] })
        continue
      }
      const { recordID, record } = choice
      log.debug("Auth.all found record", { providerID, recordID, hasEmail: !!record.email, expires: record.expires })
      result[providerID] = {
        type: "oauth",
        refresh: record.refresh,
        access: record.access,
        expires: record.expires,
        accountId: record.accountId,
        email: record.email,
        enterpriseUrl: record.enterpriseUrl,
      }
    }
    log.debug("Auth.all returning", { providers: Object.keys(result) })
    return result
  }

  export async function get(providerID: string): Promise<Info | undefined> {
    return (await all())[providerID]
  }

  export async function set(key: string, info: Info) {
    const norm = key.replace(/\/+$/, "")
    log.debug("Auth.set called", { key, norm, type: info.type })
    if (info.type === "oauth") {
      log.debug("Auth.set calling addOAuth", { key, norm, hasEmail: !!info.email, expires: info.expires })
      await addOAuth(norm, info)
      log.debug("Auth.set addOAuth complete", { key, norm })
      return
    }

    await updateStore((store) => {
      // Normalize key and clean up trailing slash variant
      if (norm !== key) {
        delete store.providers[key]
      }
      delete store.providers[norm + "/"]
      store.providers[norm] = info.type === "api" ? { type: "api", key: info.key } : { type: "wellknown", key: info.key, token: info.token }
      return { value: undefined, changed: true }
    })
    log.debug("Auth.set complete", { key, norm })
  }

  export async function remove(key: string) {
    const norm = key.replace(/\/+$/, "")
    log.debug("Auth.remove called", { key, norm })
    return updateStore((store) => {
      const existing = store.providers[key] ?? store.providers[norm]
      if (!existing) return { value: undefined, changed: false }

      delete store.providers[key]
      delete store.providers[norm]
      delete store.providers[norm + "/"]
      return { value: undefined, changed: true }
    })
  }

  export async function addOAuth(
    providerID: string,
    input: Omit<z.infer<typeof Oauth>, "type"> & { namespace?: string; label?: string },
  ) {
    const normProviderID = providerID.replace(/\/+$/, "")
    const namespace = (input.namespace ?? "default").trim() || "default"
    log.debug("Auth.addOAuth called", { providerID: normProviderID, namespace, hasEmail: !!input.email, expires: input.expires })
    return updateStore(async (store) => {
      const provider = ensureOAuthProvider(store, normProviderID)
      const now = Date.now()
      const existingRecordID = await findOAuthRecordIDByRefreshToken({
        providerID: normProviderID,
        namespace,
        refresh: input.refresh,
        provider,
      })

      if (existingRecordID) {
        log.debug("Auth.addOAuth updating existing record", { providerID: normProviderID, existingRecordID })
        const existing = findOAuthRecord(provider, existingRecordID)
        if (existing) {
          existing.refresh = input.refresh
          existing.access = input.access
          existing.expires = input.expires
          existing.updatedAt = now
          if (input.accountId !== undefined) existing.accountId = input.accountId
          if (input.email !== undefined) existing.email = input.email
          if (input.enterpriseUrl !== undefined) existing.enterpriseUrl = input.enterpriseUrl
          if (input.label) existing.label = input.label
          log.debug("Auth.addOAuth updated fields", { providerID: normProviderID, existingRecordID, email: existing.email })
        }
        const order = provider.order[namespace] ?? []
        if (!order.includes(existingRecordID)) {
          provider.order[namespace] = [...order, existingRecordID]
        }
        provider.active[namespace] = existingRecordID

        return { value: { providerID: normProviderID, namespace, recordID: existingRecordID }, changed: true }
      }

      const recordID = ulid()
      log.debug("Auth.addOAuth creating new record", { providerID: normProviderID, recordID })

      provider.records.push({
        id: recordID,
        namespace,
        label: input.label ?? "default",
        accountId: input.accountId,
        email: input.email,
        enterpriseUrl: input.enterpriseUrl,
        refresh: input.refresh,
        access: input.access,
        expires: input.expires,
        createdAt: now,
        updatedAt: now,
        health: { successCount: 0, failureCount: 0 },
      })

      provider.order[namespace] = [...(provider.order[namespace] ?? []), recordID]
      provider.active[namespace] = recordID

      return { value: { providerID: normProviderID, namespace, recordID }, changed: true }
    })
  }

  // Cache for MiniMax quota (30 minute TTL to avoid rate limiting)
  let minimaxCache:
    | {
        data: {
          fiveHour?: { utilization: number; resetsAt?: string; remainingCredits: number; totalCredits: number }
          _error?: string
          _cached?: boolean
        } | null
        timestamp: number
      }
    | null = null
  const MINIMAX_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

  export namespace OAuthPool {
    export async function snapshot(
      providerID: string,
      namespace = "default",
    ): Promise<{ records: OAuthRecordMeta[]; orderedIDs: string[]; activeID?: string }> {
      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return { records: [], orderedIDs: [] }

      const normalized = namespace.trim() || "default"
      const records = provider.records.filter((record) => record.namespace === normalized).map(toMeta)
      const orderedIDs = recordIDsForNamespace(provider, normalized)
      const activeID = provider.active[normalized]

      return { records, orderedIDs, activeID }
    }

    export async function list(providerID: string, namespace = "default"): Promise<OAuthRecordMeta[]> {
      return snapshot(providerID, namespace).then((result) => result.records)
    }

    export async function orderedIDs(providerID: string, namespace = "default"): Promise<string[]> {
      return snapshot(providerID, namespace).then((result) => result.orderedIDs)
    }

    export async function moveToBack(providerID: string, namespace: string, recordID: string): Promise<void> {
      await updateStoreBestEffort((store) => {
        const provider = store.providers[providerID]
        if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }
        const order = recordIDsForNamespace(provider, namespace)
        provider.order[namespace] = order.filter((id) => id !== recordID).concat(recordID)
        provider.active[namespace] = provider.order[namespace][0] ?? provider.active[namespace]
        return { value: undefined, changed: true }
      })
    }

    export async function recordOutcome(input: {
      providerID: string
      recordID: string
      statusCode: number
      ok: boolean
      cooldownUntil?: number
    }): Promise<void> {
      await updateStoreBestEffort((store) => {
        const provider = store.providers[input.providerID]
        if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }

        const record = findOAuthRecord(provider, input.recordID)
        if (!record) return { value: undefined, changed: false }
        const namespace = record.namespace

        const now = Date.now()
        const prevCooldown =
          record.health.cooldownUntil && record.health.cooldownUntil > now ? record.health.cooldownUntil : undefined
        const cooldownUntil = input.ok ? undefined : (input.cooldownUntil ?? prevCooldown)

        record.health = {
          ...record.health,
          cooldownUntil,
          lastStatusCode: input.statusCode,
          lastErrorAt: input.ok ? undefined : now,
          successCount: record.health.successCount + (input.ok ? 1 : 0),
          failureCount: record.health.failureCount + (input.ok ? 0 : 1),
        }
        record.updatedAt = now

        if (!input.ok) {
          const order = recordIDsForNamespace(provider, namespace)
          provider.order[namespace] = order.filter((id) => id !== input.recordID).concat(input.recordID)
          const next = availableRecordID(
            provider,
            namespace,
            provider.order[namespace].find((id) => id !== input.recordID),
          )
          provider.active[namespace] = next ?? input.recordID
        }

        return { value: undefined, changed: true }
      })
    }

    export async function markAccessExpired(providerID: string, namespace: string, recordID: string): Promise<void> {
      await updateStoreBestEffort((store) => {
        const provider = store.providers[providerID]
        if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }
        const record = findOAuthRecord(provider, recordID)
        if (!record || record.namespace !== namespace) return { value: undefined, changed: false }
        record.access = ""
        record.expires = 0
        record.updatedAt = Date.now()
        return { value: undefined, changed: true }
      })
    }

    export async function getUsage(
      providerID: string,
      namespace = "default",
    ): Promise<
      Array<{
        id: string
        label?: string
        email?: string
        isActive: boolean
        health: {
          successCount: number
          failureCount: number
          lastStatusCode?: number
          cooldownUntil?: number
        }
      }>
    > {
      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return []

      const activeID = pickRecord(providerID, provider, namespace)?.recordID

      return provider.records
        .filter((record) => record.namespace === namespace)
        .map((record) => ({
          id: record.id,
          label: record.label,
          email: record.email,
          isActive: record.id === activeID,
          health: {
            successCount: record.health.successCount,
            failureCount: record.health.failureCount,
            lastStatusCode: record.health.lastStatusCode,
            cooldownUntil: record.health.cooldownUntil,
          },
        }))
    }

    export async function pick(providerID: string, namespace = "default", preferred?: string) {
      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return
      const choice = pickRecord(providerID, provider, namespace, preferred)
      if (!choice) return
      return {
        id: choice.record.id,
        namespace: choice.record.namespace,
        label: choice.record.label,
        accountId: choice.record.accountId,
        email: choice.record.email,
        refresh: choice.record.refresh,
        access: choice.record.access,
        expires: choice.record.expires,
      }
    }

    export async function setActive(providerID: string, namespace: string, recordID: string): Promise<boolean> {
      return updateStore((store) => {
        const provider = store.providers[providerID]
        if (!provider || provider.type !== "oauth") return { value: false, changed: false }

        const record = findOAuthRecord(provider, recordID)
        if (!record || record.namespace !== namespace) return { value: false, changed: false }

        const order = recordIDsForNamespace(provider, namespace)
        provider.order[namespace] = [recordID, ...order.filter((id) => id !== recordID)]
        provider.active[namespace] = recordID

        return { value: true, changed: true }
      })
    }

    export async function updateRecord(
      providerID: string,
      recordID: string,
      namespace: string,
      update: { access?: string; refresh?: string; expires?: number; label?: string },
    ): Promise<boolean> {
      return updateStore((store) => {
        const provider = store.providers[providerID]
        if (!provider || provider.type !== "oauth") return { value: false, changed: false }

        const record = provider.records.find((r) => r.id === recordID && r.namespace === namespace)
        if (!record) return { value: false, changed: false }

        if (update.access !== undefined) record.access = update.access
        if (update.refresh !== undefined) record.refresh = update.refresh
        if (update.expires !== undefined) record.expires = update.expires
        if (update.label !== undefined) record.label = update.label
        record.updatedAt = Date.now()

        return { value: true, changed: true }
      })
    }

    export async function removeRecord(
      providerID: string,
      recordID: string,
      namespace = "default",
    ): Promise<{ removed: boolean; remaining: number }> {
      return updateStore<{ removed: boolean; remaining: number }>((store) => {
        const provider = store.providers[providerID]
        if (!provider || provider.type !== "oauth") return { value: { removed: false, remaining: 0 }, changed: false }

        const index = provider.records.findIndex((r) => r.id === recordID && r.namespace === namespace)
        if (index === -1) return { value: { removed: false, remaining: provider.records.length }, changed: false }

        // Remove the record
        provider.records.splice(index, 1)

        // Update order array
        const order = provider.order[namespace] ?? []
        provider.order[namespace] = order.filter((id) => id !== recordID)

        // If the removed record was active, set a new active
        if (provider.active[namespace] === recordID) {
          const remaining = recordIDsForNamespace(provider, namespace)
          provider.active[namespace] = remaining[0]
        }

        // If no records left for this namespace, clean up
        const remaining = provider.records.filter((r) => r.namespace === namespace).length
        if (remaining === 0) {
          delete provider.order[namespace]
          delete provider.active[namespace]
        }

        // If no records left at all, remove the provider entry
        if (provider.records.length === 0) {
          delete store.providers[providerID]
        }

        return { value: { removed: true, remaining }, changed: true }
      })
    }

    export async function fetchAnthropicUsage(
      providerID: string,
      namespace = "default",
      recordID?: string,
    ): Promise<{
      fiveHour?: { utilization: number; resetsAt?: string }
      sevenDay?: { utilization: number; resetsAt?: string }
      sevenDaySonnet?: { utilization: number; resetsAt?: string }
    } | null> {
      if (providerID !== "anthropic") return null

      const store = await loadStoreFile()
      const provider = store.providers[providerID]
      if (!provider || provider.type !== "oauth") return null

      const choice = pickRecord(providerID, provider, namespace, recordID)
      if (!choice?.record.access) return null

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      try {
        const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${choice.record.access}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: controller.signal,
        })

        if (!response.ok) return null

        const data = (await response.json()) as {
          five_hour?: { utilization: number; resets_at?: string }
          seven_day?: { utilization: number; resets_at?: string }
          seven_day_sonnet?: { utilization: number; resets_at?: string }
        }

        return {
          fiveHour: data.five_hour
            ? { utilization: Math.round(data.five_hour.utilization), resetsAt: data.five_hour.resets_at }
            : undefined,
          sevenDay: data.seven_day
            ? { utilization: Math.round(data.seven_day.utilization), resetsAt: data.seven_day.resets_at }
            : undefined,
          sevenDaySonnet: data.seven_day_sonnet
            ? { utilization: Math.round(data.seven_day_sonnet.utilization), resetsAt: data.seven_day_sonnet.resets_at }
            : undefined,
        }
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }

    export async function fetchCodexUsage(recordID?: string): Promise<{
      fiveHour?: { utilization: number; resetsAt?: string }
      sevenDay?: { utilization: number; resetsAt?: string }
      planType?: string
      source?: string
      account?: {
        id?: string
        label?: string
        email?: string
      }
      raw?: {
        rate_limit?: {
          primary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
          secondary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
        }
        plan_type?: string
      }
      _error?: string
    } | null> {
      // Read Codex auth tokens - try OpenCode OAuth pool first, then Codex CLI
      let accessToken: string | undefined
      let accountId: string | undefined
      let tokenSource: string | undefined
      let chosen: Awaited<ReturnType<typeof Auth.OAuthPool.pick>> | undefined
      let refresh: string | undefined
      let account:
        | {
            id?: string
            label?: string
            email?: string
          }
        | undefined

      // Try OpenCode OAuth pool first (supports multiple accounts)
      try {
        const store = await loadStoreFile()
        const openaiProvider = store.providers?.openai
        if (openaiProvider?.type === "oauth") {
          const choice = pickRecord("openai", openaiProvider, "default", recordID)
          if (choice?.record.access) {
            chosen = {
              id: choice.record.id,
              namespace: choice.record.namespace,
              label: choice.record.label,
              accountId: choice.record.accountId,
              email: choice.record.email,
              refresh: choice.record.refresh,
              access: choice.record.access,
              expires: choice.record.expires,
            }
            refresh = choice.record.refresh
            accessToken = choice.record.access
            accountId = choice.record.accountId
            tokenSource = "opencode-oauth-pool"
            const meta = toMeta(choice.record)
            account = {
              id: meta.accountId,
              label: meta.label,
              email: claims(choice.record.access)?.email,
            }
          }
        }
      } catch {
        // Fall through to try Codex CLI
      }

      // Fall back to Codex CLI auth.json if no OAuth pool token
      if (!accessToken) {
        const codexAuthPath = path.join(process.env.HOME || "", ".codex", "auth.json")
        
        try {
          const codexAuthData = await fs.readFile(codexAuthPath, "utf-8")
          const codexAuth = JSON.parse(codexAuthData)
          
          // Check for API key
          if (codexAuth.OPENAI_API_KEY) {
            // Using API key - can't get usage
            return { fiveHour: { utilization: 0, resetsAt: undefined }, sevenDay: { utilization: 0, resetsAt: undefined } }
          }
          
          // OAuth tokens
          if (codexAuth.tokens?.access_token) {
            accessToken = codexAuth.tokens.access_token
            accountId = codexAuth.tokens.account_id
            tokenSource = "codex-cli"
            account = {
              id: codexAuth.tokens.account_id,
              email: claims(codexAuth.tokens.access_token)?.email,
            }
          } else {
            return null
          }
        } catch {
          return null
        }
      }

      if (chosen && refresh && (!accessToken || chosen.expires < Date.now())) {
        try {
          const tokens = await refreshOpenAIToken(refresh)
          await Auth.OAuthPool.updateRecord("openai", chosen.id, "default", {
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          })
          refresh = tokens.refresh_token
          accessToken = tokens.access_token
          account = {
            id: chosen.accountId,
            label: chosen.label,
            email: claims(tokens.access_token)?.email ?? chosen.email,
          }
        } catch (error) {
          return {
            source: tokenSource,
            account,
            _error: error instanceof Error ? error.message : "Token refresh failed",
          }
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      try {
        let response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "ChatGPT-Account-Id": accountId || "",
            "User-Agent": "opencode/1.0",
          },
          signal: controller.signal,
        })

        if (response.status === 401 && chosen && refresh) {
          try {
            const tokens = await refreshOpenAIToken(refresh)
            await Auth.OAuthPool.updateRecord("openai", chosen.id, "default", {
              refresh: tokens.refresh_token,
              access: tokens.access_token,
              expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            })
            refresh = tokens.refresh_token
            accessToken = tokens.access_token
            account = {
              id: chosen.accountId,
              label: chosen.label,
              email: claims(tokens.access_token)?.email ?? chosen.email,
            }
            response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
              method: "GET",
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${tokens.access_token}`,
                "ChatGPT-Account-Id": accountId || "",
                "User-Agent": "opencode/1.0",
              },
              signal: controller.signal,
            })
          } catch (error) {
            return {
              source: tokenSource,
              account,
              _error: error instanceof Error ? error.message : "Token refresh failed",
            }
          }
        }

        if (!response.ok) {
          return {
            source: tokenSource,
            account,
            _error: `Codex quota request failed (${response.status})`,
          }
        }

        const data = (await response.json()) as {
          rate_limit?: {
            primary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
            secondary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
          }
          plan_type?: string
        }

        return {
          fiveHour: data.rate_limit?.primary_window
            ? { utilization: Math.round(data.rate_limit.primary_window.used_percent), resetsAt: new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString() }
            : undefined,
          sevenDay: data.rate_limit?.secondary_window
            ? { utilization: Math.round(data.rate_limit.secondary_window.used_percent), resetsAt: new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString() }
            : undefined,
          planType: data.plan_type,
          source: tokenSource,
          account,
          raw: data,
        }
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }

      export async function fetchMiniMaxUsage(): Promise<{
        fiveHour?: { utilization: number; resetsAt?: string; remainingCredits: number; totalCredits: number }
        _error?: string
        _cached?: boolean
      } | null> {
        // Check cache first
        const now = Date.now()
        if (minimaxCache && now - minimaxCache.timestamp < MINIMAX_CACHE_TTL) {
          return { ...minimaxCache.data, _cached: true }
        }

        // Read MiniMax API key from environment or auth store
        let apiKey = process.env.MINIMAX_API_KEY
        if (!apiKey) {
          const authInfo = await Auth.get("minimax")
          if (authInfo?.type === "api") {
            apiKey = authInfo.key
          }
        }
        if (!apiKey) return { _error: "No MiniMax API key configured" }

        // Try platform.minimax.io with browser-like headers
        // The cookies help avoid Cloudflare blocks
        const domains = ["platform.minimax.io", "platform.minimaxi.com"]

        for (const domain of domains) {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)

          try {
            const response = await fetch(`https://${domain}/v1/api/openplatform/coding_plan/remains`, {
              method: "GET",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "sec-ch-ua": '"Chromium";v="120", "Not-A.Brand";v="24"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
                Referer: "https://platform.minimax.io/user-center/payment/coding-plan",
              },
              signal: controller.signal,
            })

            if (!response.ok) {
              const errorText = await response.text().catch(() => "")
              // If rate limited, return cached data if available
              if (response.status === 403 || response.status === 429) {
                if (minimaxCache) {
                  return { ...minimaxCache.data, _error: "Rate limited - returning cached data", _cached: true }
                }
                return { _error: `MiniMax API rate limited (${response.status})` }
              }
              return { _error: `MiniMax API error (${response.status}): ${errorText.slice(0, 100)}` }
            }

            const data = (await response.json()) as {
              model_remains?: Array<{
                current_interval_total_count: number
                current_interval_usage_count: number // This is actually remaining credits!
                end_time: number
                model_name: string
              }>
              base_resp?: { status_msg?: string }
            }

            // Check for API error response (but "success" is not an error)
            if (data.base_resp?.status_msg && data.base_resp.status_msg !== "success") {
              return { _error: `MiniMax API error: ${data.base_resp.status_msg}` }
            }

            if (!data.model_remains || data.model_remains.length === 0) {
              return { _error: "No quota data returned from MiniMax API" }
            }

            const modelRemain = data.model_remains[0]
            const totalCredits = modelRemain.current_interval_total_count
            const remainingCredits = modelRemain.current_interval_usage_count
            const usedCredits = totalCredits - remainingCredits
            const utilization = Math.round((usedCredits / totalCredits) * 100)

            const result = {
              fiveHour: {
                utilization,
                resetsAt: new Date(modelRemain.end_time).toISOString(),
                remainingCredits,
                totalCredits,
              },
            }

            // Cache successful response
            minimaxCache = { data: result, timestamp: Date.now() }

            return result
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            // Continue to next domain if this one failed
            if (domain === domains[domains.length - 1]) {
              return { _error: `MiniMax API failed: ${errMsg}` }
            }
            continue
          } finally {
            clearTimeout(timeout)
          }
        }

        return { _error: "Failed to reach MiniMax API" }
      }

      export async function fetchOpenRouterUsage(): Promise<{
        isFree?: boolean
        usage?: number
        usageDaily?: number
        usageWeekly?: number
        usageMonthly?: number
        limit?: number | null
        limitRemaining?: number | null
      } | null> {
        // Read OpenRouter API key from environment or auth store
        let apiKey = process.env.OPENROUTER_API_KEY
        if (!apiKey) {
          const authInfo = await Auth.get("openrouter")
          if (authInfo?.type === "api") {
            apiKey = authInfo.key
          }
        }
        if (!apiKey) return null

       const controller = new AbortController()
       const timeout = setTimeout(() => controller.abort(), 5000)

       try {
         const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
           method: "GET",
           headers: {
             Accept: "application/json",
             Authorization: `Bearer ${apiKey}`,
             "User-Agent": "opencode/1.0",
           },
           signal: controller.signal,
         })

         if (!response.ok) return null

         const data = (await response.json()) as {
           data: {
             usage: number
             usage_daily: number
             usage_weekly: number
             usage_monthly: number
             limit: number | null
             limit_remaining: number | null
             is_free_tier: boolean
           }
         }

         return {
           isFree: data.data.is_free_tier,
           usage: data.data.usage,
           usageDaily: data.data.usage_daily,
           usageWeekly: data.data.usage_weekly,
           usageMonthly: data.data.usage_monthly,
           limit: data.data.limit,
           limitRemaining: data.data.limit_remaining,
         }
        } catch {
          return null
        } finally {
          clearTimeout(timeout)
        }
      }

      export async function fetchGitHubCopilotUsage(): Promise<{
        hasAccess?: boolean
        assignedDate?: string
        lastActivityDate?: string
        orgBillingBreakdown?: {
          planType: string
          totalSeats: number
          activeSeats: number
          inactiveSeats: number
          pendingInvitation: number
          pendingCancellation: number
        }
        organizations?: Array<{
          name: string
          role: string
        }>
        statusMessage?: string
      } | null> {
        const store = await loadStoreFile()
        const provider = store.providers["github-copilot"]
        if (!provider || provider.type !== "oauth") return null

        const activeID = availableRecordID(provider, "default", provider.active["default"])
        const record = provider.records.find((r) => r.id === activeID && r.namespace === "default")
        if (!record?.access) return null

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        try {
          // First, get user info
          const userResponse = await fetch("https://api.github.com/user", {
            method: "GET",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${record.access}`,
              "User-Agent": "opencode/1.0",
            },
            signal: controller.signal,
          })

          if (!userResponse.ok) return null

          const userData = (await userResponse.json()) as {
            login: string
          }

          const username = userData.login

          // Get user's organizations
          const orgsResponse = await fetch("https://api.github.com/user/orgs", {
            method: "GET",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${record.access}`,
              "User-Agent": "opencode/1.0",
            },
            signal: controller.signal,
          })

          if (!orgsResponse.ok) return null

          const orgsData = (await orgsResponse.json()) as Array<{
            login: string
          }>

          const result: {
            hasAccess?: boolean
            assignedDate?: string
            lastActivityDate?: string
            orgBillingBreakdown?: {
              planType: string
              totalSeats: number
              activeSeats: number
              inactiveSeats: number
              pendingInvitation: number
              pendingCancellation: number
            }
            organizations?: Array<{ name: string; role: string }>
            statusMessage?: string
          } = {}

          // Try to find org with admin access and Copilot billing info
          for (const org of orgsData) {
            const billingResponse = await fetch(`https://api.github.com/orgs/${org.login}/copilot/billing`, {
              method: "GET",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${record.access}`,
                "User-Agent": "opencode/1.0",
              },
              signal: controller.signal,
            }).catch(() => null)

            if (billingResponse?.ok) {
              const billingData = (await billingResponse.json()) as {
                seat_breakdown: {
                  total: number
                  active_this_cycle: number
                  inactive_this_cycle: number
                  pending_invitation: number
                  pending_cancellation: number
                }
                plan_type: string
              }

              result.orgBillingBreakdown = {
                planType: billingData.plan_type,
                totalSeats: billingData.seat_breakdown.total,
                activeSeats: billingData.seat_breakdown.active_this_cycle,
                inactiveSeats: billingData.seat_breakdown.inactive_this_cycle,
                pendingInvitation: billingData.seat_breakdown.pending_invitation,
                pendingCancellation: billingData.seat_breakdown.pending_cancellation,
              }
              break // Found admin access to org, use this data
            }
          }

          // Try to find user's seat in any org
          for (const org of orgsData) {
            const seatsResponse = await fetch(`https://api.github.com/orgs/${org.login}/copilot/billing/seats`, {
              method: "GET",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${record.access}`,
                "User-Agent": "opencode/1.0",
              },
              signal: controller.signal,
            }).catch(() => null)

            if (seatsResponse?.ok) {
              const seatsData = (await seatsResponse.json()) as {
                seats: Array<{
                  login: string
                  assigned_date: string
                  last_activity_date: string
                }>
              }

              const userSeat = seatsData.seats.find((s) => s.login === username)
              if (userSeat) {
                result.hasAccess = true
                result.assignedDate = userSeat.assigned_date
                result.lastActivityDate = userSeat.last_activity_date
                break // Found user's seat
              }
            }
          }

          result.organizations = orgsData.map((org) => ({
            name: org.login,
            role: "member",
          }))

          if (!result.hasAccess && !result.orgBillingBreakdown) {
            result.statusMessage = "GitHub Copilot not directly accessible via API"
          }

          return result
        } catch {
          return null
        } finally {
          clearTimeout(timeout)
        }
      }
    }

  export async function usage() {
    const all = await Auth.all()
    const result: Record<string, any> = {}

    for (const [providerID, info] of Object.entries(all)) {
      if (info.type !== "oauth") continue
      const accounts = await Auth.OAuthPool.getUsage(providerID)
      const anthropicUsage = await Auth.OAuthPool.fetchAnthropicUsage(providerID)
      result[providerID] = { accounts, anthropicUsage: anthropicUsage ?? undefined }
    }

    const codexUsage = await Auth.OAuthPool.fetchCodexUsage()
    if (codexUsage) {
      const accounts = await Auth.OAuthPool.getUsage("openai")
      result.codex = {
        accounts: await Promise.all(
          accounts.map(async (account) => ({
            ...account,
            codexUsage: (await Auth.OAuthPool.fetchCodexUsage(account.id)) ?? undefined,
          })),
        ),
        codexUsage,
      }
    }

    const minimaxUsage = await Auth.OAuthPool.fetchMiniMaxUsage()
    if (minimaxUsage) {
      result.minimax = { accounts: [], minimaxUsage }
    }

    const openrouterUsage = await Auth.OAuthPool.fetchOpenRouterUsage()
    if (openrouterUsage) {
      result.openrouter = { accounts: [], openrouterUsage }
    }

    const githubCopilotUsage = await Auth.OAuthPool.fetchGitHubCopilotUsage()
    if (githubCopilotUsage) {
      result["github-copilot"] = {
        accounts: await Auth.OAuthPool.getUsage("github-copilot"),
        githubCopilotUsage,
      }
    }

    return result
  }
}
