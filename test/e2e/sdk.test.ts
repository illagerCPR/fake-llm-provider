import Anthropic from '@anthropic-ai/sdk'
import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/core/app'
import { MemoryHub } from '../../src/core/hub'
import { mergeSettings } from '../../src/core/settings'

/**
 * 契约测试：用官方 SDK 打真实 HTTP 端口，验证我们发出的流/结构不违规。
 * 这一层才是"能不能被真正的客户端用"的证据。
 */
let server: ReturnType<typeof serve>
let baseUrl = ''

beforeAll(async () => {
  const settings = mergeSettings({
    tps: 2000,
    ttftMs: 0,
    text: '你好，世界。Hello world!',
    heartbeatMs: 500,
    logLimit: 20,
  })
  const hub = new MemoryHub(settings)
  const app = createApp({ hub, env: { version: 'test', runtime: 'node', allowAdminWithoutToken: true } })

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('OpenAI SDK 契约', () => {
  const client = () => new OpenAI({ apiKey: 'sk-fake', baseURL: `${baseUrl}/v1`, maxRetries: 0 })

  it('非流式 chat.completions 能解析', async () => {
    const completion = await client().chat.completions.create({
      model: 'fake-fixed',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
    })
    expect(completion.choices[0]?.message.content).toBe('你好，世界。Hello world!')
    expect(completion.choices[0]?.finish_reason).toBe('stop')
    expect(completion.usage?.total_tokens).toBeGreaterThan(0)
  })

  it('流式 chat.completions 能逐块拼接', async () => {
    const stream = await client().chat.completions.create({
      model: 'fake-fixed',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      stream_options: { include_usage: true },
    })
    let text = ''
    let usage: { total_tokens?: number } | undefined
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? ''
      if (chunk.usage) usage = chunk.usage
    }
    expect(text).toBe('你好，世界。Hello world!')
    expect(usage?.total_tokens).toBeGreaterThan(0)
  })

  it('SDK 能解析 tool_calls（非流式）', async () => {
    const completion = await client().chat.completions.create({
      model: 'fake-tool',
      messages: [{ role: 'user', content: '今天天气如何' }],
    })
    const call = completion.choices[0]?.message.tool_calls?.[0]
    expect(call?.type).toBe('function')
    if (call?.type !== 'function') throw new Error('期望是 function 类型的工具调用')
    expect(call.function.name).toBe('get_weather')
    expect(JSON.parse(call.function.arguments)).toEqual({ city: '上海', unit: 'celsius' })
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls')
  })

  it('SDK 能拼接流式 tool_calls 参数', async () => {
    const stream = await client().chat.completions.create({
      model: 'fake-tool',
      messages: [{ role: 'user', content: '今天天气如何' }],
      stream: true,
    })
    let args = ''
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.tool_calls?.[0]
      if (delta?.function?.arguments) args += delta.function.arguments
    }
    expect(JSON.parse(args)).toEqual({ city: '上海', unit: 'celsius' })
  })

  it('models.list 可用', async () => {
    const models = await client().models.list()
    expect(models.data.some((m) => m.id === 'fake-manual')).toBe(true)
  })

  it('错误能被 SDK 识别为 APIError', async () => {
    await expect(
      client().chat.completions.create({
        model: 'fake-fail',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    ).rejects.toMatchObject({ status: 500 })
  })

  it('embeddings 可用且确定', async () => {
    const first = await client().embeddings.create({ model: 'fake-embedding', input: 'abc', dimensions: 16 })
    const second = await client().embeddings.create({ model: 'fake-embedding', input: 'abc', dimensions: 16 })
    expect(first.data[0]?.embedding).toEqual(second.data[0]?.embedding)
  })
})

describe('Anthropic SDK 契约', () => {
  const client = () =>
    new Anthropic({ apiKey: "sk-fake", baseURL: baseUrl, maxRetries: 0, defaultHeaders: { 'anthropic-version': '2023-06-01' } })

  it('非流式 messages 能解析', async () => {
    const message = await client().messages.create({
      model: 'fake-fixed',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    })
    const block = message.content[0]
    expect(block?.type).toBe('text')
    expect(block?.type === 'text' ? block.text : '').toBe('你好，世界。Hello world!')
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage.output_tokens).toBeGreaterThan(0)
  })

  it('流式 messages 事件序列可被 SDK 消费', async () => {
    const stream = client().messages.stream({
      model: 'fake-fixed',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    })
    let text = ''
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
    }
    const final = await stream.finalMessage()
    expect(text).toBe('你好，世界。Hello world!')
    expect(final.stop_reason).toBe('end_turn')
  })

  it('SDK 能解析 tool_use', async () => {
    const message = await client().messages.create({
      model: 'fake-tool',
      max_tokens: 64,
      messages: [{ role: 'user', content: '今天天气如何' }],
    })
    const block = message.content[0]
    expect(block?.type).toBe('tool_use')
    if (block?.type === 'tool_use') {
      expect(block.name).toBe('get_weather')
      expect(block.input).toEqual({ city: '上海', unit: 'celsius' })
    }
    expect(message.stop_reason).toBe('tool_use')
  })

  it('count_tokens 可用', async () => {
    const result = await client().messages.countTokens({
      model: 'fake-fixed',
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(result.input_tokens).toBeGreaterThan(0)
  })
})
