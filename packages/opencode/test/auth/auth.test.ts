import { afterEach, expect, mock, test } from "bun:test"
import { Auth } from "../../src/auth"

const fetch0 = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = fetch0
  await Auth.remove("openai")
})

test("set normalizes trailing slashes in keys", async () => {
  await Auth.set("https://example.com/", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeDefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set cleans up pre-existing trailing-slash entry", async () => {
  // Simulate a pre-fix entry with trailing slash
  await Auth.set("https://example.com/", {
    type: "wellknown",
    key: "TOKEN",
    token: "old",
  })
  // Re-login with normalized key (as the CLI does post-fix)
  await Auth.set("https://example.com", {
    type: "wellknown",
    key: "TOKEN",
    token: "new",
  })
  const data = await Auth.all()
  const keys = Object.keys(data).filter((k) => k.includes("example.com"))
  expect(keys).toEqual(["https://example.com"])
  const entry = data["https://example.com"]!
  expect(entry.type).toBe("wellknown")
  if (entry.type === "wellknown") expect(entry.token).toBe("new")
})

test("remove deletes both trailing-slash and normalized keys", async () => {
  await Auth.set("https://example.com", {
    type: "wellknown",
    key: "TOKEN",
    token: "abc",
  })
  await Auth.remove("https://example.com/")
  const data = await Auth.all()
  expect(data["https://example.com"]).toBeUndefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set and remove are no-ops on keys without trailing slashes", async () => {
  await Auth.set("anthropic", {
    type: "api",
    key: "sk-test",
  })
  const data = await Auth.all()
  expect(data["anthropic"]).toBeDefined()
  await Auth.remove("anthropic")
  const after = await Auth.all()
  expect(after["anthropic"]).toBeUndefined()
})

test("oauth pool skips cooled-down active account", async () => {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r1",
    access: "a1",
    expires: Date.now() + 60_000,
    accountId: "acct-1",
    email: "one@example.com",
  })
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r2",
    access: "a2",
    expires: Date.now() + 60_000,
    accountId: "acct-2",
    email: "two@example.com",
  })

  const records = await Auth.OAuthPool.getUsage("openai")
  const first = records.find((item) => item.email === "one@example.com")
  expect(first).toBeDefined()
  await Auth.OAuthPool.setActive("openai", "default", first!.id)
  await Auth.OAuthPool.recordOutcome({
    providerID: "openai",
    recordID: first!.id,
    statusCode: 429,
    ok: false,
    cooldownUntil: Date.now() + 60_000,
  })

  const auth = await Auth.get("openai")
  expect(auth).toMatchObject({
    type: "oauth",
    access: "a2",
    accountId: "acct-2",
  })

  const next = await Auth.OAuthPool.getUsage("openai")
  expect(next.find((item) => item.email === "two@example.com")?.isActive).toBe(true)
  expect(next.find((item) => item.email === "one@example.com")?.health.cooldownUntil).toBeGreaterThan(Date.now())
})

test("oauth pool rotates failed active account even without cooldown", async () => {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r1",
    access: "a1",
    expires: Date.now() + 60_000,
    accountId: "acct-1",
  })
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r2",
    access: "a2",
    expires: Date.now() + 60_000,
    accountId: "acct-2",
  })

  const records = await Auth.OAuthPool.getUsage("openai")
  const active = records.find((item) => item.isActive)
  expect(active).toBeDefined()
  await Auth.OAuthPool.setActive("openai", "default", active!.id)
  await Auth.OAuthPool.recordOutcome({
    providerID: "openai",
    recordID: active!.id,
    statusCode: 400,
    ok: false,
  })

  const next = await Auth.OAuthPool.getUsage("openai")
  expect(next.find((item) => item.id === active!.id)?.isActive).toBe(false)
  expect(next.some((item) => item.id !== active!.id && item.isActive)).toBe(true)
})

test("codex usage reads non-cooled-down openai account", async () => {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r1",
    access: "token-1",
    expires: Date.now() + 60_000,
    accountId: "acct-1",
  })
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r2",
    access: "token-2",
    expires: Date.now() + 60_000,
    accountId: "acct-2",
  })

  const records = await Auth.OAuthPool.getUsage("openai")
  const active = records.find((item) => item.isActive)
  await Auth.OAuthPool.recordOutcome({
    providerID: "openai",
    recordID: active!.id,
    statusCode: 429,
    ok: false,
    cooldownUntil: Date.now() + 60_000,
  })

  const calls: string[] = []
  globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push(headers.get("authorization") || "")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18_000 },
          },
          plan_type: "plus",
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  const usage = await Auth.OAuthPool.fetchCodexUsage()
  expect(calls).toEqual(["Bearer token-1"])
  expect(usage?.planType).toBe("plus")
})

test("codex usage refreshes expired openai account token", async () => {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r1",
    access: "expired-token",
    expires: Date.now() - 1,
    accountId: "acct-1",
    email: "one@example.com",
  })

  const calls: string[] = []
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: "r1-next",
            access_token: "fresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }
    const headers = new Headers(init?.headers)
    calls.push(headers.get("authorization") || "")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18_000 },
          },
          plan_type: "team",
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  const usage = await Auth.OAuthPool.fetchCodexUsage()
  expect(calls).toEqual(["Bearer fresh-token"])
  expect(usage?.planType).toBe("team")

  const auth = await Auth.get("openai")
  expect(auth).toMatchObject({
    type: "oauth",
    access: "fresh-token",
  })
})

test("codex usage refreshes openai token after 401", async () => {
  await Auth.set("openai", {
    type: "oauth",
    refresh: "r1",
    access: "stale-token",
    expires: Date.now() + 60_000,
    accountId: "acct-1",
  })

  const calls: string[] = []
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: "r1-next",
            access_token: "retry-token",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }
    const headers = new Headers(init?.headers)
    calls.push(headers.get("authorization") || "")
    if (calls.length === 1) return Promise.resolve(new Response("", { status: 401 }))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          rate_limit: {
            secondary_window: { used_percent: 22, reset_at: Math.floor(Date.now() / 1000) + 7200, limit_window_seconds: 604_800 },
          },
          plan_type: "plus",
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  const usage = await Auth.OAuthPool.fetchCodexUsage()
  expect(calls).toEqual(["Bearer stale-token", "Bearer retry-token"])
  expect(usage?.planType).toBe("plus")

  const auth = await Auth.get("openai")
  expect(auth).toMatchObject({
    type: "oauth",
    access: "retry-token",
  })
})
