---
name: verify
description: 改完 x2 的代码、说「做完了」或提交之前，照改了哪一层验证：纯函数跑测试，读站点的对真站点跑那个读，写站点的只和人约一单 --try，网页在临时库上开、用 x2 shot（booey）截图看报错。Claude Code、Codex 改 x2 都照这一份验，不临时写脚本、不用 playwright。
---

目标：每块改动提交前用真东西验过，证据（命令的输出、截图）给人看。命令在仓库根目录跑 `node x2.ts`（下面写 `x2`）。

## 每块都做

`pnpm verify` 跑类型、静态检查、架构、测试与生产构建。改了行为就覆盖对应回归路径，外部回包解析用 `fixtures/` 的样本验证。需要独立临时库时用 `pnpm test:integration`。

## 再看改了哪一层

| 改了 | 怎么验 | 算验过 |
|---|---|---|
| `tools`、`platform` 的纯函数 | 上面那条 | 新测试改之前红、改之后绿 |
| 写入引擎（`platform/writes.ts`）、订单的步骤和加购预报（`tools/orders/check.ts`、`writes.ts`） | 模型跟着改，照 `platform/writes.tla`、`tools/orders/flow.tla` 开头的命令跑 TLC | 规则都成立（两台电脑那份照它的注释破）；查出的新路径先在临时库上重放 |
| 业务工具读写库（检查、核价、表） | 开着 `x2 web --scratch`，命令前加 `X2_DATABASE_URL=` 临时库的地址，在拷贝上跑 | 输出和改之前一样，或只差你要改的 |
| connector 的读、回包解析 | 对真站点跑那个读：`x2 <站点> <工具> --json` | 读到了、没报「回包变了」；真回包去掉个人信息换进 `fixtures/`，`NOTES.md`「回包样本」跟着改 |
| 写站点（`submit`、写操作） | 你不跑。人约好一单、人在场，`--try` 跑一次，跑完人在站点上看 | 人说站点上对了 |
| 网页（`platform/ui`、`platform/web`、`tables.ts`） | 读 references/web.md：临时库上开，`x2 shot` 截图 | 截图看过，`x2 shot` 退出码 0 |

浏览器连不上（退出码 3：booey 的 daemon 没开、扩展没连上、浏览器关着）：照实说哪一层没验，请人处理，不换办法冒充。

## 绝不做

- 不写真站点：验证时不跑写工具（`orders cart`、`orders forecast`、`listing publish`），不在页面里发会改东西的请求。
- 不碰真库的数据：会改库的命令（写工具、`page create`、`page push`、`handled`、`resolve`、网页上改格）只对临时库跑。
- 不另写截图、驱动浏览器的脚本，不装 playwright；不碰人正在用的标签页，不停 booey 的 daemon、不动扩展。

## 回报

每层一行：跑了什么、结果原话；截图的路径；没验的写为什么。
