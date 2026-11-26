import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/core/app'
import { MemoryHub } from '../../src/core/hub'
import { mergeSettings } from '../../src/core/settings'

interface SseEvent {
  event?: string
  data: string
}

function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const block of raw.split('\n\n')) {
    if (block.trim().length === 0) continue
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length > 0) out.push({ ...(event ? { event } : {}), data: data.join('\n') })
  }
  return out
}

function setup(overrides: Parameters<typeof mergeSettings>[0] = {}) {
  const settings = mergeSettings({ tps: 2000, ttftMs: 0, text: '你好世界', logLimit: 50, ...overrides })
  const hub = new MemoryHub(settings)
  const app = createApp({ hub, env: { version: 'test', runtime: 'node', allowAdminWithoutToken: true } })
  return { app, hub }
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: 'fake-fixed',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

const anthropicHeaders = { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' }

describe('假工具调用（OpenAI）', () => {
  it('非流式返回 tool_calls 与 finish_reason', async () => {
    const { app } = setup()
    const res = await app.request(
      '/v1/chat/completions',
      json(chatBody({ model: 'fake-tool', fake: { toolName: 'lookup_order', toolArgs: '{"id":"A-1"}' } })),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const call = body.choices[0].message.tool_calls[0]
    expect(call.type).toBe('function')
    expect(call.id).toMatch(/^call_fake_/)
    expect(call.function.name).toBe('lookup_order')
    expect(JSON.parse(call.function.arguments)).toEqual({ id: 'A-1' })
    expect(body.choices[0].message.content).toBeNull()
    expect(body.choices[0].finish_reason).toBe('tool_calls')
  })

  it('流式把参数分片吐出，最后 finish_reason=tool_calls', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-tool', stream: true })))
    const events = parseSse(await res.text())
    const deltas = events
      .filter((ev) => ev.data !== '[DONE]')
      .map((ev) => JSON.parse(ev.data) as any)
      .filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls)

    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas[0].choices[0].delta.tool_calls[0].function.name).toBe('get_weather')
    const args = deltas.map((chunk) => chunk.choices[0].delta.tool_calls[0].function.arguments ?? '').join('')
    expect(JSON.parse(args)).toEqual({ city: '上海', unit: 'celsius' })

    const finish = events
      .filter((ev) => ev.data !== '[DONE]')
      .map((ev) => JSON.parse(ev.data) as any)
      .find((chunk) => chunk.choices?.[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('tool_calls')
    expect(events.at(-1)?.data).toBe('[DONE]')
  })
})

describe('假工具调用（Anthropic）', () => {
  it('非流式返回 tool_use 块', async () => {
    const { app } = setup()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: 'fake-tool',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        fake: { toolName: 'search', toolArgs: '{"q":"天气"}' },
      }),
    })
    const body = (await res.json()) as any
    expect(body.content[0].type).toBe('tool_use')
    expect(body.content[0].name).toBe('search')
    expect(body.content[0].input).toEqual({ q: '天气' })
    expect(body.stop_reason).toBe('tool_use')
  })

  it('流式用 input_json_delta 分片', async () => {
    const { app } = setup()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: 'fake-tool',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const events = parseSse(await res.text())
    const start = events.find((ev) => ev.event === 'content_block_start')
    const startPayload = JSON.parse(start!.data) as any
    expect(startPayload.content_block.type).toBe('tool_use')
    expect(startPayload.content_block.name).toBe('get_weather')

    const partials = events
      .filter((ev) => ev.event === 'content_block_delta')
      .map((ev) => JSON.parse(ev.data) as any)
      .filter((payload) => payload.delta.type === 'input_json_delta')
      .map((payload) => payload.delta.partial_json)
      .join('')
    expect(JSON.parse(partials)).toEqual({ city: '上海', unit: 'celsius' })

    const messageDelta = events.find((ev) => ev.event === 'message_delta')
    expect((JSON.parse(messageDelta!.data) as any).delta.stop_reason).toBe('tool_use')
    expect(events.at(-1)?.event).toBe('message_stop')
  })
})

describe('剧本（按调用次数）', () => {
  it('默认剧本：第一次 429，第二次成功', async () => {
    const { app } = setup({ text: '第二次成功了' })
    const first = await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))
    expect(first.status).toBe(429)
    expect(((await first.json()) as any).error.type).toBe('rate_limit_error')

    const second = await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))
    expect(second.status).toBe(200)
    expect(((await second.json()) as any).choices[0].message.content).toBe('第二次成功了')
  })

  it('控制台配置的剧本按顺序执行，用完后停在最后一步', async () => {
    const { app } = setup({
      script: [
        { kind: 'fail', status: 503 },
        { kind: 'tool', toolName: 'lookup', toolArgs: '{"q":"x"}' },
      ],
    })
    expect((await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))).status).toBe(503)

    const second = (await (await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))).json()) as any
    expect(second.choices[0].message.tool_calls[0].function.name).toBe('lookup')

    const third = (await (await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))).json()) as any
    expect(third.choices[0].message.tool_calls[0].function.name).toBe('lookup')
  })

  it('请求体 fake.script 可以按次覆盖剧本', async () => {
    const { app } = setup()
    const body = chatBody({
      model: 'fake-script',
      fake: { script: [{ kind: 'instant', text: '脚本一' }, { kind: 'instant', text: '脚本二' }] },
    })
    const first = (await (await app.request('/v1/chat/completions', json(body))).json()) as any
    const second = (await (await app.request('/v1/chat/completions', json(body))).json()) as any
    expect(first.choices[0].message.content).toBe('脚本一')
    expect(second.choices[0].message.content).toBe('脚本二')
  })

  it('管理台能看到并重置剧本计数', async () => {
    const { app } = setup()
    await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-script' })))
    const state = (await (await app.request('/admin/api/state')).json()) as any
    expect(state.scriptCounters['fake-script']).toBe(1)

    const reset = await app.request('/admin/api/script/reset', { method: 'POST' })
    expect(reset.status).toBe(200)
    const after = (await (await app.request('/admin/api/state')).json()) as any
    expect(after.scriptCounters['fake-script']).toBeUndefined()
  })
})

describe('分词器切换', () => {
  it('heuristic 模式下 usage 按启发式计数', async () => {
    const { app } = setup({ tokenizer: 'heuristic' })
    const res = await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    const body = (await res.json()) as any
    expect(body.usage.completion_tokens).toBe(4)
  })

  it('tiktoken 模式按真词表计数', async () => {
    const { app } = setup({ tokenizer: 'tiktoken' })
    const res = await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    const body = (await res.json()) as any
    expect(body.usage.completion_tokens).toBe(2)
  })
})
