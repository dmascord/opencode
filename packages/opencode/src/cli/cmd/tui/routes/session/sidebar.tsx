import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, For, Show, Switch, Match, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { useSDK } from "../../context/sdk"
import { useLocal } from "../../context/local"
import { TodoItem } from "../../component/todo-item"

type ProviderQuota = {
  _error?: string
  anthropic?: {
    accounts: unknown[]
    anthropicUsage?: {
      fiveHour?: { utilization: number; resetsAt?: string }
      sevenDay?: { utilization: number; resetsAt?: string }
      sevenDaySonnet?: { utilization: number; resetsAt?: string }
    }
  }
  codex?: {
    accounts: Array<{ id: string; label?: string; isActive?: boolean }>
    codexUsage?: {
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
        email?: string
        rate_limit?: {
          primary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
          secondary_window?: { used_percent: number; reset_at: number; limit_window_seconds: number }
        }
        plan_type?: string
      }
      _error?: string
    }
  }
  minimax?: {
    accounts: unknown[]
    minimaxUsage?: {
      fiveHour?: { utilization: number; resetsAt?: string; remainingCredits: number; totalCredits: number }
      _error?: string
    }
  }
  openrouter?: {
    accounts: unknown[]
    openrouterUsage?: {
      isFree?: boolean
      usage?: number
      usageDaily?: number
      usageWeekly?: number
      usageMonthly?: number
      limit?: number | null
      limitRemaining?: number | null
    }
  }
  cohere?: {
    accounts: unknown[]
    cohereUsage?: unknown
  }
  google?: {
    accounts: unknown[]
    geminiUsage?: unknown
  }
  ["github-copilot"]?: {
    accounts: unknown[]
    githubCopilotUsage?: {
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
    }
  }
}

function getTrackedQuotaProvider(model?: { providerID: string; modelID: string }) {
  if (!model) return
  if (model.providerID === "anthropic") return "anthropic" as const
  if (model.providerID === "openai") return "codex" as const
  if (model.providerID.startsWith("minimax") || model.modelID.includes("minimax")) return "minimax" as const
  if (model.providerID === "openrouter") return "openrouter" as const
  if (model.providerID === "cohere") return "cohere" as const
  if (model.providerID === "google" || model.providerID === "google-vertex") return "gemini" as const
  if (model.providerID === "github-copilot" || model.providerID === "github-copilot-enterprise") return "github-copilot" as const
  return
}

function hasLiveQuotaProvider(provider?: ReturnType<typeof getTrackedQuotaProvider>) {
  return provider === "anthropic" || provider === "codex" || provider === "minimax" || provider === "openrouter" || provider === "github-copilot"
}

function formatResetTime(resetsAt?: string): string {
  if (!resetsAt) return ""
  const reset = new Date(resetsAt)
  const now = new Date()
  const diffMs = reset.getTime() - now.getTime()
  if (diffMs <= 0) return "due"
  const totalMinutes = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatCodexAccount(quota?: ProviderQuota | null) {
  const usage = quota?.codex?.codexUsage
  const active = quota?.codex?.accounts.find((item) => item.isActive)
  return usage?.account?.email ?? usage?.raw?.email ?? usage?.account?.label ?? active?.label ?? usage?.account?.id ?? active?.id
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()
  const sdk = useSDK()
  const local = useLocal()
  const selectedModel = createMemo(() => local.model.current())
  const selectedQuotaProvider = createMemo(() => getTrackedQuotaProvider(selectedModel()))
  
  // Provider quota state
  const [quota, setQuota] = createSignal<ProviderQuota | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal(false)
  let quotaRefreshInFlight = false

  const refreshQuota = async () => {
    if (!sdk) {
      setQuota({ _error: "SDK not available" })
      return
    }
    if (quotaRefreshInFlight) return

    quotaRefreshInFlight = true
    setQuotaLoading(true)

    try {
      const result = await sdk.client.auth.usage2({})
      if (result.data) {
        setQuota(result.data as ProviderQuota)
      } else if (result.error) {
        const errMsg = result.error instanceof Error ? result.error.message : String(result.error)
        // On rate limit (403/429), preserve previous quota data if available
        if ((errMsg.includes("403") || errMsg.includes("429")) && quota()) {
          // Just refresh the loading state, don't clear existing data
        } else {
          setQuota({ _error: errMsg })
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      // On rate limit, preserve previous quota data if available
      if ((errMsg.includes("403") || errMsg.includes("429")) && quota()) {
        // Just refresh the loading state, don't clear existing data
      } else {
        setQuota({ _error: errMsg })
      }
    } finally {
      quotaRefreshInFlight = false
      setQuotaLoading(false)
    }
  }

  let quotaIdleCycles = 0
  
  // Fetch quota on mount and periodically while idle.
  onMount(() => {
    void refreshQuota()

    let timeout: ReturnType<typeof setTimeout> | undefined

    const scheduleNext = () => {
      clearTimeout(timeout)
      const provider = selectedQuotaProvider()
      if (!hasLiveQuotaProvider(provider)) return

      const delay = quotaIdleCycles >= 3 ? 60_000 : 30_000
      timeout = setTimeout(async () => {
        quotaIdleCycles += 1
        await refreshQuota()
        scheduleNext()
      }, delay)
    }

    createEffect(() => {
      selectedQuotaProvider()
      quotaIdleCycles = 0
      scheduleNext()
    })

    onCleanup(() => clearTimeout(timeout))
  })
  
  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))
  const selectedQuotaLabel = createMemo(() => {
    const selected = selectedModel()
    if (!selected) return
    const provider = sync.data.provider.find((x) => x.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    return model?.name ?? `${selected.providerID}/${selected.modelID}`
  })

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            
            {/* Provider Quota Section */}
            <Show when={quota() && selectedQuotaProvider()}>
              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Provider Quota</b>
                  </text>
                  <Show when={quotaLoading()}>
                    <text fg={theme.textMuted}>◷</text>
                  </Show>
                </box>
                <Show when={selectedQuotaLabel()}>
                  <text fg={theme.textMuted}>{selectedQuotaLabel()}</text>
                </Show>

                <Show when={quota()!._error}>
                  <text fg={theme.error}>Error: {quota()!._error}</text>
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "codex" && quota()?.codex?.codexUsage}>
                  <Show when={formatCodexAccount(quota())}>
                    {(account) => <text fg={theme.textMuted}>Account: {account()}</text>}
                  </Show>
                  <Show when={quota()?.codex?.codexUsage?.planType}>
                    {(plan) => <text fg={theme.textMuted}>Plan: {plan()}</text>}
                  </Show>
                  <Show when={quota()?.codex?.codexUsage?.source}>
                    {(source) => <text fg={theme.textMuted}>Source: {source()}</text>}
                  </Show>
                  <text fg={theme.text}>Codex (5h): {quota()!.codex!.codexUsage!.fiveHour ? `${quota()!.codex!.codexUsage!.fiveHour!.utilization}% used` : "N/A"}</text>
                  <Show when={quota()?.codex?.codexUsage?.fiveHour?.resetsAt}>
                    <text fg={theme.textMuted}>Resets in: {formatResetTime(quota()!.codex!.codexUsage!.fiveHour!.resetsAt)}</text>
                  </Show>
                  <Show when={quota()?.codex?.codexUsage?.sevenDay}>
                    <text fg={theme.textMuted}>Codex (7d): {quota()!.codex!.codexUsage!.sevenDay!.utilization}% used</text>
                  </Show>
                  <Show when={quota()?.codex?.codexUsage?.sevenDay?.resetsAt}>
                    <text fg={theme.textMuted}>7d resets in: {formatResetTime(quota()!.codex!.codexUsage!.sevenDay!.resetsAt)}</text>
                  </Show>
                  <Show when={quota()?.codex?.codexUsage?._error}>
                    {(err) => <text fg={theme.warning}>{err()}</text>}
                  </Show>
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "anthropic" && quota()?.anthropic?.anthropicUsage}>
                  <text fg={theme.text}>Claude Pro/Max</text>
                  <Show when={quota()?.anthropic?.anthropicUsage?.fiveHour}>
                    <text fg={theme.text}>
                      Current session: {quota()!.anthropic!.anthropicUsage!.fiveHour!.utilization}% used ({Math.max(0, 100 - quota()!.anthropic!.anthropicUsage!.fiveHour!.utilization)}% remaining)
                    </text>
                  </Show>
                  <Show when={quota()?.anthropic?.anthropicUsage?.sevenDay}>
                    <text fg={theme.textMuted}>
                      Current week: {quota()!.anthropic!.anthropicUsage!.sevenDay!.utilization}% used ({Math.max(0, 100 - quota()!.anthropic!.anthropicUsage!.sevenDay!.utilization)}% remaining)
                    </text>
                  </Show>
                  <Show when={quota()?.anthropic?.anthropicUsage?.sevenDaySonnet}>
                    <text fg={theme.textMuted}>
                      Sonnet week: {quota()!.anthropic!.anthropicUsage!.sevenDaySonnet!.utilization}% used ({Math.max(0, 100 - quota()!.anthropic!.anthropicUsage!.sevenDaySonnet!.utilization)}% remaining)
                    </text>
                  </Show>
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "minimax" && quota()?.minimax?.minimaxUsage?.fiveHour}>
                  {(() => {
                    const m = quota()!.minimax!.minimaxUsage!.fiveHour!
                    const pctRemaining = 100 - m.utilization
                    const remaining = pctRemaining <= 10 ? "low" : pctRemaining <= 30 ? "medium" : "good"
                    return (
                      <>
                        <text fg={theme.text}>MiniMax (5h): {m.utilization}% used ({pctRemaining}% remaining)</text>
                        <text fg={theme.textMuted}>Resets in: {formatResetTime(m.resetsAt)}</text>
                      </>
                    )
                  })()}
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "openrouter" && quota()?.openrouter?.openrouterUsage}>
                  {(() => {
                    const o = quota()!.openrouter!.openrouterUsage!
                    return (
                      <>
                        <Show when={o.isFree}>
                          <text fg={theme.success}>OpenRouter: Free tier</text>
                        </Show>
                        <Show when={!o.isFree}>
                          <text fg={theme.text}>OpenRouter: {o.usage ?? 0} requests</text>
                        </Show>
                        <Show when={o.usageDaily !== undefined}>
                          <text fg={theme.textMuted}>Daily: {o.usageDaily}</text>
                        </Show>
                        <Show when={o.usageWeekly !== undefined}>
                          <text fg={theme.textMuted}>Weekly: {o.usageWeekly}</text>
                        </Show>
                        <Show when={o.limit !== null && o.limit !== undefined}>
                          <text fg={theme.textMuted}>Limit: {o.limit}</text>
                        </Show>
                      </>
                    )
                  })()}
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "cohere"}>
                  <text fg={theme.text}>Cohere</text>
                  <text fg={theme.textMuted}>Usage data not available via API</text>
                  <text fg={theme.textMuted}>Check Cohere dashboard for usage</text>
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "gemini"}>
                  <text fg={theme.text}>Google Gemini</text>
                  <text fg={theme.textMuted}>Usage data not available via API</text>
                  <text fg={theme.textMuted}>Check Google Cloud Console</text>
                </Show>

                <Show when={!quota()!._error && selectedQuotaProvider() === "github-copilot"}>
                  <text fg={theme.text}>GitHub Copilot</text>
                  {(() => {
                    const usage = quota()?.["github-copilot"]?.githubCopilotUsage
                    if (!usage) return <text fg={theme.textMuted}>Loading...</text>

                    return (
                      <>
                        <Show when={usage.orgBillingBreakdown}>
                          {(org) => (
                            <>
                              <text fg={theme.text}>Organization Plan</text>
                              <text fg={theme.textMuted}>{org().planType}</text>
                              <text fg={theme.textMuted}>
                                Seats: {org().activeSeats}/{org().totalSeats} active
                              </text>
                              <Show when={org().inactiveSeats > 0}>
                                <text fg={theme.textMuted}>{org().inactiveSeats} inactive</text>
                              </Show>
                            </>
                          )}
                        </Show>

                        <Show when={usage.hasAccess && !usage.orgBillingBreakdown}>
                          <text fg={theme.success}>✓ Copilot Seat Assigned</text>
                          <Show when={usage.assignedDate}>
                            {(date) => <text fg={theme.textMuted}>Assigned: {new Date(date()).toLocaleDateString()}</text>}
                          </Show>
                          <Show when={usage.lastActivityDate}>
                            {(date) => {
                              const last = new Date(date())
                              const now = new Date()
                              const daysSince = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
                              return (
                                <text fg={theme.textMuted}>
                                  Last active: {daysSince === 0 ? "today" : `${daysSince}d ago`}
                                </text>
                              )
                            }}
                          </Show>
                        </Show>

                        <Show when={!usage.hasAccess && !usage.orgBillingBreakdown && usage.organizations?.length}>
                          <text fg={theme.textMuted}>Member of {usage.organizations!.length} organization(s)</text>
                          <text fg={theme.textMuted}>No Copilot seat found</text>
                        </Show>

                        <Show when={usage.statusMessage}>
                          {(msg) => <text fg={theme.textMuted}>{msg()}</text>}
                        </Show>
                      </>
                    )
                  })()}
                </Show>

                <Show
                  when={
                    !quota()!._error &&
                    ((selectedQuotaProvider() === "codex" && !quota()?.codex?.codexUsage?.raw && !quota()?.codex?.codexUsage?._error) ||
                      (selectedQuotaProvider() === "anthropic" && !quota()?.anthropic?.anthropicUsage) ||
                      (selectedQuotaProvider() === "minimax" && !quota()?.minimax?.minimaxUsage?.fiveHour) ||
                      (selectedQuotaProvider() === "openrouter" && !quota()?.openrouter?.openrouterUsage) ||
                      (selectedQuotaProvider() === "cohere" && !quota()?.cohere?.cohereUsage) ||
                      (selectedQuotaProvider() === "gemini" && !quota()?.google?.geminiUsage) ||
                      (selectedQuotaProvider() === "github-copilot" && !quota()?.["github-copilot"]?.githubCopilotUsage))
                  }
                >
                  <text fg={theme.textMuted}>No live quota data for current model</text>
                </Show>

                <Show when={selectedQuotaProvider() === "minimax" && quota()?.minimax?.minimaxUsage?._error}>
                  <text fg={theme.warning}>{quota()?.minimax?.minimaxUsage?._error}</text>
                </Show>
              </box>
            </Show>

            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
