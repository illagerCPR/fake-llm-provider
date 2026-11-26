# 假 LLM 提供商 · 技术选型与实施计划

> 版本：**v0.2.0**（2026-11-26）
> 仓库：<https://github.com/illagerCPR/fake-llm-provider>

## 0. 决策记录

| 时间 | 决策 | 说明 |
|---|---|---|
| 2026-11-26 | 双协议 | OpenAI 兼容 + Anthropic Messages 都要，协议层做成可插拔适配器 |
| 2026-11-26 | 先计划后开工 | 用户要求「先给出可行的技术选型与计划」，确认后才动代码 |
| 2026-11-26 | v0.1.0 首发 | 签名 tag + GHCR 多架构镜像 + GitHub Release |
| 2026-11-26 | **放弃 Cloudflare 部署** | workers.dev 在用户网络被 SNI 阻断；自定义域名所在 zone 强制人机验证（`cf-mitigated: challenge`），加白名单后才可用；维护两套运行时收益不抵成本。已删除 Worker、Durable Object 适配、wrangler 配置与相关文档，项目回到 **Node + Docker 单栈** |
| 2026-11-26 | v0.2.0 | 补假工具调用、按调用序列的剧本、精确 tokenizer |

## 1. 目标

给「调用 LLM 的服务」提供一个**完全可控的假上游**，用来验证这些地方对不对：

- 鉴权头、请求体（model / messages / temperature / tools / stream_options…）是否按预期发出
- 流式解析（SSE 分包、delta 拼接、结束标记、usage 收尾）是否健壮
- 超时、重试、取消、半截流、错误码这些异常分支是否被正确处理
- 工具调用链路（tool_calls / tool_use 的参数分片与回填）是否接得住
- 客户端自己算的 token 数 / TPS / 首字延迟是否合理

**非目标**：不做真实模型推理，不替代压测工具（单进程内存态，几百路并发够用但不是为打满 QPS 设计）。

## 2. 技术选型

| 关注点 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 协议类型 + 双协议适配都靠类型兜住 |
| 运行时 | Node **26** | 已是当前 LTS 线；`node:26-alpine` 只有一个进程，部署简单 |
| HTTP 框架 | **Hono 4.13** | 路由 + 中间件轻量，`app.request()` 让集成测试不用起端口 |
| 参数校验 | **zod 4** | 设置项 / 管理 API 共用一套 schema |
| 分词 | **gpt-tokenizer 4（o200k_base）** | 真词表，`usage` 与客户端统计对得上；带增量计数器，跨分包接缝也准 |
| 管理台 | **Preact 11 + Vite 8** | 单页控制台约 500 行，不引 UI 组件库 |
| 测试 | **Vitest 5** + 官方 `openai` / `@anthropic-ai/sdk` | 用真 SDK 打自己的假服务 = 契约测试 |
| 包管理 | **pnpm 12** | `packageManager` 固定版本，CI 与本地一致 |
| 构建 | `esbuild` 打 Node 单文件产物 `dist/node.mjs` | 运行镜像不需要 node_modules，也不依赖 package.json 判定 ESM |
| 部署 | Docker（多阶段、非 root、HEALTHCHECK） | 单容器即用；`docker compose` 给样例 |

**已放弃的方案**：Cloudflare Workers + Durable Objects。SSE 本身在 Workers 上没有时长限制，DO 也能承载，但用户网络对 workers.dev 有 SNI 阻断、自有 zone 默认强制人机验证，且维护两套运行时（Node 与 workerd）的构建/类型/测试成本明显高于收益。

## 3. 架构

```
                ┌──────────────── core（纯 Node/Web 标准，无运行时分支）────────────────┐
                │ settings / models / tokenize(+tokenizer) / pace / templates / lint     │
                │ protocol/openai.ts   protocol/anthropic.ts（同一节拍器，两种编码）      │
                │ session（状态机） / hub（MemoryHub） / app（Hono 路由）                  │
                └───────────────────────────────┬────────────────────────────────────────┘
                                                │
                                  ┌─────────────▼──────────────┐
                                  │ runtime/node.ts             │
                                  │ serve + 静态 UI + JSONL 落盘 │
                                  └─────────────┬──────────────┘
                                                │
                                  ┌─────────────▼──────────────┐
                                  │ ui：管理台（会话 / 人工回复） │
                                  └────────────────────────────┘
```

两个核心抽象：

```ts
interface ProtocolAdapter {           // 一套节拍，两种线上格式
  parse(body: unknown): NormalizedRequest
  streamStart(init): Frame[]          // 文本模式首帧
  streamToolStart(init, tool, id): Frame[]
  streamDelta(text, init): Frame[]
  streamToolDelta(fragment, init): Frame[]
  streamEnd(reason, usage, init): Frame[]
  complete(text, reason, usage, init): unknown
  completeTool(tool, callId, usage, init): unknown
  // …心跳 / 错误体 / 模型列表形状
}

class Session {                        // 一次请求的生命周期
  say(text) / finish() / abort(reason)
  next(timeoutMs): Promise<Command | null>
}
```

## 4. 核心机制

### 4.1 TPS 节拍器

绝对时间表：`目标时刻(i) = 起点 + i / tps`，每 tick（约 40ms）把「已到点未发」的一次发出去。

- 落后就一次多发（追赶），**平均速度准**，分包粒度像真实模型；高 TPS 自动合批。
- 切分单位 `token` / `char` / `word`；切完拼回去必须逐字节等于原文（单测守着）。
- **精确计数**：`tokenizer=tiktoken` 时先用 o200k 算出这段文本的真 token 数，再把切分单元的权重等比缩放——分包边界仍由轻量切分器决定，但速度和 `usage` 都是真 token。
- 增量计数器（`createIncrementalCounter`）保证「分包接缝处两个 token 合并成一个」时也能算对。
- 实测 TPS 由真实发送时刻与真实 token 数算出，控制台直接显示。

### 4.2 双协议

| | OpenAI | Anthropic |
|---|---|---|
| 文本流 | `chat.completion.chunk` + `delta.content` | `message_start` → `content_block_delta` → `message_stop` |
| 工具流 | `delta.tool_calls[].function.arguments` 分片 | `content_block_start(tool_use)` → `input_json_delta` 分片 → `stop_reason: tool_use` |
| 收尾 | `finish_reason` + 可选 usage 包 + `[DONE]` | `message_delta`(usage) + `message_stop` |
| 心跳 | `: ping` 注释帧（或空 delta） | `event: ping` |

`/v1/models` 按 `anthropic-version` / `x-api-key` 头返回对应形状，同一个路径两种格式。

### 4.3 人工回复

```
waiting_human ──say(text)──► streaming ──写完──► waiting_human ──finish──► finished
      │                                              │
      └──────────── 超时策略 ──── fallback / abort / hold ◄───────────────┘
```

- 请求进来先发首帧，客户端立刻进入「正在生成」；等待期按 `HEARTBEAT_MS` 发保活。
- 人推一段就按当前 TPS 平滑吐出去，吐完继续等。
- 结束 = `finish_reason` + usage + `[DONE]`；掐断 = 直接断流（模拟上游崩溃）。
- 空等超时按 `ON_MANUAL_TIMEOUT` 处理：`fallback` / `abort` / `hold`。

> 踩过的坑：`Session.wake()` 一开始无条件从队列 `shift` 命令，driver 还在吐字时收到的 `say`/`finish` 会被静默丢弃，表现为「人工回复永远卡住」。修法是**没有等待者时不许取命令**。

### 4.4 工具调用

`fake-tool` 档位返回一个假工具调用：函数名 `TOOL_NAME`、参数 `TOOL_ARGS`（默认 `{"city":"上海","unit":"celsius"}`）。

- 流式：参数 JSON 也走节拍器，被切成多个 `function.arguments` / `input_json_delta` 分片，客户端必须自己拼。
- 非流式：直接给完整的 `message.tool_calls` / `content[tool_use]`。
- 可按请求覆盖：`{"fake":{"toolName":"lookup_order","toolArgs":"{\"id\":\"A-1\"}"}}`。

### 4.5 剧本（按调用次数）

`fake-script` 档位按「模型名的第几次调用」取剧本的一步：

```
第 1 次 → 429 限流
第 2 次起 → 正常返回（用完停在最后一步）
```

- 剧本来源优先级：请求体 `fake.script` > 控制台 `SCRIPT` > 内置默认（429 → 200）。
- 每步可覆盖 `kind` / `text` / `tps` / `ttftMs` / `status` / `toolName` / `toolArgs`。
- 计数在进程内存（`Map<model, count>`），管理台可见、可一键重置。

### 4.6 故障注入与调用体检

档位：`fixed` / `manual` / `instant` / `slow` / `fail` / `truncate` / `tool` / `script`；
优先级：请求体 `fake` > `X-Fake-*` 头 > 模型名 > 全局设置。

体检规则（只提示，`STRICT=true` 才拦截）：鉴权头、`include_usage`、`temperature`、`max_tokens`、`anthropic-version`、messages 是否为空、是否带 tools。

## 5. 测试

| 层 | 内容 |
|---|---|
| 单元 | 切分不变量、节拍精度、tiktoken 计数与增量计数、SSE 编码、模板、设置校验 |
| 集成 | `app.request()` 直接打路由：两种协议流式/非流式、工具调用、剧本、错误档位、鉴权、管理 API |
| 契约 | 官方 `openai` / `@anthropic-ai/sdk` 打真实 HTTP 端口，覆盖流式、tool_calls、tool_use、错误、embeddings |
| 冒烟 | `scripts/smoke.mjs` 对任意已运行实例跑 10 项检查（含人工回复、工具调用、剧本） |

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 精确 tokenizer 与客户端词表不一致 | usage 对不上 | 默认 o200k，并在控制台可切 `heuristic`；文档写明口径 |
| 剧本计数只存在内存 | 重启后重来 | 测试场景通常反而需要重置；管理台有一键重置 |
| 单进程内存态 | 不能压测 | 文档明确，不作为压测工具 |
| 假工具参数不是合法 JSON | Anthropic `input` 解析失败 | 解析失败时回退成 `{_raw: 原始串}` |

## 7. 后续候选

- 按「调用序号」的更细剧本（同一模型不同会话隔离）
- 假 reasoning / thinking 增量（`reasoning_content`、`thinking_delta`）
- LLM 响应里的多模态内容块（图片/音频占位）
- 请求历史的持久化与导出对比（diff 两次调用）
