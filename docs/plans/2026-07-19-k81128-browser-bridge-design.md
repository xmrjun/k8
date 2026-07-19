# k81128 专用 Chrome 桥接设计

## 目标与边界

在用户的 Mac 上长期运行一个专用 Chrome 实例。用户在该实例中自行登录 k81128，Node.js API 通过仅监听回环地址的 Chrome DevTools Protocol（CDP）连接浏览器，调用网页已经加载的应用逻辑并读取网页已经解密的业务状态。

调用方服务器通过 `https://k8.nbmrjun.top` 访问 Cloudflare Tunnel，Tunnel 将请求转发到 Mac 的 `127.0.0.1:8788`。第一阶段只提供赛事、余额和投注记录查询，不提供下注、充值、提现或任何会改变账户状态的操作。

本服务不读取、导出或返回 Chrome Cookie、Local Storage、Session Storage、密码、网页 Token 或请求签名。登录、验证码和会话续期由用户在专用 Chrome 中完成。

## 总体架构

```text
调用方服务器
  -> HTTPS https://k8.nbmrjun.top
  -> Cloudflare Tunnel
  -> Mac 127.0.0.1:8788
  -> Bearer Token 鉴权与参数校验
  -> 单队列 BrowserUpstreamAdapter
  -> CDP http://127.0.0.1:9223
  -> 专用 Chrome / 专用用户目录
  -> 已登录的 k81128 网页应用
```

CDP 端口只绑定 `127.0.0.1`，不经过 Tunnel 发布，也不允许远程服务器直接连接。外部唯一入口是受 Bearer Token 保护的业务 API。

## 专用 Chrome 运行模型

- 使用独立的浏览器用户目录，避免连接用户日常使用的 Chrome。
- 由启动脚本以 `--remote-debugging-address=127.0.0.1` 和固定 CDP 端口启动。
- 用户在这个专用窗口中手动完成账号密码登录及可能出现的验证码。
- Node 服务只寻找允许的 k81128 origin 页面，不操作其他标签页。
- 服务不自动输入密码、不绕过验证码，也不把浏览器会话复制到服务器。
- Mac 睡眠、Chrome 退出或网页登录失效时，API 明确失败，不返回旧数据冒充成功。

## BrowserUpstreamAdapter

浏览器适配器实现现有的三个方法：

- `getSports()`
- `getBalance()`
- `getBets({ limit, cursor })`

适配器通过可替换的浏览器网关连接 CDP。生产网关使用 Playwright 的 `connectOverCDP()`；测试使用完全内存化的假网关，不需要真实账号或浏览器。

每个操作遵循相同流程：

1. 确认 CDP 可连接，并找到允许 origin 的页面。
2. 确认网页已加载且处于登录状态。
3. 在页面上下文调用已验证的只读 Vue/Vuex action，或在必须时导航至只读页面。
4. 只复制赛事、余额或投注记录所需的普通 JSON 字段。
5. 在 Node 侧进行结构校验和公共模型标准化。
6. 丢弃页面操作中的临时结果，不记录完整账户响应。

优先调用网页自身的只读 action 并读取 store 状态，因为网页已经完成逐请求签名和响应解密。若投注记录没有稳定的 store action，则为其建立独立、经过集成验证的页面读取器；在验证完成前该接口返回稳定错误，而不是依赖脆弱的通用 DOM 抓取。

## 并发、超时与恢复

浏览器操作使用单队列串行执行，避免多个 API 请求同时导航或修改同一页面状态。HTTP 层仍可并发处理健康检查和鉴权失败。

- 每个浏览器操作有固定超时，默认 15 秒。
- 连接断开后，下一次请求尝试重新连接 CDP。
- Chrome 不可用时返回 `503 BROWSER_UNAVAILABLE`。
- 网页未登录或会话失效时返回 `502 UPSTREAM_AUTH_EXPIRED`。
- 页面操作超时时返回 `504 UPSTREAM_TIMEOUT`。
- 网页结构或状态结构变化时返回 `502 UPSTREAM_SCHEMA_CHANGED`。
- 不自动重放可能改变状态的动作；第一阶段本来就不存在此类动作。

`GET /health` 只说明 Node 服务是否存活。另增加不泄露账户信息的浏览器状态字段或诊断接口，用于区分 `connected`、`login_required` 和 `unavailable`。

## 对外接口与数据安全

保留现有接口：

- `GET /health`
- `GET /api/sports`
- `GET /api/balance`
- `GET /api/bets?limit=25&cursor=...`

除健康检查外，均要求 `Authorization: Bearer <API_TOKEN>`。服务继续只监听 `127.0.0.1:8788`，Cloudflare Tunnel 只暴露该 HTTP 服务。

日志仅记录请求 ID、路径、耗时、HTTP 状态和稳定错误码。以下内容禁止写入日志或 API 响应：

- API Bearer Token
- Chrome Cookie 和存储内容
- k81128 登录 Token、签名或密码
- CDP 页面快照中的无关账户信息
- 完整上游响应正文

## 启动与运行管理

运行时分为两个独立进程：

1. 专用 Chrome 启动器：固定用户目录、回环 CDP 地址和 k81128 起始页面。
2. Node API：连接 CDP、提供查询接口，并通过 launchd 保持运行。

Cloudflare Tunnel 继续作为第三个已有进程运行。安装 launchd 和修改现有 Tunnel 配置都属于影响本机长期运行状态的操作，实施时先验证模板和当前配置，再单独执行并保留回滚办法。

## 测试策略

1. 单元测试：浏览器连接、页面选择、单队列、超时、错误映射和敏感字段过滤。
2. 适配器测试：使用假浏览器网关验证三个方法及公共模型，不使用真实凭证。
3. 本机只读集成测试：连接专用 Chrome，仅验证已确认的读取 action 和状态路径。
4. HTTP 测试：验证鉴权、缓存、分页和浏览器错误到 HTTP 状态的映射。
5. Tunnel 验证：先验证未授权请求为 `401`，再以本地环境 Token 验证受保护接口。
6. 安全检查：确认 `.env.local`、浏览器用户目录和真实 Token 未进入 Git 或日志。

## 实施阶段

### 阶段一：浏览器桥接只读 API

- 增加浏览器配置、网关、单队列和错误类型。
- 增加专用 Chrome 启动脚本与运维文档。
- 通过本机已登录页面验证赛事、余额和投注记录读取路径。
- 接入现有 HTTP API，保持真实数据不可用时明确失败。

### 阶段二：本机常驻与域名

- 安装并验证 Chrome 与 API 的 launchd 服务。
- 在现有 Cloudflare Tunnel 中增加 `k8.nbmrjun.top -> http://127.0.0.1:8788`。
- 验证既有域名不受影响，并完成外部服务器调用测试。

### 阶段三：未来下注能力

下注不在本设计的实施范围内。未来若增加，必须单独设计并至少包含：独立写入 Token、默认关闭开关、投注额与每日损失上限、幂等键、明确的赛事与赔率确认、二次确认、完整审计记录以及紧急停用开关。不得把只读接口直接扩展为无保护的下注通道。

## 验收标准

- 专用 Chrome 登录后，三个只读接口能返回稳定公共模型。
- Chrome 退出、Mac 休眠或登录失效时，调用方收到稳定、可诊断且不含秘密的错误。
- CDP 与 HTTP 服务只监听回环地址。
- 外部服务器只能通过 HTTPS 域名和 Bearer Token 调用。
- 不读取或导出浏览器凭证，不在 Git、日志或响应中泄露秘密。
- 第一阶段没有任何会改变 k81128 账户状态的代码路径。
