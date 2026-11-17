# x2

x2 帮我们经营 Shopee 台湾的店（cheeroutdoor）：一个给 agent 用的命令行，和一个给人看、给人填的网页。

## 装

1. Node 24、pnpm：`pnpm install`。
2. 仓库根目录使用本项目独立的 `.env`（不进 git），要设什么照 `.env.example`，保留已有外部服务密钥。本项目的 `X2_DATABASE_URL` 指向本地 PostgreSQL（关系数据库）`127.0.0.1:55432/x2`；`X2_DATABASE_SSH=` 明确留空，`X2_HOME=../.x2-local/state`，日常运行直接连接本地库。
3. x2 经 booey（浏览器控制中继，`@wuwe1/booey`）使用已有 CDP（浏览器调试协议）连接。本项目在 Ego（浏览器）的对应用户环境登录 Shopee、1688、知虾和 chanboss；两家店保持各自账号身份。启动中继：`pnpm exec booey daemon start`。首次配置扩展时，在 `chrome://extensions` 打开开发者模式，加载 `node_modules/@wuwe1/booey/extension`；已有 cdp-relay 连接时直接复用。用 `pnpm exec booey doctor` 核对中继与扩展。
4. 本地数据库：复用持久数据目录 `../.x2-local/pgdata`，确认 PostgreSQL 在 `127.0.0.1:55432` 运行后再执行 X2 命令。运行 `../.x2-local/start-web.sh` 会先启动未运行的既有库，再启动 X2 网页服务。`x2 web --scratch` 仍用于复制当前本地库作临时验证，需要与服务端版本兼容的 `pg_dump`、`psql`。`ops/ssh_config`、`ops/db-server.sh`、`ops/db-user.sh` 保留为旧服务器的可选运维资料，本项目不默认启用 SSH（安全远程连接）数据库隧道。

`postgres` 固定为 3.4.9，项目补丁由 `package.json` 的 `pnpm.patchedDependencies` 和锁文件登记，使用项目指定的 pnpm 10.18.3 执行 `pnpm install --frozen-lockfile` 会自动应用。补丁回移官方 [#1209](https://github.com/porsager/postgres/pull/1209) 对 [#1208](https://github.com/porsager/postgres/issues/1208) 的修复，覆盖包内 ESM、CommonJS 与 Cloudflare 构建：断线后清掉待写缓冲并以 `CONNECTION_CLOSED` 拒绝待处理查询，避免延迟写入抛出未捕获异常；不自动重发查询。升级驱动时，只有目标版本已包含此修复且断线回归测试通过，才能一起移除补丁及对应锁项。

## 开始

在仓库里开 Claude Code 或 Codex，它读 `AGENTS.md`，第一件事是 `node x2.ts status`。人看网页：`node x2.ts web`，打开 http://127.0.0.1:5170：侧栏是 agent 开的页，中间是给人看的，右边是要人改、要人选的。全部命令：`node x2.ts --help`（每件事是一个工具：`x2 <toolkit> <工具> --参数 值`）。

## 目录与职责

| 路径 | 内容 | 边界 |
|---|---|---|
| `x2.ts` | 工具、连接器和固定工作区的装配 | 唯一同时认识各层的入口 |
| `platform/` | 浏览器、数据库、写入引擎、网页服务与界面 | 不引入具体业务工具和连接器 |
| `connectors/sites/`、`connectors/services/` | 网站及外部服务接入 | 只解释外部协议；回包样本放各自 `fixtures/`，能力说明放 `NOTES.md` |
| `tools/<业务>/` | 业务计算、数据操作及工具注册 | 同类代码、`schema.sql` 和模块测试放在一起 |
| `skills/` | 选品、上架和验证的流程及规则 | 参数、经营阈值和流程各有唯一维护入口，细节放相邻 `references/` |
| `.agents/skills/` | 当前项目可发现的技能入口和专项任务 | 引用已有通用流程，专项授权保留适用范围 |
| `test/` | 架构、命令行和组件装配契约 | 模块内部测试仍与源码同目录 |
| `ops/` | 部署和共享数据库运维 | 只存脚本与公开配置，不存密钥 |
| `patches/` | 锁定依赖版本的持久补丁 | 与 `package.json`、锁文件及补丁说明同步 |
| `artifacts/` | 本机运营交付及生成文件 | 已忽略，不作为源码或真实回包样本提交 |

新增功能优先扩展所属模块；页面按组件、状态和响应类型分工，不复制同一套校验或数据结构。临时脚本、截图、日志和构建输出不混入源码，合成测试输入与真实回包须明确区分。

## 流程入口

| 入口 | 能力与规则 |
|---|---|
| 定价模板 | 只读试算建议售价和整单毛利；复用现有公式与[定价参数](skills/listing/references/pricing.md)，页面调整不保存为全店设置 |
| [策略选品](.agents/skills/selection/SKILL.md) | 本机 Codex CLI（智能代理命令行工具）按[工作台](skills/selection/references/workbench.md)研究真实资料并保存备选；不自动建稿、采购或发布 |
| [商品上架](.agents/skills/listing/SKILL.md) | [主流程](skills/listing/SKILL.md)统一串联来源、核价、图文、审阅和授权发布；命令及续做见[操作顺序](skills/listing/references/workflow.md) |
| [图片处理](.agents/skills/listing-images/SKILL.md) | 必要的 OpenAI Image（图片编辑）与已审干净原图经 X2 导入、上传及指纹审阅 |

`AGENTS.md` 是工程约定，`CLAUDE.md` 和 `.claude/` 保留现有 Claude Code 配置。项目技能位于 `.agents/skills/`；Codex hooks（编码助手钩子）和插件配置仅使用项目内 `.codex/`，不向全局安装或启用。经营参数、批次授权和研究局限只在对应技能维护，README 不复制。

## 修改与提交

修改后运行 `pnpm verify`，统一执行类型、lint（静态代码检查）、架构、测试与生产构建；提交钩子和 CI（持续集成）也使用此入口。前后端共同继承 `tsconfig.base.json`，层间依赖由架构检查解析实际路径约束，禁止循环导入、`any` 和未处理的异步结果。需要页面或数据库验证时按 [验证流程](skills/verify/SKILL.md) 使用临时副本；现有独立临时库测试入口为 `pnpm test:integration`。

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
