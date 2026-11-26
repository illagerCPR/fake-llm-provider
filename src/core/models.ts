import type { ModelInfo, ToolSpec } from './protocol/types'
import type { ScriptStep, Settings } from './settings'
import type { ProfileKind } from './types'

export interface ModelProfile {
  id: string
  kind: ProfileKind
  label: string
  description: string
  defaults?: {
    ttftMs?: number
    status?: number
    failAfterTokens?: number
  }
}

/** 模型名不在上表里时的落脚档位：回复里带上客户端请求的那个名字 */
export const ECHO_MODEL_ID = 'fake-echo'

/** 模型名即档位：客户端只要换个 model 就能切行为，不必改服务端配置 */
export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'fake-fixed',
    kind: 'fixed',
    label: '固定文本',
    description: '按配置话术与 TPS 稳定流式输出',
  },
  {
    id: ECHO_MODEL_ID,
    kind: 'fixed',
    label: '回显模型名',
    description: '模型名不认识时落到这里，回复里带上请求用的模型名',
  },
  {
    id: 'fake-manual',
    kind: 'manual',
    label: '人工回复',
    description: '挂在控制台上，由人一段段打字推进',
  },
  {
    id: 'fake-tool',
    kind: 'tool',
    label: '工具调用',
    description: '返回一个假的 tool_calls / tool_use，用来测 Agent 的工具链路',
  },
  {
    id: 'fake-script',
    kind: 'script',
    label: '剧本',
    description: '按调用次数依次执行剧本（默认第一次 429、第二次成功）',
  },
  {
    id: 'fake-instant',
    kind: 'instant',
    label: '秒回',
    description: '一次性吐完，没有节拍（检验客户端是否真在增量处理）',
  },
  {
    id: 'fake-slow',
    kind: 'slow',
    label: '慢首字',
    description: '首字延迟 30 秒，用来打客户端超时/重试',
    defaults: { ttftMs: 30_000 },
  },
  {
    id: 'fake-fail',
    kind: 'fail',
    label: '直接报错',
    description: '按指定状态码返回错误体（默认 500）',
    defaults: { status: 500 },
  },
  {
    id: 'fake-truncate',
    kind: 'truncate',
    label: '半截断流',
    description: '吐若干 token 后直接断开，检验半截流处理',
    defaults: { failAfterTokens: 6 },
  },
]

/** fake-script 没配剧本时的默认值：先限流，再成功，用来测重试 */
export const DEFAULT_SCRIPT: ScriptStep[] = [
  { kind: 'fail', status: 429, note: '第一次限流' },
  { kind: 'fixed', note: '第二次成功' },
]

const MODEL_CREATED = 1_735_689_600 // 2025-01-01T00:00:00Z

export interface Behavior {
  kind: ProfileKind
  text: string
  tps: number
  ttftMs: number
  status: number
  failAfterTokens: number
  chunkTokens: number
  label: string
  /** kind === 'tool' 时有值 */
  toolCall?: ToolSpec
  /** 请求的模型名不在档位表里（原样记录下来，方便回显与排查） */
  fallbackFrom?: string
  /** 实际接住这次请求的档位 id */
  fallbackTo?: string
}

const KINDS: ProfileKind[] = ['fixed', 'manual', 'instant', 'slow', 'fail', 'truncate', 'tool', 'script']

function pickKind(value: unknown): ProfileKind | undefined {
  return typeof value === 'string' && (KINDS as string[]).includes(value) ? (value as ProfileKind) : undefined
}

function headerNumber(headers: Record<string, string | undefined>, name: string): number | undefined {
  const raw = headers[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function bodyNumber(fake: Record<string, unknown> | null | undefined, name: string): number | undefined {
  const value = fake?.[name]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function bodyString(fake: Record<string, unknown> | null | undefined, name: string): string | undefined {
  const value = fake?.[name]
  return typeof value === 'string' ? value : undefined
}

/** 模型列表（给 /v1/models 用） */
export function modelInfos(settings: Settings): ModelInfo[] {
  const ids = new Set(MODEL_PROFILES.map((p) => p.id))
  const list: ModelInfo[] = MODEL_PROFILES.map((p) => ({
    id: p.id,
    displayName: p.label,
    created: MODEL_CREATED,
  }))
  if (settings.defaultModel && !ids.has(settings.defaultModel)) {
    list.push({ id: settings.defaultModel, displayName: settings.defaultModel, created: MODEL_CREATED })
  }
  return list
}

/**
 * 决定这一次请求怎么回。优先级：请求体 fake 字段 > X-Fake-* 头 > 模型名档位 > 全局设置。
 * 模型名不认识时先回落到 defaultModel 指定的档位（默认 fake-echo，回复里带上那个名字），
 * 没配 defaultModel 才退回全局 mode。
 * 剧本档位只在这里标出 kind，具体取哪一步由调用方（带计数器）决定。
 */
export function resolveBehavior(input: {
  model: string
  settings: Settings
  headers: Record<string, string | undefined>
  fake?: Record<string, unknown> | null
}): Behavior {
  const { model, settings, headers } = input
  const fake = input.fake ?? null
  const matched = MODEL_PROFILES.find((p) => p.id === model)
  const fallback = matched ? undefined : MODEL_PROFILES.find((p) => p.id === settings.defaultModel)
  const profile = matched ?? fallback

  const kind =
    pickKind(fake?.kind) ??
    pickKind(headers['x-fake-kind']) ??
    profile?.kind ??
    (settings.mode as ProfileKind)

  let tps = settings.tps
  let ttftMs = profile?.defaults?.ttftMs ?? settings.ttftMs
  let status = profile?.defaults?.status ?? 500
  let failAfterTokens = profile?.defaults?.failAfterTokens ?? 6
  let chunkTokens = settings.chunkTokens

  const headerTps = headerNumber(headers, 'x-fake-tps')
  if (headerTps !== undefined) tps = headerTps
  const headerTtft = headerNumber(headers, 'x-fake-ttft-ms')
  if (headerTtft !== undefined) ttftMs = headerTtft
  const headerStatus = headerNumber(headers, 'x-fake-status')
  if (headerStatus !== undefined) status = headerStatus
  const headerFailAfter = headerNumber(headers, 'x-fake-fail-after-tokens')
  if (headerFailAfter !== undefined) failAfterTokens = headerFailAfter
  const headerChunk = headerNumber(headers, 'x-fake-chunk-tokens')
  if (headerChunk !== undefined) chunkTokens = headerChunk

  const fakeTps = bodyNumber(fake, 'tps')
  if (fakeTps !== undefined) tps = fakeTps
  const fakeTtft = bodyNumber(fake, 'ttftMs')
  if (fakeTtft !== undefined) ttftMs = fakeTtft
  const fakeStatus = bodyNumber(fake, 'status')
  if (fakeStatus !== undefined) status = fakeStatus
  const fakeFailAfter = bodyNumber(fake, 'failAfterTokens')
  if (fakeFailAfter !== undefined) failAfterTokens = fakeFailAfter
  const fakeChunk = bodyNumber(fake, 'chunkTokens')
  if (fakeChunk !== undefined) chunkTokens = fakeChunk

  // 回显档位自己的默认话术（要显示请求的模型名），其余档位用全局话术
  const profileText = profile?.id === ECHO_MODEL_ID ? settings.echoText : undefined
  const text = typeof fake?.text === 'string' ? fake.text : (profileText ?? settings.text)
  const toolName = bodyString(fake, 'toolName') ?? headers['x-fake-tool-name'] ?? settings.toolName
  const toolArgs = bodyString(fake, 'toolArgs') ?? settings.toolArgs

  return {
    kind,
    text,
    tps,
    ttftMs,
    status: Math.round(status),
    failAfterTokens: Math.max(0, Math.round(failAfterTokens)),
    chunkTokens: Math.max(0, Math.round(chunkTokens)),
    label: profile?.label ?? '默认档位',
    ...(fallback ? { fallbackFrom: model, fallbackTo: fallback.id } : {}),
    ...(kind === 'tool' ? { toolCall: { name: toolName, arguments: toolArgs } } : {}),
  }
}

/** 把剧本里的某一步叠加到基础行为上 */
export function applyScriptStep(base: Behavior, step: ScriptStep, settings: Settings, index: number): Behavior {
  const kind = step.kind ?? base.kind
  return {
    ...base,
    kind,
    text: step.text ?? base.text,
    tps: step.tps ?? base.tps,
    ttftMs: step.ttftMs ?? base.ttftMs,
    status: step.status ?? base.status,
    label: `${base.label} 第 ${index + 1} 步${step.note ? `（${step.note}）` : ''}`,
    ...(kind === 'tool'
      ? { toolCall: { name: step.toolName ?? settings.toolName, arguments: step.toolArgs ?? settings.toolArgs } }
      : { toolCall: undefined }),
  }
}
