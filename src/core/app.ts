import { Hono } from 'hono'
import type { Context } from 'hono'
import { buildStreamInit, completeOnce, driveStream } from './driver'
import type { SessionHub } from './hub'
import { hasBlockingLint, lintRequest } from './lint'
import { DEFAULT_SCRIPT, MODEL_PROFILES, applyScriptStep, modelInfos, resolveBehavior } from './models'
import { anthropicAdapter } from './protocol/anthropic'
import { openaiAdapter } from './protocol/openai'
import { asRecord, type ProtocolAdapter } from './protocol/types'
import { Session } from './session'
import { scriptStepSchema, type Settings, type ScriptStep } from './settings'
import { STREAM_HEADERS, serializeFrame } from './sse'
import { expandTemplate } from './templates'
import { countWith } from './tokenizer'
import type { Frame, NormalizedRequest, Protocol, RequestRecord } from './types'

export interface AppEnv {
  version: string
  runtime: string
  adminToken?: string
  /** 没配 ADMIN_TOKEN 时是否放行管理台：本地 true，公网 false */
  allowAdminWithoutToken: boolean
}

export interface AppDeps {
  hub: SessionHub
  env: AppEnv
}

const now = () => performance.now()
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function collectHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function readBearer(c: Context): string | undefined {
  const auth = c.req.header('authorization')
  if (!auth) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return match?.[1]?.trim()
}

function detectModelAdapter(c: Context): ProtocolAdapter {
  if (c.req.header('anthropic-version')) return anthropicAdapter
  if (c.req.header('x-api-key') && !c.req.header('authorization')) return anthropicAdapter
  return openaiAdapter
}

/** 返回 null 表示通过；否则是给客户端的错误说明 */
function checkAuth(c: Context, adapter: ProtocolAdapter, settings: Settings): string | null {
  if (settings.apiKeys.length === 0) return null
  const token = adapter.authHeader === 'authorization' ? readBearer(c) : c.req.header('x-api-key')?.trim()
  if (!token) return adapter.authHeader === 'authorization' ? '缺少 Authorization: Bearer 头' : '缺少 x-api-key 头'
  if (!settings.apiKeys.includes(token)) return 'API Key 不正确'
  return null
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    const value = await c.req.json()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, message: `请求体不是合法 JSON：${describeError(error)}` }
  }
}

function jsonError(c: Context, adapter: ProtocolAdapter, status: number, message: string): Response {
  return c.json(adapter.errorBody(status, message) as never, status as never, {
    'x-fake-error': '1',
    'cache-control': 'no-store',
  })
}

/** 确定性伪向量：同一个输入永远得到同一个向量，便于断言 */
function fakeVector(text: string, dims: number): number[] {
  const size = Math.max(1, Math.min(4096, Math.floor(dims) || 1536))
  const out = new Array<number>(size)
  let hash = 2166136261
  const seed = text.length > 0 ? text : '∅'
  for (let i = 0; i < size; i += 1) {
    hash ^= seed.charCodeAt(i % seed.length) + i
    hash = Math.imul(hash, 16777619)
    out[i] = ((hash >>> 0) / 4294967295) * 2 - 1
  }
  let norm = 0
  for (const v of out) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < size; i += 1) out[i] = Number((out[i]! / norm).toFixed(6))
  return out
}

/** 剧本来源优先级：请求体 fake.script > 控制台剧本 > 内置默认（429 → 200） */
function resolveScriptSteps(fake: Record<string, unknown> | null, settings: Settings): ScriptStep[] {
  if (fake && Array.isArray(fake.script)) {
    const parsed = scriptStepSchema.array().safeParse(fake.script)
    if (parsed.success && parsed.data.length > 0) return parsed.data
  }
  return settings.script.length > 0 ? settings.script : DEFAULT_SCRIPT
}

export function createApp(deps: AppDeps): Hono {
  const { hub, env } = deps
  const app = new Hono()
  const bootedAt = Date.now()
  // 剧本按「模型名」累计调用次数：第 N 次调用用剧本第 N 步
  const scriptCounters = new Map<string, number>()

  // ---------- 通用：CORS ----------
  app.use('*', async (c, next) => {
    const settings = await hub.getSettings()
    if (settings.cors !== 'none') {
      c.header('access-control-allow-origin', settings.cors === '*' ? '*' : settings.cors)
      c.header('vary', 'origin')
      c.header('access-control-allow-methods', 'GET, POST, OPTIONS')
      c.header(
        'access-control-allow-headers',
        'authorization, content-type, x-api-key, anthropic-version, x-admin-token, x-fake-kind, x-fake-tps, x-fake-ttft-ms, x-fake-status, x-fake-fail-after-tokens, x-fake-chunk-tokens',
      )
      c.header('access-control-expose-headers', 'x-request-id, x-fake-session-id, x-fake-kind, x-fake-routed-model')
      c.header('access-control-max-age', '600')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
    return
  })

  app.get('/', (c) => c.redirect('/admin/'))
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'fake-llm-provider',
      version: env.version,
      runtime: env.runtime,
      uptimeMs: Date.now() - bootedAt,
    }),
  )

  // ---------- 模型列表 ----------
  app.get('/v1/models', async (c) => {
    const settings = await hub.getSettings()
    const adapter = detectModelAdapter(c)
    const auth = checkAuth(c, adapter, settings)
    if (auth) return jsonError(c, adapter, 401, auth)
    return c.json(adapter.modelsPayload(modelInfos(settings)) as never)
  })

  app.get('/v1/models/:id', async (c) => {
    const settings = await hub.getSettings()
    const adapter = detectModelAdapter(c)
    const auth = checkAuth(c, adapter, settings)
    if (auth) return jsonError(c, adapter, 401, auth)
    const id = c.req.param('id')
    const info = modelInfos(settings).find((m) => m.id === id)
    if (!info) {
      const fallback = MODEL_PROFILES.find((p) => p.id === settings.defaultModel)
      const hint = fallback ? `；调用时这类名字会由 ${fallback.id} 接住` : ''
      return jsonError(c, adapter, 404, `模型 ${id} 不存在${hint}`)
    }
    return c.json(adapter.modelPayload(info) as never)
  })

  // ---------- 嵌入 ----------
  app.post('/v1/embeddings', async (c) => {
    const settings = await hub.getSettings()
    const auth = checkAuth(c, openaiAdapter, settings)
    if (auth) return jsonError(c, openaiAdapter, 401, auth)
    const parsed = await readJson(c)
    if (!parsed.ok) return jsonError(c, openaiAdapter, 400, parsed.message)
    const body = asRecord(parsed.value) ?? {}
    const input = body.input
    const texts = Array.isArray(input) ? input.map((v) => String(v)) : [String(input ?? '')]
    const dims = typeof body.dimensions === 'number' ? body.dimensions : 1536
    const data = texts.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: fakeVector(text, dims),
    }))
    const promptTokens = texts.reduce((sum, text) => sum + countWith(settings.tokenizer, text, settings.unit), 0)
    return c.json({
      object: 'list',
      data,
      model: typeof body.model === 'string' ? body.model : 'fake-embedding',
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    } as never)
  })

  // ---------- Anthropic：token 计数 ----------
  app.post('/v1/messages/count_tokens', async (c) => {
    const settings = await hub.getSettings()
    const auth = checkAuth(c, anthropicAdapter, settings)
    if (auth) return jsonError(c, anthropicAdapter, 401, auth)
    const parsed = await readJson(c)
    if (!parsed.ok) return jsonError(c, anthropicAdapter, 400, parsed.message)
    try {
      const request = anthropicAdapter.parse(parsed.value)
      return c.json(
        anthropicAdapter.countTokensPayload(countWith(settings.tokenizer, request.promptText, settings.unit)) as never,
      )
    } catch (error) {
      return jsonError(c, anthropicAdapter, 400, describeError(error))
    }
  })

  // ---------- 主流程 ----------
  app.post('/v1/chat/completions', (c) => handleChat(c, 'openai', hub, scriptCounters))
  app.post('/v1/messages', (c) => handleChat(c, 'anthropic', hub, scriptCounters))

  // ---------- 管理台 API ----------
  app.use('/admin/api/*', async (c, next) => {
    if (!env.adminToken) {
      if (!env.allowAdminWithoutToken) {
        return c.json({ error: 'admin_disabled', message: '未配置 ADMIN_TOKEN，管理台已禁用' }, 403)
      }
      await next()
      return
    }
    const provided = c.req.header('x-admin-token') ?? readBearer(c)
    if (provided !== env.adminToken) {
      return c.json({ error: 'unauthorized', message: 'ADMIN_TOKEN 不正确' }, 401)
    }
    await next()
    return
  })

  app.get('/admin/api/ping', (c) => c.json({ ok: true, version: env.version, runtime: env.runtime }))

  app.get('/admin/api/state', async (c) => {
    const settings = await hub.getSettings()
    const sessions = hub.list().slice(0, 80).map((s) => s.snapshot())
    return c.json({
      settings,
      sessions,
      models: MODEL_PROFILES.map((p) => ({ id: p.id, label: p.label, description: p.description, kind: p.kind })),
      version: env.version,
      runtime: env.runtime,
      scriptCounters: Object.fromEntries(scriptCounters),
      bootedAt,
      serverNow: Date.now(),
    })
  })

  app.put('/admin/api/settings', async (c) => {
    const parsed = await readJson(c)
    if (!parsed.ok) return c.json({ error: 'bad_request', message: parsed.message }, 400)
    try {
      const settings = await hub.updateSettings((parsed.value ?? {}) as Partial<Settings>)
      return c.json({ ok: true, settings })
    } catch (error) {
      return c.json({ error: 'invalid_settings', message: describeError(error) }, 400)
    }
  })

  app.get('/admin/api/sessions/:key', async (c) => {
    const session = hub.get(c.req.param('key'))
    if (!session) return c.json({ error: 'not_found' }, 404)
    return c.json(session.snapshot())
  })

  app.post('/admin/api/sessions/:key/say', async (c) => {
    const session = hub.get(c.req.param('key'))
    if (!session) return c.json({ error: 'not_found' }, 404)
    const parsed = await readJson(c)
    if (!parsed.ok) return c.json({ error: 'bad_request', message: parsed.message }, 400)
    const text = asRecord(parsed.value)?.text
    if (typeof text !== 'string' || text.length === 0) {
      return c.json({ error: 'bad_request', message: 'text 不能为空' }, 400)
    }
    const accepted = session.say(text)
    return c.json({ ok: accepted, session: session.snapshot() })
  })

  app.post('/admin/api/sessions/:key/finish', async (c) => {
    const session = hub.get(c.req.param('key'))
    if (!session) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: session.finish(), session: session.snapshot() })
  })

  app.post('/admin/api/sessions/:key/abort', async (c) => {
    const session = hub.get(c.req.param('key'))
    if (!session) return c.json({ error: 'not_found' }, 404)
    let reason = '人工掐断'
    try {
      const body = await c.req.json()
      const value = asRecord(body)?.reason
      if (typeof value === 'string' && value.length > 0) reason = value
    } catch {
      // 允许空 body
    }
    return c.json({ ok: session.abort(reason), session: session.snapshot() })
  })

  app.post('/admin/api/script/reset', (c) => {
    scriptCounters.clear()
    return c.json({ ok: true })
  })

  app.get('/admin/api/requests', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50')
    const requests = await hub.listRequests(Number.isFinite(limit) ? limit : 50)
    return c.json({ requests })
  })

  app.get('/admin/api/export', async (c) => {
    const settings = await hub.getSettings()
    const requests = await hub.listRequests(settings.logLimit)
    return c.json({ exportedAt: new Date().toISOString(), version: env.version, settings, requests })
  })

  return app
}

async function handleChat(
  c: Context,
  protocol: Protocol,
  hub: SessionHub,
  scriptCounters: Map<string, number>,
): Promise<Response> {
  const adapter = protocol === 'openai' ? openaiAdapter : anthropicAdapter
  const settings = await hub.getSettings()

  const auth = checkAuth(c, adapter, settings)
  if (auth) return jsonError(c, adapter, 401, auth)

  const parsed = await readJson(c)
  if (!parsed.ok) return jsonError(c, adapter, 400, parsed.message)

  let request: NormalizedRequest
  try {
    request = adapter.parse(parsed.value)
  } catch (error) {
    return jsonError(c, adapter, 400, describeError(error))
  }
  if (!request.model) return jsonError(c, adapter, 400, '缺少 model 字段')
  if (request.messages.length === 0) return jsonError(c, adapter, 400, 'messages 不能为空')

  const headers = collectHeaders(c)
  const fake = asRecord(asRecord(parsed.value)?.fake)
  let behavior = resolveBehavior({ model: request.model, settings, headers, ...(fake ? { fake } : {}) })
  const promptTokens = countWith(settings.tokenizer, request.promptText, settings.unit)

  // 剧本档位：按模型名累计调用次数，取对应那一步
  if (behavior.kind === 'script') {
    const steps = resolveScriptSteps(fake, settings)
    const index = scriptCounters.get(request.model) ?? 0
    const step = steps[Math.min(index, steps.length - 1)] ?? { kind: 'fixed' as const }
    scriptCounters.set(request.model, index + 1)
    behavior = applyScriptStep(behavior, step, settings, index)
  }
  const lint = lintRequest({ request, headers, apiKeys: settings.apiKeys })
  // 模型名不认识不拦截，但要在控制台一眼看到「客户端发了个别的名字」
  if (behavior.fallbackFrom) {
    lint.unshift({
      level: 'warn',
      label: `模型名 ${behavior.fallbackFrom} 不在档位表里，已回落到 ${behavior.fallbackTo}`,
      detail: '回复话术里的 {{model}} 就是客户端发的这个名字；想换掉落点改 DEFAULT_MODEL',
    })
  }

  if (settings.strict) {
    const blocking = lint.find((item) => item.level === 'fail')
    if (blocking) return jsonError(c, adapter, 400, blocking.label)
  }

  if (behavior.kind === 'fail') {
    return jsonError(c, adapter, behavior.status, `假上游按档位返回错误（status=${behavior.status}）`)
  }

  const key = crypto.randomUUID()
  const nonce = Math.random().toString(16).slice(2, 10)
  const id = protocol === 'openai' ? `chatcmpl-fake-${nonce}` : `msg_fake_${nonce}`
  const createdAt = Date.now()

  const record: RequestRecord = {
    key,
    protocol,
    path: c.req.path,
    method: c.req.method,
    model: request.model,
    ...(behavior.fallbackTo ? { routedModel: behavior.fallbackTo } : {}),
    stream: request.stream,
    headers,
    body: request.raw,
    promptTokens,
    startedAt: createdAt,
    lint,
  }

  const session = new Session({
    key,
    id,
    nonce,
    protocol,
    model: request.model,
    kind: behavior.kind,
    stream: request.stream,
    tps: behavior.tps,
    ttftMs: behavior.ttftMs,
    promptTokens,
    createdAt,
    record,
  })
  hub.add(session)

  const identityHeaders: Record<string, string> = {
    'x-request-id': id,
    'x-fake-session-id': key,
    'x-fake-kind': behavior.kind,
    ...(behavior.fallbackTo ? { 'x-fake-routed-model': behavior.fallbackTo } : {}),
  }

  if (!request.stream) {
    const init = buildStreamInit(session, false)
    const payload = await completeOnce({ session, adapter, behavior, settings, init, now, sleep })
    session.record.status = 200
    session.record.finishedAt = Date.now()
    await hub.recordRequest(session.record)
    return c.json(payload as never, 200, identityHeaders)
  }

  const init = buildStreamInit(session, request.streamIncludeUsage)
  const encoder = new TextEncoder()
  const signal = c.req.raw.signal

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: Frame) => {
        controller.enqueue(encoder.encode(serializeFrame(frame)))
      }
      try {
        await driveStream({ session, adapter, behavior, settings, init, signal, emit, now, sleep })
      } catch (error) {
        try {
          for (const frame of adapter.streamError(describeError(error))) emit(frame)
        } catch {
          // 客户端已经走了，忽略
        }
        if (!session.isClosed) session.markAborted(`internal error: ${describeError(error)}`)
      } finally {
        session.record.status = 200
        session.record.finishedAt = Date.now()
        if (session.errorMessage) session.record.error = session.errorMessage
        await hub.recordRequest(session.record)
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }
    },
    cancel() {
      session.abort('client disconnected')
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { ...STREAM_HEADERS, ...identityHeaders },
  })
}
