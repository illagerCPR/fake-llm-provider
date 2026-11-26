import { describe, expect, it } from 'vitest'
import { countTokens, splitUnits, takeTokens } from '../../src/core/tokenize'

const SAMPLES = [
  '你好，世界！',
  'The quick brown fox jumps over the lazy dog.',
  '中英混排 mixed 文本 12345 与标点。',
  '多行\n文本\r\n带\t制表符',
  'emoji 😀🙂 与代理对 𝄞',
  '  前后都有空白  ',
  '全角标点，。！？；：“引号”',
  '',
]

describe('splitUnits', () => {
  it('切完拼回去与原文逐字节相同', () => {
    for (const sample of SAMPLES) {
      for (const mode of ['char', 'token', 'word'] as const) {
        const joined = splitUnits(sample, mode)
          .map((u) => u.text)
          .join('')
        expect(joined, `${mode} / ${JSON.stringify(sample)}`).toBe(sample)
      }
    }
  })

  it('char 模式每个码位一个单元', () => {
    const units = splitUnits('a你😀', 'char')
    expect(units.map((u) => u.text)).toEqual(['a', '你', '😀'])
    expect(units.every((u) => u.tokens === 1)).toBe(true)
  })

  it('token 模式汉字逐字、拉丁按 4 字符切', () => {
    expect(countTokens('你好', 'token')).toBe(2)
    expect(countTokens('hello', 'token')).toBe(2)
    expect(countTokens('hello world', 'token')).toBe(4) // hell+o, worl+d
  })

  it('word 模式按词计数', () => {
    expect(countTokens('hello world', 'word')).toBe(2)
    expect(countTokens('你好世界', 'word')).toBe(4)
  })

  it('空白不额外产生 token', () => {
    expect(countTokens('a b', 'token')).toBe(2)
  })

  it('空文本没有单元', () => {
    expect(splitUnits('', 'token')).toEqual([])
    expect(countTokens('', 'token')).toBe(0)
  })
})

describe('takeTokens', () => {
  it('按上限截断且不破坏文本', () => {
    const source = '你好世界朋友'
    const result = takeTokens(source, 'char', 3)
    expect(result.tokens).toBe(3)
    expect(result.text).toBe('你好世')
    expect(source.startsWith(result.text)).toBe(true)
  })

  it('上限大于总量时原样返回', () => {
    const result = takeTokens('abc', 'char', 99)
    expect(result.text).toBe('abc')
    expect(result.tokens).toBe(3)
  })
})
