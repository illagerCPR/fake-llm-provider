/**
 * 跨运行时共享的类型定义。core/ 里不允许出现 node:* 或 workerd 专有 API。
 */

export type Protocol = 'openai' | 'anthropic'

/** 文本切分单位：字 / CJK 感知的近似 token / 词 */
export type UnitMode = 'char' | 'token' | 'word'

/** 回复来源：固定文本 / 人工 / 一次性吐完 */
export type ReplyMode = 'fixed' | 'manual' | 'instant'

/** 档位：由模型名或请求参数指定 */
export type ProfileKind = 'fixed' | 'manual' | 'instant' | 'slow' | 'fail' | 'truncate'

/** 停止原因（两种协议各自映射） */
export type StopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'aborted'

export interface ChatMessage {
  role: string
  content: unknown
}

/** 归一化后的请求 */
export interface NormalizedRequest {
  protocol: Protocol
  model: string
  stream: boolean
  messages: ChatMessage[]
  /** 用于估算 prompt_tokens 的纯文本 */
  promptText: string
  maxTokens?: number
  temperature?: number
  hasTools: boolean
  streamIncludeUsage: boolean
  raw: unknown
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** SSE 帧：事件行或注释行（注释用于保活，不进客户端内容） */
export type Frame =
  | { kind: 'event'; event?: string; data: string }
  | { kind: 'comment'; text: string }

/** 调用体检的一条结论 */
export interface LintItem {
  level: 'ok' | 'warn' | 'fail'
  label: string
  detail?: string
}

/** 一次请求在管理台上的样子 */
export interface RequestRecord {
  key: string
  protocol: Protocol
  path: string
  method: string
  model: string
  stream: boolean
  headers: Record<string, string>
  body: unknown
  promptTokens: number
  startedAt: number
  finishedAt?: number
  status?: number
  error?: string
  lint: LintItem[]
}
