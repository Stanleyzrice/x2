---
name: catalog
description: 查看指定 Shopee 店铺的在售或已下架商品、SKU、价格库存及1688关联；逐件确认后修改上架状态并读回核对。
---

目标：查看店铺商品及读取完整性。固定 Catalog 入口默认显示在售（网站状态码 1），可切换已下架（状态码 8）；库存筛选独立，售罄不等于下架。CLI 在仓库根目录运行 `node x2.ts`。商品状态只按用户逐件选择与确认修改；不自动更改价格、库存或货源选择。

1. `catalog shops --json` 返回 `shops` 中已配置的 shop、shopId、快照时间及最近刷新状态；选择明确店铺，后续保持同一身份。
2. 需要最新事实时，`catalog sync --shop <shop> --scope all --json`。只读取网站当前返回的全部状态，包括在售、下架、禁卖、审核、仍可返回的删除商品和售罄商品；不承诺网站不再返回的历史记录。
3. `catalog products --shop <shop> --status 1 --json` 读取当前快照中的在售商品；查看已下架时传 `--status 8`。可传 `--query <商品名或SKU>`、`--stock <all或in_stock或sold_out或unknown>`、`--page <页码>`、`--page-size <1至200>`。排查其他状态时，CLI 显式传 `--status all`、`--status unknown` 或网站状态码。
4. 输出 `rows` 中的 productId 原样传给 `catalog product --shop <同一shop> --product-id <productId> --json`，查看 `product.models` 的 modelId、SKU、规格、价格与库存；ID保持字符串。

用户要改变某个现有商品状态时：

1. 为本次操作生成新的 UUID requestId，调用 `catalog status-preview --shop <店> --product-id <商品id> --target-state listed|unlisted --request-id <UUID> --json`，展示准确店铺、商品名称、编号和前后状态。`listed` 为上架，`unlisted` 为下架；禁卖、审核、删除及无法明确判定的状态不作为普通下架商品重新上架。
2. 用户确认后，`catalog set-status` 使用相同参数。首次对应方向操作按 `trialRequired` 要求约一件加 `--try`，完成后在 Shopee 核对。仅因用户选择一个商品而操作，不自动扩大到其他商品或批量下架。
3. 提交不等于成功；只在读回 `已核对` 后报告完成。确认结果会更新这一件商品的本地状态，不表示重新读取了其全部价格库存。
4. 用 `catalog status-result` 查看该 shop、productId、requestId 的状态；结果未知或不一致时只用 `catalog reconcile-status` 核对，不重发、不换 requestId 绕过未知结果。同一 requestId 不能更换商品、方向或冻结内容。

判断依据是 `snapshot`、`lastAttempt` 和每个商品的缺项。`complete` 表示商品列表分页完整，`detailsComplete` 单独表示全快照规格信息完整。`listedCount` 是当前快照的在售商品数，`listedDetailsComplete` 表示这些在售商品均无详情缺项；`total` 是当前搜索和库存条件匹配数。保存快照不代表此刻实时状态。报告 source、scope、revision、startedAt/capturedAt、失败原因和实际读取范围。

刷新期间查看 `lastAttempt.status/phase/page/observed`；刷新失败保留旧快照，展示旧采集时间，不把旧值称为刚采集成功。`ok:false` 或登录、滑块、店铺身份不符时停止该次刷新，交人处理后再读；不反复重试相同阻塞。

未知价格、库存和缺失详情保留 null，不补零。售罄只按工具返回的 stockState 判断；删除商品详情不可读取时保留其概要和 detailError，不声称规格已完整。

`suppliers.kind=listing` 是商品稿记录的上品来源；`chosen` 是经店铺归属核对的已选货源。两者不同分别展示，broken 与 supplierWarnings 原样报告；缺少明确归属时不猜配、不自动选源。修改其他商品字段或选择货源时另行确认，并交对应工具处理。
