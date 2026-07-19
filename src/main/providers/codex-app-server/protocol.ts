// This is the deliberately small, stable subset SnipChat consumes. Run
// `npm run sidecar:fetch` to regenerate the complete pinned schema in
// resources/codex-schema directly from codex 0.144.4.
export interface JsonRpcRequest {
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  method: string
  params?: any
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface ModelListResponse {
  data: Array<{
    id: string
    model?: string
    displayName: string
    hidden?: boolean
    defaultReasoningEffort?: string
    supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
    inputModalities?: string[]
    isDefault?: boolean
  }>
  nextCursor?: string | null
}

export interface AccountReadResponse {
  account: null | {
    type: 'chatgpt' | 'apiKey'
    email?: string | null
    planType?: string | null
  }
  requiresOpenaiAuth: boolean
}

export interface ThreadStartResponse {
  thread: { id: string }
}

export interface TurnStartResponse {
  turn: { id: string; status: string; error?: { message?: string } | null }
}
