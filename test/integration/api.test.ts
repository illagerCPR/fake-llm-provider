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

function openaiContent(events: SseEvent[]): string {
  let text = ''
  for (const ev of events) {
    if (ev.data === '[DONE]') continue
    const parsed = JSON.parse(ev.data) as { choices?: Array<{ delta?: { content?: string } }> }
    text += parsed.choices?.[0]?.delta?.content ?? ''
  }
  return text
}

function anthropicContent(events: SseEvent[]): string {
  let text = ''
  for (const ev of events) {
    if (ev.event !== 'content_block_delta') continue
    const parsed = JSON.parse(ev.data) as { delta?: { text?: string } }
    text += parsed.delta?.text ?? ''
  }
  return text
}

function setup(overrides: Parameters<typeof mergeSettings>[0] = {}) {
  const settings = mergeSettings({ tps: 2000, ttftMs: 0, text: '你好世界', logLimit: 50, heartbeatMs: 500 }, overrides)
  const hub = new MemoryHub(settings)
  const app = createApp({
    hub,
    env: { version: 'test', runtime: 'node', allowAdminWithoutToken: true },
  })
  return { app, hub }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: 'fake-fixed',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

describe('OpenAI 兼容层', () => {
  it('非流式返回固定文本与 usage', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('你好世界')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.completion_tokens).toBe(2) // o200k：你好 / 世界 各 1 token
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + 2)
  })

  it('流式输出可拼接、末尾带 [DONE] 与 usage 包', async () => {
    const { app } = setup()
    const res = await app.request(
      '/v1/chat/completions',
      json(chatBody({ stream: true, stream_options: { include_usage: true } })),
    )
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = parseSse(await res.text())
    expect(events.at(-1)?.data).toBe('[DONE]')
    expect(openaiContent(events)).toBe('你好世界')

    const usageEvent = events.find((ev) => {
      if (ev.data === '[DONE]') return false
      const parsed = JSON.parse(ev.data) as { usage?: unknown }
      return parsed.usage !== undefined
    })
    expect(usageEvent).toBeTruthy()
    const usage = JSON.parse(usageEvent!.data) as { usage: { completion_tokens: number } }
    expect(usage.usage.completion_tokens).toBe(2)
  })

  it('不带 include_usage 时没有 usage 包', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', json(chatBody({ stream: true })))
    const events = parseSse(await res.text())
    const hasUsage = events.some((ev) => ev.data !== '[DONE]' && (JSON.parse(ev.data) as any).usage !== undefined)
    expect(hasUsage).toBe(false)
  })

  it('人工回复：say 两段后 finish，内容按顺序拼接', async () => {
    const { app, hub } = setup()
    const res = await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-manual', stream: true })))
    const textPromise = res.text()
    await new Promise((r) => setTimeout(r, 30))

    const session = hub.list()[0]
    expect(session?.kind).toBe('manual')
    session!.say('人工')
    session!.say('回复')
    session!.finish()

    const events = parseSse(await textPromise)
    expect(openaiContent(events)).toBe('人工回复')
    expect(events.at(-1)?.data).toBe('[DONE]')
  })

  it('请求体 fake 字段可以覆盖速度与话术', async () => {
    const { app, hub } = setup()
    const res = await app.request(
      '/v1/chat/completions',
      json(chatBody({ stream: true, fake: { text: '覆盖文本', tps: 500 } })),
    )
    const events = parseSse(await res.text())
    expect(openaiContent(events)).toBe('覆盖文本')
    expect(hub.list()[0]?.tps).toBe(500)
  })

  it('fake-fail 档位直接返回错误体', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', json(chatBody({ model: 'fake-fail' })))
    expect(res.status).toBe(500)
    const body = (await res.json()) as any
    expect(body.error.type).toBe('server_error')
  })

  it('fake-truncate 档位不发结束帧', async () => {
    const { app } = setup()
    const res = await app.request(
      '/v1/chat/completions',
      json(chatBody({ model: 'fake-truncate', stream: true, fake: { text: '一二三四五六七八九十' } })),
    )
    const events = parseSse(await res.text())
    expect(events.some((ev) => ev.data === '[DONE]')).toBe(false)
    expect(openaiContent(events)).toBe('一二三四五六')
  })

  it('配置了 API Key 时缺 key 返回 401', async () => {
    const { app } = setup({ apiKeys: ['sk-good'] })
    const bad = await app.request('/v1/chat/completions', json(chatBody()))
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as any).error.type).toBe('authentication_error')

    const good = await app.request('/v1/chat/completions', {
      ...json(chatBody()),
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-good' },
    } as RequestInit)
    expect(good.status).toBe(200)
  })

  it('非法 JSON 返回 400', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.type).toBe('invalid_request_error')
  })

  it('缺少 messages 返回 400', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', json({ model: 'fake-fixed', messages: [] }))
    expect(res.status).toBe(400)
  })

  it('请求会被记录，并带体检结论', async () => {
    const { app, hub } = setup()
    await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    const records = await hub.listRequests(10)
    expect(records).toHaveLength(1)
    expect(records[0]?.model).toBe('fake-fixed')
    expect(records[0]?.lint.some((item) => item.level === 'warn')).toBe(true)
  })
})

describe('Anthropic 兼容层', () => {
  const anthropicHeaders = { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' }

  it('非流式 messages 返回 message 结构', async () => {
    const { app } = setup()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({ model: 'fake-fixed', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.type).toBe('message')
    expect(body.content[0]).toEqual({ type: 'text', text: '你好世界' })
    expect(body.stop_reason).toBe('end_turn')
    expect(body.usage.output_tokens).toBe(2)
  })

  it('流式事件顺序符合 Anthropic 协议', async () => {
    const { app } = setup()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({ model: 'fake-fixed', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const events = parseSse(await res.text())
    expect(events[0]?.event).toBe('message_start')
    expect(events[1]?.event).toBe('content_block_start')
    expect(events.at(-1)?.event).toBe('message_stop')
    expect(events.some((ev) => ev.event === 'content_block_stop')).toBe(true)
    expect(events.some((ev) => ev.event === 'message_delta')).toBe(true)
    expect(anthropicContent(events)).toBe('你好世界')
  })

  it('缺 max_tokens 时体检报 fail（非严格模式仍放行）', async () => {
    const { app, hub } = setup()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({ model: 'fake-fixed', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const record = (await hub.listRequests(1))[0]
    expect(record?.lint.some((item) => item.level === 'fail' && item.label.includes('max_tokens'))).toBe(true)
  })

  it('严格模式下体检 fail 直接 400', async () => {
    const { app } = setup({ strict: true })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({ model: 'fake-fixed', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('辅助接口', () => {
  it('/v1/models 按请求头返回两种形状', async () => {
    const { app } = setup()
    const openai = (await (await app.request('/v1/models')).json()) as any
    expect(openai.object).toBe('list')
    expect(openai.data.some((m: any) => m.id === 'fake-manual')).toBe(true)

    const anthropic = (await (
      await app.request('/v1/models', { headers: { 'anthropic-version': '2023-06-01' } })
    ).json()) as any
    expect(Array.isArray(anthropic.data)).toBe(true)
    expect(anthropic.data[0].type).toBe('model')
  })

  it('/v1/embeddings 是确定性的', async () => {
    const { app } = setup()
    const call = () =>
      app.request(
        '/v1/embeddings',
        json({ model: 'fake-embedding', input: '同一个输入', dimensions: 8 }),
      )
    const first = (await (await call()).json()) as any
    const second = (await (await call()).json()) as any
    expect(first.data[0].embedding).toHaveLength(8)
    expect(first.data[0].embedding).toEqual(second.data[0].embedding)
  })

  it('/healthz 正常', async () => {
    const { app } = setup()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).ok).toBe(true)
  })

  it('管理台可以改设置并回读', async () => {
    const { app } = setup()
    const before = (await (await app.request('/admin/api/state')).json()) as any
    expect(before.settings.tps).toBe(2000)

    const put = await app.request('/admin/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tps: 5, mode: 'manual' }),
    })
    expect(put.status).toBe(200)

    const after = (await (await app.request('/admin/api/state')).json()) as any
    expect(after.settings.tps).toBe(5)
    expect(after.settings.mode).toBe('manual')
  })

  it('非法设置返回 400', async () => {
    const { app } = setup()
    const res = await app.request('/admin/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tps: 999_999_9 }),
    })
    expect(res.status).toBe(400)
  })
})

describe('非流式耗时模拟', () => {
  it('simulateDuration=false 时立刻返回，不做节拍', async () => {
    const { app } = setup({ simulateDuration: false, tps: 1, ttftMs: 5000 })
    const startedAt = Date.now()
    const res = await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    const elapsed = Date.now() - startedAt
    expect(res.status).toBe(200)
    expect(elapsed).toBeLessThan(500)
  })

  it('默认会按 TPS 模拟耗时', async () => {
    const { app } = setup({ tps: 1000, ttftMs: 120, text: '一二三四五' })
    const startedAt = Date.now()
    await app.request('/v1/chat/completions', json(chatBody({ stream: false })))
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(120)
  })
})
