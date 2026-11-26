import { describe, expect, it } from 'vitest'
import { countWith, createCounter, scaleUnits } from '../../src/core/tokenizer'

describe('精确计数（tiktoken / o200k_base）', () => {
  it('中文按真词表计数', () => {
    expect(countWith('tiktoken', '你好世界')).toBe(2)
    expect(countWith('tiktoken', '你好，world！123')).toBe(5)
  })

  it('空文本是 0', () => {
    expect(countWith('tiktoken', '')).toBe(0)
    expect(countWith('heuristic', '')).toBe(0)
  })

  it('启发式与 tiktoken 会给出不同数字', () => {
    const text = '你好世界'
    expect(countWith('heuristic', text)).toBe(4) // 逐字
    expect(countWith('tiktoken', text)).toBe(2) // 你好 / 世界
  })
})

describe('增量计数器', () => {
  it('跨分包累计与整段计数一致', () => {
    const counter = createCounter('tiktoken')
    counter.append('你好')
    const afterSecond = counter.append('世界')
    expect(afterSecond).toBe(2)
    expect(counter.count()).toBe(2)
  })

  it('分包接缝处的合并也会被算对', () => {
    const whole = countWith('tiktoken', 'hello world')
    const counter = createCounter('tiktoken')
    counter.append('hello')
    counter.append(' world')
    expect(counter.count()).toBe(whole)
  })

  it('heuristic 模式逐段累加', () => {
    const counter = createCounter('heuristic', 'char')
    counter.append('你好')
    expect(counter.append('世界')).toBe(4)
  })
})

describe('scaleUnits', () => {
  it('按精确总数等比缩放权重', () => {
    const units = [
      { text: '你', tokens: 1 },
      { text: '好', tokens: 1 },
    ]
    const scaled = scaleUnits(units, 1)
    expect(scaled.reduce((sum, unit) => sum + unit.tokens, 0)).toBeCloseTo(1)
    expect(scaled.map((unit) => unit.text)).toEqual(['你', '好'])
  })

  it('总数一致时原样返回', () => {
    const units = [{ text: 'ab', tokens: 2 }]
    expect(scaleUnits(units, 2)).toBe(units)
  })
})
