import { mergeSettings, type Settings } from '../core/settings'
import type { SessionHub } from '../core/hub'
import type { Session } from '../core/session'
import type { RequestRecord } from '../core/types'

/**
 * Durable Object 版 Hub。
 *
 * 会话状态留在内存里（流式请求期间 DO 一定是活的），只有设置落 SQLite：
 * 请求记录如果每次全量写盘，写放大会很夸张，而它只是排障用途，丢了不致命。
 */
export class DurableHub implements SessionHub {
  private readonly sessions = new Map<string, Session>()
  private requests: RequestRecord[] = []
  private settings: Settings
  private limit: number
  private initialized = false

  constructor(
    private readonly storage: DurableObjectStorage,
    initial: Settings,
  ) {
    this.settings = initial
    this.limit = initial.logLimit
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const stored = await this.storage.get<Partial<Settings>>('settings')
      if (stored) {
        this.settings = mergeSettings(this.settings, stored)
        this.limit = this.settings.logLimit
      }
    } catch {
      // 首次启动或存储不可用：用环境变量里的默认值
    }
  }

  add(session: Session): void {
    this.sessions.set(session.key, session)
    this.prune()
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key)
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  remove(key: string): void {
    this.sessions.delete(key)
  }

  async getSettings(): Promise<Settings> {
    await this.init()
    return this.settings
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.init()
    this.settings = mergeSettings(this.settings, patch)
    this.limit = this.settings.logLimit
    await this.storage.put('settings', this.settings)
    return this.settings
  }

  async listRequests(limit: number): Promise<RequestRecord[]> {
    return this.requests.slice(0, Math.max(1, limit))
  }

  async recordRequest(record: RequestRecord): Promise<void> {
    this.requests = [record, ...this.requests.filter((r) => r.key !== record.key)].slice(0, this.limit)
  }

  private prune(): void {
    if (this.sessions.size <= this.limit) return
    const finished = [...this.sessions.values()]
      .filter((s) => s.isClosed)
      .sort((a, b) => a.createdAt - b.createdAt)
    let excess = this.sessions.size - this.limit
    for (const session of finished) {
      if (excess <= 0) break
      this.sessions.delete(session.key)
      excess -= 1
    }
  }
}
