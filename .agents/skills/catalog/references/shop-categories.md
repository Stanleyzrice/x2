店铺导航分类（Shop Categories）与商品的 Shopee 平台 category 不同。用户已明确授权执行分类方案后，按该方案继续操作，不因进入下一步重复请求同一授权：

1. `catalog shop-categories --shop <店> --json` 现读分类与草稿；用当前完整在售清单核对商品归属，不能直接把旧快照中的已下架商品归入。`--ids <分类id逗号列表>` 可读完整成员。
2. 每项操作使用独立 UUID requestId。先 `catalog create-shop-category-draft --shop <店> --name <分类名> --request-id <UUID> --json`；读回草稿 id 后，用 `catalog create-shop-category --shop <店> --name <分类名> --draft-id <草稿id> --product-ids <完整在售商品id逗号列表> --request-id <另一个UUID> --json` 转为正式分类。按完整商品 ID 集合核对，不只比较款数。
3. 正式分类若尚未显示，用 `catalog shop-category-status --shop <店> --id <分类id> --status active --request-id <UUID> --json` 启用。方案涉及替换旧入口时，仅隐藏当前有效商品数为零的旧分类，改用 `--status inactive`；隐藏保留其历史成员，不删除分类或清空失效商品记录。
4. 分类齐全后，`catalog sort-shop-categories --shop <店> --ids <含隐藏分类的全部id，按目标顺序逗号排列> --request-id <UUID> --json` 设置顺序。最后现读分类状态、顺序与完整成员，确认后再报告完成。

以上新写操作首次分别加 `--try`。失败保留原结果；结果未知或不一致时先 `x2 verify`，只读回核对，不重发、不换 requestId 绕过未知结果。同一 requestId 不得更换店铺、名称、草稿、成员或顺序。
