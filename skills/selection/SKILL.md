---
name: selection
description: 为 ni1206、cheeroutdoor 做选品研究、筛选候选并记录依据；业务规则和执行方法以本 skill 的 references 为准。
---

命令在仓库根目录运行 `node x2.ts`。规则正文只在本 skill 与 listing skill 维护；数据库中的旧规则、策略变更和商品稿快照用于追溯。

1. 确认店铺、研究方向和本次名额；只研究时不添加商品稿。
2. 先读 [选品规则](references/rules.md)，再读 [策略方法](references/strategies.md) 中对应的方法；`selection strategy-list` 只核对实验状态和版本。
3. 用 `zhixia` 的读取工具找关键词、竞品和需求证据；不把销量、搜索量、价格等未知值补成零。
4. 找到候选后，优先用知虾以图搜同款，再读取 1688 商品。每次读取一个，记录匹配依据。
5. 按 [定价流程](../listing/references/pricing.md) 取得参数并报价；单品与组合都要核对实际可成交的搭配。
6. 按规则筛选，分别报告事实、估计、判断和未知项；找不到合格的就照实报告。
7. 获准添加候选时，`listing add` 一次一个链接，带店铺、策略、选品理由和依据；不替人选定货源或发布商品。

需要按策略分工时，读 [任务边界与交付](references/search.md)。业务条件变化时先改对应 skill，再按工具参数执行；不在 Connector、数据库或页面另立一套规则。
