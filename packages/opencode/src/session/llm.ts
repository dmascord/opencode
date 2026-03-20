import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type {
  LanguageModelV2CallWarning,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolChoice,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  const PROMPT_TOOL_CALL_OPEN = "<tool_call>"
  const PROMPT_TOOL_CALL_CLOSE = "</tool_call>"

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    let tools = await resolveTools(input)
    let toolChoice = input.toolChoice

    if (disablesToolsForModel(input.model)) {
      if (Object.keys(tools).length > 0 || toolChoice) {
        l.warn("disabling tools for unsupported model", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          apiModelID: input.model.api.id,
          toolCount: Object.keys(tools).length,
        })
      }
      tools = {}
      toolChoice = undefined
    }

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const runtimeToolLimit = input.model.runtime.maxActiveTools
    if (runtimeToolLimit) {
      const invalidEntry = Object.entries(tools).find(([name]) => name === "invalid")
      const activeEntries = Object.entries(tools).filter(([name]) => name !== "invalid")
      const referencedTools = referencedToolNames(input.messages)
      const requiredTools = requiredToolNames(input.toolChoice)
      const toolPriority = new Map((input.model.runtime.toolPriority ?? []).map((name, index) => [name, index]))

      if (activeEntries.length > runtimeToolLimit) {
        const ranked = activeEntries
          .map(([name, value], index) => ({
            name,
            value,
            index,
            referenced: referencedTools.has(name),
            required: requiredTools.has(name),
            corePriority: toolPriority.get(name) ?? Number.POSITIVE_INFINITY,
          }))
          .sort((a, b) => {
            if (a.required !== b.required) return a.required ? -1 : 1
            if (a.referenced !== b.referenced) return a.referenced ? -1 : 1
            if (a.corePriority !== b.corePriority) return a.corePriority - b.corePriority
            return a.index - b.index
          })
        const kept = ranked
          .slice(0, runtimeToolLimit)
          .sort((a, b) => a.index - b.index)
        const dropped = ranked.slice(runtimeToolLimit).map((item) => item.name)
        tools = Object.fromEntries(kept.map((item) => [item.name, item.value]))
        if (invalidEntry) tools.invalid = invalidEntry[1]
        l.warn("capping active tools to model runtime limit", {
          limit: runtimeToolLimit,
          kept: kept.length,
          dropped: activeEntries.length - kept.length,
          requiredKept: kept.filter((item) => item.required).map((item) => item.name),
          referencedKept: kept.filter((item) => item.referenced).map((item) => item.name),
          droppedTools: dropped.slice(0, 10),
          toolPriority: input.model.runtime.toolPriority,
        })
      }
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              // @ts-expect-error
              args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              if (usesPromptToolCalling(input.model, args.params)) {
                l.info("activating prompt-based tool fallback", {
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                  apiModelID: input.model.api.id,
                  toolCount: Array.isArray(args.params.tools) ? args.params.tools.length : 0,
                })
                args.params = transformParamsForPromptToolCalling(args.params)
              }
              return args.params
            },
            async wrapGenerate({ doGenerate, params }) {
              const result = await doGenerate()
              if (!getPromptToolCallingState(params)) return result
              l.info("rewriting prompt-based tool response", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                mode: "generate",
              })
              return rewriteGenerateResultForPromptToolCalling(result, params)
            },
            async wrapStream({ doGenerate, doStream, params }) {
              if (!getPromptToolCallingState(params)) return doStream()
              l.info("rewriting prompt-based tool response", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                mode: "stream",
              })

              const result = await doStream()
              return {
                request: result.request,
                response: result.response,
                stream: new ReadableStream<LanguageModelV2StreamPart>({
                  async start(controller) {
                    const orderedParts: Array<{ type: "text" | "reasoning"; id: string; text: string }> = []
                    const warnings: LanguageModelV2CallWarning[] = []
                    let finishReason: LanguageModelV2FinishReason = "unknown"
                    let usage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
                    let providerMetadata: SharedV2ProviderMetadata | undefined

                    for await (const part of result.stream as any) {
                      if (part.type === "stream-start") {
                        warnings.push(...part.warnings)
                        continue
                      }
                      if (part.type === "text-start") {
                        orderedParts.push({ type: "text", id: part.id, text: "" })
                        continue
                      }
                      if (part.type === "text-delta") {
                        let match = orderedParts.find((item) => item.type === "text" && item.id === part.id)
                        if (!match) {
                          match = { type: "text", id: part.id, text: "" }
                          orderedParts.push(match)
                        }
                        match.text += part.delta
                        continue
                      }
                      if (part.type === "reasoning-start") {
                        orderedParts.push({ type: "reasoning", id: part.id, text: "" })
                        continue
                      }
                      if (part.type === "reasoning-delta") {
                        let match = orderedParts.find((item) => item.type === "reasoning" && item.id === part.id)
                        if (!match) {
                          match = { type: "reasoning", id: part.id, text: "" }
                          orderedParts.push(match)
                        }
                        match.text += part.delta
                        continue
                      }
                      if (part.type === "finish") {
                        finishReason = part.finishReason
                        usage = part.usage
                        providerMetadata = part.providerMetadata as SharedV2ProviderMetadata | undefined
                      }
                    }

                    const rewritten = rewriteGenerateResultForPromptToolCalling(
                      {
                        content: orderedParts.map((part) =>
                          part.type === "text" ? { type: "text", text: part.text } : { type: "reasoning", text: part.text },
                        ),
                        finishReason,
                        usage,
                        warnings,
                        providerMetadata,
                      },
                      params,
                    )

                    controller.enqueue({
                      type: "stream-start",
                      warnings: rewritten.warnings,
                    })

                    for (const part of rewritten.content) {
                      if (part.type === "text") {
                        const id = `text-${crypto.randomUUID()}`
                        controller.enqueue({ type: "text-start", id })
                        controller.enqueue({ type: "text-delta", id, delta: part.text })
                        controller.enqueue({ type: "text-end", id })
                        continue
                      }

                      if (part.type === "reasoning") {
                        const id = `reasoning-${crypto.randomUUID()}`
                        controller.enqueue({ type: "reasoning-start", id })
                        controller.enqueue({ type: "reasoning-delta", id, delta: part.text })
                        controller.enqueue({ type: "reasoning-end", id })
                        continue
                      }

                      if (part.type === "tool-call") {
                        const rawInput = JSON.stringify(part.input)
                        controller.enqueue({
                          type: "tool-input-start",
                          id: part.toolCallId,
                          toolName: part.toolName,
                          providerExecuted: false,
                        })
                        controller.enqueue({
                          type: "tool-input-delta",
                          id: part.toolCallId,
                          delta: rawInput,
                        })
                        controller.enqueue({ type: "tool-input-end", id: part.toolCallId })
                        controller.enqueue(part)
                      }
                    }

                    controller.enqueue({
                      type: "finish",
                      finishReason: rewritten.finishReason,
                      usage: rewritten.usage,
                      providerMetadata: rewritten.providerMetadata,
                    })
                    controller.close()
                  },
                }),
              }
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  function disablesToolsForModel(model: Provider.Model) {
    return model.runtime.disableLocalTools === true || model.capabilities.toolcall === false
  }

  function usesPromptToolCalling(model: Provider.Model, params: Pick<LanguageModelV2CallOptions, "tools">) {
    return disablesToolsForModel(model) && Array.isArray(params.tools) && params.tools.some((tool) => tool.type === "function")
  }

  function transformParamsForPromptToolCalling(params: LanguageModelV2CallOptions): LanguageModelV2CallOptions {
    const functionTools = (params.tools ?? []).filter(
      (tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
    )
    if (functionTools.length === 0) return params

    const prompt = rewritePromptForPromptToolCalling(params.prompt, functionTools, params.toolChoice)
    return {
      ...params,
      prompt,
      tools: undefined,
      toolChoice: undefined,
      providerOptions: {
        ...params.providerOptions,
        opencode: {
          ...(params.providerOptions?.opencode ?? {}),
          promptToolCalling: JSON.stringify({
            tools: functionTools.map((tool) => ({
              type: tool.type,
              name: tool.name,
              description: tool.description ?? null,
              inputSchema: tool.inputSchema,
            })),
            toolChoice: params.toolChoice ?? null,
          }),
        },
      },
    }
  }

  function getPromptToolCallingState(params: Pick<LanguageModelV2CallOptions, "providerOptions">) {
    const value = params.providerOptions?.opencode?.promptToolCalling
    if (typeof value !== "string") return undefined
    let parsed: { tools?: unknown }
    try {
      parsed = JSON.parse(value) as { tools?: unknown }
    } catch {
      return undefined
    }
    const tools = parsed.tools
    if (!Array.isArray(tools)) return undefined
    return {
      tools: tools.filter(
        (tool): tool is LanguageModelV2FunctionTool =>
          !!tool &&
          typeof tool === "object" &&
          (tool as { type?: unknown }).type === "function" &&
          typeof (tool as { name?: unknown }).name === "string",
      ),
    }
  }

  function rewritePromptForPromptToolCalling(
    prompt: LanguageModelV2Prompt,
    tools: LanguageModelV2FunctionTool[],
    toolChoice?: LanguageModelV2ToolChoice,
  ): LanguageModelV2Prompt {
    const instruction = buildPromptToolCallingInstruction(tools, toolChoice)
    const result: LanguageModelV2Prompt = []
    let injected = false

    for (const message of prompt) {
      if (message.role === "system") {
        result.push({
          ...message,
          content: injected ? message.content : `${message.content}\n\n${instruction}`,
        })
        injected = true
        continue
      }

      if (message.role === "assistant") {
        const content = assistantContentToText(message.content)
        if (content) {
          result.push({
            ...message,
            content: [{ type: "text", text: content }],
          })
        }
        continue
      }

      if (message.role === "tool") {
        const content = toolResultsToText(message.content)
        if (content) {
          result.push({
            role: "user",
            content: [{ type: "text", text: content }],
          })
        }
        continue
      }

      result.push(message)
    }

    if (!injected) {
      result.unshift({
        role: "system",
        content: instruction,
      })
    }

    return result
  }

  function buildPromptToolCallingInstruction(
    tools: LanguageModelV2FunctionTool[],
    toolChoice?: LanguageModelV2ToolChoice,
  ) {
    const toolList = tools
      .map((tool) => {
        const schema = JSON.stringify(tool.inputSchema)
        return `- ${tool.name}: ${tool.description ?? "No description"}\n  schema: ${schema}`
      })
      .join("\n")

    const choiceInstruction = (() => {
      if (!toolChoice || toolChoice.type === "auto") return "Use a tool only when needed."
      if (toolChoice.type === "required") return "You must emit a tool call before giving a final answer."
      if (toolChoice.type === "tool") return `You must call the tool named ${toolChoice.toolName}.`
      return "Do not call any tool unless the conversation explicitly requires it."
    })()

    return [
      "Native function calling is unavailable for this model. Use text-based tool calling instead.",
      choiceInstruction,
      `When you need a tool, reply with exactly one block in this format and nothing else: ${PROMPT_TOOL_CALL_OPEN}{\"name\":\"tool_name\",\"arguments\":{}}${PROMPT_TOOL_CALL_CLOSE}`,
      "Rules:",
      "- Do not use markdown fences around the tool block.",
      "- The JSON must be valid.",
      "- The arguments value must be a JSON object.",
      "- After tool results are returned, continue the task or emit another tool block.",
      "Available tools:",
      toolList,
    ].join("\n")
  }

  function assistantContentToText(content: Array<any>) {
    const chunks: string[] = []
    for (const part of content) {
      if (part.type === "text" || part.type === "reasoning") {
        if (part.text) chunks.push(part.text)
        continue
      }
      if (part.type === "tool-call") {
        chunks.push(`${PROMPT_TOOL_CALL_OPEN}${JSON.stringify({ name: part.toolName, arguments: part.input })}${PROMPT_TOOL_CALL_CLOSE}`)
      }
    }
    return chunks.join("\n").trim()
  }

  function toolResultsToText(content: Array<any>) {
    const chunks = content.map((part) => {
      return `Tool result for ${part.toolName} (call_id=${part.toolCallId}):\n${serializeToolResultOutput(part.output)}`
    })
    return chunks.join("\n\n").trim()
  }

  function serializeToolResultOutput(output: LanguageModelV2ToolResultOutput) {
    switch (output.type) {
      case "text":
      case "error-text":
        return output.value
      case "json":
      case "error-json":
        return JSON.stringify(output.value)
      case "content":
        return JSON.stringify(output.value)
    }
  }

  function rewriteGenerateResultForPromptToolCalling(
    result: {
      content: LanguageModelV2Content[]
      finishReason: LanguageModelV2FinishReason
      usage: LanguageModelV2Usage
      warnings: LanguageModelV2CallWarning[]
      providerMetadata?: SharedV2ProviderMetadata
      request?: { body?: unknown }
      response?: any
    },
    params: LanguageModelV2CallOptions,
  ) {
    const functionTools = getPromptToolCallingState(params)?.tools ?? []
    const rewrittenContent = rewriteContentForPromptToolCalling(result.content, functionTools)
    return {
      ...result,
      content: rewrittenContent,
      finishReason: rewrittenContent.some((part) => part.type === "tool-call") ? ("tool-calls" as LanguageModelV2FinishReason) : result.finishReason,
    }
  }

  function rewriteContentForPromptToolCalling(
    content: LanguageModelV2Content[],
    tools: LanguageModelV2FunctionTool[],
  ): LanguageModelV2Content[] {
    const toolNames = new Set(tools.map((tool) => tool.name))
    const rewritten: LanguageModelV2Content[] = []
    let toolIndex = 0

    for (const part of content) {
      if (part.type !== "text") {
        rewritten.push(part)
        continue
      }

      for (const parsed of parsePromptToolCalls(part.text)) {
        if (parsed.type === "text") {
          if (parsed.text) rewritten.push({ type: "text", text: parsed.text })
          continue
        }

        if (!toolNames.has(parsed.toolName)) {
          rewritten.push({
            type: "text",
            text: `${PROMPT_TOOL_CALL_OPEN}${parsed.raw}${PROMPT_TOOL_CALL_CLOSE}`,
          })
          continue
        }

        rewritten.push({
          type: "tool-call",
          toolCallId: `prompt-tool-${++toolIndex}`,
          toolName: parsed.toolName,
          input: JSON.stringify(parsed.input),
          providerExecuted: false,
        } as LanguageModelV2Content)
      }
    }

    return rewritten
  }

  function parsePromptToolCalls(text: string) {
    const result: Array<{ type: "text"; text: string } | { type: "tool-call"; toolName: string; input: Record<string, unknown>; raw: string }> = []
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
    let lastIndex = 0

    for (const match of text.matchAll(regex)) {
      const [full, rawJson] = match
      const start = match.index ?? 0

      if (start > lastIndex) {
        result.push({ type: "text", text: text.slice(lastIndex, start) })
      }

      const parsed = parsePromptToolCallJson(rawJson)
      if (parsed) {
        result.push({
          type: "tool-call",
          toolName: parsed.toolName,
          input: parsed.input,
          raw: rawJson,
        })
      } else {
        result.push({ type: "text", text: full })
      }

      lastIndex = start + full.length
    }

    if (lastIndex < text.length) {
      result.push({ type: "text", text: text.slice(lastIndex) })
    }

    return result
  }

  function parsePromptToolCallJson(rawJson: string) {
    try {
      const parsed = JSON.parse(rawJson) as { name?: unknown; arguments?: unknown }
      if (typeof parsed.name !== "string") return undefined
      if (!parsed.arguments || typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments)) return undefined
      return {
        toolName: parsed.name,
        input: parsed.arguments as Record<string, unknown>,
      }
    } catch {
      return undefined
    }
  }

  function referencedToolNames(messages: ModelMessage[]) {
    const result = new Set<string>()
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if ((part.type === "tool-call" || part.type === "tool-result") && typeof part.toolName === "string") {
          result.add(part.toolName)
        }
      }
    }
    return result
  }

  function requiredToolNames(toolChoice: StreamInput["toolChoice"]) {
    const result = new Set<string>()
    const maybeToolChoice = toolChoice as unknown
    if (
      maybeToolChoice &&
      typeof maybeToolChoice === "object" &&
      "toolName" in maybeToolChoice &&
      typeof maybeToolChoice.toolName === "string"
    ) {
      result.add(maybeToolChoice.toolName)
    }
    return result
  }
}
