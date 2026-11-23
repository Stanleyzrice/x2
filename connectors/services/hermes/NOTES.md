# Hermes Agent（智能代理）

X2 通过本机 Hermes Agent 运行已选商品的上品任务。可以复用 X2 本机运行目录的 Hermes，也可用 `X2_HERMES_PYTHON` 指定已安装 Hermes 和 MCP 依赖的 Python。每次运行由 X2 建立临时 Hermes 配置，仅连接该次任务的本机工具。

在 X2 的 `.env` 填 `DEEPSEEK_API_KEY`。Hermes 默认用 `deepseek-flash`，可按需通过 `X2_HERMES_MODEL` 调整。图片检查使用官方 DeepSeek 视觉接口读取实际图像，图片写入和审核沿用 X2 的当前文件指纹及规格范围。需要编辑的图片由经营者按原流程处理后续做。

从仓库根目录运行以下命令，替换成已经授权处理的店铺和备选编号。

```sh
node x2.ts listing source-hermes --shop '<店铺>' --source-ids '<编号列表>' --publish --json
```

仅在现有发布工具要求首次试单并已约定单件时，传一个备选编号并加 `--trial`。结果包含选中件的草稿和发布状态。若看到未决编号，沿原请求读回核对。
