# Penna gateway

`POST /deepseek/chat/completions` 使用 Penna `Authorization: Bearer <token>`，请求及回包采用 OpenAI Chat Completions 形状。只通过 `X2_PENNA_URL` 指定的 gateway；不接受厂商 key、不直连 DeepSeek。

`X2_CHAT_MODEL` 可选；当前 gateway 支持 `deepseek-flash`、`deepseek-v4-pro`。`x-penna-what: x2-chat` 走正常额度检查。HTTP 401 表示 token 无效，402 表示额度不足；调用不自动重试。

客服风格、上下文范围和发送许可属于 Chat toolkit/Skill，不属于本 Connector。
