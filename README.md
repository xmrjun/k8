# K8 IM Sports Read-Only Gateway

K8 把 Mac 上已经登录的专用 Chrome 转换为受令牌保护的 HTTP 与 WebSocket 服务，让远程服务器能够读取 IM 体育赛事、赔率、盘口、比分和账户摘要，并可在本机内存中准备短期人工确认草稿。

项目对 IM 体育始终严格只读：为获取当前快照，读取器可能切换或选择 `scope`/`sport`
导航筛选控件，但本地草稿不会改变真实注单；项目不读取或导出浏览器登录凭证，不下注，
也不执行兑现、确认或资金操作。

## 架构

```text
远程服务器
  -> Cloudflare Tunnel / HTTPS
  -> 127.0.0.1:8788  K8 API
  -> 127.0.0.1:9223  Chrome DevTools（仅限本机）
  -> K8 专用 Chrome（用户自行登录）
```

Cloudflare 只转发 `127.0.0.1:8788`。Chrome 调试端口 `9223` 必须始终绑定回环地址，不能暴露到公网、局域网或隧道。

## 当前功能

| 接口 | 状态 | 说明 |
| --- | --- | --- |
| `GET /health` | 可用 | 无需鉴权的进程健康检查 |
| `GET /api/sports?scope=…&sport=…` | 可用 | 按范围和体育项目读取赛事、市场与赔率快照 |
| `GET /api/sports/catalog` | 可用 | 热门锦标赛、串关标签及完整体育项目目录 |
| `GET /api/sports/boosts` | 可用 | 赔率增值与可见组合卡片，只读且不提供下注动作 |
| `GET /api/sports/account` | 可用 | IM 体育余额与未结算金额，不缓存 |
| `GET /api/balance` | 可用 | 主账户钱包；要求对应账户页面保持登录 |
| `POST /api/bets/drafts` | 可用 | 只在本机内存中校验并创建两分钟人工确认草稿；这是安全的本地 draft，不是真实投注写入 |
| `WS /ws/sports` | 可用 | IM 体育实时快照、赔率增量、比分和心跳 |
| `GET /api/bets` | 改造中 | 正在从错误的主账户记录页改接 IM 体育注单弹窗，当前不建议接入生产 |

实时推送目前只发布经过验证的足球数据；混合快照中的未验证体育类型会被忽略，不会猜测字段含义。

## 环境要求

- macOS
- Node.js 22 或更高版本
- Google Chrome
- 一个独立、持久化的 K8 Chrome 配置目录
- 可选：Cloudflare Tunnel，用于让自己的服务器访问本机 API

## 安装

```bash
git clone git@github.com:xmrjun/k8.git
cd k8
npm ci
cp .env.example .env.local
```

在 `.env.local` 中设置两个不同且至少 32 个字符的随机令牌：

```dotenv
API_TOKEN=<HTTP 接口专用随机令牌>
WS_TOKEN=<WebSocket 专用随机令牌，必须与 API_TOKEN 不同>
```

不要提交 `.env.local`，也不要把真实令牌粘贴到文档、聊天、截图或 shell 历史中。

推荐的浏览器配置为：

```dotenv
HOST=127.0.0.1
PORT=8788
UPSTREAM_MODE=browser
BROWSER_TRANSPORT=cdp
BROWSER_CDP_URL=http://127.0.0.1:9223
BROWSER_PAGE_ORIGIN=https://k81128.com
BROWSER_SPORTS_ORIGIN=https://imsb-fxnag.utoyen.com:2053
BROWSER_OPERATION_TIMEOUT_MS=15000
```

`BROWSER_SPORTS_ORIGIN` 只能填写纯 HTTPS origin。不要添加体育页面路径、查询参数或登录 token。

## 启动

先启动专用 Chrome，再启动 API。Chrome 示例：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --user-data-dir="/path/to/k8-chrome-profile" \
  --no-first-run \
  --no-default-browser-check
```

在这个 Chrome 中自行登录账户并保持 IM 体育页面打开。随后在项目目录运行：

```bash
npm start
```

服务默认监听：

```text
http://127.0.0.1:8788
```

本机已有桌面快捷方式的部署，可直接按以下顺序操作：

1. 双击“启动 K8 专用 Chrome”。
2. 确认专用 Chrome 中的账户和 IM 体育页面已登录。
3. 双击“启动 K8 API”。
4. 保持 Cloudflare Tunnel 运行。

详细运行与故障处理见 [docs/operations.md](docs/operations.md)。

## HTTP API

除 `/health` 外，HTTP 请求都需要：

```text
Authorization: Bearer <API_TOKEN>
```

健康检查：

```bash
curl http://127.0.0.1:8788/health
```

### 赛事与赔率端点

统一端点：

```text
GET /api/sports?scope=<范围>&sport=<体育项目>
```

`scope` 和 `sport` 都是必填参数。`scope` 可用值：

| 值 | 含义 |
| --- | --- |
| `live` | 滚球中 |
| `today` | 今日赛事 |
| `early` | 早盘赛事 |

`sport` 可用值：

| 值 | 含义 | 已验证市场 |
| --- | --- | --- |
| `football` | 足球 | `1x2`、`handicap`、`total` |
| `basketball` | 篮球 | `moneyline`、`handicap`、`total` |
| `tennis` | 网球 | `moneyline`、`handicap`、`total`、`odd_even` |

完整的九个端点组合：

```text
GET /api/sports?scope=live&sport=football
GET /api/sports?scope=today&sport=football
GET /api/sports?scope=early&sport=football
GET /api/sports?scope=live&sport=basketball
GET /api/sports?scope=today&sport=basketball
GET /api/sports?scope=early&sport=basketball
GET /api/sports?scope=live&sport=tennis
GET /api/sports?scope=today&sport=tennis
GET /api/sports?scope=early&sport=tennis
```

读取滚球足球：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports?scope=live&sport=football"
```

读取今日篮球：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports?scope=today&sport=basketball"
```

读取篮球早盘：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports?scope=early&sport=basketball"
```

远程服务器通过域名调用时，只替换基础地址，查询参数保持相同：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "https://<你的 API 域名>/api/sports?scope=today&sport=basketball"
```

示例响应结构：

```json
{
  "data": {
    "events": [
      {
        "event_id": "...",
        "sport": "basketball",
        "scope": "today",
        "league": "...",
        "starts_at": "2026-07-19T12:00:00.000Z",
        "home": "...",
        "away": "...",
        "markets": [
          {
            "period": "full_time",
            "type": "moneyline",
            "selections": [
              {
                "selection_key": "...:full_time:moneyline:home",
                "name": "home",
                "decimal_odds": "1.91",
                "display_odds": "0.91",
                "odds_format": "hong_kong",
                "available": true
              }
            ]
          }
        ]
      }
    ],
    "count": 1,
    "truncated": false
  },
  "source": "im-sports-browser",
  "fetched_at": "2026-07-19T00:00:00.000Z",
  "request_id": "..."
}
```

说明：

- 页面上的 `滚球中`、`所有体育 → 今日`、`所有体育 → 早盘`各有独立的体育项目列表；API 会先选择范围，再只在该范围中选择项目。
- 请求缺少任一参数、使用 `scope=all`、未知值、空值或重复参数都会返回 `400 INVALID_REQUEST`。
- 当前 HTTP 自动选择只支持足球、篮球和网球；某个范围当前没有请求的项目时，成功返回 `events=[]`。
- `period` 当前可为 `full_time` 或 `first_half`；网球当前只发布已验证的 `full_time`。
- `decimal_odds` 是十进制赔率，`display_odds` 保留页面显示值，`available=false` 表示锁盘或暂不可用。
- WebSocket 实时推送当前仍只发布经过验证的 `live + football`；不要把 HTTP 快照能力误认为对应的实时推送已经完成。

### 热门、锦标赛、串关与赔率增值

读取当前导航目录：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports/catalog"
```

目录返回 `scopes`、`tabs`、`live_sports`、`all_sports`、
`popular_tournaments` 和 `odds_boost_sports`。当前可识别的目录项目包括：

```text
football              足球
electronic_football   电子足球
basketball            篮球
electronic_basketball 电子篮球
esports               电竞体育
tennis                网球
fantasy_marble        魔幻弹珠
table_tennis          乒乓球
volleyball            排球
baseball              棒球
virtual_sports        虚拟体育
combat_sports         拳击 / 综合格斗
snooker_billiards     斯诺克/ 台球
```

目录中出现某个项目只表示页面导航已经识别，不代表其赛事和市场结构已经开放。
`GET /api/sports` 目前仍只接受足球、篮球和网球。

读取赔率增值卡片：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports/boosts"
```

卡片类型为 `event_parlay`（赛事串关）或 `chain_parlay`（连串过关），返回可见
组合说明、参与人数、原赔率、增值赔率和可用性。响应不包含下注动作、控制 URL、
确认或兑现能力。

读取 IM 体育账户摘要：

```bash
curl \
  -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8788/api/sports/account"
```

成功响应统一包含 `data`、`source`、`fetched_at` 和 `request_id`。`401` 表示 API 令牌无效，`503` 通常表示专用 Chrome 或目标页面不可用，`502` 表示登录失效或页面结构发生变化。

### 人工确认投注草稿

`POST /api/bets/drafts` 是一个安全的本地草稿端点，不是真实投注写接口。它使用
Bearer 鉴权和 `application/json`，不接受查询参数，请求体不得超过 8192 字节。下面的
完整示例只有占位符；请从调用进程的安全配置注入 API 地址和令牌，不要把真实域名、
令牌、事件标识或 selection key 写进文档和 shell 历史。使用前必须在安全的调用方配置
中把每个 `<...>` 替换为对应值；这个占位模板本身不会形成可执行的真实请求：

```bash
curl --request POST \
  --url "https://<API_HOST>/api/bets/drafts" \
  --header "Authorization: Bearer <API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{
    "scope": "<SCOPE>",
    "sport": "<SPORT>",
    "event_id": "<EVENT_ID>",
    "selection_key": "<SELECTION_KEY>",
    "stake": "<STAKE_DECIMAL>",
    "expected_odds": "<EXPECTED_ODDS_DECIMAL>",
    "max_odds_drift": "<MAX_ODDS_DRIFT_DECIMAL>",
    "idempotency_key": "<IDEMPOTENCY_KEY>"
  }'
```

JSON 对象必须恰好包含以下 8 个字符串字段，不能增加未知字段：

| 字段 | 说明 |
| --- | --- |
| `scope` | 快照范围：`live`、`today` 或 `early` |
| `sport` | 体育项目：`football`、`basketball` 或 `tennis` |
| `event_id` | 来自 `GET /api/sports` 当前响应的稳定事件标识；必须是 1–32 位数字字符串 |
| `selection_key` | 同一响应中的稳定选择标识；1–500 个字符，必须在该事件中唯一且当前可用 |
| `stake` | `0.01`–`1000000.00` 的正数金额十进制字符串，最多两位小数 |
| `expected_odds` | 调用方刚观察到的正数十进制赔率字符串 |
| `max_odds_drift` | 允许的当前赔率与预期赔率绝对偏差，非负十进制字符串 |
| `idempotency_key` | 调用方生成的 1–200 字符不透明幂等键；相同意图重试时复用 |

所有金额和赔率都必须是十进制字符串，不能发送 JSON number。服务会移除无意义的前导
零和末尾零并返回规范十进制字符串，例如 `"10.00"` 变为 `"10"`、`"1.9500"`
变为 `"1.95"`；`projected_gross_return` 始终保留两位小数。

成功响应示例：

```json
{
  "data": {
    "state": "ready_for_manual_confirmation",
    "scope": "<SCOPE>",
    "sport": "<SPORT>",
    "event_id": "<EVENT_ID>",
    "selection_key": "<SELECTION_KEY>",
    "stake": "<STAKE_DECIMAL>",
    "expected_odds": "<EXPECTED_ODDS_DECIMAL>",
    "current_odds": "<CURRENT_ODDS_DECIMAL>",
    "max_odds_drift": "<MAX_ODDS_DRIFT_DECIMAL>",
    "odds_changed": false,
    "projected_gross_return": "<PROJECTED_GROSS_RETURN_DECIMAL>",
    "created_at": "<ISO_8601_CREATED_AT>",
    "expires_at": "<ISO_8601_EXPIRES_AT>",
    "draft_id": "<LOCAL_DRAFT_ID>"
  },
  "source": "im-sports-browser",
  "fetched_at": "<ISO_8601_VERIFICATION_TIME>",
  "request_id": "<REQUEST_ID>"
}
```

响应模板中的 `<...>` 表示对应运行时值；`odds_changed: false` 仅展示该字段的 JSON
boolean 类型，实际值由当前赔率是否变化决定。固定协议值只有
`state: "ready_for_manual_confirmation"` 和 `source: "im-sports-browser"`。

响应字段含义：

- `state` 固定为 `ready_for_manual_confirmation`，只表示可以交给用户人工复核。
- `scope`、`sport`、`event_id`、`selection_key`、`stake`、`expected_odds` 和
  `max_odds_drift` 是规范化后的提案；`current_odds` 是创建草稿时重新校验的当前赔率。
- `odds_changed` 表示当前赔率是否不同于预期赔率；差值大于 `max_odds_drift` 时不会创建
  草稿。`projected_gross_return` 是用当前赔率计算并按分四舍五入的预计总回报，不是盈利
  或支付承诺。
- `created_at` 是草稿创建时间，`expires_at` 恰好晚 120 秒，`draft_id` 只标识本进程中的
  临时草稿。
- `source` 固定为 `im-sports-browser`；`fetched_at` 是实际校验时间，与首次响应的
  `created_at` 相同；`request_id` 用于关联已脱敏诊断。

每次新建草稿都会通过现有只读读取器获取新鲜、未缓存的当前 `scope`/`sport` 快照，
再检查事件和选择唯一、可用及 schema 合法。服务不使用 HTTP sports 缓存，并以
当前赔率执行偏差检查和预计总回报计算。相同
`idempotency_key` 和相同规范化请求会原样重放同一个草稿，不再读取上游；同一键的并发
相同请求也会合并为一次校验。重放时 `fetched_at` 仍是首次实际校验时间，始终保留原始
`created_at`/`expires_at`，不会伪装成一次更新的赔率读取。相同键配不同请求返回冲突。

草稿只在内存中保留两分钟（120 秒），最多保存 1000 个未过期草稿并最多处理 1000 个
尚未完成的创建；过期草稿会清理，已存草稿满时淘汰最旧项，处理中请求满时返回过载。
状态不持久化，API 重启会立即使所有草稿失效。调用方必须在有效期内回到已登录的 IM
体育页面，亲自复核选择、最新赔率和金额并手动完成最终确认。

稳定错误如下；错误响应只含稳定 code、通用 message 和 `request_id`：

| HTTP | code | 含义 |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | 查询参数、JSON、字段集合或字段值不合法 |
| `401` | `UNAUTHORIZED` | Bearer 令牌缺失或错误 |
| `405` | `METHOD_NOT_ALLOWED` | 草稿路径使用了非 `POST` 方法；响应 `Allow: POST` |
| `409` | `IDEMPOTENCY_CONFLICT` | 幂等键已用于不同的规范化请求 |
| `409` | `EVENT_UNAVAILABLE` | 当前快照中事件不存在或不唯一 |
| `409` | `SELECTION_UNAVAILABLE` | 当前选择不存在、不唯一、锁定或不可用 |
| `409` | `ODDS_DRIFT_EXCEEDED` | 当前赔率偏差超过允许值 |
| `413` | `PAYLOAD_TOO_LARGE` | 请求体超过 8192 字节 |
| `415` | `UNSUPPORTED_MEDIA_TYPE` / `UNSUPPORTED_CHARSET` | 不是受支持的 UTF-8 JSON |
| `500` | `INTERNAL_ERROR` | 内部服务状态无效；响应不会泄漏内部细节 |
| `502` | `MALFORMED_CURRENT_SNAPSHOT` | 当前体育快照不符合完整 schema |
| `503` | `DRAFT_CAPACITY_EXCEEDED` | 1000 个创建请求仍在处理中，请稍后重试 |
| `503` | `BROWSER_UNAVAILABLE` | 专用 Chrome 不可用 |
| `502` | `UPSTREAM_AUTH_EXPIRED` | IM 体育登录已过期 |
| `504` | `UPSTREAM_TIMEOUT` | 新鲜快照读取超时 |
| `502` | `UPSTREAM_BAD_RESPONSE` | 上游响应损坏 |
| `502` | `UPSTREAM_SCHEMA_CHANGED` | IM 体育页面 schema 已变化 |

这个项目永远不会通过 API 或页面点击提交、确认、取消、结算或兑现真实注单，也没有
对应的 submit/confirm/cancel/settle/cashout 路由。所有最终确认只能由用户在 IM 体育
页面手动完成。浏览器读取器可能只读地选择 `scope` 和 `sport` 导航筛选控件以获取快照；
它绝不点击赔率、下注单、提交、确认、取消、结算或兑现等交易控件，也绝不调用私有下注端点。
草稿请求、响应、文档示例和日志都不得包含浏览器凭证、Cookie、
Web Storage、完整页面 URL 或 URL query token；服务也不读取这些内容。Bearer API
令牌只能出现在传输中的 Authorization header，响应和日志绝不回显。

### 注单接口状态

`GET /api/bets` 与上述本地 `POST` 草稿完全不同。它目前仍保留旧实现，但该实现读取的
不是 IM 体育注单弹窗；请继续把它视为不可靠的只读接口，不要让生产服务器依赖它，
更不能把它解释为创建或管理真实注单的能力。

已确认的新接口设计为：

```text
GET /api/bets?status=unsettled|settled|all&limit=25&cursor=0
```

实现计划见 [IM Sports Bet Records Implementation Plan](docs/plans/2026-07-19-im-sports-bets-implementation.md)。

## 实时 WebSocket

公网连接形式：

```text
wss://<你的 API 域名>/ws/sports?token=<WS_TOKEN>
```

首帧一定是完整快照，之后只推送变化：

```json
{"type":"snapshot","events":[],"seq":1}
{"type":"delta","event_id":"...","selection_key":"...","decimal_odds":2.1,"line":null,"available":true,"seq":2}
{"type":"score","event_id":"...","score":"1-0","clock":"52:10","seq":3}
{"type":"ping","seq":4}
```

- `snapshot`：连接时的当前完整滚球快照
- `delta`：赔率、盘口线或可用性变化
- `score`：比分或比赛时钟变化
- `ping`：每 30 秒发送的应用心跳
- `seq`：连接内严格递增的序号，可用于检测丢包或乱序

服务器端应在连接断开、收到 `1012` 或长时间未收到消息时重新连接，并用下一次 `snapshot` 覆盖旧状态。

## 验证

```bash
npm run check
npm test
npm run smoke
npm run smoke:ws
```

公网冒烟测试只需要修改不含凭证的目标地址；令牌仍从 `.env.local` 读取：

```bash
K8_API_BASE_URL=https://<你的 API 域名> npm run smoke
K8_WS_BASE_URL=wss://<你的 API 域名> npm run smoke:ws
```

冒烟程序只输出状态和消息计数，不输出真实赛事、赔率、余额或令牌。

## 安全边界

- API 不读取 Cookie、Local Storage、Session Storage、密码、请求头或请求签名。
- API 不记录完整体育页面 URL、查询 token、Authorization 或 WebSocket 查询字符串。
- HTTP 与 WebSocket 使用不同的高强度令牌。
- 浏览器调试端口只允许 `127.0.0.1` 或 `::1`。
- Cloudflare Tunnel 只连接 API 端口，不连接 Chrome 调试端口。
- 第一版不提供下注、兑现、确认或资金操作。
- 赔率增值和串关端点只是只读展示；项目不提供自动下注、确认下注或兑现接口。
- 自动化测试只使用合成数据，不保存真实账户记录。

## 文档

- [IM 体育页面契约](docs/im-sports-upstream.md)
- [主账户页面契约](docs/k81128-upstream.md)
- [部署与故障处理](docs/operations.md)
- [实时行情设计](docs/plans/2026-07-19-im-sports-realtime-feed-design.md)
- [IM 注单弹窗设计](docs/plans/2026-07-19-im-sports-bets-design.md)
