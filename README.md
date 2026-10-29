# x2

x2 帮我们经营 Shopee 台湾的两家店（ni1206、cheeroutdoor）：一个给 agent 用的命令行，和一个给人看、给人填的网页。

## 装

1. Node 24、pnpm：`pnpm install`。
2. 仓库根目录写 `.env`（不进 git），要设什么照 `.env.example`：至少 `X2_DATABASE_URL`（Postgres）、`GEMINI_API_KEY`、`XIANGJI_USER_KEY`、`XIANGJI_IMG_TRANS_KEY`。
3. Chrome 装 cdp-relay，两家店各开一个浏览器（Chrome 的不同用户），在里面登录 Shopee、1688、知虾、chanboss。
4. 连服务器：`ops/ssh_config` 是三台服务器的 SSH 配置（不含秘密），在 `~/.ssh/config` 里 `Include` 它，或 `ssh -F ops/ssh_config penna-hk`。

## 开始

在仓库里开 Claude Code 或 Codex，它读 `AGENTS.md`，第一件事是 `node x2.ts status`。人看网页：`node x2.ts web`，打开 http://127.0.0.1:5170。全部命令：`node x2.ts --help`（每件事是一个工具：`x2 <toolkit> <工具> --参数 值`）。

## 输出约定

stdout 只放结果，加 `--json` 时是一个 JSON 值；stderr 只放进度。加 `--json` 出错时 stdout 是 `{ "error": { "kind", "message" } }`。id 一律是字符串，时间是 ISO 8601。

| 退出码 | kind | 意思 | 下一步 |
|---|---|---|---|
| 0 | | 成功 | |
| 1 | error | 出错 | 把原话告诉人 |
| 2 | usage | 用法不对 | 看 `--help` 改命令 |
| 3 | human | 要人处理：没登录、要过滑块、浏览器没连上 | 请人在浏览器里处理好再重试 |
| 4 | | 写的结果未知 | 不许重发，先 `x2 verify` 读回来 |
