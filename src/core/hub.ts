import { mergeSettings, type Settings } from './settings'
import type { Session } from './session'
import type { RequestRecord } from './types'

/**
 * 会话与设置的存放处。Node 用内存实现，Cloudflare 用 Durable Object 存储实现，
 * 但对应用层是同一个接口。
 */
export interface SessionHub {
  add(session: Session): void
  get(key: string): Session | undefined
  list(): Session[]
  remove(key: string): void
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  listRequests(limit: number): Promise<RequestRecord[]>
  recordRequest(record: RequestRecord): Promise<void>
}

export interface MemoryHubOptions {
  /** 启动时恢复的历史记录（新的在前） */
  initialRequests?: RequestRecord[]
  /** 每记录一条就回调一次，Node 端用它落 JSONL */
  onRecord?: (record: RequestRecord) => void
}

export class MemoryHub implements SessionHub {
  private readonly sessions = new Map<string, Session>()
  private requests: RequestRecord[]
  private settings: Settings
  private limit: number
  private readonly onRecord?: (record: RequestRecord) => void

  constructor(initial: Settings, options: MemoryHubOptions = {}) {
    this.settings = initial
    this.limit = initial.logLimit
    this.requests = (options.initialRequests ?? []).slice(0, this.limit)
    if (options.onRecord) this.onRecord = options.onRecord
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
    return this.settings
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = mergeSettings(this.settings, patch)
    this.limit = this.settings.logLimit
    return this.settings
  }

  async listRequests(limit: number): Promise<RequestRecord[]> {
    return this.requests.slice(0, Math.max(1, limit))
  }

  async recordRequest(record: RequestRecord): Promise<void> {
    this.requests = [record, ...this.requests.filter((r) => r.key !== record.key)].slice(0, this.limit)
    this.onRecord?.(record)
  }

  /** 会话只保留最近一批，避免长跑的服务把内存吃满 */
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
