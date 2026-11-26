# 假 LLM 提供商 · 技术选型与实施计划

> 状态：**已确认，待开工**（v0.1.0）
> 日期：2026-11-26
> 仓库：<https://github.com/illagerCPR/fake-llm-provider>

## 0. 已确认的决策

| 决策点 | 结论 |
|---|---|
| Cloudflare 交付 | **真实部署到账号**（`*.workers.dev`，管理台由 `ADMIN_TOKEN` 保护） |
| 协议范围 | **OpenAI 兼容 + Anthropic Messages 双协议** |
| 首发 Release | **先交付给你看**，确认后再打标签发布（代码、镜像脚本、Release 说明先备齐） |

## 1. 目标

给"调用 LLM 的服务"提供一个**完全可控的假上游**，用来验证这些地方对不对：

- 鉴权头、请求体（model / messages / temperature / tools / stream_options…）是否按预期发出
- 流式解析（SSE 分包、delta 拼接、结束标记、usage 收尾）是否健壮
- 超时、重试、取消、半截流、错误码这些异常分支是否被正确处理
- 客户端自己算的 token 数 / TPS / 首字延迟是否合理

四条硬需求：

| # | 需求 | 计划怎么落 |
|---|---|---|
| 1 | 固定文本回复，或**人工回复**（人打字慢 → 分多次推送，靠心跳撑住长连接） | 固定话术 + 管理台人工推送 + SSE 保活 |
| 2 | Docker / Cloudflare 双部署 | 同一套 Hono 路由，两个 runtime 适配层 |
| 3 | 可调 Token/s | 绝对时间表节拍器（非 `sleep` 累加） |
| 4 | v0.1.0 首发 Release | 签名 tag + GHCR 多架构镜像 + Release Notes（发布前先给你看） |

**非目标**：不做真实模型推理，不追求词表级精确 tokenizer，不替代压测工具（并发能力不是重点，单进程几百路足够）。

## 2. 技术选型

| 关注点 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 协议类型 + 双部署都要靠类型兜住 |
| 运行时 | Node **26**（本机 v26.13.0） | 已是当前 LTS 线；`node:26-alpine` 镜像在 RHEL10 已验证存在 |
| HTTP 框架 | **Hono 4.13** | 同一份路由代码可在 Node 与 Workers 上跑；TS 类型好；体积小 |
| 参数校验 | **zod 4** | 设置项 / 管理 API 共用一套 schema |
| 管理台 | **Preact 11 + Vite 8** | 单页控制台约 500 行，不引 UI 组件库；包体小，Workers 静态资源直接托管 |
| 测试 | **Vitest 5** + 官方 **openai SDK 7** / **@anthropic-ai/sdk** | 用真 SDK 打自己的假服务 = 契约测试 |
| 包管理 | **pnpm 12** | 本机已装，锁文件稳定 |
| Docker | `node:26-alpine` 多阶段构建 | 已在 RHEL10 `docker pull` 通过；最终镜像非 root、带 HEALTHCHECK |
| Cloudflare | **Workers + Durable Object（SQLite 后端）+ Static Assets** | 免费计划可用（已核实）；DO 提供跨请求共享状态 |
| 构建 | `tsc`（Node 产物）+ `wrangler`（Worker 产物）+ `vite`（UI） | 三条产物互不干扰 |
| CI | GitHub Actions → GHCR | 公开仓库，免费额度 |

**为什么不选**：
- Express/Fastify 单栈：上不了 Workers，等于维护两套。
- Cloudflare Pages Functions：能做，但 DO 绑定与静态资源配置不如 Workers + Assets 直接。
- 引第三方 SSE 库：SSE 编码就是拼字符串，自己写 20 行，省一个依赖。
- 真 tiktoken：包体 1MB+，且"假 token"本来就是自定义单位，先做 CJK 感知的启发式，留插件接口（见 §9）。

**已核实的关键事实**（2026-11，直接决定可行性）：

- Workers 入站 HTTP 请求**墙钟时间无上限**，只要客户端保持连接；流式响应期间 Worker 保持活跃。
- SSE 流**没有有效的时长限制**（Cloudflare Agents 文档明确写 "No timeout limits"）。
- 运行时更新时，长连接宽限期已放宽到 **20 分钟**（2026-10 changelog），不会 30 秒被掐。
- Durable Objects **免费计划可用**（仅 SQLite 后端），单对象 10GB、单请求 30s CPU——我们几乎全是等待，CPU 可忽略。
- 首字节必须 **125s 内**发出，否则 Cloudflare 返回 524——我们收到请求就立刻发 SSE 头，不触发。

## 3. 架构

```
                 ┌──────────── core（运行时无关，禁止 import node:*）────────────────┐
                 │ config / models / tokenize / pace / templates / hub / session      │
                 │ protocol/openai.ts   protocol/anthropic.ts（同一节拍器，两种编码） │
                 └───────────────┬───────────────────────────────┬────────────────────┘
                                 │                               │
              ┌──────────────────▼──────────────┐  ┌─────────────▼────────────────────┐
              │ runtime/node                    │  │ runtime/worker                   │
              │ Hono serve + MemoryHub          │  │ Worker 路由 → DO stub → DurableHub│
              │ 静态 UI + JSONL 落盘            │  │ Static Assets + DO SQLite         │
              └─────────────────────────────────┘  └──────────────────────────────────┘
                                 │                               │
                          ┌──────▼───────────────────────────────▼───────┐
                          │ ui：管理台（会话列表 / 实时流 / 人工回复框）   │
                          └──────────────────────────────────────────────┘
```

核心抽象两个：

```ts
interface ProtocolAdapter {                 // 一套节拍，两种线上格式
  id: 'openai' | 'anthropic'
  parse(body: unknown): NormalizedRequest   // 归一化成 {model, messages, stream, ...}
  open(): Frame[]                           // 发头 + 首个事件（role / message_start）
  delta(text: string): Frame
  close(reason: StopReason): Frame[]        // stop / usage / [DONE] / message_stop
  error(status: number, msg: string): Frame
}

interface SessionHub {
  create(input: RequestInfo, cfg: Settings): Promise<Session>
  list(): Promise<SessionSummary[]>
  get(id: string): Promise<Session | null>
  say(id: string, text: string): Promise<void>     // 人工推送一段
  finish(id: string): Promise<void>                // 正常收尾
  abort(id: string, reason: string): Promise<void> // 异常收尾
}
```

- Node：内存 Map + 挂起队列（`Promise` 被 `say` 唤醒），可选 JSONL 追加。
- Workers：一个 `Hub` Durable Object（`idFromName("hub")`）承载全部会话，状态在内存、设置与日志在 SQLite。请求一律 `stub.fetch()` 转进 DO，所以流和管理操作天然在同一个实例里。

**约束**：`core/` 不许出现 Node API；时间用 `Date.now()`、随机用 `crypto.randomUUID()`、编码用 `TextEncoder`。这条约束保证"一份逻辑、两处部署"不打架。

## 4. 核心机制设计

### 4.1 TPS 节拍器

朴素做法 `for token: await sleep(1000/tps)` 会因定时器精度和事件循环抖动越跑越慢，高 TPS 时 1ms 定时器根本不生效。用**绝对时间表**：

```
目标时刻(i) = t0 + ttftMs + i * 1000 / tps
每个 tick（默认 40ms）：把"已到点但还没发"的 token 一起发出去
```

- 落后就一次多发（追赶），所以**平均 TPS 准**，抖动只体现在分包粒度上，跟真实模型相似。
- tick 内按 `ceil(tps * tickMs / 1000)` 分块，高 TPS 下不会碎成上万个 chunk。
- 记录每个 chunk 的实际发送时刻，服务端自报 `achievedTps`，管理台直接显示"目标 20 / 实测 19.6"。
- 文本切分单位可配：`char`（按字）/ `token`（CJK 感知：汉字 1、拉丁词约 4 字符 1、标点 1）/ `word`。不变量有单测守着：切完拼回去必须**逐字节等于原文**（不破坏代理对/emoji）。
- 非流式请求同样模拟耗时：`ttft + N/tps`，可一键关闭（`simulate:false`）用于快速联调。

### 4.2 流式协议（两种线上格式，同一节拍器）

**OpenAI `/v1/chat/completions`**

```
data: {"id":"chatcmpl-fake-…","object":"chat.completion.chunk","created":…,"model":"…",
       "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
data: {…,"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}
…
data: {…,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {…,"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}   # 仅 stream_options.include_usage
data: [DONE]
```

**Anthropic `/v1/messages`**（`x-api-key` + `anthropic-version`）

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_fake_…","type":"message","role":"assistant","content":[],"model":"…","usage":{"input_tokens":12,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}
```

细节按需实现：`stream_options.include_usage`、`stop_reason`（`stop`/`length`/`tool_calls`/`end_turn`/`max_tokens`/`tool_use`）、`x-request-id` 与 `x-fake-session-id` 响应头（便于和管理台对上号）。保活在 Anthropic 侧天然就是 `event: ping`。

### 4.3 人工回复（核心差异化）

会话状态机：

```
waiting_human ──say(text)──► streaming ──写完──► waiting_human ──finish──► finished
      │                                              │
      └──────────── 超时策略 ──── fallback / abort / hold ◄───────────────┘
```

- 请求一进来立刻发 SSE 头 + 首个事件，客户端马上进入"正在生成"状态（顺手验证首包处理）。
- 人每推一段，就按当前 TPS 平滑吐出去；吐完继续等。
- 等待期间每 `heartbeatMs`（默认 10s）发保活。三档可选：
  - `comment`：OpenAI 侧 `: ping`（SDK 直接忽略，不污染内容）；Anthropic 侧 `event: ping`；
  - `empty-delta`：OpenAI 侧发 `delta:{}` 空 chunk，更接近真实上游，但会考验客户端拼接逻辑；
  - `off`。
- 人工动作：**发送**（推一段）、**结束**（正常 stop + usage + 结束事件）、**掐断**（直接断流，模拟上游崩溃）、**报错**（流内 error）。
- 超时策略 `onManualTimeout`：`fallback`（默认，吐兜底文本后正常结束）/ `abort`（断流）/ `hold`（一直挂着，专门测客户端超时）。
- 这正好覆盖需求里那句"人工打字慢，通过定期回复一段文本保持连接"。

### 4.4 情景档位与故障注入

三种注入方式，优先级：请求体 `fake` 字段 > `X-Fake-*` 头 > 模型名档位 > 全局设置。

| 档位（模型名） | 行为 |
|---|---|
| `fake-fixed` | 按配置话术 + TPS 正常流式 |
| `fake-instant` | 一次性吐完，无延迟（测客户端是否真在增量处理） |
| `fake-manual` | 进入人工回复 |
| `fake-slow` | 首字延迟 30s（测连接/读超时） |
| `fake-fail` | 直接 500 / 429 / 401（状态码可配，带 `Retry-After`） |
| `fake-truncate` | 吐一半后断流（测半截流与重试） |

单个请求的逃生口（不用重启服务）：

```json
POST /v1/chat/completions
{"model":"fake-fixed","messages":[…],
 "fake":{"tps":2,"text":"自定义这段","ttftMs":800,"failAfterTokens":5,"status":429}}
```

### 4.5 调用体检（call lint，加分项）

每条请求按规则打体检章，管理台直接显示"✅ 带 Bearer / ✅ model 合法 / ⚠️ 没传 stream_options.include_usage / ⚠️ Anthropic 请求缺 anthropic-version"。规则表驱动、易扩展。这一项直接服务"验证服务调用是否正确"这个目的，成本很低。

## 5. 接口清单

**LLM 兼容层**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 流式 / 非流式，`tools` 透传与假 `tool_calls` 分支 |
| POST | `/v1/messages` | Anthropic 流式 / 非流式（含 `tool_use` 分支、`count_tokens` 可选） |
| GET | `/v1/models` | 档位即模型；按 `anthropic-version` / `x-api-key` 头区分两种返回形状 |
| POST | `/v1/embeddings` | 确定性伪向量（同输入同输出），维度可配（OpenAI 侧） |
| GET | `/healthz` | 健康检查（Docker HEALTHCHECK 用） |

**管理 API**（`/admin/api/*`，需 `ADMIN_TOKEN`）

`GET/PUT /settings`、`GET /sessions`、`GET /sessions/{id}`、`POST /sessions/{id}/say|finish|abort`、`GET /requests`、`GET /export`。

**配置项**（env / 管理台可改，管理台改动落库）

`PORT` `MODE` `TEXT` `TPS` `TTFT_MS` `UNIT` `HEARTBEAT_MS` `MANUAL_TIMEOUT_MS` `ON_MANUAL_TIMEOUT` `API_KEYS` `ADMIN_TOKEN` `DATA_DIR` `CORS`

## 6. 部署

### Docker

```bash
docker run -d --name fake-llm -p 8080:8080 \
  -e ADMIN_TOKEN=change-me -e TPS=20 -v fake-llm-data:/data \
  ghcr.io/illagercpr/fake-llm-provider:0.1.0
```

多阶段（build → runtime），非 root，`HEALTHCHECK`，`docker-compose.yml` 给一份带注释的样例。构建与冒烟测试在 RHEL10 上做（本机 Ubuntu 无 daemon；RHEL10 与 Ubuntu 共享 netns，`localhost:8080` 直接可达）。

### Cloudflare（真实部署）

`wrangler.jsonc`：Worker 入口 + `assets: ./dist/ui` + `run_worker_first: ["/v1/*","/admin/api/*"]` + `Hub` DO 绑定与 migration。

```bash
pnpm cf:dev      # 本地 workerd，端口 8787，本地 DO（无需账号）
pnpm cf:deploy   # 已登录（wrangler OAuth 可用），部署出 *.workers.dev
```

- 公网管理台强制 `ADMIN_TOKEN`（未设置时拒绝访问管理台，只留 `/v1`）；`/v1` 可选要求 `API_KEYS`。
- 人工回复在 CF 上依赖 DO 常驻（§2 已核实无时长限制），保活间隔默认 10s。
- 部署后会把地址、`ADMIN_TOKEN` 的存放方式一起告诉你。

## 7. 测试与验收

| 层 | 内容 |
|---|---|
| 单元 | 切分不变量、节拍精度（假定时器测 5/50/500/5000 TPS，允许 ±10%）、SSE 编码、模板展开、设置校验、call lint 规则 |
| 契约 | 官方 `openai` / `@anthropic-ai/sdk`：流式/非流式、`include_usage`、tools、断流、401/429/500、超时 |
| 端到端 | RHEL10 跑容器 → Ubuntu 侧 SDK 打过去；`wrangler dev` 同一套冒烟脚本；部署后再跑一遍 |
| 手工 | 管理台人工回复走一遍：边打字边看客户端增量输出、心跳、掐断、结束 |

验收标准：`pnpm test` 全绿；Docker 与 CF 两边同一冒烟脚本通过；TPS 实测偏差 <10%；人工回复可撑过 5 分钟不超时。

## 8. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | 骨架 + core（节拍器 / 双协议编解码 / 会话状态机）+ Node 端 + 单测 | 本机 `curl` 就能拿到两种格式的流 |
| M2 | 管理台 + 人工回复 + 请求日志 + 体检章 | 浏览器里能人工扮演模型 |
| M3 | Cloudflare 适配（DO + Assets）+ `wrangler dev` + **真实部署** | 两条部署路径都跑通，给你地址 |
| M4 | Docker + compose + CI + 文档 + 构建镜像 | 代码/镜像/Release 说明备齐 → **等你点头再发 v0.1.0** |

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Workers 上长连接被运行时更新打断 | 人工回复会话中断 | 宽限期 20 分钟已够；会话状态在 DO，重连可续 |
| 单 DO 承载所有会话 | 极高并发下排队 | 测试工具场景够用；预留"每会话一 DO"开关 |
| TS 7（native）生态兼容 | 构建失败 | 固定 `tsc` 版本，必要时回退 5.9；产物不依赖 TS 运行时 |
| 启发式 tokenizer 与真词表有偏差 | 客户端数出来的 TPS 略偏 | 管理台自报 `achievedTps`；预留 tiktoken 插件与 `unit=char` |
| 双协议细节差异（事件顺序、usage 字段） | 某些 SDK 版本不认 | 以官方 SDK 契约测试为准，逐条对齐 |

## 附：v0.2 候选

按调用序列的剧本（第一次 429、第二次 200）、精确 tokenizer、`/v1/completions`、`/v1/responses`、延迟分布图、多副本一致性（SQLite/Redis）、thinking / reasoning 增量。
