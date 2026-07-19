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

第一版严格只读：发布赛事、赔率、盘口可用性、比分和时钟，不执行或准备下注。

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
- `503`：确认专用 Chrome 的 IM 体育页仍登录并停留在滚球赛事页面。
- `1012`：上游超过 15 秒无有效数据或 CDP 断开；客户端应重连。
- 未知上游增量不会被猜测应用；服务会限频刷新页面，等待新的完整快照。
- 如需临时回滚到 Apple Events，可设置 `BROWSER_TRANSPORT=apple_events`，但实时
  WebSocket 会保持不可用并返回 `503`。

现有 `odds.nbmrjun.top -> http://localhost:8787` 规则、隧道凭证和 DNS 记录均不修改。

## 令牌轮换

分别轮换 `.env.local` 中的 `API_TOKEN` 和 `WS_TOKEN`，确保两者不同，然后重启 API
并更新调用服务器。任何曾粘贴到聊天或终端的 Cloudflare Global API Key 都应在
Cloudflare 控制台撤销；运行隧道使用 tunnel credentials，不依赖 Global API Key。
