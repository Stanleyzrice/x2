# x2

x2（小二）帮一个人经营网店：到各个网站上读数据、做事，拿不准的请示掌柜。掌柜是运营本人，她在自己的 Mac 上用 coding agent（Claude）使唤 x2。

只为运营真实的需求做事，抽象是这些需求用到的东西的最大公约数。第一个需求是订单：Shopee 上有人下单，要在出货期限前从 1688 买到对的货、预报给仓老板、打包，不重买、不漏买。

## 四个概念

| 概念 | 是什么 | 例 |
|---|---|---|
| **site** | 读、写一个网站。经运营已登录的浏览器（cdp-relay）发请求，一个站点一个模块；读操作声明成 `ops`（参数 + 怎么读），命令行直接能用；写操作声明在 `site/writes.ts`，只由 `x2 run` 执行 | `x2 shopee orders`、`x2 1688 offer --id …` |
| **库** | Postgres（`X2_DATABASE_URL`），唯一的数据：人定的（货源、设置、批准）、写入的记录、站点数据的镜像。表的结构在 `src/db/schema.sql`，x2 建和改；人在 NocoDB 里看和填 | 订单、规格、收件箱、写入 |
| **循环** | 同步（站点 → 库）→ 检查（算出收件箱和 agent 要做的）→ agent 准备写入、人在收件箱里做和批准 → `x2 run` 执行、读回来 → 下一轮。做完 = 收件箱是空的（[docs/loop.md](docs/loop.md)） | `x2 status`、`x2 propose`、`x2 run` |
| **skill** | 告诉 agent 一件事怎么做：按什么顺序调哪些命令，哪一步等人 | `.claude/skills/orders/SKILL.md` |

人和 agent 用同一套命令：`x2 <命令>`，加 `--json` 给 agent 读。改站点上的东西（加购、预报）只有一条路：agent 用 `x2 propose` 写成待批准的写入，人在收件箱里批准，`x2 run` 先记意图、提交一次、再读回来。agent 开起来做什么在 [AGENTS.md](AGENTS.md)。

## 推进：x2 status

```sh
x2 status                      # 同步过期的数据 → 检查 → 更新收件箱 → 数据新不新、收件箱里有什么、agent 能做什么
x2 status --json               # 给 agent：todo 里有现成的一批写入
x2 sync orders --force         # 只同步一域：orders 订单（仓老板）、skus 规格（Shopee，一家店一份）、cart 1688 购物车、purchases 采购单
x2 source 188862745004         # 给一个规格找货源：这个商品用过的 → 以图搜图 → 按规格名打分
x2 propose < 一批.json          # 写一批待批准的写入；收件箱加一行「批准」
x2 approve 12                  # 人在终端里说「批准」时，替人勾上
x2 run                         # 执行批准了的写入
```

两家店各开一个浏览器（Chrome 的不同用户）：x2 每个连着的浏览器读一次登录着的店和 1688 账号，按店、按账号选。只连着一个浏览器、或要手动选时，用 `X2_BROWSER`。

## 读站点：x2 <站点> <操作>

每个站点的读操作都能直接跑（先例 steampipe 的表：参数是 key columns，翻页藏在操作里）。agent 要什么数据就现读什么，算和分析在 agent 那边做：

```sh
x2 shopee                                   # 列出操作
x2 shopee performance --help                # 参数
x2 shopee performance --start 2026-09-01 --end 2026-09-30 --period past30days --json
x2 zhixia hot-word-items --word 123 --path 100629,100630 --pages 2 --json
x2 schema                                   # 全部操作的说明和参数（JSON Schema）
```

- 参数写成 `--名字 值`；日期是台湾时间的 `YYYY-MM-DD`（也可以给秒）；一列值用逗号分隔。
- 列表（list）默认翻到底，`--pages N` 只翻 N 页，`--cursor <next>` 从上次停下的地方接着翻；输出 `{ rows, next }`，`next` 是 null 就是到底了。
- 只收读。写不进通用入口：写只经 `x2 propose` → 人批准 → `x2 run`。
- 逃生口：`x2 shopee raw --path …`、`x2 zhixia raw --path …`，只 GET。

## 输出约定

先例 himalaya（Pimalaya 的输出约定）。

1. **stdout 只放结果**：加 `--json` 时整个 stdout 是一个 JSON 值。
2. **stderr 只放进度、日志**：例「检查货源 3/8」「第 2 页，共 96 行」。
3. **出错**：加 `--json` 时 stdout 是 `{ "error": { "kind", "message" } }`，退出码不是 0；不加时错误在 stderr。
4. **退出码**告诉调用方下一步做什么：

   | 退出码 | kind | 意思 | 下一步 |
   |---|---|---|---|
   | 0 | | 成功 | |
   | 1 | error | 出错 | 把原话告诉人 |
   | 2 | usage | 用法不对 | 看 `--help` 改命令 |
   | 3 | human | 要人处理：没登录、要过滑块、浏览器没连上 | 请运营在浏览器里处理好再重试 |
   | 4 | | 写的结果未知 | 不许重发，先回读 |

5. **字段**：id 一律是字符串（Shopee、1688 的订单号超过 JS 数字的精度）；时间用 ISO 8601。读来的原样字段（`any` 的行）先照站点的样子给，用到时再整理。
6. **自描述**：`x2 <站点>`、`x2 <站点> <操作> --help`、`x2 schema`。
7. **读不写库**：读操作不碰库，同步才写。

## 目录

```
x2/
├ bin/x2.ts               命令行入口：x2 <命令> …
├ AGENTS.md               agent 开起来做什么、不许做什么（CLAUDE.md 引它）
├ docs/                   loop.md 循环怎么转；orders.md 订单；glossary.md 词
├ src/
│ ├ browser.ts            唯一碰 cdp-relay 的地方：选浏览器（using）、用自己开的标签页、在页面里发请求
│ ├ accounts.ts           按店找浏览器：每个浏览器里登录着哪家店、哪个 1688 账号
│ ├ errors.ts             错误分类和退出码：用法不对、要人处理
│ ├ site/                 一个站点一个文件（大的一个目录），只管「怎么请求、怎么从响应里取出数据」；各站的接口一览和坑在同目录的 .md
│ │ ├ op.ts               读操作的声明（get、list）和参数的类型（日期、逗号分隔的一列……）
│ │ ├ writes.ts           写操作的声明：加购、预报（现读 → 提交 → 读回来），只由 x2 run 执行
│ │ ├ shopee/             卖家中心：订单、商品和上架、批量上架、收入、售后、经营数据和营销、聊聊、帮助中心（shopee.md）；ops.ts 是它的读操作
│ │ ├ 1688.ts             1688：货源、搜索、购物车和加购、采购单、物流
│ │ ├ zhixia.ts           知虾：类目、热搜词、竞品、1688 同款（zhixia.md 是全部数据接口）
│ │ └ chanboss.ts         仓老板：订单、预报、库存、退件、扣款流水（chanboss.md）
│ ├ db/                   库：连接、schema.sql（建表、加列）、import.ts（把 ~/x2 的 JSON 迁进来，只用一次）
│ ├ sync/                 同步，一域一个（站点 → 镜像），按 syncs 表的「目标多新」决定读不读
│ ├ check/                检查：纯函数（orders.ts、reconcile.ts 对采购单），index.ts 读快照、写回收件箱
│ ├ propose.ts            x2 propose、x2 approve：待批准的写入、收件箱的「批准」
│ ├ run.ts                x2 run：执行批准了的写入
│ ├ source.ts             x2 source：选货源
│ ├ similar.ts            规格名的比较：按字比，列出缺的数字、颜色
│ └ commands/             x2 的子命令，一个文件一组：site.ts（读站点）、loop.ts（status、sync、propose、approve、run）、source.ts、db.ts
├ .claude/skills/
│ └ orders/SKILL.md       订单：找货源 → 加购 → 人付款 → 对采购单 → 预报 → 人打包
├ test/                   pnpm test 跑的单元测试（loop.test.ts 连库：设 X2_TEST_DATABASE_URL，会清空那个库）；live/ 是对真站点跑一遍读取的脚本
├ package.json            依赖：@wuwe1/cdp-relay、postgres、zod
└ tsconfig.json           只做类型检查：Node 24 直接运行 .ts
```

数据都在库里。本机只留一个文件：`~/x2/zhixia-usage.json`（知虾最近一小时的请求时间，限流用，几个 x2 进程共用）。凭证（库的密码）在环境变量里。

## 先例

- site：一个站点的操作写成代码，不写成声明。写代码的是 agent，直接写函数最简单、出错最好查。
- 循环：Kubernetes 的 controller（按状态触发，不按事件）；lilto 的「做完 = 某个视图为空」「读取的频率是目标，不是任务」。
- skill：Claude 的 skill。
- 前身是 lilto（`~/Developer/lilto`），现在只当资料：Shopee、1688、聊聊的接口和 cdp-relay 的坑都记在那里。
