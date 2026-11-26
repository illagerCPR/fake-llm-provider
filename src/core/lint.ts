import type { LintItem, NormalizedRequest } from './types'

/**
 * 调用体检：把"一次调用像不像样子"翻译成几条结论。
 * 目标不是拦截（strict 才拦截），而是让管理台一眼看出客户端哪里没传。
 */
export function lintRequest(input: {
  request: NormalizedRequest
  headers: Record<string, string | undefined>
  apiKeys: string[]
}): LintItem[] {
  const { request, headers, apiKeys } = input
  const items: LintItem[] = []
  const requireKey = apiKeys.length > 0

  if (request.protocol === 'openai') {
    const auth = headers['authorization']
    if (!auth) {
      items.push({
        level: requireKey ? 'fail' : 'warn',
        label: '缺少 Authorization 头',
        detail: '上游要求 Bearer 形式；如果客户端从没带过，多半是 baseURL/鉴权配置漏了',
      })
    } else if (!/^Bearer\s+\S+/i.test(auth)) {
      items.push({ level: 'fail', label: 'Authorization 不是 Bearer 形式', detail: auth.slice(0, 24) })
    } else {
      items.push({ level: 'ok', label: '带 Bearer 鉴权头' })
    }

    if (!request.model) {
      items.push({ level: 'fail', label: '缺少 model 字段' })
    } else {
      items.push({ level: 'ok', label: `model = ${request.model}` })
    }

    if (request.messages.length === 0) {
      items.push({ level: 'fail', label: 'messages 为空' })
    }

    if (request.stream && !request.streamIncludeUsage) {
      items.push({
        level: 'warn',
        label: '流式请求没带 stream_options.include_usage',
        detail: '结束包不会带 usage，客户端若依赖用量统计会拿到 null',
      })
    }

    if (request.temperature === undefined) {
      items.push({ level: 'warn', label: '没传 temperature', detail: '默认可接受，但测试确定性时通常需要显式传' })
    }

    if (request.maxTokens === undefined) {
      items.push({ level: 'warn', label: '没传 max_tokens', detail: '上游会用自己的默认上限' })
    }

    if (request.hasTools) {
      items.push({ level: 'ok', label: '携带 tools 定义' })
    }
  } else {
    const key = headers['x-api-key']
    if (!key) {
      items.push({ level: requireKey ? 'fail' : 'warn', label: '缺少 x-api-key 头' })
    } else {
      items.push({ level: 'ok', label: '带 x-api-key' })
    }

    if (!headers['anthropic-version']) {
      items.push({
        level: 'warn',
        label: '缺少 anthropic-version 头',
        detail: '官方 SDK 一定会带；手写请求容易漏，部分服务端会直接 400',
      })
    } else {
      items.push({ level: 'ok', label: `anthropic-version = ${headers['anthropic-version']}` })
    }

    if (!request.model) {
      items.push({ level: 'fail', label: '缺少 model 字段' })
    } else {
      items.push({ level: 'ok', label: `model = ${request.model}` })
    }

    if (request.maxTokens === undefined) {
      items.push({ level: 'fail', label: '缺少 max_tokens', detail: 'Anthropic Messages 接口必填' })
    }

    if (request.messages.length === 0) {
      items.push({ level: 'fail', label: 'messages 为空' })
    }

    if (request.hasTools) {
      items.push({ level: 'ok', label: '携带 tools 定义' })
    }
  }

  return items
}

export function hasBlockingLint(items: LintItem[]): boolean {
  return items.some((item) => item.level === 'fail')
}
