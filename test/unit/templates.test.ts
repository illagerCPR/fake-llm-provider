import { describe, expect, it } from 'vitest'
import { expandTemplate, nowStamp, shortNonce } from '../../src/core/templates'

describe('expandTemplate', () => {
  it('替换已知变量', () => {
    expect(expandTemplate('模型 {{model}} / {{ nonce }}', { model: 'fake-fixed', nonce: 'abc12345' })).toBe(
      '模型 fake-fixed / abc12345',
    )
  })

  it('未知变量原样保留', () => {
    expect(expandTemplate('{{unknown_var}}', {})).toBe('{{unknown_var}}')
  })

  it('大小写不敏感', () => {
    expect(expandTemplate('{{MODEL}}', { model: 'x' })).toBe('x')
  })

  it('数字变量转字符串', () => {
    expect(expandTemplate('{{prompt_tokens}}', { prompt_tokens: 12 })).toBe('12')
  })
})

describe('shortNonce', () => {
  it('是 8 位十六进制', () => {
    const nonce = shortNonce()
    expect(nonce).toMatch(/^[0-9a-f]{8}$/)
  })

  it('每次不同', () => {
    const set = new Set(Array.from({ length: 20 }, () => shortNonce()))
    expect(set.size).toBe(20)
  })
})

describe('nowStamp', () => {
  it('输出可读时间', () => {
    expect(nowStamp(Date.UTC(2026, 10, 26, 10, 0, 0))).toBe('2026-11-26 10:00:00Z')
  })
})
