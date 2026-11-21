---
name: listing
description: X2通用商品上架流程：资料复用、货源规格核对、现行核价、图片与繁体文案、类目物流、真实审阅、授权发布及读回；经营规则与专项细节引用各自唯一入口。
---

在仓库根目录运行 `node x2.ts`，结果加 `--json` 保存。本文件是通用入口，命令、执行边界与中断恢复统一见[操作顺序](references/workflow.md)。项目可发现入口为[项目上架技能](../../.agents/skills/listing/SKILL.md)。

指定清单和续做默认快速上架。批次开始读一次 [AGENTS.md](../../AGENTS.md)、[选品规则](../selection/references/rules.md)、[定价流程](references/pricing.md)以及相关店铺设置。按需查看[采集与恢复](references/collecting.md)、[市场核价](references/market-pricing.md)和[繁体文案](references/copy.md)，已掌握的规则和有效证据直接复用。

1. **批次准备。** 固定店铺、货源、销售范围和已有授权，集中读进度、定价与卖家优惠。做图前用 `listing source-preflight` 批量复用采集快照，筛查供货、全部所售 SKU（规格）和成本；按回执只补读缺失、冲突或失效的字段。原稿续做，已在售记录链接，结果未知查原请求。
2. **成稿并一次终审。** 规格范围确定后按成本组核价；无可用市场样本直接走[成本定价](references/pricing.md)。空白计费数据有依据时取保守上限，[包装](references/channels.md)直接匹配可承运宅配。略过非必填且不影响购买、合规或履约的字段。按[图片技能](../../.agents/skills/listing-images/SKILL.md)选用真实同款图，优先用原图，只编辑必须处理的区域；文案和规格用台湾繁体。稿件齐备后 `review-preview` 对照最终规格、图文、价格及经营字段，复用未变图片的实审证据，`review` 保存一次完整结论。
3. **就绪即提交。** 在已有授权内用 `listing publish`，仅工具要求首次试单时用约定的单件 `--try`。按发布工具的建品核对及在售回执结单，商品号从本地稿读取。读回缺失或不一致才查受影响的商品或原请求。每件就绪即发布，有硬缺项的记录原因，其他继续。

cheeroutdoor 上架完成后按 [NAS 批次跟踪](references/follow-up.md)登记和复查。

只有具体问题会改变买家收到的款色、尺码或件数，导致定价不达标，影响平台必填、法规或安全，或使实际履约不可行时才阻塞对应方案。研究备注中的加工设想、未知市场样本、可省略的卖点、可保守估计的包装及规格图里的简短规格标注均按操作细则处理。不同稿的本地准备可并行，共享浏览器写入串行。发布、续做和失败处理见[操作顺序](references/workflow.md)，已建商品的修改、复制及跨店操作见[商品修改](references/editing.md)。
