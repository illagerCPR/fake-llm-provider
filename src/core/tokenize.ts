import type { UnitMode } from './types'

/**
 * 一个可发送单元：text 是要原样发出的字符串，tokens 是它的"假 token"权重。
 * 所有单元的 text 拼起来必须与输入逐字节相同（有单测守着）。
 */
export interface Unit {
  text: string
  tokens: number
}

const CJK_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2fdf], // CJK 部首
  [0x3000, 0x303f], // CJK 标点（含全角空格）
  [0x3040, 0x30ff], // 假名
  [0x3130, 0x318f], // Hangul 兼容字母
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa960, 0xa97f],
  [0xac00, 0xd7af], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef], // 全角/半角形式
]

function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch)
}

/** 拉丁词按 4 字符切一刀，模拟 BPE 的粗粒度分包 */
const WORD_PIECE = 4

/**
 * 切分文本。不破坏代理对（emoji）与组合字符的基本场景：一律按 code point 迭代。
 * - char：每个码位一个单元
 * - token：CJK 逐字、拉丁按 4 字符、标点逐个；空白附着到前一个单元上
 * - word：CJK 逐字、拉丁按词
 */
export function splitUnits(text: string, mode: UnitMode): Unit[] {
  if (text.length === 0) return []
  if (mode === 'char') {
    return Array.from(text).map((ch) => ({ text: ch, tokens: 1 }))
  }

  const chars = Array.from(text)
  const units: Unit[] = []
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]!
    if (isSpace(ch)) {
      // 空白并入前一个单元，避免凭空多出 token；开头的空白自成一个零权重单元
      const prev = units[units.length - 1]
      if (prev) prev.text += ch
      else units.push({ text: ch, tokens: 0 })
      i += 1
      continue
    }
    if (isCjk(ch)) {
      units.push({ text: ch, tokens: 1 })
      i += 1
      continue
    }
    if (isWordChar(ch)) {
      let run = ''
      while (i < chars.length && isWordChar(chars[i]!)) {
        run += chars[i]
        i += 1
      }
      if (mode === 'word') {
        units.push({ text: run, tokens: 1 })
      } else {
        for (let k = 0; k < run.length; k += WORD_PIECE) {
          units.push({ text: run.slice(k, k + WORD_PIECE), tokens: 1 })
        }
      }
      continue
    }
    units.push({ text: ch, tokens: 1 })
    i += 1
  }
  return units
}

/** 数一下这段文本按指定单位算多少 token */
export function countTokens(text: string, mode: UnitMode = 'token'): number {
  let n = 0
  for (const unit of splitUnits(text, mode)) n += unit.tokens
  return n
}

/** 把一段可能很长的文本截到指定 token 数以内（用于 truncate 档位） */
export function takeTokens(text: string, mode: UnitMode, limit: number): { text: string; tokens: number } {
  let out = ''
  let tokens = 0
  for (const unit of splitUnits(text, mode)) {
    if (tokens >= limit) break
    out += unit.text
    tokens += unit.tokens
  }
  return { text: out, tokens }
}
