# 客服模型服务

聊聊优先用 X2 设置中的 DeepSeek API Key（接口密钥）。未设置 DeepSeek 密钥时，可同时配置 `X2_CHAT_BASE_URL`、`X2_CHAT_API_KEY`、`X2_CHAT_MODEL`，并在聊聊选择跟随默认模型。服务商需兼容 OpenAI Chat Completions（对话生成接口）。地址可包含服务商的路径前缀。

[回包样本](fixtures/completion.json)用于解析测试。[客服技能](../../../.agents/skills/chat/SKILL.md)维护建议风格和发送规则。
