import { DONE_FRAME } from '../sse'
import type { Frame, NormalizedRequest, StopReason, Usage } from '../types'
import type { ModelInfo, ProtocolAdapter, StreamInit, ToolSpec } from './types'
import { asRecord, contentToText, readMessages } from './types'

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function errorTypeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'server_error'
  return 'invalid_request_error'
}

function chunkBase(init: StreamInit) {
  return {
    id: init.id,
    object: 'chat.completion.chunk',
    created: init.createdAt,
    model: init.model,
    system_fingerprint: 'fp_fake_llm',
  }
}

export const openaiAdapter: ProtocolAdapter = {
  protocol: 'openai',
  authHeader: 'authorization',

  parse(body: unknown): NormalizedRequest {
    const rec = asRecord(body)
    if (!rec) throw new Error('请求体必须是 JSON 对象')
    const messages = readMessages(rec.messages)
    const streamOptions = asRecord(rec.stream_options)
    const model = typeof rec.model === 'string' ? rec.model : ''
    return {
      protocol: 'openai',
      model,
      stream: rec.stream === true,
      messages,
      promptText: messages.map((m) => `${m.role}: ${contentToText(m.content)}`).join('\n'),
      ...(num(rec.max_completion_tokens ?? rec.max_tokens) !== undefined
        ? { maxTokens: num(rec.max_completion_tokens ?? rec.max_tokens) }
        : {}),
      ...(num(rec.temperature) !== undefined ? { temperature: num(rec.temperature) } : {}),
      hasTools: Array.isArray(rec.tools) && rec.tools.length > 0,
      streamIncludeUsage: streamOptions?.include_usage === true,
      raw: body,
    }
  },

  streamStart(init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }],
        }),
      },
    ]
  },

  streamToolStart(init: StreamInit, tool: ToolSpec, callId: string): Frame[] {
    return [
      {
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: '' } }],
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        }),
      },
    ]
  },

  streamToolDelta(fragment: string, init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
              logprobs: null,
              finish_reason: null,
            },
          ],
        }),
      },
    ]
  },

  streamDelta(text: string, init: StreamInit): Frame[] {
    return [
      {
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }],
        }),
      },
    ]
  },

  streamEnd(reason: StopReason, usage: Usage, init: StreamInit): Frame[] {
    const frames: Frame[] = [
      {
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [
            {
              index: 0,
              delta: {},
              logprobs: null,
              finish_reason: reason === 'length' ? 'length' : reason === 'tool_calls' ? 'tool_calls' : reason === 'content_filter' ? 'content_filter' : 'stop',
            },
          ],
        }),
      },
    ]
    if (init.includeUsage) {
      frames.push({
        kind: 'event',
        data: JSON.stringify({
          ...chunkBase(init),
          choices: [],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }),
      })
    }
    frames.push(DONE_FRAME)
    return frames
  },

  streamHeartbeat(style) {
    if (style === 'off') return null
    if (style === 'comment') return { kind: 'comment', text: 'ping' }
    // 空 delta：更像真实上游，但会考验客户端拼接逻辑
    return { kind: 'event', data: JSON.stringify({ choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: null }] }) }
  },

  streamError(message: string, kind?: string): Frame[] {
    return [
      {
        kind: 'event',
        data: JSON.stringify({
          error: { message, type: kind ?? 'server_error', param: null, code: null },
        }),
      },
      DONE_FRAME,
    ]
  },

  complete(text: string, reason: StopReason, usage: Usage, init: StreamInit) {
    return {
      id: init.id,
      object: 'chat.completion',
      created: init.createdAt,
      model: init.model,
      system_fingerprint: 'fp_fake_llm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          logprobs: null,
          finish_reason:
            reason === 'length' ? 'length' : reason === 'tool_calls' ? 'tool_calls' : reason === 'content_filter' ? 'content_filter' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    }
  },

  completeTool(tool: ToolSpec, callId: string, usage: Usage, init: StreamInit) {
    const anyArgs = tool.arguments
    return {
      id: init.id,
      object: 'chat.completion',
      created: init.createdAt,
      model: init.model,
      system_fingerprint: 'fp_fake_llm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: callId, type: 'function', function: { name: tool.name, arguments: anyArgs } }],
          },
          logprobs: null,
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    }
  },

  errorBody(status: number, message: string, kind?: string) {
    return { error: { message, type: kind ?? errorTypeForStatus(status), param: null, code: null } }
  },

  modelsPayload(models: ModelInfo[]) {
    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: m.created,
        owned_by: 'fake-llm-provider',
      })),
    }
  },

  modelPayload(model: ModelInfo) {
    return { id: model.id, object: 'model', created: model.created, owned_by: 'fake-llm-provider' }
  },

  countTokensPayload(promptTokens: number) {
    return { prompt_tokens: promptTokens, total_tokens: promptTokens }
  },
}
