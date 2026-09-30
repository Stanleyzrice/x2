# x2

x2（小二）帮一个人经营网店：到各个网站上读数据、做事，拿不准的请示掌柜。掌柜是运营本人，她在自己的 Mac 上用 coding agent（Claude）使唤 x2。

只为运营真实的需求做事，抽象是这些需求用到的东西的最大公约数。第一个需求是采购：Shopee 上有人下单，要在出货期限前从 1688 买到对的货，不重买、不漏买。

## 四个概念

| 概念 | 是什么 | 例 |
|---|---|---|
| **site** | 读、写一个网站。经运营已登录的浏览器（cdp-relay）发请求，一个站点一个模块，每个导出的函数是一个操作 | `shopee.toShipOrders()`、`alibaba.offer(id)` |
| **store** | 存数据：读来的、人给的判断，都是 JSON 文件（`~/x2/`）。计算就是普通的函数 | `store.read("orders")`、`store.append("bought", …)` |
| **page** | 声明式的网页：agent 写一份 JSON，x2 渲染成网页。`ask` 等人操作、把答案交回 agent；`show` 只展示。常看的存成文件（`views/`），数据写「从哪个命令来」，每次打开都是最新的 | `x2 ask spec.json`、`x2 show buy` |
| **skill** | 告诉 agent 一件事怎么做：按什么顺序调哪些命令，哪一步要 ask | `.claude/skills/buy/SKILL.md` |

人和 agent 用同一套命令：`x2 <命令>`，加 `--json` 给 agent 读。改网站上的东西（加购、上架、发消息）的命令分两步：先列计划，人在 page 上确认了再做。

## 目录

```
x2/
├ bin/x2.ts               命令行入口：x2 <命令> …
├ src/
│ ├ browser.ts            唯一碰 cdp-relay 的地方：选登录着的浏览器、用自己开的标签页、在页面里发请求
│ ├ site/                 一个站点一个文件，只管「怎么请求、怎么从响应里取出数据」
│ │ ├ shopee.ts           待出货的订单、订单明细、商品和规格
│ │ └ alibaba.ts          1688：货源（标题、图、规格、价格）
│ ├ similar.ts            规格名的比较：按字比，列出缺的数字、颜色
│ ├ store.ts              读写 ~/x2/*.json：整份覆盖（读来的）、往后加（人给的）
│ ├ page/
│ │ ├ spec.ts             page 的声明：组件目录（zod）。渲染不了的声明当场报错给 agent
│ │ ├ serve.ts            本机起一个页面、打开浏览器；ask 时等提交，把答案打印出来
│ │ └ web/                渲染声明的网页：index.html + render.ts，不用框架
│ └ commands/             x2 的子命令，一个文件一组
│   ├ buy.ts              x2 buy：同步订单（order）、采购单、找货源（source）、标买过（done）
│   └ page.ts             x2 ask、x2 show
├ views/                  存下来的 page：buy.json（采购单）……
├ .claude/skills/
│ └ buy/SKILL.md          采购：同步订单 → 采购单 → ask 找货源 → 人过一眼 → 在 1688 买 → 标买过
├ test/
├ package.json            依赖只有 @wuwe1/cdp-relay、zod
└ tsconfig.json           只做类型检查：Node 24 直接运行 .ts
```

数据在 `~/x2/`：

```
~/x2/
├ orders.json     读来的：待出货的订单和明细，每次 x2 buy order 整份覆盖
├ offers.json     读来的：1688 货源和它的规格
├ sources.json    人给的：Shopee 的一个 SKU → 1688 一家货源的一个规格，只往后加
└ bought.json     人给的：买过的订单，只往后加
```

## 先例

- site：一个站点的操作写成代码，不写成声明。写代码的是 agent，直接写函数最简单、出错最好查。
- page：Vercel 的 json-render（组件目录当护栏）、MCP 的 elicitation（向用户要结构化输入）、LangGraph 的 interrupt（流程停下等人）。
- skill：Claude 的 skill。
- 前身是 lilto（`~/Developer/lilto`），现在只当资料：Shopee、1688、聊聊的接口和 cdp-relay 的坑都记在那里。
