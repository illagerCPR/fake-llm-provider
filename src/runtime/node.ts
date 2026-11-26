import { serve } from '@hono/node-server'
import type { Context } from 'hono'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createApp } from '../core/app'
import { MemoryHub } from '../core/hub'
import { mergeSettings, settingsFromEnv } from '../core/settings'
import type { RequestRecord } from '../core/types'
import { APP_VERSION } from '../core/version'

const uiRoot = path.resolve(process.env.UI_DIR ?? 'dist/ui')
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

async function loadHistory(file: string, limit: number): Promise<RequestRecord[]> {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean).slice(-limit)
    const records: RequestRecord[] = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as RequestRecord)
      } catch {
        // 跳过坏行（进程被杀时最后一行可能不完整）
      }
    }
    return records.reverse()
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  let settings
  try {
    settings = mergeSettings(settingsFromEnv(process.env))
  } catch (error) {
    console.error('[fake-llm] 配置有问题：', error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const historyFile = dataDir ? path.join(dataDir, 'requests.jsonl') : undefined
  const history = historyFile ? await loadHistory(historyFile, settings.logLimit) : []
  if (dataDir) await mkdir(dataDir, { recursive: true })

  const hub = new MemoryHub(settings, {
    initialRequests: history,
    ...(historyFile
      ? {
          onRecord: (record: RequestRecord) => {
            void writeFile(historyFile, `${JSON.stringify(record)}\n`, { flag: 'a' }).catch(() => undefined)
          },
        }
      : {}),
  })

  const app = createApp({
    hub,
    env: {
      version: APP_VERSION,
      runtime: 'node',
      ...(process.env.ADMIN_TOKEN ? { adminToken: process.env.ADMIN_TOKEN } : {}),
      allowAdminWithoutToken: !process.env.ADMIN_TOKEN,
    },
  })

  app.get('/admin', (c) => c.redirect('/admin/'))

  const serveUi = async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url)
    let rel = url.pathname.replace(/^\/admin/, '')
    if (rel === '' || rel === '/') rel = '/index.html'
    const file = path.resolve(uiRoot, `.${rel}`)
    if (!file.startsWith(uiRoot)) return c.text('forbidden', 403)
    try {
      const data = await readFile(file)
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': mimeFor(file),
          'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      })
    } catch {
      try {
        const html = await readFile(path.join(uiRoot, 'index.html'))
        return new Response(new Uint8Array(html), { headers: { 'content-type': MIME['.html']!, 'cache-control': 'no-cache' } })
      } catch {
        return c.text('管理台尚未构建：先运行 pnpm build（或 pnpm dev:ui）', 503)
      }
    }
  }

  app.get('/admin/*', serveUi)

  const port = Number(process.env.PORT ?? 8080)
  const hostname = process.env.HOST ?? '0.0.0.0'
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const adminState = process.env.ADMIN_TOKEN ? '已启用（需要 ADMIN_TOKEN）' : '未设 ADMIN_TOKEN，仅本机使用'
    console.log(`[fake-llm] v${APP_VERSION} 已启动：http://${hostname}:${info.port}`)
    console.log(`[fake-llm] 管理台：http://127.0.0.1:${info.port}/admin/  ${adminState}`)
    console.log(`[fake-llm] 默认：mode=${settings.mode} tps=${settings.tps} unit=${settings.unit} text=${settings.text.slice(0, 24)}…`)
  })

  const shutdown = (signal: string) => {
    console.log(`[fake-llm] 收到 ${signal}，正在关闭…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void main()
