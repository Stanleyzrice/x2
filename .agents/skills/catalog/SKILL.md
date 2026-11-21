---
name: catalog
description: 核对 Shopee 店铺目录、商品与货源，按用户确认逐件变更上下架状态。
---

用 `node x2.ts catalog`。先定位 `shops`，需最新全量列表时 `sync --shop <店>`。用 `products --status 1|8|all` 分别看在售、下架或全部；售罄看 `stockState`。用 `product` 现读同店单品。报告采集时间、刷新失败和详情缺项；上架稿来源、已选货源及对应冲突分别呈现。

变更状态时，`status-preview` 返回确切商品与目标。用户逐件确认后用同一 `requestId` 和参数调用 `set-status`，按工具提示试单。只有读回 `已核对` 才报告完成；未决查 `status-result` 或 `reconcile-status`。店铺导航分类见[分类流程](references/shop-categories.md)。
