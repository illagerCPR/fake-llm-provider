import type { Frame, NormalizedRequest, Protocol, StopReason, Usage } from '../types'

export interface StreamInit {
  id: string
  model: string
  /** Unix 秒 */
  createdAt: number
  promptTokens: number
  /** OpenAI: stream_options.include_usage */
  includeUsage: boolean
}

export interface ModelInfo {
  id: string
  displayName: string
  /** Unix 秒 */
  created: number
}

export type HeartbeatStyle = 'comment' | 'empty-delta' | 'off'

export interface ProtocolAdapter {
  protocol: Protocol
  /** 客户端把 key 放在哪个头里 */
  authHeader: 'authorization' | 'x-api-key'
  /** 该协议对模型列表路由的判别方式（用于 /v1/models 双形状） */
  parse(body: unknown): NormalizedRequest
  streamStart(init: StreamInit): Frame[]
  streamDelta(text: string, init: StreamInit): Frame[]
  streamEnd(reason: StopReason, usage: Usage, init: StreamInit): Frame[]
  streamHeartbeat(style: HeartbeatStyle): Frame | null
  streamError(message: string, kind?: string): Frame[]
  complete(text: string, reason: StopReason, usage: Usage, init: StreamInit): unknown
  errorBody(status: number, message: string, kind?: string): unknown
  modelsPayload(models: ModelInfo[]): unknown
  modelPayload(model: ModelInfo): unknown
  countTokensPayload(promptTokens: number): unknown
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 把 OpenAI / Anthropic 各种形态的 content 压成纯文本，用于估算 prompt_tokens */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      const rec = asRecord(part)
      if (!rec) continue
      if (typeof rec.text === 'string') parts.push(rec.text)
      else if (typeof rec.content === 'string') parts.push(rec.content)
      else if (typeof rec.input === 'string') parts.push(rec.input)
    }
    return parts.join('\n')
  }
  return ''
}

export function readMessages(value: unknown): Array<{ role: string; content: unknown }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ role: string; content: unknown }> = []
  for (const item of value) {
    const rec = asRecord(item)
    if (!rec) continue
    out.push({
      role: typeof rec.role === 'string' ? rec.role : 'user',
      content: rec.content,
    })
  }
  return out
}
