export interface ScriptStep {
  kind?: 'fixed' | 'manual' | 'instant' | 'slow' | 'fail' | 'truncate' | 'tool'
  text?: string
  tps?: number
  ttftMs?: number
  status?: number
  toolName?: string
  toolArgs?: string
  note?: string
}

export interface Settings {
  mode: 'fixed' | 'manual' | 'instant'
  text: string
  tps: number
  ttftMs: number
  unit: 'char' | 'token' | 'word'
  tokenizer: 'tiktoken' | 'heuristic'
  chunkTokens: number
  heartbeatMs: number
  heartbeatStyle: 'comment' | 'empty-delta' | 'off'
  manualTimeoutMs: number
  onManualTimeout: 'fallback' | 'abort' | 'hold'
  fallbackText: string
  simulateDuration: boolean
  defaultModel: string
  echoText: string
  toolName: string
  toolArgs: string
  script: ScriptStep[]
  apiKeys: string[]
  cors: string
  logLimit: number
  strict: boolean
}

export interface LintItem {
  level: 'ok' | 'warn' | 'fail'
  label: string
  detail?: string
}

export interface RequestRecord {
  key: string
  protocol: 'openai' | 'anthropic'
  path: string
  method: string
  model: string
  routedModel?: string
  stream: boolean
  headers: Record<string, string>
  body: unknown
  promptTokens: number
  startedAt: number
  finishedAt?: number
  status?: number
  error?: string
  lint: LintItem[]
}

export interface SessionSnapshot {
  key: string
  id: string
  protocol: 'openai' | 'anthropic'
  model: string
  kind: string
  stream: boolean
  state: 'waiting_human' | 'streaming' | 'finished' | 'aborted' | 'error'
  createdAt: number
  finishedAt?: number
  tps: number
  ttftMs: number
  promptTokens: number
  emittedTokens: number
  emittedChars: number
  chunks: number
  achievedTps: number
  finishReason?: string
  error?: string
  queueLength: number
  lint: LintItem[]
  request: RequestRecord
  emittedPreview: string
}

export interface ModelCard {
  id: string
  label: string
  description: string
  kind: string
}

export interface StatePayload {
  settings: Settings
  sessions: SessionSnapshot[]
  models: ModelCard[]
  version: string
  runtime: string
  scriptCounters: Record<string, number>
  bootedAt: number
  serverNow: number
}

const TOKEN_KEY = 'fake-llm-admin-token'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('x-admin-token', token)
  if (init.body) headers.set('content-type', 'application/json')
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { message?: string; error?: string }
      message = data.message ?? data.error ?? message
    } catch {
      // 保留默认消息
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export const api = {
  state: () => request<StatePayload>('/admin/api/state'),
  saveSettings: (patch: Partial<Settings>) =>
    request<{ ok: boolean; settings: Settings }>('/admin/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  say: (key: string, text: string) =>
    request<{ ok: boolean }>(`/admin/api/sessions/${key}/say`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  finish: (key: string) => request<{ ok: boolean }>(`/admin/api/sessions/${key}/finish`, { method: 'POST' }),
  resetScripts: () => request<{ ok: boolean }>('/admin/api/script/reset', { method: 'POST' }),
  abort: (key: string, reason: string) =>
    request<{ ok: boolean }>(`/admin/api/sessions/${key}/abort`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
}
