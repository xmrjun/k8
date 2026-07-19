# IM Sports 全量赔率 API 设计

## 目标与边界

Mac 上的专用 Chrome 由用户自行登录 k81128，并打开 IM Sports 场馆页面。Node.js API 仅通过本机回环 CDP 读取页面已经展示的普通赛事与赔率数据，再通过受 Bearer Token 保护的 HTTPS 域名供用户的服务器查询。

第一阶段严格只读。服务不下注、不充值、不提现，也不读取、导出、保存或返回 Cookie、Local Storage、Session Storage、账号密码、页面 URL token、请求签名或其他登录凭证。用户负责登录、验证码和会话续期。

本设计取代原浏览器桥设计中“从 k81128 首页快捷体育卡片读取 `/api/sports`”的方案。余额与游戏记录仍来自 k81128 账户页面；体育赛事和赔率只以 IM Sports 场馆页面为权威来源，不做不完整的首页数据降级。

## 双页面架构

```text
调用方服务器
  -> HTTPS 域名 / Cloudflare Tunnel
  -> Mac 127.0.0.1:8788
  -> Bearer Token + 参数校验 + 分范围缓存
  -> 单操作队列 BrowserUpstreamAdapter
  -> CDP 127.0.0.1:9223
       -> k81128 origin：余额、游戏记录
       -> IM Sports origin：滚球、今日、早盘全体育赔率
```

两个浏览器网关只按完整 origin 选择标签页。配置中只允许 origin，不允许路径、查询字符串或片段，因此 IM Sports 页面 URL 中的 token 不会进入配置、日志、Git 或 API 响应。所有浏览器操作共享一个串行队列，避免同时读取或导航同一个专用 Chrome 会话。

## 体育查询接口

```http
GET /api/sports?scope=live|today|early|all&sport=<sport-key>
Authorization: Bearer <API_TOKEN>
```

- `scope` 默认 `all`。
- `sport` 可省略；省略表示所有体育类型。
- 未知参数、重复参数、空参数或不支持的值返回 `400 INVALID_REQUEST`。
- 单次最多返回 500 个赛事；超过时 `truncated=true`。
- `all` 包含滚球、今日和早盘，按页面顺序返回。

成功响应的业务数据为：

```json
{
  "data": {
    "events": [],
    "count": 0,
    "truncated": false
  },
  "source": "im-sports-browser",
  "fetched_at": "2026-07-19T00:00:00.000Z",
  "request_id": "..."
}
```

## 公共数据模型

```json
{
  "event_id": "111486996",
  "sport": "football",
  "scope": "live",
  "league": "示例联赛",
  "home": "主队",
  "away": "客队",
  "score": { "home": 0, "away": 0 },
  "clock": "下半场 77:24",
  "markets": [
    {
      "period": "full_time",
      "type": "1x2",
      "selections": [
        {
          "selection_key": "111486996:full_time:1x2:home",
          "name": "home",
          "display_odds": "6.43",
          "odds_format": "hong_kong",
          "decimal_odds": "7.43",
          "available": true
        }
      ]
    }
  ]
}
```

规则如下：

- `event_id` 从场馆赛事链接的稳定数字 ID 提取，不使用 DOM 下标。
- `sport` 和 `scope` 从已验证的页面分区归一化；无法可靠识别时视为页面结构变化。
- `score` 和 `clock` 只在页面明确展示时返回，否则为 `null`。
- 首批标准市场支持 `1x2`、`handicap` 和 `total`；保留 `period`，先稳定支持 `full_time`，其余时段只在能可靠识别后输出。
- `selection_key` 由 `event_id:period:type:name` 组成，是未来下注解析的稳定引用；当前接口不接受该键执行写操作。
- 页面显示的是香港盘赔率。`display_odds` 原样保留规范化后的十进制字符串；有效香港盘赔率转换为 `decimal_odds = display_odds + 1`。
- 锁盘、`--`、空赔率或不可点击项返回 `available=false`，且不伪造 `decimal_odds`。
- 赔率字符串转换使用十进制字符串运算，避免二进制浮点误差。

## DOM 读取与校验

浏览器表达式最多扫描 500 个赛事，只返回体育业务字段组成的普通 JSON。已验证的页面结构包括：

- 赛事链接：`a[href^="/sev/"]`
- 赛事行：`.event_row`
- 联赛标题：`.competition_header_team`
- 队伍：`.teamname_title`
- 比分与时间：`.score`、`.datetime`
- 1X2：`.event_even.double .odds_wrap`
- 盘口与大小：`.handi`、`.ou`
- 赔率值：`.odds`
- 锁盘：`.lock`

表达式不得访问 `document.cookie`、`localStorage`、`sessionStorage`、IndexedDB 或页面网络请求头。Node 侧对表达式结果进行严格结构校验；登录页、跳转页、空壳页和未知 DOM 不得伪装成合法空数据。

## 缓存、超时与错误

缓存按 `scope + sport` 分键，默认有效期：

- `live`：1 秒
- `today`：3 秒
- `early`：10 秒
- `all`：1 秒，因为其中包含滚球数据

缓存只保存标准化体育数据，不保存页面原始响应。默认不在读取失败时返回过期缓存。

稳定错误映射：

- IM Sports 标签页不存在或 Chrome 不可用：`503 BROWSER_UNAVAILABLE`
- 页面登录失效、跳转到登录页或赛事场馆会话失效：`502 UPSTREAM_AUTH_EXPIRED`
- 页面选择器或返回结构变化：`502 UPSTREAM_SCHEMA_CHANGED`
- 浏览器操作超时：`504 UPSTREAM_TIMEOUT`

错误响应和日志不得包含页面 URL、URL token、CDP WebSocket 地址、DOM 快照、账户名、余额或原始异常正文。

## 测试与验收

- 使用完全脱敏的合成 fixture 测试滚球、今日、早盘、1X2、让球、大小、锁盘和缺失赔率。
- 对查询参数、500 条上限、截断标记、缓存分键和错误映射做 HTTP 测试。
- 表达式安全测试确认不包含浏览器存储、Cookie 或凭证读取语句。
- 本机 Chrome 集成测试只检查状态码、字段形状和数量，不保存真实赛事快照或账户数据。
- Chrome 或 IM Sports 页面不可用时明确失败；不得回退到 k81128 首页的非完整体育卡片。

## 未来下注边界

下注能力不属于本阶段。未来必须使用独立的 `/api/orders`、独立写入 Token、默认关闭开关、单笔与累计限额、赔率容忍度、幂等键、赛事与盘口二次确认、完整审计以及紧急停止开关。只读 `/api/sports` 的 Token 永远不能直接获得写权限。
