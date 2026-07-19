# k81128 Read-Only API

受 Bearer Token 保护的本机只读 HTTP API。第一版目标接口：

- `GET /health`
- `GET /api/sports`
- `GET /api/balance`
- `GET /api/bets?limit=25&cursor=...`

服务默认只监听 `127.0.0.1:8788`。除 `/health` 外，所有接口都要求 `Authorization: Bearer <API_TOKEN>`。

## 当前状态

HTTP 路由、鉴权、响应格式、缓存、分页校验、上游错误映射和测试均已完成。真实 k81128 网页使用同源 POST、逐请求签名、登录 token 和响应加密；生产上游适配器目前安全禁用，受保护接口会返回 `502 UPSTREAM_BAD_RESPONSE`，不会返回假数据。

已发现的真实路径和限制见 [docs/k81128-upstream.md](docs/k81128-upstream.md)。

## 本地运行

要求 Node.js 22 或更高版本。

```bash
npm test
npm run generate-token
npm start
```

`npm run generate-token` 创建权限为 `0600` 的 `.env.local`，如果文件已存在则拒绝覆盖，也不会打印 token。

另一个终端运行：

```bash
npm run smoke
```

当前上游禁用时，预期 smoke 输出类似：

```json
{"health":"ok","protected_status":502}
```

这表示健康检查成功并且 Bearer Token 已被接受；它不表示真实赛事数据已经接通。

## launchd 模板

`deploy/com.nbmrjun.k8-api.plist` 使用当前项目绝对路径和 `/opt/homebrew/bin/node`。安装前应先检查路径，再复制到 `~/Library/LaunchAgents/`。本阶段没有自动安装或启动 launchd 服务。

## 安全约束

- 不提交 `.env.local`、真实 token 或网页登录凭证。
- 不从浏览器 Cookie、Local Storage 或 Session Storage 抽取凭证。
- 日志不记录 Authorization、网页 token 或完整账户响应。
- 生产适配器未通过签名和解密集成测试前保持禁用。
