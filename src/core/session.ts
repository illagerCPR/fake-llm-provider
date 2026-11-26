import type { LintItem, Protocol, ProfileKind, RequestRecord, StopReason } from './types'

export type SessionState = 'waiting_human' | 'streaming' | 'finished' | 'aborted' | 'error'

export type Command =
  | { type: 'say'; text: string }
  | { type: 'finish' }
  | { type: 'abort'; reason: string }

export interface SessionInit {
  key: string
  /** 协议侧可见的 id（chatcmpl-… / msg_…） */
  id: string
  nonce: string
  protocol: Protocol
  model: string
  kind: ProfileKind
  stream: boolean
  tps: number
  ttftMs: number
  promptTokens: number
  createdAt: number
  record: RequestRecord
}

export interface SessionSnapshot {
  key: string
  id: string
  protocol: Protocol
  model: string
  kind: ProfileKind
  stream: boolean
  state: SessionState
  createdAt: number
  finishedAt?: number
  tps: number
  ttftMs: number
  promptTokens: number
  emittedTokens: number
  emittedChars: number
  chunks: number
  achievedTps: number
  finishReason?: StopReason
  error?: string
  queueLength: number
  lint: LintItem[]
  request: RequestRecord
  emittedPreview: string
}

/**
 * 一次请求的完整生命周期。流有两条来源：固定话术自己跑节拍，或由人一段段推。
 * 管理台通过 say/finish/abort 与它对话，driver 通过 next() 取指令。
 */
export class Session {
  readonly key: string
  readonly id: string
  readonly nonce: string
  readonly protocol: Protocol
  readonly model: string
  readonly kind: ProfileKind
  readonly stream: boolean
  readonly tps: number
  readonly ttftMs: number
  readonly promptTokens: number
  readonly createdAt: number
  readonly record: RequestRecord

  state: SessionState
  emittedTokens = 0
  emittedChars = 0
  chunks = 0
  firstTokenAt?: number
  finishedAt?: number
  achievedTps = 0
  finishReason?: StopReason
  errorMessage?: string

  private readonly emittedParts: string[] = []
  private queue: Command[] = []
  private waiter?: (command: Command | null) => void
  private closed = false
  private startedAt = 0

  constructor(init: SessionInit) {
    this.key = init.key
    this.id = init.id
    this.nonce = init.nonce
    this.protocol = init.protocol
    this.model = init.model
    this.kind = init.kind
    this.stream = init.stream
    this.tps = init.tps
    this.ttftMs = init.ttftMs
    this.promptTokens = init.promptTokens
    this.createdAt = init.createdAt
    this.record = init.record
    this.state = init.kind === 'manual' ? 'waiting_human' : 'streaming'
  }

  get isClosed(): boolean {
    return this.closed
  }

  get started(): boolean {
    return this.startedAt > 0
  }

  markStarted(at: number): void {
    if (this.startedAt === 0) this.startedAt = at
  }

  appendEmitted(chunk: string, tokens: number): void {
    if (chunk.length > 0) this.emittedParts.push(chunk)
    this.emittedChars += chunk.length
    this.emittedTokens += tokens
    this.chunks += 1
    if (this.firstTokenAt === undefined && chunk.length > 0) this.firstTokenAt = Date.now()
    if (this.state === 'waiting_human') this.state = 'streaming'
  }

  markFinished(reason: StopReason): void {
    this.state = reason === 'aborted' ? 'aborted' : 'finished'
    this.finishReason = reason
    this.finishedAt = Date.now()
    this.closed = true
    const elapsed = this.finishedAt - (this.startedAt || this.finishedAt)
    this.achievedTps = elapsed > 0 ? Math.round((this.emittedTokens / elapsed) * 1000 * 10) / 10 : 0
    this.wakeAll()
  }

  markAborted(reason: string): void {
    this.state = 'aborted'
    this.errorMessage = reason
    this.finishedAt = Date.now()
    this.closed = true
    this.wakeAll()
  }

  say(text: string): boolean {
    if (this.closed || text.length === 0) return false
    this.queue.push({ type: 'say', text })
    this.wake()
    return true
  }

  finish(): boolean {
    if (this.closed) return false
    this.queue.push({ type: 'finish' })
    this.wake()
    return true
  }

  abort(reason: string): boolean {
    if (this.closed) return false
    this.queue.push({ type: 'abort', reason })
    this.wake()
    return true
  }

  /** 拿下一段指令；超时返回 null（driver 用它发心跳、检查空闲时长） */
  next(timeoutMs: number): Promise<Command | null> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(null)
    return new Promise<Command | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        resolve(null)
      }, Math.max(50, timeoutMs))
      this.waiter = (command) => {
        clearTimeout(timer)
        this.waiter = undefined
        resolve(command)
      }
    })
  }

  private wake(): void {
    // 没有等待者时绝不能从队列里取走指令——否则命令会在 driver 还在吐字时被悄悄丢掉
    if (!this.waiter) return
    const command = this.queue.shift()
    if (!command) return
    const waiter = this.waiter
    this.waiter = undefined
    waiter(command)
  }

  private wakeAll(): void {
    this.wake()
  }

  snapshot(): SessionSnapshot {
    return {
      key: this.key,
      id: this.id,
      protocol: this.protocol,
      model: this.model,
      kind: this.kind,
      stream: this.stream,
      state: this.state,
      createdAt: this.createdAt,
      ...(this.finishedAt === undefined ? {} : { finishedAt: this.finishedAt }),
      tps: this.tps,
      ttftMs: this.ttftMs,
      promptTokens: this.promptTokens,
      emittedTokens: this.emittedTokens,
      emittedChars: this.emittedChars,
      chunks: this.chunks,
      achievedTps: this.achievedTps,
      ...(this.finishReason === undefined ? {} : { finishReason: this.finishReason }),
      ...(this.errorMessage === undefined ? {} : { error: this.errorMessage }),
      queueLength: this.queue.length,
      lint: this.record.lint,
      request: this.record,
      emittedPreview: this.emittedParts.join('').slice(-400),
    }
  }
}
