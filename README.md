# 假 LLM 提供商 · fake-llm-provider

> A controllable fake LLM upstream for integration testing — OpenAI & Anthropic compatible, fixed or human-typed replies, adjustable tokens-per-second, deployable to Docker and Cloudflare Workers.

给「调用 LLM 的服务」准备一个**完全可控的假上游**：它不会真的推理，但会把流式协议、鉴权、错误码、超时、断流这些边角料演得足够真，让你能安心验证自己的客户端/服务有没有写对。

它解决四件事：

1. **回复内容可控**：固定话术，或者由你在浏览器控制台里一段段手打（打字慢也没关系，中间有保活）。
2. **回复速度可控**：按 Token/s 精确节拍，首字延迟也能调。
3. **故障可控**：500 / 429 / 慢首字 / 半截断流 / 客户端超时，一个模型名就能切。
4. **两边都能跑**：同一个 Docker 镜像，或者同一份代码部署到 Cloudflare Workers。

兼容 OpenAI（`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`）与 Anthropic（`/v1/messages`、`count_tokens`）两套协议，官方 SDK 已在测试里跑通。

---

## 快速开始

### Docker

```bash
docker run -d --name fake-llm -p 8080:8080 \
  -e ADMIN_TOKEN=change-me \
  -e TPS=20 \
  fake-llm-provider:0.1.0
```

或者直接：

```bash
docker compose up -d
```

打开 <http://127.0.0.1:8080/admin/>，输入 `ADMIN_TOKEN` 就能看到控制台。

### Cloudflare Workers

```bash
pnpm install
pnpm build                    # 先构建管理台
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

部署后把客户端指向你的域名即可；没配 `ADMIN_TOKEN` 时管理台会被**主动关闭**（只留 `/v1`），避免公网裸奔。

### 从源码运行

```bash
pnpm install
pnpm build
pnpm start                    # http://127.0.0.1:8080
```

开发时用 `pnpm dev`（服务端热重启）+ `pnpm dev:ui`（管理台 Vite 开发服务器，5173 端口，自动代理 API）。

---

## 客户端怎么接

只要把 baseURL 换掉，其它一行不用改。

**Python（OpenAI SDK）**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="sk-anything")

stream = client.chat.completions.create(
    model="fake-fixed",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

**Python（Anthropic SDK）**

```python
import anthropic

client = anthropic.Anthropic(base_url="http://127.0.0.1:8080", api_key="sk-anything")

with client.messages.stream(
    model="fake-fixed",
    max_tokens=256,
    messages=[{"role": "user", "content": "你好"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

**curl**

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fake-fixed","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

---

## 模型名就是档位

不用改服务端配置，客户端换个 `model` 就能切换行为：

| 模型名 | 行为 |
|---|---|
| `fake-fixed` | 按配置话术与 TPS 正常流式输出 |
| `fake-manual` | 进入人工回复，挂在控制台等你打字 |
| `fake-instant` | 一次性吐完，没有节拍（检验客户端是否真的在增量处理） |
| `fake-slow` | 首字延迟 30 秒，用来打客户端超时/重试 |
| `fake-fail` | 直接返回错误体（默认 500，可调） |
| `fake-truncate` | 吐几个 token 后直接断开，检验半截流处理 |

用别的模型名（比如你线上真在用的 `gpt-4o-mini`）也可以，它走「默认回复来源」这一档，方便你只改 baseURL 就复用现有配置。

---

## 调节回复速度（Token/s）

控制台里改「速度（每秒单位数）」即可，也可以按请求临时覆盖：

```bash
# 每个请求 2 token/s，首字延迟 800ms
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fake-fixed","messages":[{"role":"user","content":"hi"}],"stream":true,
       "fake":{"tps":2,"ttftMs":800,"text":"这段是临时话术"}}'
```

也可以用请求头 `X-Fake-TPS` / `X-Fake-Kind` / `X-Fake-TTFT-Ms`。

**单位可选**：`token`（CJK 感知的近似计数：汉字 1、拉丁约 4 字符 1）、`char`（按字）、`word`（按词）。服务端会给每个分包打时间戳，控制台上显示的「实测 TPS」就是拿它算的，方便你和客户端自己统计的数字对账。

节拍用的是**绝对时间表**（目标时刻 = 起点 + 已发数 / TPS），不是循环 sleep，所以长时间跑也不会越跑越慢；高 TPS 时会自动合批，不会一个 token 一个 SSE 包。

---

## 人工回复（控制台）

1. 让客户端用 `model: "fake-manual"` 发一个流式请求。
2. 打开 <http://127.0.0.1:8080/admin/>，左侧出现一个「等待人工」的会话。
3. 在右侧输入框里打一段，`Ctrl/⌘+Enter` 发给客户端；它会按当前 TPS 平滑吐出去。
4. 吐完继续等下一段——**等待期间每 10 秒发一次保活**（默认 `: ping` 注释帧，OpenAI SDK 会直接忽略；也可以改成空 delta，更接近真实上游）。
5. 点「结束回复」正常收尾（`finish_reason` + usage + `[DONE]`）；点「掐断连接」则直接断开，模拟上游崩溃。

空等超过 `MANUAL_TIMEOUT_MS`（默认 180 秒）后按 `ON_MANUAL_TIMEOUT` 处理：`fallback` 吐一段兜底文字后正常结束、`abort` 断流、`hold` 一直挂着（专门用来测客户端超时）。

这正好覆盖「人打字慢、需要靠定期回复一段文本保持连接」的场景。

---

## 故障注入

```jsonc
POST /v1/chat/completions
{
  "model": "fake-fixed",
  "messages": [...],
  "fake": {
    "kind": "fail",          // fixed / manual / instant / slow / fail / truncate
    "status": 429,           // fail 档位返回的状态码
    "tps": 2,
    "ttftMs": 30000,
    "failAfterTokens": 5,    // truncate 档位吐多少个 token 后断流
    "text": "自定义话术",
    "chunkTokens": 3         // 每个 SSE 包最多几个 token
  }
}
```

优先级：请求体 `fake` 字段 > `X-Fake-*` 请求头 > 模型名档位 > 控制台设置。

---

## 请求日志与「调用体检」

每个进来的请求都会记一条，控制台上可以直接展开看**请求头、请求体、prompt token 数**（鉴权头默认打码），旁边还有一排体检结论：

- ✅ 带了 Bearer / ❌ 缺少鉴权头
- ⚠️ 流式请求没带 `stream_options.include_usage`（客户端拿不到 usage）
- ⚠️ 没传 `temperature` / `max_tokens`
- ❌ Anthropic 请求缺 `anthropic-version` 或必填的 `max_tokens`

默认只提示不拦截；把 `STRICT=true` 打开后，体检出现 ❌ 会直接 400，适合在 CI 里跑「客户端不许发残缺请求」的断言。

---

## 配置项

环境变量（控制台里也能改，改了立即生效）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MODE` | `fixed` | 默认回复来源：`fixed` / `manual` / `instant` |
| `TEXT` | 内置长文本 | 固定话术，支持 `{{model}}` `{{nonce}}` `{{id}}` `{{prompt_tokens}}` `{{datetime}}` |
| `TPS` | `20` | 每秒多少个单位，`0` = 不限速 |
| `TTFT_MS` | `300` | 首字延迟（毫秒） |
| `UNIT` | `token` | `token` / `char` / `word` |
| `CHUNK_TOKENS` | `0` | 单个 SSE 包最多多少 token，0 = 自动（约 40ms 的量） |
| `HEARTBEAT_MS` | `10000` | 人工等待时的保活间隔 |
| `HEARTBEAT_STYLE` | `comment` | `comment` / `empty-delta` / `off` |
| `MANUAL_TIMEOUT_MS` | `180000` | 人工空等上限 |
| `ON_MANUAL_TIMEOUT` | `fallback` | `fallback` / `abort` / `hold` |
| `API_KEYS` | 空 | 逗号分隔；非空时校验 `Authorization: Bearer` / `x-api-key` |
| `ADMIN_TOKEN` | 空 | 控制台口令；Workers 上留空 = 控制台关闭 |
| `CORS` | `*` | 允许的来源，`none` = 不发 CORS 头 |
| `DATA_DIR` | 空 | 非空时把请求记录追加到 `requests.jsonl` |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Node 监听地址 |
| `LOG_LIMIT` | `200` | 保留多少条请求记录 |
| `STRICT` | `false` | 体检不合格是否直接 400 |

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容，流式 / 非流式 |
| POST | `/v1/messages` | Anthropic 兼容，流式 / 非流式 |
| POST | `/v1/messages/count_tokens` | Anthropic token 计数 |
| GET | `/v1/models` | 模型列表（按 `anthropic-version` / `x-api-key` 头返回对应形状） |
| POST | `/v1/embeddings` | 确定性伪向量（同输入同输出） |
| GET | `/healthz` | 健康检查 |
| GET | `/admin/` | 控制台 |
| — | `/admin/api/*` | 控制台 API（需 `ADMIN_TOKEN`） |

---

## 常见问题

**实测 TPS 和设置值差几个百分点？**
正常。定时器有精度上限，服务端按「落后就一次多发」追赶，长期平均是准的；控制台的「实测 TPS」是拿实际发送时刻算的，可以拿来对账。

**控制台一直提示 401 / 403？**
`ADMIN_TOKEN` 没配对（或 Workers 上没配置）。改了环境变量要重启容器；Workers 上重新 `wrangler secret put` 后会自动生效。

**客户端说「connection reset」/ 收不到 `[DONE]`？**
你大概率用了 `fake-truncate` 或点了「掐断连接」——这正是它要模拟的东西。

**能当压测工具用吗？**
不建议。它是单进程内存态（Workers 上是单 Durable Object），几百路并发没问题，但不是为了打满 QPS 设计的。

---

## 开发

架构与设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)，发布记录见 [CHANGELOG.md](CHANGELOG.md)。

```bash
pnpm typecheck    # 三套 tsconfig：Node / Worker / 管理台
pnpm test         # 单元 + 集成 + 官方 SDK 契约测试
pnpm build        # 管理台 + Node 单文件产物
pnpm cf:dev       # 本地 workerd（含 DO），无需账号
```

## License

MIT
