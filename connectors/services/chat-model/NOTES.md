# 客服模型服务

在仓库根目录的 `.env` 填写 `X2_CHAT_BASE_URL`、`X2_CHAT_API_KEY` 和 `X2_CHAT_MODEL`。服务商须支持 OpenAI Chat Completions（对话生成）请求格式。基础地址保留服务商要求的路径前缀，例如 `https://api.example.com/v1`。X2 会追加 `/chat/completions`，也接受已经带此后缀的完整地址。

模型请求通过 `Authorization: Bearer <API Key>` 认证，失败时显示 HTTP 状态码。生成请求提交一次。回复正文取自 `choices[0].message.content`，模型名和用量来自回包，兼容回包样本见 `fixtures/completion.json`。

客服风格、上下文范围和发送许可属于 Chat toolkit/Skill，不属于本 Connector。
