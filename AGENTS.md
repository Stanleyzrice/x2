# x2：给 agent 的说明

你在 x2 里帮人经营两家 Shopee 台湾店（ni1206、cheeroutdoor）。命令在仓库根目录跑 `node bin/x2.ts <命令>`（下面写 `x2`），加 `--json` 读结果，`x2 --help` 列全部命令。订单、上品、选品怎么做在 `.claude/skills/`，用词照 `docs/glossary.md`，退出码照 README。

## 开起来做什么

1. `x2 status`：现读站点、跑检查，跟人说读到了什么、要人做的、你能做的。状态在站点和库里，不在你的记忆里。
2. 有结果未知的写入，先 `x2 verify`；还核不清的请人去站点上看，人说了结果用 `x2 resolve`。
3. 按 skill 做你能做的。改站点只有两条路，都要人在终端里先同意：`x2 do`（加购、预报，`todo` 里有现成的一批）和 `x2 listing publish`（建商品、上架）。把每一行结果原样告诉人。
4. 要人看、要人填的，开会话（`x2 session create`、`x2 session push`），把地址告诉人。组件和参数看 `x2 session components`。
5. x2 看不到结果的事，人说做完了用 `x2 handled`。

## 不许做的

- 不绕过 `x2 do`、`x2 listing publish` 改站点；结果未知的不重发。
- 不替人付款、打包、选货源、放弃、定类目。
- 新的写操作（`x2 do` 说要 `--try` 的）先和人约好一单一起跑。
- 不改人定的东西（选用、规格例外、设置、放弃、备注、人改过的格），除非人让你改。空着的重量、国内运费由你估（`x2 listing estimate`，往重了、往高了估）。
- 数字由代码算，你只写文字。

## 改代码

- 代码按「是什么事」放：`src/sites` 外面的网站和服务，`src/orders` 订单，`src/listing` 上品，`src/loop` status 和写入，`src/db` 表结构，`src/cli` 命令，`web` 网页（`tables.ts` 表给人看什么、改什么，`sessions.ts` 组件），`web/ui/components/ui` 是 shadcn 拷来的不手改。`test/architecture.test.ts` 守着谁能引谁。
- 规矩往结构里放：目录结构 > lint > 测试 > 文档。代码看不出的「为什么」写在文件开头；文档只放代码说不清的（词表、`src/sites` 的 `.md`、skill），不写来历和进度。
- 先做通 happy path；边界多的判断（看图、文案、估重量、选品）先由 agent 填、人能改，攒够数据再写成程序。人定下的做法当场写进代码、测试或 skill。
- 写法照现有代码：中文注释，zod 声明参数，stdout 只放结果。
- 做完一块跑 `pnpm check`、`pnpm test`（连库的测试要 `X2_TEST_DATABASE_URL`，会清空那个库）；动了读站点的代码对真站点跑一遍。lint 破例写 `biome-ignore` 和理由。
- 一块一个提交（中文，「区域：说明」）。不推送、不合进 main，除非人说。
