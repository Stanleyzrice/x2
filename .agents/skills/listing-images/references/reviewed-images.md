# OpenAI Image 与明确的视觉审阅

用户选择 OpenAI Image（图片生成与编辑）后，可对真实源图的后加文案做台湾繁体本地化；保留实物、印花、商标和包装本体原貌。无须修改的干净原图可以由 Codex 或人实际看图后采用，不为走流程重画实物。此路径不依赖 Gemini 额度，也不把服务报错当审核通过。

1. 对未建稿运行 `listing reviewed-images-preview --id <编号>`，读取 `expectedScope`、完整 `sourceMain`/`sourceDetail` 及数量、已保存原图SHA和 `requiredOptions`。先核对全部来源，再记录采用、过滤及原因。
2. 原图取文件可经 `image save`；编辑使用 OpenAI Image。逐张查看实际成图，与源图和源SKU核款式、花色、尺寸、件数及实物文字；不能凭生成成功即认定通过。记录原图SHA256、处理文件SHA256和真实审阅证据。
3. 用 `listing reviewed-images --id <编号> --manifest -` 从stdin交JSON：`{expectedScope,main:[{sourceUrl,sourceSha256,path,sha256,provider,evidence}],detail:[同结构],options:[{同结构,skuIds:[...]}]}`。`path`为本地绝对路径；`provider`为 `openai-image` 或 `clean-original`。原图模式的两个SHA必须相同；所有来源URL必须在本稿保存的货源里。options按预览原URL分组，skuIds精确覆盖该URL的全部已选SKU，不能漏规格、换款或编造规格。
4. 导入先核全部文件SHA、来源SHA、尺寸与规格指纹，再统一由X2加本店水印、上传Shopee并持久化。详情图须宽≥700、高≥32、宽高比0.5–32；长图须先形成经审阅的合规图。main最多9张、detail最多12张；一张长源图可拆成多份不同处理文件，分别保留相同源URL/SHA及各自处理SHA、证据。导入不改商品规格、售价、人工字段或Gemini检查缓存。
5. `listing make --ids <编号> --image-mode reviewed` 沿用已导入图与原规格，只续补空白类目、属性和备货天数；不再筛字、译图或重排规格。需更换范围时重新预览并导入。
6. `listing text ... --review-mode deferred` 仅保存已做纯规则校验的文案，不调用Gemini，不算通过审阅。类目、物流、价格、文案和图片齐备后运行 `listing review-preview --id <编号>`，实际查看所有最终图片（包含尺码表）和对应原货源，再以 `listing review --id <编号> --expected-key <指纹> --provider codex-visual|human --evidence <真实依据> --text-issues '[]' --images '[{id,issues:[]},...]'` 保存完整逐图结论。有问题如实填写，不填空数组冒充未审图。
7. 明确审阅与原Gemini审阅经过同一上品门槛；文案、图片顺序、规格映射或源规格变化后指纹失效。结果如实显示审阅provider，不称作Gemini已完成。发布仍经既有 `listing publish` 授权、写入和读回流程。
