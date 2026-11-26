import { describe, expect, it } from 'vitest'
import { ECHO_MODEL_ID, MODEL_PROFILES, modelInfos, resolveBehavior } from '../../src/core/models'
import { DEFAULT_ECHO_TEXT, mergeSettings } from '../../src/core/settings'

const noHeaders: Record<string, string | undefined> = {}

function resolve(
  model: string,
  overrides: Parameters<typeof mergeSettings>[0] = {},
  headers: Record<string, string | undefined> = noHeaders,
  fake: Record<string, unknown> | null = null,
) {
  const settings = mergeSettings(overrides)
  return resolveBehavior({ model, settings, headers, fake })
}

describe('模型名路由', () => {
  it('档位表里有 fake-echo，并且是默认回落点', () => {
    expect(MODEL_PROFILES.some((p) => p.id === ECHO_MODEL_ID)).toBe(true)
    expect(mergeSettings({}).defaultModel).toBe(ECHO_MODEL_ID)
    expect(modelInfos(mergeSettings({})).some((m) => m.id === ECHO_MODEL_ID)).toBe(true)
  })

  it('不认识的模型名回落到 fake-echo，并记住客户端发的名字', () => {
    const behavior = resolve('gpt-4o-mini')
    expect(behavior.kind).toBe('fixed')
    expect(behavior.label).toBe('回显模型名')
    expect(behavior.text).toBe(DEFAULT_ECHO_TEXT)
    expect(behavior.fallbackFrom).toBe('gpt-4o-mini')
    expect(behavior.fallbackTo).toBe(ECHO_MODEL_ID)
  })

  it('认识的名字不算回落', () => {
    const behavior = resolve('fake-fixed')
    expect(behavior.text).toBe(mergeSettings({}).text)
    expect(behavior.label).toBe('固定文本')
    expect(behavior.fallbackFrom).toBeUndefined()
  })

  it('显式请求 fake-echo 也不打回落标记', () => {
    const behavior = resolve(ECHO_MODEL_ID)
    expect(behavior.text).toBe(DEFAULT_ECHO_TEXT)
    expect(behavior.fallbackFrom).toBeUndefined()
  })

  it('回显话术可配置，且优先用请求体里的 fake.text', () => {
    expect(resolve('o3', { echoText: '模型 {{model}} 不认识' }).text).toBe('模型 {{model}} 不认识')
    const overridden = resolve('o3', {}, noHeaders, { text: '自定义话术' })
    expect(overridden.text).toBe('自定义话术')
    expect(overridden.fallbackFrom).toBe('o3')
  })

  it('DEFAULT_MODEL 换成别的档位时落到那个档位', () => {
    const behavior = resolve('claude-sonnet-5', { defaultModel: 'fake-manual' })
    expect(behavior.kind).toBe('manual')
    expect(behavior.fallbackTo).toBe('fake-manual')
  })

  it('DEFAULT_MODEL 为空或不是档位名时退回 MODE', () => {
    const noFallback = resolve('gpt-4o', { defaultModel: '', mode: 'instant' })
    expect(noFallback.kind).toBe('instant')
    expect(noFallback.fallbackFrom).toBeUndefined()

    const fakeOnlineName = resolve('gpt-4o', { defaultModel: 'gpt-4o' })
    expect(fakeOnlineName.kind).toBe('fixed')
    expect(fakeOnlineName.text).toBe(mergeSettings({}).text)
    expect(fakeOnlineName.fallbackFrom).toBeUndefined()
  })

  it('X-Fake-Kind 仍能覆盖回落档位的 kind，但话术还是回显话术', () => {
    const behavior = resolve('o3', {}, { 'x-fake-kind': 'instant' })
    expect(behavior.kind).toBe('instant')
    expect(behavior.text).toBe(DEFAULT_ECHO_TEXT)
    expect(behavior.fallbackFrom).toBe('o3')
  })
})
