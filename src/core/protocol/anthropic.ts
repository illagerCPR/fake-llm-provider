import type { Frame, NormalizedRequest, StopReason, Usage } from '../types'
import type { ModelInfo, ProtocolAdapter, StreamInit, ToolSpec } from './types'
import { asRecord, contentToText, readMessages } from './types'

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mapStopReason(reason: StopReason): string {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function mapErrorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function messageFor(init: StreamInit, usage: Usage) {
  return {
    id: init.id,
    type: 'message',
    role: 'assistant',
    model: init.model,
    content: [] as unknown[],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: usage.inputTokens, output_tokens: 0 },
  }
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: 'anthropic',
  authHeader: 'x-api-key',

  parse(body: unknown): NormalizedRequest {
    const rec = asRecord(body)
    if (!rec) throw new Error('请求体必须是 JSON 对象')
    const messages = readMessages(rec.messages)
    const systemText = contentToText(rec.system)
    const promptText = [
      ...(systemText ? [`system: ${systemText}`] : []),
      ...messages.map((m) => `${m.role}: ${contentToText(m.content)}`),
    ].join('\n')
    return {
      protocol: 'anthropic',
      model: typeof rec.model === 'string' ? rec.model : '',
      stream: rec.stream === true,
      messages,
      promptText,
      ...(num(rec.max_tokens) !== undefined ? { maxTokens: num(rec.max_tokens) } : {}),
      ...(num(rec.temperature) !== undefined ? { temperature: num(rec.temperature) } : {}),
      hasTools: Array.isArray(rec.tools) && rec.tools.length > 0,
      streamIncludeUsage: true,
      raw: body,
    }
  },

  streamStart(init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: messageFor(init, { inputTokens: init.promptTokens, outputTokens: 0 }),
        }),
      },
      {
        kind: 'event',
        event: 'content_block_start',
        data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      },
    ]
  },

  streamToolStart(init: StreamInit, tool: ToolSpec, callId: string): Frame[] {
    return [
      {
        kind: 'event',
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: messageFor(init, { inputTokens: init.promptTokens, outputTokens: 0 }),
        }),
      },
      {
        kind: 'event',
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: callId, name: tool.name, input: {} },
        }),
      },
    ]
  },

  streamToolDelta(fragment: string, _init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: fragment },
        }),
      },
    ]
  },

  streamDelta(text: string, _init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        event: 'content_block_delta',
        data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      },
    ]
  },

  streamEnd(reason: StopReason, usage: Usage, _init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
      },
      {
        kind: 'event',
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: mapStopReason(reason), stop_sequence: null },
          usage: { output_tokens: usage.outputTokens },
        }),
      },
      { kind: 'event', event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ]
  },

  streamHeartbeat(style) {
    if (style === 'off') return null
    // Anthropic 的保活就是 ping 事件，两种 style 都用它
    return { kind: 'event', event: 'ping', data: JSON.stringify({ type: 'ping' }) }
  },

  streamError(message: string, kind?: string): Frame[] {
    return [
      {
        kind: 'event',
        event: 'error',
        data: JSON.stringify({ type: 'error', error: { type: kind ?? 'api_error', message } }),
      },
    ]
  },

  complete(text: string, reason: StopReason, usage: Usage, init: StreamInit) {
    return {
      id: init.id,
      type: 'message',
      role: 'assistant',
      model: init.model,
      content: [{ type: 'text', text }],
      stop_reason: mapStopReason(reason),
      stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    }
  },

  completeTool(tool: ToolSpec, callId: string, usage: Usage, init: StreamInit) {
    let input: unknown
    try {
      input = JSON.parse(tool.arguments)
    } catch {
      input = { _raw: tool.arguments }
    }
    return {
      id: init.id,
      type: 'message',
      role: 'assistant',
      model: init.model,
      content: [{ type: 'tool_use', id: callId, name: tool.name, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    }
  },

  errorBody(status: number, message: string, kind?: string) {
    return { type: 'error', error: { type: kind ?? mapErrorType(status), message } }
  },

  modelsPayload(models: ModelInfo[]) {
    const data = models.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.displayName,
      created_at: new Date(m.created * 1000).toISOString(),
    }))
    return {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    }
  },

  modelPayload(model: ModelInfo) {
    return {
      type: 'model',
      id: model.id,
      display_name: model.displayName,
      created_at: new Date(model.created * 1000).toISOString(),
    }
  },

  countTokensPayload(promptTokens: number) {
    return { input_tokens: promptTokens }
  },
}
