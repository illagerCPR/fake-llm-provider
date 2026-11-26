import { describe, expect, it } from 'vitest'
import { paceText } from '../../src/core/pace'

/** 虚拟时钟：sleep 直接把时间往前拨，测试跑在微任务里，结果稳定 */
function virtualClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

function repeat(text: string, times: number): string {
  return text.repeat(times)
}

describe('paceText', () => {
  it('按 TPS 控制总时长（100 token / 100 tps ≈ 1s）', async () => {
    const clock = virtualClock()
    const chunks: string[] = []
    const source = repeat('你', 100)
    const result = await paceText({
      text: source,
      tps: 100,
      unit: 'char',
      now: clock.now,
      sleep: clock.sleep,
      emit: (chunk) => chunks.push(chunk),
    })
    expect(result.tokens).toBe(100)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900)
    expect(result.elapsedMs).toBeLessThanOrEqual(1150)
    expect(chunks.join('')).toBe(source)
  })

  it('低 TPS 也准（5 token/s，20 token ≈ 4s）', async () => {
    const clock = virtualClock()
    const source = repeat('字', 20)
    const result = await paceText({
      text: source,
      tps: 5,
      unit: 'char',
      now: clock.now,
      sleep: clock.sleep,
      emit: () => undefined,
    })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3800)
    expect(result.elapsedMs).toBeLessThanOrEqual(4200)
  })

  it('高 TPS 会合批，不会碎成上千包', async () => {
    const clock = virtualClock()
    let chunks = 0
    const source = repeat('a', 400)
    const result = await paceText({
      text: source,
      tps: 2000,
      unit: 'char',
      now: clock.now,
      sleep: clock.sleep,
      emit: () => {
        chunks += 1
      },
    })
    expect(result.tokens).toBe(400)
    expect(chunks).toBeLessThan(40)
    expect(result.elapsedMs).toBeLessThanOrEqual(400)
  })

  it('tps <= 0 表示不限速，一次吐完', async () => {
    let calls = 0
    const result = await paceText({
      text: '你好世界',
      tps: 0,
      unit: 'char',
      emit: () => {
        calls += 1
      },
    })
    expect(calls).toBe(1)
    expect(result.elapsedMs).toBeLessThan(5)
  })

  it('提前 abort 时返回 aborted 且只发出部分内容', async () => {
    const clock = virtualClock()
    const controller = new AbortController()
    const parts: string[] = []
    let emitted = 0
    const result = await paceText({
      text: repeat('x', 100),
      tps: 100,
      unit: 'char',
      now: clock.now,
      sleep: clock.sleep,
      signal: controller.signal,
      emit: (chunk) => {
        parts.push(chunk)
        emitted += 1
        if (emitted === 3) controller.abort()
      },
    })
    expect(result.aborted).toBe(true)
    expect(result.tokens).toBeLessThan(100)
    expect(parts.join('').length).toBe(result.tokens)
  })

  it('chunkTokens 限制单包大小', async () => {
    const sizes: number[] = []
    await paceText({
      text: repeat('a', 50),
      tps: 100,
      unit: 'char',
      chunkTokens: 3,
      emit: (chunk) => sizes.push(chunk.length),
    })
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3)
  })
})
