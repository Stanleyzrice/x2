# x2：给 agent 的说明

读者是在 x2 里推进两家店（ni1206、cheeroutdoor）日常工作的 agent（Claude Code、Codex）。命令在仓库根目录运行：`node bin/x2.ts <命令>`（下面简写成 `x2`），加 `--json` 读结果，`x2 --help` 列出全部命令。订单、上品、选品怎么做在 `.claude/skills/` 里，用词照 [docs/glossary.md](docs/glossary.md)。

## 开起来做什么

1. **`x2 status`**：现读站点，跑检查。跟人说三件事：读到了什么（哪样没读成）、要人做的（「人」）、你能做什么（「agent」）。状态在站点和库里，不在你的记忆里：哪台电脑开你，第一件事都是它。
2. **有结果未知的写入，先核清**：`x2 verify` 读回来。还核不清的，请人到站点上看一眼，人说了结果，用 `x2 resolve <写入> 已核对|被拒`。
3. **你能做的，按 skill 准备好**（订单：`.claude/skills/orders`；上品：`.claude/skills/listing`；选品：`.claude/skills/selection`）。加购、预报：`x2 status --json` 的 `todo` 里有现成的一批，给人看过，人在终端里同意了，交给 `x2 do`。商品稿走到待批准，开会话放它的审稿视图给人看（下一步）；人说批准，用 `x2 listing publish <商品稿…>` 建商品、上架。人在商品稿「备注」里写的要求（`todo` 的「备注」）照做，做完 `x2 listing noted`。
4. **要人看、要人填的，开一个会话放进去，把地址告诉人**：`x2 session create <标题>`，`x2 session push <会话>` 放 datagrid（引用 `web/tables.ts` 的表和视图，例 `{ "component": "datagrid", "props": { "table": "listings", "view": "审稿" } }`），跟人说的结论可以放 markdown、table、chart、images。有哪些组件、参数：`x2 session components`。人在网页（`x2 web` 开着时 http://127.0.0.1:5170/#会话编号）上看、改格。
5. **把每一行写入的结果原样告诉人。**
6. **x2 看不到结果的事**（`human` 里的，例 取消订单的货的去处），人说做完了，用 `x2 handled <key…>`，不再提醒。
7. **再 `x2 status`**：「人」「agent」里没有了就是做完了；还有的说为什么。

## 不许做的

- 不绕过 `x2 do`、`x2 listing publish` 改站点上的东西（不自己发加购、预报的请求，不用 raw 接口写）。结果未知的写入不重发，先读回来。
- 不替人付款、打包、打拣货单，不替人选货源（人在会话里的「货源」表勾「选用」）。人在终端里同意了才 `x2 do`、`x2 listing publish`，说了「放弃」才 `x2 listing cancel`，定了类目才 `x2 listing category`，说做完了才 `x2 handled`。
- 不在真订单上试新的写操作：没跑过的（`x2 do` 说要 `--try` 的）先和人约好一张单，一起跑，跑完在站点上看一眼。
- 不改库里人定的东西（货源的「选用」「规格例外」、订单设置、店铺设置、商品稿的「放弃」「备注」和人定的类目、人改过的「简称」和填了的「重量」「国内运费」、已删除的图、已移除的规格和保留的图），除非人让你改。「重量」「国内运费」空着的（1688 没给、读不到）由你估：`x2 listing estimate`，往重了、往高了估。
- 数字由代码算（`x2 status`、检查、核价），你写文字；不自己算钱、件数报给人。

## 命令出错

- 退出码 3（要人处理：没登录、要过滑块、浏览器没连上）：请人在浏览器里处理好再重试。两家店各开一个浏览器；x2 按登录找浏览器，哪家店的浏览器没连着、哪样没登录，`x2 status` 会说；1688 跳了滑块验证，x2 说在哪家店的浏览器里拉。
- 命令慢、stderr 写着「排队」：别的 x2 进程在用同一个浏览器的同一个站点，用完就轮到，不用重跑、不用自己错开。
- 退出码 4（写的结果未知）：不重试，见上面第 2 步。
- 别的错误：把原话告诉人。

## 代码放哪

按「是什么事」放，`test/architecture.test.ts` 守着：

| 文件夹 | 放什么 |
|---|---|
| `src/sites/` | 外面的网站和服务（Shopee、1688、chanboss、知虾、Gemini、象寄）：怎么请求、怎么取数据；浏览器、锁。一个站点一个文件，接口一览和坑在同名 `.md`。不引业务 |
| `src/orders/` | 订单：检查（当前步骤、提醒、一批加购和预报）、采购单分给订单、规格配对、现读、找货源 |
| `src/listing/` | 上品和选品：商品稿、核价、规格、图、文案、Gemini 文字检查 |
| `src/loop/` | 循环：`x2 status` 拼快照和检查、`x2 do` 执行写入、写操作的声明（`writes.ts`） |
| `src/db/` | 库：表结构（`schema.sql`）、连接 |
| `src/cli/` | 一组 `x2` 子命令一个文件：解析参数、调上面的、照输出约定输出。接到 `bin/x2.ts` |
| `web/` | 网页的服务：`server.ts`；`tables.ts` 哪些表给人看、人能改哪几格；`sessions.ts` 会话和组件的参数 |
| `web/ui/` | 网页的界面：`components/ui/` 是 shadcn 拷来的（不手改，`npx shadcn add` 加）；`generative/`、`interactive/` 是我们的组件 |

业务（orders、listing、loop）不引 `cli`、`web`；`sites` 不引业务；`web/ui` 只引自己（别的只 import type）。检查、核价这类只算的写成纯函数，好测。放不进哪个文件夹的，先想清楚它是什么；规则不对，改测试和这张表，不加例外。

## 改代码

- 先做通 happy path：好复现的关键步骤写成程序；看图、规格名、文案、估重量、选品这类边界多的判断先由 agent 填、人可以改、不挡流程，攒够数据再设计。
- 人定下的做法当场写进代码、测试或 skill，不只留在会话里。
- 一切以数据为核心：先把数据存对，界面为数据服务。网页的 datagrid 照 `web/tables.ts` 的说明显示和收人改的格，加列、改视图只改它；组件和参数在 `web/sessions.ts`；没有数据要给人看、要人填，就不做界面。
- 写法照现有代码：中文注释，zod 声明参数，输出约定照 README（stdout 只放结果，退出码 2/3/4）。
- 规矩往结构里放，按这个先后：能放进目录结构的不写成 lint，能写成 lint 的不写成测试，能写成测试的不写成文档。代码看不出来的「为什么」写在实现它的文件开头。文档只放代码说不清的：用词在 `docs/glossary.md`，站点接口的坑在 `src/sites` 的同名 `.md`，agent 怎么做事在 skill。不写来历、路线图、进度（在 git log 里）。
- 每做完一块跑 `pnpm check`（tsc 严格模式 + Biome 的 lint 和格式；格式、能自动改的用 `pnpm fix`）、`pnpm test`（连库的测试要设 `X2_TEST_DATABASE_URL`，会清空那个库）；动了读站点的代码，用 `x2 <站点> <操作>` 对真站点跑一遍。提交前 git hook 跑 `pnpm check`，推送后 CI 跑两样。lint 规则不随手关：确实要破例的写 `biome-ignore` 和理由。
- 一块一个提交，提交信息照 git log 的写法（中文，「区域：说明」）。不推送、不合进 main，除非人说。
