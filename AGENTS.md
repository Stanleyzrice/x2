# x2：给 agent 的说明

你在 x2 里帮人经营两家 Shopee 台湾店（ni1206、cheeroutdoor）。命令在仓库根目录跑 `node x2.ts <命令>`（下面写 `x2`），加 `--json` 读结果。每件事是一个工具：`x2 <toolkit> <工具> --参数 值`，`x2 --help` 列 toolkit，`x2 <toolkit> <工具> --help` 看参数，`x2 schema` 是全部工具的 JSON Schema。订单、上品、选品怎么做在 `skills/<名字>/SKILL.md`，退出码照 README。

## 开起来做什么

1. `x2 status`：现读站点、跑检查，跟人说读到了什么、要人做的、你能做的。状态在站点和库里，不在你的记忆里。
2. 有结果未知的写入，先 `x2 verify`；还核不清的请人去站点上看，人说了结果用 `x2 resolve --id <写入> --status 已核对|被拒`。
3. 按 skill 做你能做的：`todo` 里每一项写着要调的工具（`tool`）和参数（`params`）。改站点只经写工具（`x2 --help` 里标着「写」：`orders cart`、`orders forecast`、`listing publish`），都要人在终端里先同意。把每一行结果原样告诉人。
4. 要给人看、要人改、要人选的，放到一页上：`x2 page create` 开一页，`x2 page push` 放组件、`x2 page update` 改，把地址告诉人；人在上面选了的，`x2 page show` 读答案。有哪些组件、参数和例子看 `x2 page components`。
5. x2 看不到结果的事，人说做完了用 `x2 handled --keys <key>`。

## 不许做的

- 不绕过写工具改站点；结果未知的不重发。
- 不替人付款、打包、选货源、放弃、定类目。
- 新的写操作（写工具说要 `--try` 的）先和人约好一单一起跑。
- 不改人定的东西（选用、规格例外、设置、放弃、备注、人改过的格），除非人让你改。空着的重量、国内运费由你估（`x2 listing estimate`，往重了、往高了估）。
- 数字由代码算，你只写文字。

## 改代码

- 分四层：`platform` 换哪门生意都一样（工具的注册表和命令行、至多一次写入、浏览器、库、网页；`platform/ui/components/ui` 是 shadcn 拷来的不手改）；`connectors` 一个外部系统一个（`sites` 经浏览器、用人的登录，`services` 用 API key；写只发一次请求）；`tools` 是我们自己的业务工具，一类业务一个（订单、上品、选品）：生意的规则写成代码，它的代码、表、测试放在一起；`skills` 只有 md（`SKILL.md` 和 `references/`），教 agent 怎么用工具。根上的 `x2.ts` 是装配（把连接器、业务工具登记进平台，唯一同时认识各层的文件）；platform 不 import connectors、tools；连接器只 import platform 和自己，不碰库（`platform/db`）；业务工具之间不互相 import（要用别的业务的，读它的表）；网页的界面（`platform/ui`）只引自己和 `platform/web` 的类型。这些由 lint 管（`biome.json` 的 overrides，每条写着为什么）；lint 管不了的在 `test/architecture.test.ts`（顶层有哪些、环境变量都写在 `.env.example`……）。
- connector 回网站给的原样数据，用网站自己的说法，不替业务做判断（阈值、选哪个账号、该不该做都在业务工具里）。
- 外部的数据进来就解析：connector 拿到回包照 zod 的形状解析（`platform/reply.ts`，只写用到的格，对不上报「回包变了」），每个解析的接口在 `fixtures/` 配一份回包样本、有测试；库里读出的行给类型（`sql<行[]>`）。之后的代码信类型，不写 `any`（lint 管）。几种 id 都是字符串的，用各自的 brand（`OfferId`、`OrderSn`、`ListingId`、`WriteId`……），在边界上贴，函数签名只收对的那一种。
- 定义工具用 `platform/tool.ts` 的 `get`、`list`、`byPage`、`all`（最后一个参数 `{ text, exit }` 是命令行怎么显示）、`write`、`submit`，参数、输出的类型照 zod 和函数推出来。
- 规矩往结构里放：目录结构 > lint > 测试 > 文档。代码看不出的「为什么」写在文件开头；文档只放代码说不清的（skill、连接器的 `NOTES.md`），不写来历和进度。
- 先做通 happy path；边界多的判断（看图、文案、估重量、选品）先由 agent 填、人能改，攒够数据再写成程序。人定下的做法当场写进代码、测试或 skill。
- 写法照现有代码：中文注释，zod 声明参数，stdout 只放结果。
- 做完一块跑 `pnpm check`、`pnpm test`（测试只测纯函数和架构，不连库；判断写成纯函数，库的读写薄薄一层）；动了读站点的代码对真站点跑一遍。lint 破例写 `biome-ignore` 和理由。
- 一块一个提交（中文，「区域：说明」）。不推送、不合进 main，除非人说。
