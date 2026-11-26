/**
 * 话术模板：{{model}} / {{nonce}} / {{id}} / {{created}} / {{prompt_tokens}} / {{datetime}}
 * 未知变量原样保留，方便肉眼发现拼错的名字。
 */
export function expandTemplate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const key = name.toLowerCase()
    const value = vars[key]
    return value === undefined ? whole : String(value)
  })
}

/** 生成一个短随机串，用来给每次回复打上唯一标记（验证去重 / 缓存 / 拼接） */
export function shortNonce(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function nowStamp(now: number): string {
  return new Date(now).toISOString().replace('T', ' ').replace(/\..+$/, 'Z')
}
