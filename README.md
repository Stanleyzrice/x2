# x2

x2 帮我们经营 Shopee 台湾的两家店（ni1206、cheeroutdoor）：一个给 agent 用的命令行，和一个给人看、给人填的网页。

## 装

1. Node 24、pnpm：`pnpm install`。
2. 仓库根目录写 `.env`（不进 git），要设什么照 `.env.example`：至少 `X2_DATABASE_URL`、`X2_DATABASE_SSH`、`GEMINI_API_KEY`、`XIANGJI_USER_KEY`、`XIANGJI_IMG_TRANS_KEY`。库是大家共用的，在香港服务器上，本机不用装 Postgres、不用 Docker：连库的两行找管服务器的人要（他跑 `ops/db-user.sh <你的名字>`），x2 连库时自己经 SSH 隧道连过去（要你的公钥已经在服务器上）。只有 `x2 web --scratch` 要本机有 `pg_dump`、`psql`（15 或更新，`brew install libpq`）。
3. x2 经 booey（`@wuwe1/booey`，`pnpm install` 装好了）用浏览器：开它的 daemon（`pnpm exec booey daemon start`，开着就不用）；两家店各开一个浏览器（Chrome 的不同用户），每个在 `chrome://extensions` 打开开发者模式、「加载已解压的扩展程序」选 `node_modules/@wuwe1/booey/extension`，在扩展弹窗里起个名字，再登录 Shopee、1688、知虾、chanboss。`pnpm exec booey doctor` 查 daemon、扩展对不对得上。
4. 连服务器：`ops/ssh_config` 是三台服务器和共享库隧道的 SSH 配置（不含秘密），在 `~/.ssh/config` 里 `Include` 它，或 `ssh -F ops/ssh_config penna-hk`。共享库在服务器上怎么装、怎么开账号是 `ops/db-server.sh`、`ops/db-user.sh`。

`postgres` 固定为 3.4.9，项目补丁由 `package.json` 的 `pnpm.patchedDependencies` 和锁文件登记，使用项目指定的 pnpm 10.18.3 执行 `pnpm install --frozen-lockfile` 会自动应用。补丁回移官方 [#1209](https://github.com/porsager/postgres/pull/1209) 对 [#1208](https://github.com/porsager/postgres/issues/1208) 的修复，覆盖包内 ESM、CommonJS 与 Cloudflare 构建：断线后清掉待写缓冲并以 `CONNECTION_CLOSED` 拒绝待处理查询，避免延迟写入抛出未捕获异常；不自动重发查询。升级驱动时，只有目标版本已包含此修复且断线回归测试通过，才能一起移除补丁及对应锁项。

## 开始

在仓库里开 Claude Code 或 Codex，它读 `AGENTS.md`，第一件事是 `node x2.ts status`。人看网页：`node x2.ts web`，打开 http://127.0.0.1:5170：侧栏是 agent 开的页，中间是给人看的，右边是要人改、要人选的。全部命令：`node x2.ts --help`（每件事是一个工具：`x2 <toolkit> <工具> --参数 值`）。

## 输出约定

stdout 只放结果，加 `--json` 时是一个 JSON 值；stderr 只放进度。加 `--json` 出错时 stdout 是 `{ "error": { "kind", "message" } }`。id 一律是字符串，时间是 ISO 8601。

| 退出码 | kind | 意思 | 下一步 |
|---|---|---|---|
| 0 | | 成功 | |
| 1 | error | 出错 | 把原话告诉人 |
| 2 | usage | 用法不对 | 看 `--help` 改命令 |
| 3 | human | 要人处理：没登录、要过滑块、浏览器没连上 | 请人在浏览器里处理好再重试 |
| 4 | | 写的结果未知 | 不许重发，先 `x2 verify` 读回来 |
