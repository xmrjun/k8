# k81128 上游接口发现记录

## 结论

2026-07-19 对已登录的 `https://k81128.com/sports` 页面进行了只读检查。页面确实展示赛事和赔率，但生产网页并不是调用一个可直接复用的普通 Bearer API。它使用同源 POST 接口、逐请求签名、可选响应加密，以及登录会话中的多个字段。

本次检查未读取 Cookie、Local Storage、Session Storage、密码或任何登录凭证。以下路径来自页面公开加载的 JavaScript 文件，测试请求均未携带用户凭证。

## 已确认的查询接口

所有 URL 都以 `https://k81128.com` 为基址。

| 数据 | 方法 | 路径 | 网页调用参数 |
| --- | --- | --- | --- |
| 快捷投注赛事 | `POST` | `/_glaxy_91a2c0_/game/sbtGetEvents` | `platformCurrency: "CNY"`、`sportIDs: []`、`eventStatus: []` |
| 当前余额 | `POST` | `/_glaxy_91a2c0_/customer/getBalance` | 调用方传空对象；拦截器补充账户和币种字段 |
| 电游投注记录 | `POST` | `/_glaxy_91a2c0_/bet/queryBetsWithGameKind` | `pageNo`、`pageSize`、`currency`、`lastDays`、`gameKind: 5`、`platformCode` |

网页当前赛事页使用 `sbtGetEvents`，不是旧代码中仍存在但当前请求返回 404 的 `sports-event/ysb-hot-events`。

## 请求封装

公开客户端代码显示，公共命名空间为 `_glaxy_91a2c0_`，基址为空，因此请求发送到当前网页同源。共享请求拦截器会：

1. 在请求体中补充 `productId`，登录后通常还补充 `loginName`、币种或平台币种。
2. 生成 `Qid`，并基于规范化请求体、`Qid`、公开应用 ID、版本号以及会话 token 生成 `Sign`。
3. 添加 `AppId`、`Qid`、`v`、`domainName`、`needEncrypt`、`token`，部分请求还需要 `deviceId`。
4. 当 `needEncrypt=1` 时解密成功响应的 `body`。

因此，只有一个不透明的 `UPSTREAM_CREDENTIAL` 字符串不足以可靠复现请求。真正的直连适配器至少需要用户在浏览器之外提供受支持的登录凭证组合，并实现、测试签名和响应解密。

## 无凭证验证

对三个确认路径各发送了一次不带 Cookie、token 或签名的空 JSON 请求。服务器均返回 HTTP 200 和业务错误 `GW_899998`（非法访问）。这证明路径存在，也证明匿名直连不可用。

未验证真实响应结构。`test/fixtures/*.json` 目前只是公共 API 模型测试夹具，不能视为上游真实响应样本。

## 当前支持边界

- HTTP 服务和测试可以使用 fake adapter 完成。
- 生产直连 adapter 暂不启用，直到用户通过本地环境安全提供独立凭证且签名/解密实现通过集成测试。
- 余额和投注记录不能通过 DOM 推断或假装可用。
- 若无法提供独立凭证，应实现一个明确隔离的浏览器采集 adapter；它不得依赖 Codex 的 Chrome 控制会话，也不得把浏览器存储复制到仓库。

## 后续验证清单

1. 由用户在浏览器之外提供平台支持的会话凭证格式。
2. 在本地环境文件中保存，确保 Git 忽略且日志不输出。
3. 实现请求签名与响应解密后，每个接口只做一次聚焦集成请求。
4. 将响应脱敏后更新 fixtures 和 normalizer，再启用生产上游。
