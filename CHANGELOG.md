# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-26

### 新增

- **假工具调用**：`fake-tool` 档位返回 `tool_calls`（OpenAI）/ `tool_use`（Anthropic），参数按流式分片吐出（`function.arguments` / `input_json_delta`），函数名与参数可在控制台配置或按请求覆盖。
- **按调用序列的剧本**：`fake-script` 档位按「模型名第几次被调用」取剧本的一步，内置「第一次 429、第二次成功」；剧本可在控制台用 JSON 编辑、按请求覆盖，并支持一键重置计数。
- **精确 tokenizer**：默认使用 `gpt-tokenizer` 的 o200k_base 真词表计算 `usage` 与节拍，增量计数保证跨分包接缝处也准确；`TOKENIZER=heuristic` 可退回零依赖估算。
- 管理台新增：token 计数方式、假工具名/参数、剧本编辑与计数展示、重置按钮。
- 冒烟脚本新增工具调用与剧本两项检查（共 10 项）。

### 变更

- `usage` 里的 token 数默认按 o200k 真词表统计（v0.1.0 是启发式估算），与客户端用 tiktoken 数出来的结果一致。
- 版本号升至 0.2.0。

### 移除

- **Cloudflare Workers 部署支持**：删除 Worker 入口、Durable Object Hub、`wrangler.jsonc`、Worker 专用 tsconfig、CI 的打包校验步骤，以及 README / 设计文档里的 Cloudflare 章节。项目回到 Node + Docker 单栈。

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
- **部署**：Docker 镜像（多阶段、非 root、带健康检查）；Cloudflare Workers 版本（已于 0.2.0 移除）。
- **测试**：单元 + 集成 + 官方 SDK 契约测试。
