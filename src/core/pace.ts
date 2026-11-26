import { splitUnits } from './tokenize'
import type { UnitMode } from './types'

export interface PaceOptions {
  text: string
  /** 每秒多少个单位；<= 0 表示不限速、一次吐完 */
  tps: number
  unit: UnitMode
  /** 单个分包最多带多少 token；0/undefined = 按 TPS 自动（约 40ms 的量） */
  chunkTokens?: number
  /** 这段文本的精确 token 总数（tiktoken 模式下传入，节拍按它等比缩放） */
  totalTokens?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  emit: (chunk: string, tokens: number) => void
}

export interface PaceResult {
  tokens: number
  chunks: number
  elapsedMs: number
  aborted: boolean
  firstEmitAt?: number
}

const defaultNow = () => performance.now()
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 每包最多多少 token：约 40ms 的量，高 TPS 时不会碎成上万个包 */
function autoChunkTokens(tps: number): number {
  return Math.min(512, Math.max(1, Math.ceil(tps * 0.04)))
}

/**
 * 按绝对时间表平滑吐字。
 *
 * 目标时刻只用 `起点 + 已发 token 数 / tps` 计算，不累加 sleep：事件循环抖动造成的
 * 迟到会让下一轮一次多发几个 token 追上，因此**平均速度准**，分包粒度也像真实模型。
 * 内部先攒进 pending，攒够一包（chunkTokens）再吐，避免 1ms 一个包。
 */
export async function paceText(options: PaceOptions): Promise<PaceResult> {
  const now = options.now ?? defaultNow
  const sleep = options.sleep ?? defaultSleep
  const units = splitUnits(options.text, options.unit)
  const heuristicTotal = units.reduce((sum, unit) => sum + unit.tokens, 0)
  // 精确 token 数已知时，把每段权重等比缩放，速度按真 token 走
  const scale = options.totalTokens && options.totalTokens > 0 && heuristicTotal > 0 ? options.totalTokens / heuristicTotal : 1
  const weights = units.map((unit) => unit.tokens * scale)
  const totalTokens = weights.reduce((sum, weight) => sum + weight, 0)
  const startedAt = now()

  if (units.length === 0) {
    return { tokens: 0, chunks: 0, elapsedMs: 0, aborted: false }
  }

  if (options.tps <= 0) {
    options.emit(options.text, totalTokens)
    const at = now()
    return { tokens: totalTokens, chunks: 1, elapsedMs: at - startedAt, aborted: false, firstEmitAt: at }
  }

  const chunkLimit =
    options.chunkTokens !== undefined && options.chunkTokens > 0
      ? Math.min(8192, options.chunkTokens)
      : autoChunkTokens(options.tps)

  const msPerToken = 1000 / options.tps
  let emitted = 0
  let chunks = 0
  let firstEmitAt: number | undefined
  let cursor = 0
  let pending = ''
  let pendingTokens = 0

  const flush = (): void => {
    if (pending.length === 0 && pendingTokens === 0) return
    options.emit(pending, pendingTokens)
    chunks += 1
    pending = ''
    pendingTokens = 0
    if (firstEmitAt === undefined) firstEmitAt = now()
  }

  while (cursor < units.length) {
    if (options.signal?.aborted) {
      flush()
      return {
        tokens: emitted,
        chunks,
        elapsedMs: now() - startedAt,
        aborted: true,
        ...(firstEmitAt === undefined ? {} : { firstEmitAt }),
      }
    }

    const at = now()
    // 到现在为止"应当已经发出"的 token 数
    const budget = ((at - startedAt) / 1000) * options.tps
    if (emitted >= budget) {
      const nextDue = startedAt + (Math.floor(emitted) + 1) * msPerToken
      const wait = Math.max(1, Math.min(nextDue - at, 50))
      await sleep(wait)
      continue
    }

    const before = emitted
    while (cursor < units.length) {
      const dueAt = startedAt + emitted * msPerToken
      if (dueAt > at) break
      const unit = units[cursor]!
      const weight = weights[cursor] ?? unit.tokens
      pending += unit.text
      pendingTokens += weight
      emitted += weight
      cursor += 1
      if (pendingTokens >= chunkLimit) break
    }
    if (emitted === before && cursor >= units.length) break
    if (pendingTokens >= chunkLimit) flush()
  }

  flush()
  return {
    tokens: emitted,
    chunks,
    elapsedMs: now() - startedAt,
    aborted: false,
    ...(firstEmitAt === undefined ? {} : { firstEmitAt }),
  }
}
