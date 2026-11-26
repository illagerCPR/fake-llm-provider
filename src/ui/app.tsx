import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import {
  ApiError,
  api,
  getToken,
  setToken,
  type SessionSnapshot,
  type Settings,
  type StatePayload,
} from './api'

const POLL_MS = 900

const STATE_LABEL: Record<SessionSnapshot['state'], string> = {
  waiting_human: '等待人工',
  streaming: '生成中',
  finished: '已结束',
  aborted: '已掐断',
  error: '出错',
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

function maskHeader(name: string, value: string): string {
  if (!/authorization|x-api-key|x-admin-token/i.test(name)) return value
  if (value.length <= 10) return '****'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function useCopy(): (text: string) => void {
  return (text: string) => {
    void navigator.clipboard.writeText(text)
  }
}

export function App() {
  const [state, setState] = useState<StatePayload | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState(false)
  const [token, setTokenValue] = useState(getToken())
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.state()
      setState(next)
      setError(null)
      setAuthError(false)
      if (!dirty) setDraft(next.settings)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setAuthError(true)
      else setError(err instanceof Error ? err.message : String(err))
    }
  }, [dirty])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!state) return
    if (selectedKey && state.sessions.some((s) => s.key === selectedKey)) return
    const waiting = state.sessions.find((s) => s.state === 'waiting_human')
    setSelectedKey(waiting?.key ?? state.sessions[0]?.key ?? null)
  }, [state, selectedKey])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(timer)
  }, [notice])

  const selected = useMemo(
    () => state?.sessions.find((s) => s.key === selectedKey) ?? null,
    [state, selectedKey],
  )

  const update = (patch: Partial<Settings>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
    setDirty(true)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const result = await api.saveSettings(draft)
      setDraft(result.settings)
      setDirty(false)
      setNotice('设置已保存')
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (authError) {
    return (
      <div class="gate">
        <div class="gate-card">
          <h1>需要访问令牌</h1>
          <p class="muted">管理台由 ADMIN_TOKEN 保护。令牌只保存在浏览器本地。</p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setToken(token)
              void refresh()
            }}
          >
            <input
              type="password"
              value={token}
              placeholder="ADMIN_TOKEN"
              onInput={(event) => setTokenValue((event.target as HTMLInputElement).value)}
            />
            <button type="submit" class="primary">
              进入
            </button>
          </form>
        </div>
      </div>
    )
  }

  const origin = typeof location === 'undefined' ? '' : location.origin

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="logo">假</span>
          <div>
            <h1>假 LLM 提供商</h1>
            <div class="muted small">
              v{state?.version ?? '—'} · {state?.runtime ?? '—'} · {state?.sessions.length ?? 0} 个会话
            </div>
          </div>
        </div>
        <div class="endpoints">
          <Endpoint label="OpenAI baseURL" value={`${origin}/v1`} />
          <Endpoint label="Anthropic baseURL" value={origin} />
        </div>
      </header>

      {error && (
        <div class="banner error">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      {notice && <div class="banner ok">{notice}</div>}

      <main class="layout">
        <aside class="panel sessions">
          <div class="panel-head">
            <h2>会话</h2>
            <button class="ghost" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          <ul class="session-list">
            {(state?.sessions ?? []).length === 0 && <li class="empty">还没有请求。让客户端打一下 /v1 就会出现在这里。</li>}
            {(state?.sessions ?? []).map((session) => (
              <li key={session.key}>
                <button
                  class={`session-row ${session.key === selectedKey ? 'active' : ''}`}
                  onClick={() => setSelectedKey(session.key)}
                >
                  <span class={`dot ${session.state}`} />
                  <span class="session-main">
                    <span class="session-model">
                      {session.model}
                      <span class="tag">{session.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
                      {session.stream && <span class="tag ghosted">stream</span>}
                    </span>
                    <span class="muted small">
                      {STATE_LABEL[session.state]} · {session.emittedTokens} tok ·{' '}
                      {fmtDuration((session.finishedAt ?? state?.serverNow ?? Date.now()) - session.createdAt)}
                    </span>
                  </span>
                  {session.queueLength > 0 && <span class="queue-badge">+{session.queueLength}</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section class="panel detail">
          {!selected && <div class="empty big">左侧选一个会话；没有会话就让客户端先发一次请求。</div>}
          {selected && (
            <SessionDetail
              session={selected}
              serverNow={state?.serverNow ?? Date.now()}
              defaultText={draft?.text ?? ''}
              onNotice={setNotice}
              onError={setError}
              onRefresh={() => void refresh()}
            />
          )}
        </section>
      </main>

      <section class="panel settings">
        <div class="panel-head">
          <h2>回复设置</h2>
          <div class="row gap">
            {dirty && <span class="muted small">未保存</span>}
            <button class="ghost" onClick={() => state && (setDraft(state.settings), setDirty(false))} disabled={!dirty}>
              还原
            </button>
            <button class="primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        {draft && (
          <div class="settings-grid">
            <label class="field">
              <span>默认回复来源</span>
              <select value={draft.mode} onChange={(e) => update({ mode: (e.target as HTMLSelectElement).value as Settings['mode'] })}>
                <option value="fixed">fixed · 固定话术</option>
                <option value="manual">manual · 人工回复</option>
                <option value="instant">instant · 一次性吐完</option>
              </select>
            </label>
            <label class="field">
              <span>速度（每秒单位数）</span>
              <input
                type="number"
                min={0}
                step={1}
                value={draft.tps}
                onInput={(e) => update({ tps: Number((e.target as HTMLInputElement).value) })}
              />
            </label>
            <label class="field">
              <span>首字延迟（ms）</span>
              <input
                type="number"
                min={0}
                step={50}
                value={draft.ttftMs}
                onInput={(e) => update({ ttftMs: Number((e.target as HTMLInputElement).value) })}
              />
            </label>
            <label class="field">
              <span>切分单位</span>
              <select value={draft.unit} onChange={(e) => update({ unit: (e.target as HTMLSelectElement).value as Settings['unit'] })}>
                <option value="token">token（CJK 感知）</option>
                <option value="char">char（按字）</option>
                <option value="word">word（按词）</option>
              </select>
            </label>
            <label class="field wide">
              <span>固定话术（支持 {'{{model}} {{nonce}} {{id}} {{prompt_tokens}} {{datetime}}'}）</span>
              <textarea rows={4} value={draft.text} onInput={(e) => update({ text: (e.target as HTMLTextAreaElement).value })} />
            </label>

            <div class="advanced wide">
              <button class="ghost" onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? '收起高级设置' : '展开高级设置'}
              </button>
            </div>

            {showAdvanced && (
              <>
                <label class="field">
                  <span>心跳间隔（ms）</span>
                  <input
                    type="number"
                    min={500}
                    step={500}
                    value={draft.heartbeatMs}
                    onInput={(e) => update({ heartbeatMs: Number((e.target as HTMLInputElement).value) })}
                  />
                </label>
                <label class="field">
                  <span>心跳形式</span>
                  <select
                    value={draft.heartbeatStyle}
                    onChange={(e) => update({ heartbeatStyle: (e.target as HTMLSelectElement).value as Settings['heartbeatStyle'] })}
                  >
                    <option value="comment">注释帧 : ping</option>
                    <option value="empty-delta">空 delta</option>
                    <option value="off">关闭</option>
                  </select>
                </label>
                <label class="field">
                  <span>人工空等上限（ms）</span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={draft.manualTimeoutMs}
                    onInput={(e) => update({ manualTimeoutMs: Number((e.target as HTMLInputElement).value) })}
                  />
                </label>
                <label class="field">
                  <span>超时行为</span>
                  <select
                    value={draft.onManualTimeout}
                    onChange={(e) => update({ onManualTimeout: (e.target as HTMLSelectElement).value as Settings['onManualTimeout'] })}
                  >
                    <option value="fallback">fallback · 吐兜底文本</option>
                    <option value="abort">abort · 断流</option>
                    <option value="hold">hold · 一直挂着</option>
                  </select>
                </label>
                <label class="field">
                  <span>API Keys（逗号分隔，空 = 不校验）</span>
                  <input
                    value={draft.apiKeys.join(', ')}
                    onInput={(e) =>
                      update({
                        apiKeys: (e.target as HTMLInputElement).value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label class="field">
                  <span>CORS</span>
                  <input value={draft.cors} onInput={(e) => update({ cors: (e.target as HTMLInputElement).value })} />
                </label>
                <label class="field">
                  <span>保留请求条数</span>
                  <input
                    type="number"
                    min={10}
                    step={10}
                    value={draft.logLimit}
                    onInput={(e) => update({ logLimit: Number((e.target as HTMLInputElement).value) })}
                  />
                </label>
                <label class="field checkbox">
                  <input type="checkbox" checked={draft.strict} onChange={(e) => update({ strict: (e.target as HTMLInputElement).checked })} />
                  <span>严格模式（体检失败直接 400）</span>
                </label>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function Endpoint({ label, value }: { label: string; value: string }) {
  const copy = useCopy()
  return (
    <button class="endpoint" title="点击复制" onClick={() => copy(value)}>
      <span class="muted small">{label}</span>
      <code>{value}</code>
    </button>
  )
}

interface DetailProps {
  session: SessionSnapshot
  serverNow: number
  defaultText: string
  onNotice: (text: string | null) => void
  onError: (text: string | null) => void
  onRefresh: () => void
}

function SessionDetail({ session, serverNow, defaultText, onNotice, onError, onRefresh }: DetailProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [showBody, setShowBody] = useState(false)
  const [showHeaders, setShowHeaders] = useState(false)

  // 切到另一个会话时收起详情面板，但不改动作者已经打了一半的回复
  useEffect(() => {
    setShowBody(false)
    setShowHeaders(false)
  }, [session.key])

  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await api.say(session.key, text)
      setText('')
      onNotice('已推送一段')
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    setBusy(true)
    try {
      await api.finish(session.key)
      onNotice('已结束本次回复')
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const abort = async () => {
    setBusy(true)
    try {
      await api.abort(session.key, '人工掐断')
      onNotice('已掐断连接')
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const live = session.state === 'waiting_human' || session.state === 'streaming'
  const elapsed = (session.finishedAt ?? serverNow) - session.createdAt

  return (
    <div class="detail-body">
      <div class="detail-head">
        <div>
          <h2>
            {session.model} <span class={`state ${session.state}`}>{STATE_LABEL[session.state]}</span>
          </h2>
          <div class="muted small mono">{session.id}</div>
        </div>
        <div class="metrics">
          <Metric label="目标 TPS" value={String(session.tps)} />
          <Metric label="已发" value={`${session.emittedTokens} tok`} />
          <Metric label="分包" value={String(session.chunks)} />
          <Metric label="实测 TPS" value={session.achievedTps ? String(session.achievedTps) : '—'} />
          <Metric label="已耗时" value={fmtDuration(elapsed)} />
          <Metric label="prompt" value={`${session.promptTokens} tok`} />
        </div>
      </div>

      <div class="lint-row">
        {session.lint.map((item, index) => (
          <span key={index} class={`lint ${item.level}`} title={item.detail ?? ''}>
            {item.level === 'ok' ? '✓' : item.level === 'warn' ? '!' : '×'} {item.label}
          </span>
        ))}
      </div>

      <div class="composer">
        <div class="composer-head">
          <span>人工回复（Ctrl/⌘+Enter 发送）</span>
          <div class="row gap">
            <button class="ghost" onClick={() => setText(defaultText)}>
              填入默认话术
            </button>
          </div>
        </div>
        <textarea
          rows={5}
          value={text}
          placeholder={live ? '在这里打字，按 Ctrl+Enter 推给客户端…' : '会话已结束'}
          disabled={!live}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div class="row gap">
          <button class="primary" onClick={() => void send()} disabled={!live || busy || !text.trim()}>
            发送这一段
          </button>
          <button onClick={() => void finish()} disabled={!live || busy}>
            结束回复
          </button>
          <button class="danger" onClick={() => void abort()} disabled={!live || busy}>
            掐断连接
          </button>
          {session.state === 'waiting_human' && <span class="muted small">队列中还有 {session.queueLength} 段</span>}
        </div>
      </div>

      <div class="preview">
        <div class="preview-head">
          <span>已发出的内容</span>
          <span class="muted small">{session.emittedChars} 字符</span>
        </div>
        <pre class="emitted">{session.emittedPreview || '（还没发出任何内容）'}</pre>
      </div>

      <div class="request">
        <div class="row gap">
          <button class="ghost" onClick={() => setShowBody((v) => !v)}>
            {showBody ? '隐藏请求体' : '查看请求体'}
          </button>
          <button class="ghost" onClick={() => setShowHeaders((v) => !v)}>
            {showHeaders ? '隐藏请求头' : '查看请求头'}
          </button>
          <span class="muted small">
            {session.request.method} {session.request.path} · {session.stream ? 'stream' : '非流式'} · prompt {session.promptTokens} tok
          </span>
        </div>
        {showHeaders && (
          <table class="headers">
            <tbody>
              {Object.entries(session.request.headers).map(([name, value]) => (
                <tr key={name}>
                  <th>{name}</th>
                  <td class="mono">{maskHeader(name, value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {showBody && <pre class="body">{JSON.stringify(session.request.body, null, 2)}</pre>}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div class="metric">
      <span class="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
