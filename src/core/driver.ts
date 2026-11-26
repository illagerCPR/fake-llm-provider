import type { Behavior } from './models'
import { paceText } from './pace'
import type { ProtocolAdapter, StreamInit } from './protocol/types'
import type { Session } from './session'
import type { Settings } from './settings'
import { expandTemplate, nowStamp } from './templates'
import { takeTokens } from './tokenize'
import { countWith, createCounter } from './tokenizer'
import type { Frame, StopReason, Usage } from './types'

export interface ReplyResult {
  text: string
  /** aborted 表示没有正常收尾（断流 / 掐断），调用方不要再发结束帧 */
  reason: StopReason
  tokens: number
  elapsedMs: number
  truncated: boolean
}

export interface ReplyContext {
  session: Session
  behavior: Behavior
  settings: Settings
  signal?: AbortSignal
  now: () => number
  sleep: (ms: number) => Promise<void>
  onDelta: (text: string, tokens: number) => void
  onHeartbeat?: () => void
}

function templateVars(session: Session): Record<string, string | number> {
  return {
    model: session.model,
    nonce: session.nonce,
    id: session.id,
    created: Math.floor(session.createdAt / 1000),
    prompt_tokens: session.promptTokens,
    datetime: nowStamp(Date.now()),
  }
}

/**
 * 真正的"吐字"过程：固定话术走节拍器，人工模式等人推，工具档位吐的是参数 JSON。
 * 不负责发帧、不负责收尾状态——那些交给调用方，便于流式/非流式复用。
 */
export async function runReply(ctx: ReplyContext): Promise<ReplyResult> {
  const { session, behavior, settings } = ctx
  const startedAt = ctx.now()
  const parts: string[] = []
  const counter = createCounter(settings.tokenizer, settings.unit)
  let tokens = 0
  let truncated = false
  let reason: StopReason = 'stop'

  // 精确计数交给 counter（tiktoken 会处理分包接缝处的合并），节拍器只负责发
  const emit = (text: string) => {
    const total = counter.append(text)
    const delta = total - tokens
    tokens = total
    parts.push(text)
    ctx.onDelta(text, delta)
  }

  const paceChunk = (text: string) =>
    paceText({
      text,
      tps: behavior.tps,
      unit: settings.unit,
      chunkTokens: behavior.chunkTokens,
      totalTokens: countWith(settings.tokenizer, text, settings.unit),
      now: ctx.now,
      sleep: ctx.sleep,
      emit,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

  const manualLoop = async (): Promise<void> => {
    let idleSince = ctx.now()
    for (;;) {
      if (ctx.signal?.aborted) {
        reason = 'aborted'
        return
      }
      const command = await session.next(settings.heartbeatMs)
      if (command) {
        if (command.type === 'say') {
          idleSince = ctx.now()
          await paceChunk(expandTemplate(command.text, templateVars(session)))
          idleSince = ctx.now()
          continue
        }
        if (command.type === 'finish') return
        session.markAborted(command.reason)
        reason = 'aborted'
        return
      }
      if (session.isClosed) {
        reason = 'aborted'
        return
      }
      // 空等：发心跳，顺手判断是否超时
      ctx.onHeartbeat?.()
      if (ctx.now() - idleSince >= settings.manualTimeoutMs) {
        if (settings.onManualTimeout === 'fallback') {
          await paceChunk(settings.fallbackText)
          return
        }
        if (settings.onManualTimeout === 'abort') {
          session.markAborted('manual reply timeout')
          reason = 'aborted'
          return
        }
        // hold：什么都不做，继续挂着（用来打客户端超时）
      }
    }
  }

  switch (behavior.kind) {
    case 'fail': {
      // 正常不会走到这里（调用方在开流之前就返回错误体了）
      reason = 'stop'
      break
    }
    case 'tool': {
      await paceChunk(behavior.toolCall?.arguments ?? '{}')
      reason = 'tool_calls'
      break
    }
    case 'truncate': {
      const partial = takeTokens(expandTemplate(behavior.text, templateVars(session)), settings.unit, behavior.failAfterTokens)
      const result = await paceChunk(partial.text)
      truncated = !result.aborted
      reason = 'aborted'
      break
    }
    case 'manual': {
      await manualLoop()
      break
    }
    default: {
      const text = expandTemplate(behavior.text, templateVars(session))
      const result = await paceChunk(text)
      reason = result.aborted ? 'aborted' : 'stop'
      break
    }
  }

  return {
    text: parts.join(''),
    reason,
    tokens,
    elapsedMs: ctx.now() - startedAt,
    truncated,
  }
}

export interface DriveStreamContext {
  session: Session
  adapter: ProtocolAdapter
  behavior: Behavior
  settings: Settings
  init: StreamInit
  signal: AbortSignal
  emit: (frame: Frame) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export function buildStreamInit(session: Session, includeUsage: boolean): StreamInit {
  return {
    id: session.id,
    model: session.model,
    createdAt: Math.floor(session.createdAt / 1000),
    promptTokens: session.promptTokens,
    includeUsage,
  }
}

/** 流式：发首帧 → 吐字 → 收尾；掐断时故意不发结束帧 */
export async function driveStream(ctx: DriveStreamContext): Promise<void> {
  const { session, adapter, behavior } = ctx
  const tool = behavior.toolCall
  const callId = `call_fake_${session.nonce}`
  const emitFrames = (frames: Frame[]) => {
    for (const frame of frames) ctx.emit(frame)
  }

  // 人工模式立刻发首包，让客户端马上进入"正在生成"；其余模式先等首字延迟
  if (behavior.kind !== 'manual' && behavior.ttftMs > 0) await ctx.sleep(behavior.ttftMs)

  session.markStarted(ctx.now())
  if (tool) emitFrames(adapter.streamToolStart(ctx.init, tool, callId))
  else emitFrames(adapter.streamStart(ctx.init))

  const usage: Usage = { inputTokens: session.promptTokens, outputTokens: 0 }
  const result = await runReply({
    session,
    behavior,
    settings: ctx.settings,
    signal: ctx.signal,
    now: ctx.now,
    sleep: ctx.sleep,
    onDelta: (text, tokens) => {
      usage.outputTokens += tokens
      session.appendEmitted(text, tokens)
      emitFrames(tool ? adapter.streamToolDelta(text, ctx.init) : adapter.streamDelta(text, ctx.init))
    },
    onHeartbeat: () => {
      const heartbeat = adapter.streamHeartbeat(ctx.settings.heartbeatStyle)
      if (heartbeat) emitFrames([heartbeat])
    },
  })

  if (result.reason === 'aborted' || session.state === 'aborted' || ctx.signal.aborted) {
    if (!session.isClosed) session.markAborted(ctx.signal.aborted ? 'client disconnected' : 'aborted by upstream')
    return
  }

  emitFrames(adapter.streamEnd(result.reason, usage, ctx.init))
  session.markFinished(result.reason)
}

export interface CompleteContext {
  session: Session
  adapter: ProtocolAdapter
  behavior: Behavior
  settings: Settings
  init: StreamInit
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** 非流式：等"生成"完再一次性返回；时长与流式一致，方便测超时 */
export async function completeOnce(ctx: CompleteContext): Promise<unknown> {
  const { session, adapter, settings } = ctx
  // 非流式默认也模拟"生成耗时"，方便测超时；关掉 simulateDuration 就立即返回
  const behavior = settings.simulateDuration ? ctx.behavior : { ...ctx.behavior, tps: 0, ttftMs: 0 }
  const tool = behavior.toolCall
  const callId = `call_fake_${session.nonce}`

  if (behavior.ttftMs > 0) await ctx.sleep(behavior.ttftMs)
  session.markStarted(ctx.now())

  const usage: Usage = { inputTokens: session.promptTokens, outputTokens: 0 }
  const result = await runReply({
    session,
    behavior,
    settings,
    now: ctx.now,
    sleep: ctx.sleep,
    onDelta: (text, tokens) => {
      usage.outputTokens += tokens
      session.appendEmitted(text, tokens)
    },
  })

  const reason: StopReason = tool
    ? 'tool_calls'
    : result.truncated
      ? 'length'
      : result.reason === 'aborted'
        ? 'stop'
        : result.reason
  session.markFinished(reason)
  return tool ? adapter.completeTool(tool, callId, usage, ctx.init) : adapter.complete(result.text, reason, usage, ctx.init)
}
