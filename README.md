# k81128 Read-Only API

受 Bearer Token 保护的本机只读 HTTP API。第一版目标接口：

- `GET /health`
- `GET /api/sports`
- `GET /api/sports/account`
- `GET /api/balance`
- `GET /api/bets?limit=25&cursor=...`

服务默认只监听 `127.0.0.1:8788`。除 `/health` 外，所有接口都要求 `Authorization: Bearer <API_TOKEN>`。

## 当前状态

HTTP 路由、鉴权、响应格式、缓存、分页校验、浏览器错误映射和只读页面 reader 均已完成。默认的 `BROWSER_TRANSPORT=apple_events` 直接使用 Mac 上当前运行且已经登录的 Google Chrome；不需要复制网页凭证，也不会读取 Cookie、Local Storage、Session Storage、密码、完整页面 URL、URL token、请求头或请求签名。

IM Sports 页面 reader 和限制见 [docs/im-sports-upstream.md](docs/im-sports-upstream.md)，账户页面限制见 [docs/k81128-upstream.md](docs/k81128-upstream.md)。

`GET /api/sports/account` 每次实时读取 IM Sports 页面左侧账户面板，不缓存，返回 `currency`、`available_balance` 和 `unsettled_amount`。它与读取 k81128 主账户钱包的 `/api/balance` 相互独立。

## 本地运行

要求 macOS、Node.js 22 或更高版本，以及当前已经登录的 Chrome：

1. 保持 `https://k81128.com` 与配置的 IM Sports origin 两个标签页打开。
2. 在屏幕顶部 Chrome 菜单选择 **View > Developer > Allow JavaScript from Apple Events**。
3. 不要把 IM Sports 的完整网址或查询 token 放入任何配置文件。

```bash
npm test
npm run check
npm run generate-token
npm start
```

`npm run generate-token` 创建权限为 `0600` 的 `.env.local`，如果文件已存在则拒绝覆盖，也不会打印 token。传输层默认值等同于：

```dotenv
BROWSER_TRANSPORT=apple_events
```

第一次调用时，macOS 可能显示 Terminal 或 Node 的 **Automation** 权限提示，询问是否允许控制 **Google Chrome**；需要选择允许。若之前拒绝，可到 **System Settings > Privacy & Security > Automation** 重新开启。

另一个终端运行：

```bash
npm run smoke
```

成功接通浏览器时，`protected_status` 应为 `200`：

```json
{"health":"ok","protected_status":200}
```

`503` 表示 Chrome、目标标签页或 Automation 权限不可用；`502` 表示登录状态或页面结构需要检查。所有错误响应均经过脱敏。

### CDP 兼容回退

如果以后使用独立 Chrome 调试实例，可显式设置：

```dotenv
BROWSER_TRANSPORT=cdp
BROWSER_CDP_URL=http://127.0.0.1:9223
```

CDP 端口只能监听回环地址，绝不能暴露到局域网、服务器或 Cloudflare Tunnel。

## launchd 模板

`deploy/com.nbmrjun.k8-api.plist` 明确使用 Apple Events 传输，并使用当前项目绝对路径和 `/opt/homebrew/bin/node`。安装前应先检查路径，再复制到 `~/Library/LaunchAgents/`。launchd 进程也必须获得控制 Google Chrome 的 Automation 权限。本阶段没有自动安装或启动 launchd 服务。

## 安全约束

- 不提交 `.env.local`、真实 token 或网页登录凭证。
- 不从浏览器 Cookie、Local Storage 或 Session Storage 抽取凭证。
- 日志不记录 Authorization、网页 token 或完整账户响应。
- 只把 `127.0.0.1:8788` 交给受 Bearer Token 保护的隧道；永不暴露浏览器控制端口。
