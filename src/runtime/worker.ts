import { DurableObject } from 'cloudflare:workers'
import type { Hono } from 'hono'
import { createApp } from '../core/app'
import { mergeSettings, settingsFromEnv } from '../core/settings'
import { APP_VERSION } from '../core/version'
import { DurableHub } from './durable-hub'

export interface Env {
  HUB: DurableObjectNamespace
  ASSETS: Fetcher
  ADMIN_TOKEN?: string
  [key: string]: unknown
}

/**
 * 全局单实例 Hub：所有会话、设置都在这个 DO 里。
 * 好处是流式请求和"人工打字"天然在同一个实例，不需要跨实例同步；
 * 测试工具的并发量完全撑得住。
 */
export class FakeLlmHub extends DurableObject<Env> {
  private appPromise?: Promise<Hono>

  private app(): Promise<Hono> {
    if (!this.appPromise) {
      this.appPromise = (async () => {
        const settings = mergeSettings(settingsFromEnv(this.env as Record<string, string | undefined>))
        const hub = new DurableHub(this.ctx.storage, settings)
        await hub.init()
        return createApp({
          hub,
          env: {
            version: APP_VERSION,
            runtime: 'workers',
            ...(this.env.ADMIN_TOKEN ? { adminToken: this.env.ADMIN_TOKEN } : {}),
            // 公网部署：没配 ADMIN_TOKEN 时管理台直接关闭，只留 /v1
            allowAdminWithoutToken: false,
          },
        })
      })()
    }
    return this.appPromise
  }

  override async fetch(request: Request): Promise<Response> {
    const app = await this.app()
    return app.fetch(request, this.env)
  }
}

function hubStub(env: Env): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName('hub'))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // LLM 兼容层与管理 API 全部转进 DO（同一个实例 = 同一份会话表）
    if (
      url.pathname === '/healthz' ||
      url.pathname.startsWith('/v1/') ||
      url.pathname.startsWith('/admin/api/')
    ) {
      return hubStub(env).fetch(request)
    }

    // 管理台静态资源挂在 /admin/ 下，实际文件在 assets 根目录
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const assetUrl = new URL(request.url)
      const rest = url.pathname.replace(/^\/admin/, '')
      assetUrl.pathname = rest === '' || rest === '/' ? '/index.html' : rest
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request))
    }

    if (url.pathname === '/') {
      return Response.redirect(new URL('/admin/', url).toString(), 302)
    }

    return env.ASSETS.fetch(request)
  },
}
