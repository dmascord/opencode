export const PROVIDER_RUNTIME_POLICY = {
  apim: {
    maxActiveTools: 128,
    toolPriority: [
      "task",
      "bash",
      "read",
      "glob",
      "grep",
      "apply_patch",
      "edit",
      "write",
      "webfetch",
      "todoread",
      "todowrite",
      "question",
      "skill",
      "websearch",
      "codesearch",
      "batch",
      "lsp",
      "planexit",
    ],
  },
  groq: {
    systemPrompt: "groq",
    maxActiveTools: 4,
    toolPriority: ["bash", "read", "glob", "grep"],
  },
} as const

export const MODEL_RUNTIME_POLICY = {
  "groq/compound": {
    disableLocalTools: true,
    maxActiveTools: undefined,
  },
  "groq/compound-mini": {
    disableLocalTools: true,
    maxActiveTools: undefined,
  },
  "groq/llama-3.1-8b-instant": {
    maxActiveTools: 1,
  },
} as const
