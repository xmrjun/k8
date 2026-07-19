# IM Sports 体育项目区分设计

## 目标与边界

`scope` 与 `sport` 是两个独立维度。`scope` 只表示赛事时间分区：`live`、`today`、`early`；`sport` 只表示体育项目。第一批完成并验证 `football`、`basketball`、`tennis`，不根据相似中文名称把电子足球、电子篮球或其他项目混入这三类。

接口继续使用：

```http
GET /api/sports?scope=live|today|early|all&sport=football|basketball|tennis
```

省略 `sport` 时返回所选范围内所有已可靠识别的项目。每个赛事必须同时返回 `scope` 和 `sport`，缓存键继续由两者共同组成。WebSocket 仍维持当前已经验证的 `live + football` 能力；本次不假设篮球或网球的站内推送协议已经验证。

## 已验证的页面身份

2026-07-19 的只读页面检查确认，赛事链接路径为：

```text
/sev/<sport-id>/<view-id>/<event-id>
```

第一段才是体育项目 ID：

| sport-id | API sport | 页面名称 |
| --- | --- | --- |
| `1` | `football` | 足球 |
| `2` | `basketball` | 篮球 |
| `3` | `tennis` | 网球 |

现有解析器错误地把第二段当作体育项目回退值；这会把篮球和网球误判为足球。新解析器以第一段为稳定身份，并与赛事块标题中的项目名称交叉校验。ID 与标题不一致、未知 ID 或混合项目进入同一赛事块时，返回 `UPSTREAM_SCHEMA_CHANGED`，不做猜测。

`滚球中`、`今日`、`早盘`继续从各赛事块标题识别。页面上的“所有体育”和“热门”是导航分组，不作为 `scope`；“串关”是组合视图，也不作为赛事自身的 `scope`。

## 项目专用市场

三个项目共用赛事、联赛、队伍、比分、时钟、香港盘赔率和锁盘的基础结构，但市场不同：

- 足球：三项 `1x2`（home/draw/away）、`handicap`、`total`。
- 篮球：两项 `moneyline`（home/away）、`handicap`、`total`。
- 网球：两项 `moneyline`（home/away）、`handicap`、`total`，并在结构明确时输出 `odd_even`（odd/even）。

足球和篮球赛事块可包含两个时期容器：第一个归一化为 `full_time`，第二个归一化为 `first_half`。网球当前只读取第一个经过验证的时期容器。`selection_key` 继续使用 `event_id:period:type:name`，因此不同项目和时期不会冲突。

锁盘仍返回 `available=false`。只有包含明确盘口线的 `handicap` 和 `total` 才要求 `line`；`1x2`、`moneyline` 和 `odd_even` 不带 `line`。

## 解析、错误与测试

DOM 表达式保持只读、最多读取 500 个赛事，不点击赔率、不发起页面请求，也不读取 Cookie、Local Storage、Session Storage、请求头或完整场馆 URL。表达式只返回普通体育 JSON，Node 侧再做严格归一化。

测试使用合成 DOM 和合成 payload 覆盖：体育 ID `1/2/3`、标题交叉校验、足球三项胜负盘、篮球/网球两项独赢、上下半场、让分、大小、网球单双、锁盘以及 `scope + sport` 过滤。未知项目和项目冲突必须失败，不能静默丢到足球。

README 和页面契约文档将明确：HTTP 支持三个项目的快照过滤；实时 WebSocket 仍只承诺已验证的滚球足球，直到篮球和网球推送协议另行完成。
