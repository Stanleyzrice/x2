# x2

x2（小二）帮一个人经营网店：到各个网站上读数据、做事，拿不准的请示掌柜。掌柜是运营本人，她在自己的 Mac 上用 coding agent（Claude）使唤 x2。

只为运营真实的需求做事，抽象是这些需求用到的东西的最大公约数。第一个需求是采购：Shopee 上有人下单，要在出货期限前从 1688 买到对的货，不重买、不漏买。

## 四个概念

| 概念 | 是什么 | 例 |
|---|---|---|
| **site** | 读、写一个网站。经运营已登录的浏览器（cdp-relay）发请求，一个站点一个模块，每个导出的函数是一个操作；读操作另外声明成 `ops`（参数 + 怎么读），命令行直接能用 | `x2 shopee orders`、`x2 1688 offer --id …` |
| **store** | 存数据：读来的、人给的判断，都是 JSON 文件（`~/x2/`）。计算就是普通的函数 | `store.read("orders")`、`store.append("carted", …)` |
| **page** | 声明式的网页：agent 写一份 JSON，x2 渲染成网页。`ask` 等人操作、把答案交回 agent；`show` 只展示。常看的存成文件（`views/`），数据写「从哪个命令来」，每次打开都是最新的 | `x2 ask spec.json`、`x2 show buy` |
| **skill** | 告诉 agent 一件事怎么做：按什么顺序调哪些命令，哪一步要 ask | `.claude/skills/buy/SKILL.md` |

人和 agent 用同一套命令：`x2 <命令>`，加 `--json` 给 agent 读。改网站上的东西（加购、上架、发消息）的命令分两步：先列计划，人在 page 上确认了再做。

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
- 列表（list）默认翻到底，`--pages N` 只翻 N 页，`--cursor <next>` 从上次停下的地方接着翻；输出 `{ rows, next }`，`next` 是 null 就是到底了。page 的表格可以写 `"from": "shopee products --pages 1", "key": "rows"`。
- 只收读。写不进通用入口：写要先列计划、人在 page 上确认（例 `x2 buy cart`）。
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
7. **读不写文件**：读操作不碰 `~/x2/`。

## 目录

```
x2/
├ bin/x2.ts               命令行入口：x2 <命令> …
├ src/
│ ├ browser.ts            唯一碰 cdp-relay 的地方：选登录着的浏览器、用自己开的标签页、在页面里发请求
│ ├ errors.ts             错误分类和退出码：用法不对、要人处理
│ ├ site/                 一个站点一个文件（大的一个目录），只管「怎么请求、怎么从响应里取出数据」；各站的接口一览和坑在同目录的 .md
│ │ ├ op.ts               读操作的声明（get、list）和参数的类型（日期、逗号分隔的一列……）
│ │ ├ shopee/             卖家中心：订单、商品和上架、批量上架、收入、售后、经营数据和营销、聊聊、帮助中心（shopee.md）；ops.ts 是它的读操作
│ │ ├ alibaba.ts          1688：货源、搜索、购物车和加购、采购单、物流
│ │ ├ zhixia.ts           知虾：类目、热搜词、竞品、1688 同款（zhixia.md 是全部数据接口）
│ │ └ chanboss.ts         仓老板：入仓单、库存、退件、扣款流水
│ ├ similar.ts            规格名的比较：按字比，列出缺的数字、颜色
│ ├ store.ts              读写 ~/x2/*.json：整份覆盖（读来的）、往后加（人给的）
│ ├ page/
│ │ ├ spec.ts             page 的声明：组件目录（zod）。渲染不了的声明当场报错给 agent
│ │ ├ serve.ts            本机起一个页面、打开浏览器；ask 时等提交，把答案打印出来
│ │ └ web/                渲染声明的网页：index.html + render.ts，不用框架
│ └ commands/             x2 的子命令，一个文件一组
│   ├ site.ts             x2 <站点> <操作>、x2 schema：读操作的通用入口
│   ├ buy.ts              x2 buy：同步订单（order）、采购单、找货源（source）、加进 1688 购物车（cart）
│   └ page.ts             x2 ask、x2 show
├ views/                  存下来的 page：buy.json（采购单）……
├ .claude/skills/
│ └ buy/SKILL.md          采购：同步订单 → 采购单 → ask 找货源 → ask 确认加购 → 加进 1688 购物车 → 人付款
├ test/                   pnpm test 跑的单元测试；live/ 是对真站点跑一遍读取的脚本（手动运行，只打印字段名和条数）
├ package.json            依赖只有 @wuwe1/cdp-relay、zod
└ tsconfig.json           只做类型检查：Node 24 直接运行 .ts
```

数据在 `~/x2/`：

```
~/x2/
├ orders.json     读来的：待出货的订单和明细，每次 x2 buy order 整份覆盖
├ offers.json     读来的：1688 货源和它的规格
├ sources.json    人给的：Shopee 的一个 SKU → 1688 一家货源的一个规格，只往后加
├ carted.json     做过的：加进 1688 购物车的订单行（订单号 + SKU），只往后加
└ zhixia-usage.json  知虾最近一小时的请求时间：限流用，几个 x2 进程共用
```

## 先例

- site：一个站点的操作写成代码，不写成声明。写代码的是 agent，直接写函数最简单、出错最好查。
- page：Vercel 的 json-render（组件目录当护栏）、MCP 的 elicitation（向用户要结构化输入）、LangGraph 的 interrupt（流程停下等人）。
- skill：Claude 的 skill。
- 前身是 lilto（`~/Developer/lilto`），现在只当资料：Shopee、1688、聊聊的接口和 cdp-relay 的坑都记在那里。
