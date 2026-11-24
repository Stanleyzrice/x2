# X2

X2 是面向 Shopee（虾皮）台湾站的运营工作台。网页提供策略选品、上架、采购、客服、报账和监控，x2bot 可调用已登记工具协助处理确认过的任务。

## 新电脑安装

按系统复制一条命令。安装器会准备 Node.js、PostgreSQL、Hermes Agent、Booey 和 X2 专用浏览器，再打开首次设置。

**Mac（终端）**

```sh
x2_installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/Stanleyzrice/x2/main/ops/install/mac.sh -o "$x2_installer" && /bin/bash "$x2_installer"
```

**Windows 64 位（PowerShell）**

```powershell
$x2Installer = Join-Path $env:TEMP 'x2-install.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Stanleyzrice/x2/main/ops/install/windows.ps1' -OutFile $x2Installer -ErrorAction Stop; & ([scriptblock]::Create((Get-Content -LiteralPath $x2Installer -Raw -Encoding UTF8)))
```

安装后，在专用浏览器登录 Shopee、1688，回 X2 填入自己的 DeepSeek API Key 并绑定店铺。需要使用象寄图片翻译时，在设置中填写 UserKey 和 ImgTransKey。已有安装可再次执行同一条命令更新并启动，沿用本机数据库、设置和浏览器资料。

### 手动安装

准备 Git、Node.js 24、pnpm 10.18.3、Chrome（浏览器）及 PostgreSQL（关系数据库）。用以下命令安装并启动 X2。

```sh
git clone https://github.com/Stanleyzrice/x2.git
cd x2
pnpm install --frozen-lockfile
node x2.ts web
```

打开 http://127.0.0.1:5170，按首次设置填写数据库地址、连接 DeepSeek、绑定新店铺。新店铺首次发布前，在「店铺设置」核对费率、毛利、物流并解除暂停。

| 配置 | 怎么准备 |
| --- | --- |
| PostgreSQL | 给新店用一个独立数据库，连接账号须能在库里建表。地址格式为 `postgresql://x2:<密码>@127.0.0.1:55432/x2`，密码中的 URL 保留字符须编码。已有 PostgreSQL 可以直接建库。 |
| Shopee 和 1688 | 在 Chrome 登录新店及采购账号。在 `chrome://extensions` 开启开发者模式，加载仓库内 `node_modules/@wuwe1/booey/extension`。执行 `pnpm exec booey daemon start`，再用 `pnpm exec booey doctor` 检查连接。首次设置从当前浏览器识别店铺。 |
| DeepSeek 和 x2bot | 安装下方 Hermes Agent（智能代理）环境后，在首次设置填店铺自己的 DeepSeek API Key（接口密钥）并测试。客服建议复用这把密钥。 |
| 象寄翻译 | 在启动配置的「象寄图片翻译」打开[象寄官网](https://www.xiangjifanyi.com/home/)，注册或登录自己的账号，填写 UserKey（用户密钥）和 ImgTransKey（图片翻译服务标识码）。旧 Gemini 流程、知虾镜像与其他集成按 [配置示例](.env.example) 选配。 |

本机已安装 Docker（容器工具）时，可以用官方 PostgreSQL 镜像启动新库。先把命令里的示例密码换成自己的密码。

```sh
docker run -d --name x2-postgres -p 127.0.0.1:55432:5432 -v x2-postgres:/var/lib/postgresql/data -e POSTGRES_USER=x2 -e POSTGRES_DB=x2 -e POSTGRES_PASSWORD='替换为本地密码' postgres:17
```

新电脑从空库开始。店铺登录、API Key 和旧电脑的商品稿及聊天记录都保存在各自的本机配置或数据库里。需要接续旧数据时，备份并恢复旧库到新电脑，再配置现用账号。

### Hermes Agent 环境

已有 Hermes 时，在设置页填写它的 Python 可执行文件绝对路径，测试通过即可复用。新装可用 [uv（Python 环境管理工具）](https://docs.astral.sh/uv/getting-started/installation/) 安装当前 X2 使用的 [Hermes Agent v0.23.3](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3)。

```sh
git clone --depth 1 --branch v0.23.3 https://github.com/NousResearch/hermes-agent.git artifacts/runtime/hermes-agent
uv sync --project artifacts/runtime/hermes-agent --locked --python 3.14 --extra mcp
```

X2 会识别该目录的虚拟环境。日后启动运行 `node x2.ts web`，更新运行 `git pull --ff-only`、`pnpm install --frozen-lockfile`，然后重启 X2。

## 流程入口

- [策略选品](.agents/skills/selection/SKILL.md)、[上架](.agents/skills/listing/SKILL.md)、[图片翻译](.agents/skills/listing-images/SKILL.md)
- [商品目录](.agents/skills/catalog/SKILL.md)、[客服](.agents/skills/chat/SKILL.md)、[采购](.agents/skills/procurement/SKILL.md)、[报账](.agents/skills/reimbursement/SKILL.md)

运行 `node x2.ts --help` 查看命令，`node x2.ts status` 汇总待办，加 `--json` 取得结构化回执。退出码 3 表示需要人工处理，退出码 4 表示写入结果未决，沿原请求用 `node x2.ts verify` 读回。

## 修改与提交

`x2.ts` 装配应用，`platform/` 提供运行机制，`connectors/` 接入外部系统，`tools/` 维护业务。依赖边界、工具注册和网页确认由测试校验。

提交钩子和 CI（持续集成）都运行 `pnpm verify`。[项目约定](AGENTS.md)说明授权边界。[验证技能](skills/verify/SKILL.md)说明对受影响行为的检查。提交按 `type(scope): 中文说明` 分组，例如 `fix(db): 修复断线后的连接清理`。密钥放入本机配置。
