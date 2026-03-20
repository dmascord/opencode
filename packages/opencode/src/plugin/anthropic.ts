import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { generatePKCE } from "@openauthjs/openauth/pkce"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { Log } from "@/util/log"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const USER_AGENT = "claude-cli/2.1.80 (external, cli)"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CALLBACK_URL = "https://platform.claude.com/oauth/code/callback"
const RETRY_MAX_MS = 15_000
const RETRY_MAX_ATTEMPTS = 2
const RETRY_FALLBACK_MS = [2_000, 5_000]
const log = Log.create({ service: "plugin.anthropic" })

function retryafter(response: Response) {
  const value = response.headers.get("retry-after") ?? response.headers.get("Retry-After")
  if (!value) return

  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000

  const date = Date.parse(value)
  if (Number.isNaN(date)) return
  return Math.max(0, date - Date.now())
}

async function token(body: Record<string, string>, progress?: (message: string) => void) {
  let last = ""

  for (let i = 0; i <= RETRY_MAX_ATTEMPTS; i++) {
    const attempt = i + 1
    log.info("anthropic oauth token exchange", {
      attempt,
      grant_type: body.grant_type,
      redirect_uri: body.redirect_uri,
    })
    const result = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    })

    if (result.ok) return { ok: true as const, result }

    const text = await result.text().catch(() => "")
    last = text
    const retry = retryafter(result)
    log.warn("anthropic oauth token exchange failed", {
      attempt,
      status: result.status,
      retry_after: retry,
      error: text,
    })

    if (result.status !== 429) return { ok: false as const, result, text }

    const wait = retry ?? RETRY_FALLBACK_MS[i]
    if (wait === undefined || wait > RETRY_MAX_MS || i === RETRY_MAX_ATTEMPTS) {
      if (wait !== undefined && wait > RETRY_MAX_MS) {
        progress?.(`Anthropic rate limited; retry-after ${Math.ceil(wait / 1000)}s exceeds auto-retry window.`)
      }
      return {
        ok: false as const,
        result,
        text: text || `Token exchange failed: ${result.status}`,
      }
    }

    progress?.(`Anthropic rate limited, retrying in ${Math.ceil(wait / 1000)}s...`)
    log.info("anthropic oauth token exchange retrying", {
      attempt,
      wait,
      source: retry === undefined ? "fallback" : "retry-after",
    })
    await Bun.sleep(wait)
  }

  return {
    ok: false as const,
    result: undefined,
    text: last || "Token exchange failed",
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (input.model?.providerID !== "anthropic") return
      output.system.unshift(prefix)
      if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1]
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}
        if (provider.key) return {}

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(inputValue: RequestInfo | URL, init?: RequestInit) {
            const auth = await getAuth()
            if (auth.type !== "oauth") return fetch(inputValue, init)

            if (!auth.access || auth.expires < Date.now()) {
              const response = await fetch(TOKEN_URL, {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "anthropic-beta": "oauth-2025-04-20",
                  "user-agent": USER_AGENT,
                },
                body: JSON.stringify({
                  grant_type: "refresh_token",
                  refresh_token: auth.refresh,
                  client_id: CLIENT_ID,
                }),
              })

              if (!response.ok) {
                throw new Error(`Token refresh failed: ${response.status}`)
              }

              const json = await response.json()
              await input.client.auth.set({
                path: { id: "anthropic" },
                body: {
                  type: "oauth",
                  refresh: json.refresh_token,
                  access: json.access_token,
                  expires: Date.now() + json.expires_in * 1000,
                },
              })

              auth.access = json.access_token
              auth.expires = Date.now() + json.expires_in * 1000
            }

            const requestInit = init ?? {}
            const headers = new Headers()
            if (inputValue instanceof Request) {
              inputValue.headers.forEach((value, key) => {
                headers.set(key, value)
              })
            }

            if (requestInit.headers instanceof Headers) {
              requestInit.headers.forEach((value, key) => {
                headers.set(key, value)
              })
            }

            if (Array.isArray(requestInit.headers)) {
              for (const [key, value] of requestInit.headers) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }

            if (requestInit.headers && !(requestInit.headers instanceof Headers) && !Array.isArray(requestInit.headers)) {
              for (const [key, value] of Object.entries(requestInit.headers)) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }

            const incomingBeta = headers.get("anthropic-beta") || ""
            const requiredBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"]
            const mergedBetas = [...new Set([...requiredBetas, ...incomingBeta.split(",").map((x) => x.trim()).filter(Boolean)])].join(",")

            headers.set("authorization", `Bearer ${auth.access}`)
            headers.set("anthropic-beta", mergedBetas)
            headers.set("user-agent", USER_AGENT)
            headers.delete("x-api-key")

            let body = requestInit.body
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body)
                if (parsed.system && Array.isArray(parsed.system)) {
                  parsed.system = parsed.system.map((item: any) => {
                    if (item.type !== "text" || !item.text) return item
                    return {
                      ...item,
                      text: item.text.replace(/OpenCode/g, "Claude Code").replace(/opencode/gi, "Claude"),
                    }
                  })
                }
                body = JSON.stringify(parsed)
              } catch {}
            }

            let requestValue = inputValue
            let url: URL | undefined
            try {
              if (typeof inputValue === "string" || inputValue instanceof URL) url = new URL(inputValue.toString())
              if (inputValue instanceof Request) url = new URL(inputValue.url)
            } catch {}

            if (url && url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
              url.searchParams.set("beta", "true")
              requestValue = inputValue instanceof Request ? new Request(url.toString(), inputValue) : url
            }

            return fetch(requestValue, {
              ...requestInit,
              body,
              headers,
            })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()

            const url = new URL(AUTHORIZE_URL)
            url.searchParams.set("code", "true")
            url.searchParams.set("client_id", CLIENT_ID)
            url.searchParams.set("response_type", "code")
            url.searchParams.set("redirect_uri", CALLBACK_URL)
            url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
            url.searchParams.set("code_challenge", pkce.challenge)
            url.searchParams.set("code_challenge_method", "S256")
            url.searchParams.set("state", pkce.verifier)

            return {
              url: url.toString(),
              instructions: "Paste the authorization callback URL or code here:",
              method: "code" as const,
              callback: async (code: string, stateFromCallback?: string, progress?: (message: string) => void) => {
                const verifier = pkce.verifier

                const splits = code.split("#")
                const codeValue = splits[0]
                const stateValue = stateFromCallback || splits[1] || verifier

                const exchange = await token(
                  {
                    code: codeValue,
                    state: stateValue,
                    grant_type: "authorization_code",
                    client_id: CLIENT_ID,
                    redirect_uri: CALLBACK_URL,
                    code_verifier: verifier,
                  },
                  progress,
                )

                if (!exchange.ok) {
                  return {
                    type: "failed" as const,
                    error: exchange.text,
                  }
                }

                const json = await exchange.result.json()

                return {
                  type: "success" as const,
                  refresh: json.refresh_token,
                  access: json.access_token,
                  expires: Date.now() + json.expires_in * 1000,
                }
              },
            }
          },
        },
      ],
    },
  }
}
