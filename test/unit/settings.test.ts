import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, settingsFromEnv, settingsSchema } from '../../src/core/settings'

describe('settings', () => {
  it('默认值来自 schema', () => {
    const parsed = settingsSchema.parse({})
    expect(parsed.mode).toBe('fixed')
    expect(parsed.unit).toBe('token')
    expect(parsed.tps).toBe(20)
    expect(parsed.apiKeys).toEqual([])
    expect(DEFAULT_SETTINGS.text).toContain('{{nonce}}')
  })

  it('从环境变量解析数字、布尔和数组', () => {
    const parsed = settingsFromEnv({
      TPS: '42',
      TTFT_MS: '800',
      SIMULATE_DURATION: 'false',
      API_KEYS: 'sk-a, sk-b ,,',
      MODE: 'manual',
      UNIT: 'char',
    })
    expect(parsed.tps).toBe(42)
    expect(parsed.ttftMs).toBe(800)
    expect(parsed.simulateDuration).toBe(false)
    expect(parsed.apiKeys).toEqual(['sk-a', 'sk-b'])
    expect(parsed.mode).toBe('manual')
    expect(parsed.unit).toBe('char')
  })

  it('非数字环境变量直接报错', () => {
    expect(() => settingsFromEnv({ TPS: 'abc' })).toThrow(/不是数字/)
  })

  it('mergeSettings 会校验范围', () => {
    expect(() => mergeSettings({ tps: 999_999 })).toThrow()
    expect(mergeSettings({ tps: 5 }).tps).toBe(5)
  })

  it('后传入的值覆盖前面的值', () => {
    const merged = mergeSettings({ tps: 5, text: 'a' }, { text: 'b' })
    expect(merged.tps).toBe(5)
    expect(merged.text).toBe('b')
  })
})
