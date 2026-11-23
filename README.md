# x2

X2 是面向 Shopee（虾皮）台湾站卖家的运营工作台，连接选品、上架、采购、客服、报账和店铺监控。经营者可以在网页核对和确认操作，也可以通过 AI Agent（智能代理）调用同一套工具。

- **Agent 命令行**：`node x2.ts <命令>` 用自然语言驱动，按技能规则执行，`--json` 输出结构化回执。
- **网页工作台**：`node x2.ts web` 起 http://127.0.0.1:5170，给人核对、填写和审批。
- **x2bot（对话）**：在网页选择 DeepSeek 模型、添加照片与文本文件或引用段落，查看工具执行链路并处理已确认的上架任务。
- **浏览器自动化**：经 booey（CDP 中继）复用已登录站点会话，操作 Shopee、1688、知虾与 chanboss，不接触账号密码。
- **本地 PostgreSQL**：持久化选品稿、上架稿、采购证据与监控快照。

## 能力

| 模块 | 说明 |
|---|---|
| 策略选品 | 按工作台研究真实资料，保存备选，不自动建稿、采购或发布 |
| 商品上架 | 来源、核价、图文、审阅到授权发布一条龙 |
| 订单采购 | 核对待出货订单、货源与历史采购，按确认加购 |
| 商品目录 / 客服 / 报账 | 查询和操作各工作区 |
| 店铺监控 | 曝光 / 点击 / 转化、日快照与同比对比 |
| 批次跟踪 | 上架后第 3 / 7 / 14 天自动复查 |

## 技术栈

TypeScript · Node 24 · pnpm · PostgreSQL · React + Vite + Tailwind · Chrome DevTools Protocol（经 booey）

---

## 装

1. Node 24、pnpm：`pnpm install`。
2. 仓库根目录使用本项目独立的 `.env`（不进 git），要设什么照 `.env.example`，保留已有外部服务密钥。本项目的 `X2_DATABASE_URL` 指向本地 PostgreSQL（关系数据库）`127.0.0.1:55432/x2`；`X2_DATABASE_SSH=` 明确留空，`X2_HOME=../.x2-local/state`，日常运行直接连接本地库。
3. x2 经 booey（浏览器控制中继，`@wuwe1/booey`）使用已有 CDP（浏览器调试协议）连接。在浏览器登录运营所需的 Shopee、1688、知虾和 chanboss 账号。启动中继：`pnpm exec booey daemon start`。首次配置扩展时，在 `chrome://extensions` 打开开发者模式，加载 `node_modules/@wuwe1/booey/extension`；已有 cdp-relay 连接时直接复用。用 `pnpm exec booey doctor` 核对中继与扩展。
4. 本地数据库：复用持久数据目录 `../.x2-local/pgdata`，确认 PostgreSQL 在 `127.0.0.1:55432` 运行后再执行 X2 命令。运行 `../.x2-local/start-web.sh` 会先启动未运行的既有库，再启动 X2 网页服务。`x2 web --scratch` 仍用于复制当前本地库作临时验证，需要与服务端版本兼容的 `pg_dump`、`psql`。本项目不启用 SSH（安全远程连接）数据库隧道，直接连本地库。

`postgres` 固定为 3.4.9，项目补丁由 `package.json` 的 `pnpm.patchedDependencies` 和锁文件登记，使用项目指定的 pnpm 10.18.3 执行 `pnpm install --frozen-lockfile` 会自动应用。补丁回移官方 [#1209](https://github.com/porsager/postgres/pull/1209) 对 [#1208](https://github.com/porsager/postgres/issues/1208) 的修复，覆盖包内 ESM、CommonJS 与 Cloudflare 构建：断线后清掉待写缓冲并以 `CONNECTION_CLOSED` 拒绝待处理查询，避免延迟写入抛出未捕获异常；不自动重发查询。升级驱动时，只有目标版本已包含此修复且断线回归测试通过，才能一起移除补丁及对应锁项。

## 开始

在仓库里开 Claude Code 或 Codex，按 [AGENTS.md](AGENTS.md) 进入对应技能。`node x2.ts status` 汇总全局待办，`node x2.ts web` 启动 http://127.0.0.1:5170。全部命令见 `node x2.ts --help`。

## 目录与职责

| 路径 | 内容 | 边界 |
|---|---|---|
| `x2.ts` | 工具、连接器和固定工作区的装配 | 注册能力与工作区 |
| `platform/` | 浏览器、数据库、写入引擎、网页服务与界面 | 不引入具体业务工具和连接器 |
| `connectors/sites/`、`connectors/services/` | 网站及外部服务接入 | 只解释外部协议；回包样本放各自 `fixtures/`，能力说明放 `NOTES.md` |
| `tools/<业务>/` | 业务计算、数据操作及工具注册 | 跨业务复用走对方的 `index.ts`，同类代码、`schema.sql` 和模块测试放在一起 |
| `skills/` | 选品、上架和验证的流程及规则 | 参数、经营阈值和流程各有唯一维护入口，细节放相邻 `references/` |
| `.agents/skills/` | 当前项目可发现的技能入口和专项任务 | 引用已有通用流程，专项授权保留适用范围 |
| `test/` | 架构、命令行和组件装配契约 | 模块内部测试仍与源码同目录 |
| `ops/` | 本机定时任务与采集脚本 | 只存脚本与公开配置，不存密钥 |
| `patches/` | 锁定依赖版本的持久补丁 | 与 `package.json`、锁文件及补丁说明同步 |
| `artifacts/` | 本机运营交付及生成文件 | 已忽略，不作为源码或真实回包样本提交 |

新增功能优先扩展所属模块；页面按组件、状态和响应类型分工，不复制同一套校验或数据结构。临时脚本、截图、日志和构建输出不混入源码，合成测试输入与真实回包须明确区分。

## 流程入口

| 入口 | 能力与规则 |
|---|---|
| [订单采购](.agents/skills/procurement/SKILL.md) | 核对待出货订单、货源和历史采购，按确认加购 |
| [商品目录](.agents/skills/catalog/SKILL.md)、[客服](.agents/skills/chat/SKILL.md)、[报账](.agents/skills/reimbursement/SKILL.md) | 查询和操作各工作区 |
| 定价模板 | 只读试算建议售价和整单毛利；复用现有公式与[定价参数](skills/listing/references/pricing.md)，页面调整不保存为全店设置 |
| [策略选品](.agents/skills/selection/SKILL.md) | 在网页勾选策略和 DeepSeek 模型，按[工作台规则](skills/selection/references/workbench.md)研究真实资料并保存备选 |
| [商品上架](.agents/skills/listing/SKILL.md) | [主流程](skills/listing/SKILL.md)统一串联来源、核价、图文、审阅和授权发布；命令及续做见[操作顺序](skills/listing/references/workflow.md) |
| [图片处理](.agents/skills/listing-images/SKILL.md) | 必要的 OpenAI Image（图片编辑）与已审干净原图经 X2 导入、上传及指纹审阅 |

`AGENTS.md` 是工程约定，`CLAUDE.md` 和 `.claude/` 保留现有 Claude Code 配置。项目技能位于 `.agents/skills/`；Codex hooks（编码助手钩子）和插件配置仅使用项目内 `.codex/`，不向全局安装或启用。经营参数、批次授权和研究局限只在对应技能维护，README 不复制。

## 修改与提交

本地、提交钩子和 CI（持续集成）使用同一个 `pnpm verify` 入口。按 [验证技能](skills/verify/SKILL.md)核对受影响的页面和数据库行为。

按一个完整功能或修复一组提交，采用 `type(scope): 中文说明`，例如 `fix(db): 修复断线后连接释放`。提交只包含源码、规则、必要样本与测试，保留 `.env`、本机产物和授权凭据在版本管理之外。

## 输出约定

stdout 只放结果，加 `--json` 时是一个 JSON 值；stderr 只放进度。加 `--json` 出错时 stdout 是 `{ "error": { "kind", "message" } }`。id 一律是字符串，时间是 ISO 8601。

| 退出码 | kind | 意思 | 下一步 |
|---|---|---|---|
| 0 | | 成功 | |
| 1 | error | 出错 | 把原话告诉人 |
| 2 | usage | 用法不对 | 看 `--help` 改命令 |
| 3 | human | 要人处理：没登录、要过滑块、浏览器没连上 | 请人在浏览器里处理好再重试 |
| 4 | | 写的结果未知 | 不许重发，先 `x2 verify` 读回来 |
