import { countTokens as o200kCount, createIncrementalCounter } from 'gpt-tokenizer/encoding/o200k_base'
import { countTokens, splitUnits, type Unit } from './tokenize'
import type { UnitMode } from './types'

/**
 * token 计数方式：
 * - tiktoken：o200k_base 真词表，usage 里的数字和客户端用 tiktoken 数出来的一致
 * - heuristic：CJK 感知的估算，零依赖、快，但不等于任何真词表
 */
export type TokenizerMode = 'tiktoken' | 'heuristic'

export function countWith(tokenizer: TokenizerMode, text: string, unit: UnitMode = 'token'): number {
  if (text.length === 0) return 0
  if (tokenizer === 'heuristic') return countTokens(text, unit)
  return o200kCount(text)
}

export interface TokenCounter {
  /** 追加一段文本，返回当前的累计 token 数（跨分包边界也正确） */
  append(chunk: string): number
  count(): number
}

/**
 * 流式累加计数器。tiktoken 用官方的增量计数器（会重算分包接缝处的合并），
 * heuristic 则简单累加。
 */
export function createCounter(tokenizer: TokenizerMode, unit: UnitMode = 'token'): TokenCounter {
  if (tokenizer === 'tiktoken') {
    const counter = createIncrementalCounter()
    return {
      append: (chunk: string) => counter.append(chunk),
      count: () => counter.count(),
    }
  }
  let total = 0
  return {
    append: (chunk: string) => {
      total += countTokens(chunk, unit)
      return total
    },
    count: () => total,
  }
}

/**
 * 把按启发式切出来的单元权重，按精确 token 总数等比缩放。
 * 这样分包边界仍然沿用切分器（轻量、不破坏 UTF-8），但速度是按真 token 算的。
 */
export function scaleUnits(units: Unit[], totalTokens: number): Unit[] {
  const heuristicTotal = units.reduce((sum, unit) => sum + unit.tokens, 0)
  if (heuristicTotal <= 0 || totalTokens <= 0 || totalTokens === heuristicTotal) return units
  const scale = totalTokens / heuristicTotal
  return units.map((unit) => ({ text: unit.text, tokens: unit.tokens * scale }))
}

/** 便于测试：只拿切分单元，不关心节拍 */
export function unitsFor(text: string, unit: UnitMode): Unit[] {
  return splitUnits(text, unit)
}
