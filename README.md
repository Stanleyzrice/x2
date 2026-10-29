# x2

x2（小二）帮一个人经营网店：到各个网站上读数据、做事，拿不准的请示掌柜。掌柜是运营本人，她在自己的 Mac 上用 coding agent（Claude）使唤 x2。

只为运营真实的需求做事，抽象是这些需求用到的东西的最大公约数。现在做的两件事：订单（Shopee 上有人下单，要在出货期限前从 1688 买到对的货、预报给 chanboss、打包，不重买、不漏买）和上品（把 1688 的货源做成店里在售的商品）。

## 四个概念

| 概念 | 是什么 | 例 |
|---|---|---|
| **site** | 读、写一个网站。经运营已登录的浏览器（cdp-relay）发请求，一个站点一个模块；读操作声明成 `ops`（参数 + 怎么读），命令行直接能用；写操作声明在 `src/flows/writes.ts`，只经 `x2 do`、`x2 listing publish` 执行 | `x2 shopee orders`、`x2 1688 offer --id …` |
| **库** | Postgres（`X2_DATABASE_URL`），唯一的数据：人定的（货源、设置、到货问题、商品稿、已处理的提醒）、写入的记录、给团队看的订单进度。站点上有的（购物车、采购单、货源的详情）不存，每次现读。表的结构在 `src/core/schema.sql`，x2 建和改；人在网页上（`x2 web`）看和填 | 写入、货源、订单、商品稿 |
| **循环** | 现读站点 → 检查（算出要人做的和 agent 要做的）→ agent 准备写入给人看、人做和同意 → `x2 do` 执行、读回来 → 下一轮。做完 = `x2 status` 里没有要做的（[docs/loop.md](docs/loop.md)） | `x2 status`、`x2 do`、`x2 verify` |
| **skill** | 告诉 agent 一件事怎么做：按什么顺序调哪些命令，哪一步等人 | `.claude/skills/orders/SKILL.md`、`.claude/skills/listing/SKILL.md` |

人和 agent 用同一套命令：`x2 <命令>`，加 `--json` 给 agent 读。改站点上的东西（加购、预报、建商品、上架）只有一条路：agent 给人看，人在终端里同意了（加购、预报：`x2 do`；建商品、上架：`x2 listing publish`），x2 先记意图、提交一次、再读回来。agent 开起来做什么在 [AGENTS.md](AGENTS.md)。

## 推进：x2 status

```sh
x2 status                      # 现读站点 → 检查 → 读到了什么、要人做的、agent 能做什么
x2 status --json               # 给 agent：todo 里有现成的一批写入
x2 source <商品 id>             # 给店里一个商品找货源：以图搜图，看卖过的规格有几成配得上；--url <链接> 用人贴的
x2 do < 一批.json               # 人在终端里同意了：执行一批写入（先记意图 → 提交一次 → 读回来）；--try 操作 跑还没在真站点上跑过的
x2 verify                      # 读回来核清结果未知的写入
x2 resolve 12 已核对            # 人到站点上看过结果未知的写入（或 被拒）
x2 handled cancel-goods:<订单号>  # x2 看不到结果的事，人说做完了：不再提醒
x2 web                         # 开网页：商品稿（审稿、删图）、订单、货源、写入、设置（默认 127.0.0.1:5170；--host 0.0.0.0 给同一个网络里别的电脑）
```

上品（[docs/listing.md](docs/listing.md)）：

```sh
x2 listing quote <1688 链接>             # 报价（选品用）：售价区间、每个规格的价格和重量、服务、起订量；不做图、不存库
x2 listing add cheeroutdoor <1688 链接>   # 添加货源：一个货源 × 一家店一份商品稿
x2 listing make --jobs 3                # 做商品稿：读货源、规格和核价、图（筛字 → 译图 → 译图检查 → 水印 → 传图）、类目属性；几份同时做
x2 listing estimate 3 --weight 1 --freight 10   # 1688 没给的重量、读不到的国内运费由 agent 估（只填空着的），马上重新核价
x2 listing show 3                       # 写文案要用的事实
x2 listing text 3 --title … --description … --tiers … --nickname …   # agent 写的标题、描述、规格名和简称，写完马上 Gemini 文字检查
x2 listing category 4 101686            # 人在终端里定了类目时，写成人定的类目（叶子、本店允许的），再 x2 listing make
x2 listing publish 3 5                  # 人在终端里说「批准」时：建商品、上架
x2 listing cancel 4 --why …             # 人在终端里说「放弃」时，替人勾「放弃」（建了商品的要下架，不是放弃）
x2 listing noted 3                      # 照人写的「备注」做完：记下看过（备注再改，todo 又给出来）
x2 listing list                         # 每份商品稿的简称、当前步骤
x2 strategy list                        # 选品的策略：第几版、每个出了几份商品稿、上架了几个
x2 strategy set 搜索缺口 --how … --why …   # 改策略要写为什么：版本号加 1，记进变更记录（x2 strategy log 搜索缺口）
x2 rule add "<规矩>" --why …              # 选品规矩（所有策略共用）；x2 rule retire <编号> --why … 停用，不删
x2 listing add cheeroutdoor <1688 链接> --strategy 搜索缺口 --why … --evidence …   # 按策略选的：记下选品理由、依据、当时的策略和规矩
```

建商品、上架是写入：人在网页「商品稿」里看过、在终端里说批准 → `x2 listing publish`（交给 x2 以后内容又变了就不建）。外部服务的 key（Gemini、象寄）在 `.env`；同时问 Gemini 几个、取几张图：`X2_GEMINI_CONCURRENCY`（默认 8）、`X2_DOWNLOAD_CONCURRENCY`（默认 6）。

两家店各开一个浏览器（Chrome 的不同用户），1688、知虾、chanboss 登录在其中一个里。x2 按登录选浏览器（每个进程现读一次，不存库）：Shopee 按店，1688、知虾、chanboss 用登录着的那个；要强制指定，设 `X2_BROWSER`（浏览器在 cdp-relay 里的 id）。几个 x2 同时跑：同一个浏览器的同一个站点一次只让一个进程用，别的排队（stderr 写着在等谁）；1688 的页面两次加载之间隔 3 秒，跳了滑块验证就停下（退出码 3，说在哪个浏览器里拉）。

## 读站点：x2 <站点> <操作>

每个站点的读操作都能直接跑（翻页藏在操作里）。agent 要什么数据就现读什么，算和分析在 agent 那边做：

```sh
x2 shopee                                   # 列出操作
x2 shopee performance --help                # 参数
x2 shopee performance --start 2026-09-01 --end 2026-09-30 --period past30days --json
x2 zhixia hot-word-items --word 123 --path 100629,100630 --pages 2 --json
x2 schema                                   # 全部操作的说明和参数（JSON Schema）
```

- 参数写成 `--名字 值`；日期是台湾时间的 `YYYY-MM-DD`（也可以给秒）；一列值用逗号分隔。
- 列表（list）默认翻到底，`--pages N` 只翻 N 页，`--cursor <next>` 从上次停下的地方接着翻；输出 `{ rows, next }`，`next` 是 null 就是到底了。
- 只收读。写不进通用入口：写只经 `x2 do`、`x2 listing publish`（人在终端里同意了）。
- 逃生口：`x2 shopee raw --path …`、`x2 zhixia raw --path …`，只 GET。
- Shopee 按店读：连着几家店时给 `--shop <店>`（账号名，例 `x2 shopee orders --shop ni1206`）；只有一个浏览器登录着 Shopee 时不用给。

## 输出约定

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
7. **读不写库**：`x2 <站点> <操作>` 不碰库；只有 `x2 status` 把订单写回库、更新货源快照。

## 目录

```
x2/
├ bin/x2.ts               命令行入口：x2 <命令> …
├ AGENTS.md               agent 开起来做什么、不许做什么（CLAUDE.md 引它）
├ docs/                   loop.md 循环怎么转；orders.md 订单；listing.md 上品；glossary.md 词
├ src/                     分层，运行时的 import 只往里指（test/architecture.test.ts 守着；AGENTS.md「代码放哪」）
│ ├ core/                 运行环境：env.ts 读 .env；errors.ts 错误分类和退出码；lock.ts 跨进程的锁（~/x2/locks/）；db.ts、schema.sql 库
│ ├ domain/               纯函数，只算：不碰库、站点、外部服务
│ │ ├ orders/             check.ts 订单的检查（当前步骤、提醒、一批加购和预报）；reconcile.ts 采购单分给订单；similar.ts 规格名的比较和配对
│ │ └ listing/            check.ts 商品稿的检查；price.ts、pricing.ts 核价、报价；variants.ts 规格；product.ts 建商品的 product_info；ready.ts 商品稿 → 要建的商品；
│ │                       category.ts 类目属性；text.ts 文案的规矩；audit.ts Gemini 文字检查的结果；pics.ts 图的类型
│ ├ sites/                一个站点一个文件（大的一个目录），只管「怎么请求、怎么从响应里取出数据」；接口一览和坑在同目录的 .md
│ │ ├ browser.ts          唯一碰 cdp-relay 的地方：选浏览器、排队、在页面里发请求、认出登录页和 1688 的滑块验证
│ │ ├ accounts.ts         按登录找浏览器：每个浏览器里登录着哪家店、哪个 1688 账号，知虾、chanboss 登录在哪个里
│ │ ├ op.ts               读操作的声明（get、list）和参数的类型
│ │ ├ shopee/             卖家中心（shopee.md）；ops.ts 是它的读操作
│ │ ├ 1688.ts             1688：货源、搜索、购物车和加购、采购单、物流、退款（1688.md）
│ │ ├ zhixia.ts           知虾：类目、热搜词、竞品、1688 同款（zhixia.md）
│ │ └ chanboss.ts         chanboss：订单、预报、库存、退件、扣款流水（chanboss.md）
│ ├ services/             外部服务：gemini.ts、xiangji.ts（象寄译图，收费）、image.ts（取图、认格式、宽高、sha256）
│ ├ flows/                把上面几层拼成一件事（读写库、站点）
│ │ ├ read.ts             现读：chanboss 订单（写回库）、1688 的购物车和采购单、要买的商品的货源；同一个进程 2 分钟内读过的复用
│ │ ├ check.ts            拼快照（现读的 + 库里人定的），跑 domain 的检查，算出提醒、todo，写回订单的进度
│ │ ├ writes.ts           写操作的声明：加购、预报、译图、建商品、上架（现读 → 提交 → 读回来）
│ │ ├ batch.ts、run.ts    x2 do 校验一批写入、记进库；执行：先核清结果未知的，再一个一个做、读回来
│ │ ├ source.ts           x2 source：选货源，更新货源快照
│ │ └ listing/            做商品稿（make.ts）、图（images.ts、screen.ts 筛字、watermark.ts 水印）、textcheck.ts 问 Gemini 文字检查、pick.ts 选品、queue.ts 同时做的上限和排队
│ ├ commands/             x2 的子命令，一个文件一组：只解析参数、调 flows、照输出约定输出
│ └ web/                  x2 web 的服务：tables.ts 哪些表、列给人看，人能改哪几格；server.ts 照它读写库、发界面
├ .claude/skills/
│ ├ orders/SKILL.md       订单：找货源 → 加购 → 人付款 → 采购单分给订单 → 预报 → 人打包
│ ├ listing/SKILL.md      上品：贴货源 → 做商品稿 → 写文案 → Gemini 文字检查 → 人审稿、说批准 → 建商品、上架
│ └ selection/SKILL.md    选品：按策略找词和竞品 → 以图搜 1688 同款 → 报价 → 照选品规矩筛 → 写选品理由加成商品稿
├ web/                    网页的界面（React、Cloudflare Kumo）：main.tsx 侧栏和路由，view.tsx 表格、卡片、表单，value.tsx 照类型显示和改一格；x2 web 打包进 web/dist
├ test/                   pnpm test 跑的单元测试（loop.test.ts 连库：设 X2_TEST_DATABASE_URL，会清空那个库）；live/ 是对真站点跑一遍读取的脚本
├ biome.json              lint 和格式（Biome）；.githooks/ 提交前跑 pnpm check；.github/workflows/ 推送后 CI 跑 pnpm check、pnpm test
├ package.json            依赖：@wuwe1/cdp-relay、postgres、zod、opencc-js（简体转台湾繁体）；网页的（React、Kumo、Vite、Tailwind）是 devDependencies
└ tsconfig.json           只做类型检查（TypeScript 7，严格）：Node 24 直接运行 .ts
```

数据都在库里。本机只留 `~/x2` 下的：`zhixia-usage.json`（知虾最近一小时的请求时间，限流用，几个 x2 进程共用）、`locks/`（几个 x2 进程排队的锁、1688 上一次加载页面的时间）。凭证（库的密码，Gemini、象寄的 key）在环境变量里，或者写在仓库根目录的 `.env`（x2 启动时读，环境里已经有的不覆盖；不进 git）。
