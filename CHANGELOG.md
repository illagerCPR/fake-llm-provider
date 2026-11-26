# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-26

首个可用版本。

### 新增

- **OpenAI 兼容层**：`/v1/chat/completions`（流式 / 非流式、`stream_options.include_usage`、`finish_reason`）、`/v1/models`、`/v1/embeddings`（确定性伪向量）。
- **Anthropic 兼容层**：`/v1/messages`（`message_start` → `content_block_delta` → `message_stop` 全事件序列）、`/v1/messages/count_tokens`。
- **TPS 节拍器**：绝对时间表控制速度，支持 `token` / `char` / `word` 三种单位，首字延迟（TTFT）可调，实测 TPS 自报。
- **人工回复**：控制台里一段段推送文本，等待期间按间隔发保活（注释帧 / 空 delta / 关闭），支持结束、掐断、超时兜底。
- **档位与故障注入**：`fake-fixed` / `fake-manual` / `fake-instant` / `fake-slow` / `fake-fail` / `fake-truncate`，并支持请求体 `fake` 字段与 `X-Fake-*` 头按次覆盖。
- **控制台**：会话列表、实时发送内容预览、请求头/请求体查看、鉴权头打码、调用体检结论、在线改配置。
- **调用体检**：检查鉴权头、`include_usage`、`temperature`、`max_tokens`、`anthropic-version` 等常见遗漏，`STRICT=true` 时可拦截。
- **双部署**：Docker 镜像（多阶段、非 root、带健康检查）与 Cloudflare Workers（Durable Object + Static Assets，SQLite 后端，免费计划可用）。
- **测试**：54 个用例，含官方 `openai` / `@anthropic-ai/sdk` 的契约测试与真实 HTTP 端口。
