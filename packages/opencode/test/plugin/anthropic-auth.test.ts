import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { AnthropicAuthPlugin } from "../../src/plugin/anthropic"
import type { PluginInput } from "@opencode-ai/plugin"

const calls: Array<{ url: string; init?: RequestInit }> = []
const orig = globalThis.fetch
const sleep = Bun.sleep

const input = {
  client: {} as never,
  project: {} as never,
  worktree: "/tmp",
  directory: "/tmp",
  serverUrl: new URL("http://localhost"),
  $: Bun.$,
} satisfies PluginInput

beforeEach(() => {
  calls.length = 0
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push({ url, init })
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = orig
  Bun.sleep = sleep
})

test("anthropic oauth exchanges via platform token host with Claude CLI headers", async () => {
  const plugin = await AnthropicAuthPlugin(input)

  const auth = plugin.auth!
  const method = auth.methods[0]
  if (method.type !== "oauth") throw new Error("expected oauth method")

  const login = await method.authorize()
  if (login.method !== "code") throw new Error("expected code method")

  const result = await login.callback(
    "abc#wrapped-state-from-callback",
    "wrapped-state-from-callback",
  )

  expect(result.type).toBe("success")
  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe("https://platform.claude.com/v1/oauth/token")

  const headers = new Headers(calls[0].init?.headers)
  expect(headers.get("accept")).toBe("application/json")
  expect(headers.get("content-type")).toBe("application/json")
  expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
  expect(headers.get("user-agent")).toBe("claude-cli/2.1.80 (external, cli)")

  const body = JSON.parse(String(calls[0].init?.body))
  expect(body.code).toBe("abc")
  expect(body.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback")
  expect(body.state).toBe("wrapped-state-from-callback")
  expect(body.code_verifier).toBeTruthy()
  expect(body.code_verifier).not.toBe("wrapped-state-from-callback")
})

test("anthropic oauth retries 429 without retry-after", async () => {
  let n = 0
  const waits: number[] = []
  Bun.sleep = ((ms: number) => {
    waits.push(ms)
    return Promise.resolve()
  }) as typeof Bun.sleep
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push({ url, init })
    n++
    if (n < 3) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited." } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      )
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  try {
    const plugin = await AnthropicAuthPlugin(input)

    const auth = plugin.auth!
    const method = auth.methods[0]
    if (method.type !== "oauth") throw new Error("expected oauth method")
    const login = await method.authorize()
    if (login.method !== "code") throw new Error("expected code method")

    const progress: string[] = []
    const result = await login.callback("abc", undefined, (msg) => progress.push(msg))

    expect(result.type).toBe("success")
    expect(calls.length).toBe(3)
    expect(waits).toEqual([2000, 5000])
    expect(progress).toEqual([
      "Anthropic rate limited, retrying in 2s...",
      "Anthropic rate limited, retrying in 5s...",
    ])
  } finally {
    Bun.sleep = sleep
  }
})
