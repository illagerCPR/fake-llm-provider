#!/usr/bin/env node
/**
 * 冒烟测试：不带任何依赖，直接打一个已经跑起来的实例。
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:8080 ADMIN_TOKEN=xxx node scripts/smoke.mjs
 *
 * 覆盖：健康检查、模型列表（两种形状）、非流式、流式、Anthropic 流式、
 * 错误档位、工具调用、未知模型回显、剧本、人工回复（后两项需要 ADMIN_TOKEN）。
 */

const BASE = (process.env.SMOKE_BASE_URL ?? process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed += 1
  console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`)
}

function bad(name, detail) {
  failed += 1
  console.log(`  ✗ ${name}\n      ${detail}`)
}

function check(name, condition, detail = '') {
  if (condition) ok(name, detail)
  else bad(name, detail || '断言失败')
}

async function jsonFetch(path, init = {}) {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (ADMIN_TOKEN && path.startsWith('/admin')) headers.set('x-admin-token', ADMIN_TOKEN)
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

function parseSse(raw) {
  const events = []
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue
    let event
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return events
}

function openaiText(events) {
  let out = ''
  for (const ev of events) {
    if (ev.data === '[DONE]') continue
    try {
      const parsed = JSON.parse(ev.data)
      out += parsed.choices?.[0]?.delta?.content ?? ''
    } catch {
      // 忽略
    }
  }
  return out
}

function anthropicText(events) {
  let out = ''
  for (const ev of events) {
    if (ev.event !== 'content_block_delta') continue
    try {
      out += JSON.parse(ev.data).delta?.text ?? ''
    } catch {
      // 忽略
    }
  }
  return out
}

async function streamChat(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  return { status: res.status, raw, events: parseSse(raw) }
}

async function main() {
  console.log(`\n冒烟测试 → ${BASE}\n`)

  // 1. 健康检查
  const health = await jsonFetch('/healthz')
  check('健康检查', health.status === 200 && health.body?.ok === true, `status=${health.status} runtime=${health.body?.runtime}`)

  // 2. 模型列表（两种形状）
  const openaiModels = await jsonFetch('/v1/models')
  check(
    'OpenAI 模型列表',
    openaiModels.status === 200 && openaiModels.body?.object === 'list' && Array.isArray(openaiModels.body.data),
    `${openaiModels.body?.data?.length ?? 0} 个模型`,
  )
  const anthropicModels = await jsonFetch('/v1/models', { headers: { 'anthropic-version': '2023-06-01' } })
  check(
    'Anthropic 模型列表',
    anthropicModels.status === 200 && Array.isArray(anthropicModels.body?.data) && anthropicModels.body.data[0]?.type === 'model',
    `${anthropicModels.body?.data?.length ?? 0} 个模型`,
  )

  // 3. 非流式
  const nonStream = await jsonFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'fake-fixed',
      messages: [{ role: 'user', content: 'hi' }],
      fake: { text: '你好，冒烟测试。', tps: 500, ttftMs: 0 },
    }),
  })
  check(
    'OpenAI 非流式',
    nonStream.status === 200 && nonStream.body?.choices?.[0]?.message?.content === '你好，冒烟测试。',
    `total_tokens=${nonStream.body?.usage?.total_tokens}`,
  )

  // 4. 流式
  const streamed = await streamChat('/v1/chat/completions', {
    model: 'fake-fixed',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    fake: { text: '流式输出一二三四五。', tps: 200, ttftMs: 0 },
  })
  const hasDone = streamed.events.some((ev) => ev.data === '[DONE]')
  const hasUsage = streamed.events.some((ev) => {
    if (ev.data === '[DONE]') return false
    try {
      return JSON.parse(ev.data).usage !== undefined
    } catch {
      return false
    }
  })
  check(
    'OpenAI 流式',
    streamed.status === 200 && openaiText(streamed.events) === '流式输出一二三四五。' && hasDone && hasUsage,
    `${streamed.events.length} 个事件，usage=${hasUsage}`,
  )

  // 5. Anthropic 流式
  const anthropic = await streamChat('/v1/messages', {
    model: 'fake-fixed',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    fake: { text: 'Anthropic 也走一遍。', tps: 200, ttftMs: 0 },
  })
  const order = anthropic.events.map((ev) => ev.event)
  check(
    'Anthropic 流式',
    anthropicText(anthropic.events) === 'Anthropic 也走一遍。' &&
      order[0] === 'message_start' &&
      order.at(-1) === 'message_stop',
    `${order.length} 个事件`,
  )

  // 6. 错误档位
  const failResponse = await jsonFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'fake-fail', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('错误档位返回 500', failResponse.status === 500 && failResponse.body?.error?.type === 'server_error', `status=${failResponse.status}`)

  // 7. 工具调用
  const toolCall = await jsonFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'fake-tool',
      messages: [{ role: 'user', content: 'weather?' }],
      fake: { toolName: 'lookup_city', toolArgs: '{"city":"杭州"}' },
    }),
  })
  const call = toolCall.body?.choices?.[0]?.message?.tool_calls?.[0]
  check(
    '工具调用',
    toolCall.status === 200 &&
      call?.function?.name === 'lookup_city' &&
      JSON.parse(call?.function?.arguments ?? '{}').city === '杭州' &&
      toolCall.body?.choices?.[0]?.finish_reason === 'tool_calls',
    `finish=${toolCall.body?.choices?.[0]?.finish_reason}`,
  )

  // 8. 剧本（需要管理台权限来重置计数）
  if (!ADMIN_TOKEN) {
    console.log('  - 跳过剧本测试（未提供 ADMIN_TOKEN）')
  } else {
    await jsonFetch('/admin/api/script/reset', { method: 'POST' })
    const first = await jsonFetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'fake-script', messages: [{ role: 'user', content: 'retry me' }] }),
    })
    const second = await jsonFetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'fake-script', messages: [{ role: 'user', content: 'retry me' }] }),
    })
    check(
      '剧本（429 → 200）',
      first.status === 429 && second.status === 200,
      `${first.status} → ${second.status}`,
    )
  }

  // 9. 未知模型回显
  const echoed = await jsonFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fake: { tps: 500, ttftMs: 0 },
    }),
  })
  const echoText = echoed.body?.choices?.[0]?.message?.content ?? ''
  const routed = echoed.headers.get('x-fake-routed-model')
  check(
    '未知模型回显',
    echoed.status === 200 && echoText.includes('gpt-4o-mini') && routed === 'fake-echo',
    `routed=${routed}`,
  )

  // 10. 人工回复
  if (!ADMIN_TOKEN) {
    console.log('  - 跳过人工回复测试（未提供 ADMIN_TOKEN）')
  } else {
    const controller = new AbortController()
    const started = Date.now()
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-manual',
        messages: [{ role: 'user', content: 'manual' }],
        stream: true,
        fake: { tps: 500, ttftMs: 0 },
      }),
      signal: controller.signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
      }
    })()

    await new Promise((r) => setTimeout(r, 400))
    const state = await jsonFetch('/admin/api/state')
    const session = state.body?.sessions?.find((s) => s.kind === 'manual' && s.state === 'waiting_human')
    if (!session) {
      bad('人工回复', '管理台里没找到等待中的会话')
      controller.abort()
    } else {
      const key = session.key
      await jsonFetch(`/admin/api/sessions/${key}/say`, { method: 'POST', body: JSON.stringify({ text: '人工第一段。' }) })
      await new Promise((r) => setTimeout(r, 300))
      await jsonFetch(`/admin/api/sessions/${key}/finish`, { method: 'POST' })
      await pump
      const events = parseSse(raw)
      const text = openaiText(events)
      check(
        '人工回复',
        text === '人工第一段。' && events.some((ev) => ev.data === '[DONE]'),
        `${text.length} 字符 / ${Date.now() - started}ms`,
      )
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('冒烟测试异常：', error)
  process.exit(2)
})
