---
name: selection
description: 选品，按策略给一家店找 1688 货源：知虾找词和竞品、以图搜 1688 同款、报价、照选品规矩筛、写选品理由和依据加成商品稿。运营说「选品」「找货」「再上一批」「按策略选 N 个」时用；做商品稿以后的事见 listing skill。
---

目标：每家店按在用的策略加够名额的商品稿，每份都能回头查为什么选、按的是哪一版策略和规矩。命令在 x2 仓库根目录跑 `node x2.ts <命令>`（下面写 `x2`），加 `--json` 读结果；工具的参数看 `x2 <toolkit> <工具> --help`。跟运营说起商品稿用「简称（店铺）」。

## 步骤

1. **分这一轮**：两家店方向不同、货不重复；每个在用的策略分一份名额。读 references/round.md。能开 subagent 就一个策略开一个 `listing-select`（给它店、策略、名额、别的策略在找的方向），主对话不装候选的细节。
2. **看策略和规矩**：`selection strategy-list`、`selection rule-list`。照策略的「选品方法」找，照规矩筛。策略、规矩要改先跟运营说，**她同意了**再用 `selection strategy-set`、`selection rule-add`、`selection rule-retire` 记下。怎么记读 references/records.md。
3. **找词、找竞品**：知虾的 `zhixia hot-words`、`zhixia hot-word-items`、`zhixia competition`、`zhixia price-line`；种子从店里卖得好的来（`shopee performance`）。知虾的数字有坑、限流共用，读 references/zhixia.md。
4. **找 1688 货源**：用竞品的图以图搜，`zhixia similar-1688`。不用 `1688 search`（最容易跳滑块）。挑图的办法读 references/zhixia.md。
5. **报价**：每个候选 `listing quote`，一个一个报，别连着刷。看售价区间、规格数、重量（估的会写出来）、服务、起订量、问题。
6. **筛**：照选品规矩，做法读 references/screening.md。
7. **加成商品稿**：`listing add` 带上策略、选品理由、依据，理由不一样的分开加。依据写什么读 references/records.md。
8. **回报**：每个策略加了哪些（简称或 1688 标题、售价区间、为什么选），放弃了哪些、为什么，这一轮学到的（哪类货赢不了、哪种找法不灵）。要改规矩或策略的提给运营定。

之后照 listing skill：做商品稿、估重量、写文案、人审稿批准、上架。
