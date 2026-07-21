# K8 只读 API 运维说明

## 数据路径

生产数据路径如下：

```text
调用服务器
  -> Cloudflare（k8.nbmrjun.top）
  -> 127.0.0.1:8788（K8 API 与 WebSocket）
  -> 127.0.0.1:9223（仅本机 CDP）
  -> K8 专用 Chrome（独立持久化配置）
```

Cloudflare 隧道配置无需修改，仍只转发到 `127.0.0.1:8788`。不得把
`9223` 加入 Cloudflare、路由器端口转发或任何公网监听；CDP 必须绑定
`127.0.0.1`。

对 IM 体育的浏览器访问严格只读：服务发布赛事、赔率、盘口可用性、比分和时钟，
也可仅在本机内存中准备两分钟人工确认草稿，但不执行真实下注或改变页面。

## 启动顺序

1. 双击桌面的 `启动 K8 专用 Chrome.command`。
2. 在这个专用 Chrome 中保持账户站和 IM 体育页面登录。
3. 双击桌面的 `启动 K8 API.command`。快捷方式会等待
   `http://127.0.0.1:9223/json/version`，专用 Chrome 未就绪时会明确失败。
4. 保持现有 `cloudflared tunnel --config ... run` 进程运行。

专用 Chrome 使用固定目录：

```text
/Users/apple/Documents/Codex/2026-07-19/chrome-cookie-local-storage/.runtime/k8-chrome-profile
```

普通 Chrome 不会被用作自动回退。Mac 休眠、专用 Chrome 退出、登录会话过期、
API 或隧道退出，都会使公网行情不可用。

## 接口

HTTP 接口继续使用独立的 `API_TOKEN`。实时接口是：

```text
GET /api/sports?scope=live|today|early&sport=football|basketball|tennis
GET /api/sports/catalog
GET /api/sports/boosts
POST /api/bets/drafts
```

`scope` 和 `sport` 都必须提供。HTTP 读取会在专用 Chrome 中自动选择对应的范围和
体育项目；滚球、今日、早盘各自使用自己的体育项目列表。某个范围当前没有该项目时
返回空赛事列表，不会读取另一个范围的数据。

`/api/sports/catalog` 和 `/api/sports/boosts` 不接受查询参数且不缓存。前者读取热门
锦标赛、串关标签和其他体育项目目录；后者读取可见赔率增值卡片。两者都不提供下注、
确认、兑现或资金写入能力。

## 人工确认草稿运维

创建 `POST /api/bets/drafts` 前，必须先启动专用 Chrome，在其中完成登录并保持目标
IM 体育页面打开；API 还必须能从 `127.0.0.1:9223` 找到完全匹配配置 origin 的页面。
草稿读取现有只读体育快照，不会打开页面或替操作者登录。请求必须使用 HTTP Bearer
令牌、`Content-Type: application/json`、无查询参数且不超过 8192 字节。

草稿及幂等记录完全保存在 API 进程内存，不持久化到数据库、文件、Cookie 或浏览器
Web Storage。每个草稿创建后 120 秒过期；API 重启、进程崩溃或
部署切换都会使全部草稿立即失效。重启后客户端必须重新获取赛事、重新创建草稿，并由
用户再次复核，不能把旧 `draft_id` 当作有效凭据。

服务最多保留 1000 个未过期草稿，并最多同时处理 1000 个尚未完成的新建请求。已保存
草稿满时会清理过期项并淘汰最旧项；如果处理中请求已经满，返回
`503 DRAFT_CAPACITY_EXCEEDED`。调用方应指数退避并稍后重试，复用同一意图的
`idempotency_key`；不要并发制造新键来绕过容量。`BROWSER_UNAVAILABLE` 和
`UPSTREAM_TIMEOUT` 也可在页面恢复后有限重试。`409` 表示提案状态已变化：重新读取
赔率并让用户重新决定，不要盲目重试旧输入。登录过期或 schema 变化应先人工修复。

成功只到 `ready_for_manual_confirmation`。运维交接流程是：调用方展示响应中的
`current_odds`、`stake`、`projected_gross_return` 和 `expires_at`；用户回到已登录的
IM 体育页面手动定位同一选择，重新核对页面当前赔率和金额，并手动完成最终确认。
本服务永远不会代替这一步，也没有 submit、confirm、cancel、settle 或 cashout
API、私有场馆请求或页面点击。

冒烟检查只验证响应结构和汇总状态，不打印私有请求体或响应体。测试工具应在内存中
断言：HTTP 状态为 `200`，`data.state` 为 `ready_for_manual_confirmation`，
`current_odds` 是字符串，`created_at < expires_at`，`fetched_at === created_at`，且
响应没有 credential、Cookie、Web Storage 或 URL token 字段；控制台只报告类似
`draft_shape=ok status=200` 的汇总。失败时只记录 HTTP 状态、稳定 error code 和
服务生成的 `request_id`，不得记录 Authorization、完整 URL、请求体、响应体、事件、
选择、赔率或金额。示例只用占位符，绝不复制真实令牌或真实页面 URL。

实时接口是：

```text
wss://k8.nbmrjun.top/ws/sports?token=<WS_TOKEN>
```

`WS_TOKEN` 必须和 `API_TOKEN` 不同。不要把实际连接地址粘贴到聊天、日志、文档、
截图或 shell 历史中。服务端诊断不会记录查询字符串。

连接后的消息类型只有：

- `snapshot`：当前完整滚球赛事；
- `delta`：赔率、盘口线或可用性变化；
- `score`：比分或时钟变化；
- `ping`：每 30 秒一次的应用心跳。

## 安全验证

本地检查只输出汇总计数，不输出事件、余额或令牌：

```bash
cd /Users/apple/Documents/Codex/2026-07-19/chrome-cookie-local-storage/k8/.worktrees/browser-bridge
npm run smoke:ws
```

公网验证时，仅在当前进程中设置不含令牌的目标地址：

```bash
K8_WS_BASE_URL=wss://k8.nbmrjun.top npm run smoke:ws
```

未提供 WebSocket 令牌应收到 `401`；行情尚未形成快照应收到 `503`。安全冒烟程序
只接受 `snapshot/delta/score/ping`，并检查 `seq` 严格递增。

## 故障与回滚

- `9223` 不可访问：先启动桌面上的 K8 专用 Chrome。
- `503`：确认专用 Chrome 的 IM 体育页仍登录并保持打开。
- `400`：确认 HTTP 请求同时提供支持的 `scope` 和 `sport`，不要使用 `scope=all`。
- `1012`：上游超过 15 秒无有效数据或 CDP 断开；客户端应重连。
- 未知上游增量不会被猜测应用；服务会限频刷新页面，等待新的完整快照。
- 如需临时回滚到 Apple Events，可设置 `BROWSER_TRANSPORT=apple_events`，但实时
  WebSocket 会保持不可用并返回 `503`。

现有 `odds.nbmrjun.top -> http://localhost:8787` 规则、隧道凭证和 DNS 记录均不修改。

## 令牌轮换

分别轮换 `.env.local` 中的 `API_TOKEN` 和 `WS_TOKEN`，确保两者不同，然后重启 API
并更新调用服务器。任何曾粘贴到聊天或终端的 Cloudflare Global API Key 都应在
Cloudflare 控制台撤销；运行隧道使用 tunnel credentials，不依赖 Global API Key。
