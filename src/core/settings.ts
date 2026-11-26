import { z } from 'zod'

/** 默认话术：刻意覆盖多段落、中英混排、标点、换行，方便验证分片拼接 */
export const DEFAULT_TEXT = `【假 LLM 提供商】收到请求了（nonce={{nonce}}，模型 {{model}}）。
这是一段固定回复，用来验证流式解析、UTF-8 分片和多字节字符拼接是否正常。
下面几句英文用来检查拉丁文分词与空格处理：The quick brown fox jumps over the lazy dog, 0123456789.
最后一句用来检查标点、引号"与"换行。

第二段：如果客户端把 chunk 拼错了，这里就会出现重复或缺失。
—— 完 ——`

export const settingsSchema = z.object({
  /** 默认回复来源 */
  mode: z.enum(['fixed', 'manual', 'instant']).default('fixed'),
  /** 固定话术，支持 {{model}} {{nonce}} {{id}} {{created}} {{prompt_tokens}} {{datetime}} */
  text: z.string().default(DEFAULT_TEXT),
  /** 目标速度（单位由 unit 决定） */
  tps: z.number().min(0).max(100_000).default(20),
  /** 首字延迟（毫秒） */
  ttftMs: z.number().min(0).max(600_000).default(300),
  /** 切分单位 */
  unit: z.enum(['char', 'token', 'word']).default('token'),
  /** 单个 SSE 分包最多携带多少 token，0 = 按 TPS 自动 */
  chunkTokens: z.number().min(0).max(8192).default(0),
  /** 人工回复等待时的心跳间隔 */
  heartbeatMs: z.number().min(500).max(120_000).default(10_000),
  /** 心跳形式 */
  heartbeatStyle: z.enum(['comment', 'empty-delta', 'off']).default('comment'),
  /** 人工回复最长空等时间 */
  manualTimeoutMs: z.number().min(1_000).max(3_600_000).default(180_000),
  /** 空等超时后的行为 */
  onManualTimeout: z.enum(['fallback', 'abort', 'hold']).default('fallback'),
  /** 超时兜底话术 */
  fallbackText: z.string().default('（人工回复超时，这是自动兜底的一段文字。）'),
  /** 非流式请求是否也模拟耗时 */
  simulateDuration: z.boolean().default(true),
  /** 未知模型名落到哪个档位 */
  defaultModel: z.string().default('fake-fixed'),
  /** 允许的 API Key，空数组 = 不校验 */
  apiKeys: z.array(z.string()).default([]),
  /** CORS 允许的来源 */
  cors: z.string().default('*'),
  /** 管理台保留多少条请求记录 */
  logLimit: z.number().min(10).max(5_000).default(200),
  /** 严格模式：请求字段不合规直接 400（默认只体检不拦截） */
  strict: z.boolean().default(false),
})

export type Settings = z.infer<typeof settingsSchema>

/** 全默认值（同时被 zod 校验过一遍，保证类型与运行时一致） */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({})

const NUMERIC_KEYS = [
  'tps',
  'ttftMs',
  'chunkTokens',
  'heartbeatMs',
  'manualTimeoutMs',
  'logLimit',
] as const

/** 环境变量名 → 设置字段 */
const ENV_MAP: Record<string, keyof Settings> = {
  MODE: 'mode',
  TEXT: 'text',
  TPS: 'tps',
  TTFT_MS: 'ttftMs',
  UNIT: 'unit',
  CHUNK_TOKENS: 'chunkTokens',
  HEARTBEAT_MS: 'heartbeatMs',
  HEARTBEAT_STYLE: 'heartbeatStyle',
  MANUAL_TIMEOUT_MS: 'manualTimeoutMs',
  ON_MANUAL_TIMEOUT: 'onManualTimeout',
  FALLBACK_TEXT: 'fallbackText',
  SIMULATE_DURATION: 'simulateDuration',
  DEFAULT_MODEL: 'defaultModel',
  API_KEYS: 'apiKeys',
  CORS: 'cors',
  LOG_LIMIT: 'logLimit',
  STRICT: 'strict',
}

/**
 * 把 Node 的 process.env / Worker 的 env 对象里的字符串值转成设置对象的一部分。
 * 非法值直接抛错，避免带着半个配置启动。
 */
export function settingsFromEnv(env: Record<string, string | undefined>): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [envKey, field] of Object.entries(ENV_MAP)) {
    const raw = env[envKey]
    if (raw === undefined || raw === '') continue
    if (field === 'apiKeys') {
      out[field] = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      continue
    }
    if (field === 'simulateDuration' || field === 'strict') {
      out[field] = !/^(0|false|no|off)$/i.test(raw)
      continue
    }
    if ((NUMERIC_KEYS as readonly string[]).includes(field)) {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`环境变量 ${envKey} 不是数字：${raw}`)
      out[field] = n
      continue
    }
    out[field] = raw
  }
  return settingsSchema.partial().parse(out) as Partial<Settings>
}

/** 合并默认值并按 schema 校验；抛错信息带字段路径，便于启动时报清楚 */
export function mergeSettings(...parts: Array<Partial<Settings> | undefined>): Settings {
  const merged: Record<string, unknown> = {}
  for (const part of parts) {
    if (!part) continue
    for (const [k, v] of Object.entries(part)) {
      if (v !== undefined) merged[k] = v
    }
  }
  return settingsSchema.parse({ ...DEFAULT_SETTINGS, ...merged })
}
