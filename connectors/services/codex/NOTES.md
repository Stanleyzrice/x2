# 本机 Codex CLI

本机2026-11-17已安装 `/opt/homebrew/bin/codex`，版本0.169.0。已读 `exec --help`、`features list`，并用所有执行参数加`--help`确认参数组合可解析；未由这项检查运行模型。

调用 `exec --ignore-user-config --model gpt-6.1-sol -c 'model_reasoning_effort="medium"' --ephemeral --sandbox read-only --json --output-schema <file> --output-last-message <file> -C <repo> -`，stdin传完整提示。模型与推理强度由本连接器的项目代码显式指定，不继承桌面会话或用户全局模型配置。关闭shell、unified_exec、apps、plugins、hooks、browser、computer-use、code-mode、multi-agent、skill-search，禁用web-search，清空MCP配置；连接器用于提供事实后的模型分析，外站请求由业务层工具执行。配置仅限此子进程，不修改用户全局或Claude配置。

本机官方模型缓存列有 `gpt-6.1-sol`，支持 `medium` 推理强度；这仅是已知模型能力，不能证明某次请求已经成功。`status` 返回 `model`、`reasoningEffort` 配置值以及 CLI 可用性，不发起模型任务、不声称服务端已确认模型。旧实现未传 `--model`，运行记录也没有模型回执，无法据此确证历史实际模型。

`--json`是JSONL事件；只转发会话开始、分析开始和返回这类短进度，不记录模型原文、命令参数、完整stderr或凭证。等待期间每30秒发出`analysis.waiting`，仅包含安全提示、`elapsedMs`及`timeoutMs`；任务停止、取消、失败或完成后清理计时器，不再发进度。最终结果从独立临时文件读取为unknown，由业务层Zod声明校验。退出失败、缺文件、非法JSON、取消或超时都抛错，不能当作完成。

取消或超时先SIGTERM，1.5秒仍未停止则SIGKILL，等待close后才返回。macOS/Linux使用独立进程组，主进程先退出时也终止和核对整组，不能在遗留子进程仍执行时返回可重试超时；Windows使用子进程kill。无法确认整组停止时返回`CODEX_PROCESS_STOP_FAILED`，不得自动重试。

默认单次上限240秒，调用方可显式指定`timeoutMs`。确认旧进程已停止后，超时抛出`CodexTimeoutError`，其稳定合同是`code="CODEX_TIMEOUT"`、`timeoutMs`和`elapsedMs`，不包含原始stderr或账号资料。若停止期间收到取消，按取消返回；输出超限、非零退出、非法结果不伪装成可重试超时。连接器不自行重发模型请求，是否缩小只读分析并有限重试由业务流程决定，避免叠加重试。临时schema/结果文件在结束后清除；没有业务数据库读写。

CLI可用不等于账号、网络或模型配额可用；status只检查安装与所需参数。连接器不自动登录、不更改信任设置，也不使用绕过审批/沙箱参数。
