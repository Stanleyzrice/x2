# 商品修改

商品图片处理与图中文字转换统一遵循[项目图片流程](../../../.agents/skills/listing-images/SKILL.md)，先经X2准备图片资产，再调用本流程修改商品。

有本地原稿的已建商品，可用 `listing upload-reviewed-assets --id <原稿号> --product-id <商品id> --offer-id <1688编号> --manifest -` 上传已实审的主图、详情和规格图。清单为 `{main, detail, options}`，图片字段沿用[已审图片清单](../../../.agents/skills/listing-images/references/reviewed-images.md)，每条 `options` 另带对应原 `skuId`。工具核对稿、商品、货源和图片指纹，经本店现行水印与上传记录返回图片编号。商品内容通过下述预览与写入流程更新。

准确类目不在店铺允许范围而用户已明确授权该单稿时，用 `listing category --id <编号> --category <叶子ID> --allow-outside-shop --reason <本稿授权及类目依据>` 记录仅限该叶子的单稿例外；不扩大店铺允许类目。修改类目后重新 `make` 补齐新类目属性和备货天数。

已建商品改类目时，现读原标题、完整原类目路径和目标叶子的必填属性；用 `listing edit-preview` 显式提供 `beforeCategoryPath`、`categoryPath`、`attributes`，核对后以同一参数调用 `listing edit`。只改类目时 `title` 与 `beforeTitle` 同为现有标题、`prices=[]`；原类目变化就重新确认，提交后读回目标路径和属性。

已建商品只换主图时，现读原标题与完整有序图片id列表，将原列表作为 `beforeImages`、审核后的完整新列表作为 `images`，以相同原标题和 `prices=[]` 调用 `listing edit-preview`，再以同一参数 `listing edit`；核对原列表和货号后提交一次，只改主图与同值标题，不提交规格、价格或描述。读回图片数量、顺序和id全部一致后才算完成。

修改描述时，将现读完整 `description_info` 作为 `beforeDescriptionInfo`，显式提供 `descriptionInfo`（`description` 字符串、`description_type` 为 `json` 或 `normal`），保留其他字段和富文本 `field_list` 中未修改的文字、图片。经同一套预览及写工具，原完整描述变化则停止，读回完整对象一致后才算完成；不提供这组参数时不发送描述。

需要修改 Size Chart 时，先审核真实尺寸或现有规格建议的依据并上传至本店，再将现读完整 `size_chart_info` 作为 `beforeSizeChartInfo`，完整新对象作为 `sizeChartInfo`，只替换其中 `size_chart` 为已上传图片id，保留 `size_chart_id` 等其他字段。原图可为空，新图须为非空Shopee图片id；经相同 `listing edit-preview` 和 `listing edit` 流程核对原对象并单次提交，读回完整目标对象一致后才算完成。不提供这组参数时不发送Size Chart；不能因站点要求该字段而虚构量体数据或更改原规格单位。

本批商品描述须有对应1688链接的详情图，主图和规格选项图不能代替描述内的图片。优先采用实拍、结构、尺寸和使用展示；只展示实际在售SKU适用的款式和参数，不把已排除规格重新放入详情图。全部可见文字按文案流程审核，后加简体说明处理为繁体，永久实物简体印字不能修改成不真实商品。先上传至本店，再在原 `field_list` 中追加 `{type:1,value:图片id,width:宽,height:高}`，最多12张，宽至少700px、高至少32px、宽高比0.5–32。保持原商品介绍、规格选择和使用提醒，读回描述内图片的数量、顺序和id；在X2记录每张的1688来源、处理和审核依据。

用户要求不展示产地时，保留同款适用的产品介绍、结构、折叠收纳与使用展示；优先仅移除产地、厂名地址或供货联系区块，后加说明转为台湾繁体，不因图中带介绍文字而整张排除。不得把该要求扩大为删除有用介绍，也不得将其他款式、尺寸或不适用部件混入。

按已选1688链接补齐规格时，先取得完整货源SKU，逐SKU核对颜色、尺寸、件数、skuId/specId和规格图。依[定价与组合流程](pricing.md)的现行利润目标及合理售价筛出可售子集，利润不足的不新增，不虚构缺货或未通过核价的组合；已上架SKU保留。超过平台100个模型或两层规格时，按完整款式/尺码分组拆品，不能截断SKU清单。

本轮 `cheeroutdoor` 指定备选（14、13、12、11、10、9、8、7、6、5、4、3、1）中的地垫商品，尺寸范围限定为 **40×60、50×80、60×90、80×120 cm（厘米）**，执行时先核实货源单位与尺寸含义，仅保留实际存在且通过其余上架规则的对应SKU，排除其他尺寸；保留既有人工选定款式，不因此扩选款式。不能为凑齐四种尺寸补造SKU，也不能把相近尺寸改名为目标尺寸；缺少的尺寸如实列明，四档均无可用规格或单位、尺寸含义未核清的保留待核对。同步核对最终规格、文案、尺码图及详情图，不重新引入已排除尺寸。该限制仅用于本轮待上架商品，不追溯修改已上架商品，不扩展至其他批次或店铺。

从单默认SKU展开为一至两层，或扩充完整规格表，用 `listing expand-preview`。显式提供 `offerId`、最终 `tiers[{name,options:[{name,imageId}]}]` 和 `models[{skuId,specId,tierIndex,costRmb,weightKg,price,stock,imageId,existingModelId?}]`；第一层每个选项有审核通过的已上传图片id，每个保留旧模型须给 `existingModelId`。输入是通过核价的完整子集，可以缺少组合。工具按现有 `LT{offerId}-{specId或skuId}` 规则生成merchantSKU并检查截断后的碰撞；不改原模型id、货号、价格，不发送原库存。

所有SKU按同一商品级重量重新核价；默认沿用原重量，较重新增SKU需显式 `targetWeightKg` 覆盖全部SKU及原重量。原SKU在原售价下因此利润不足时，先排除重SKU或拆品，不能静默让原SKU亏损。记录逐SKU成本及核价依据，工具不替代定价与组合流程。

核对预览的 `mapping`、旧模型保留、规格图、完整目标列表及 `currentHash`，再将该值作为 `beforeHash` 调用 `listing expand`。这是独立的新WriteOp，首次只做用户指定一款 `--try`，单默认转多规格的接口兼容性须以真实单件提交和原生读回确认。旧库存不发送，订单导致的原库存变化不阻止展开；新增库存、全部模型id/merchantSKU/索引/价格、规格图及未修改的商品字段须读回一致。已经完整展开时返回已完成，不重复建模型；结果未知先verify。

已建商品同时补译详情图和规格图时，可在 `expand-preview` 与 `expand` 提供原完整 `beforeDescriptionInfo` 和目标 `descriptionInfo`，用 `review-preview --shop … --product-id … --proposal …` 取得同一份最终图清单，按图片流程保存语言结论后一次提交。只换图时保留原规格、名称、售价与库存，读回也要与目标描述一致。

以上站点写入均须在用户已授权范围内，沿用既有 WriteOp 的首次单件 `--try` 和结果未知不重发规则。只改类目或图片不会自动回写旧商品稿的派生字段；最终导出应使用已核对的原生读回。

### 在售换图的语言审阅

用 `listing review-preview --shop <店铺> --product-id <商品编号> --proposal <修改参数JSON>` 查看改动后的商品最终图片。修改参数为 `{kind, input}`，`kind` 取 `edit`（改商品）、`expand`（展开规格）或 `add-size`（追加尺寸），`input` 使用对应工具原有参数，含店铺与商品编号。审阅后用同样的店铺、商品及 `proposal` 调用 `listing review`，提交预览指纹和实际逐图结论。核对完成后走原修改入口；写入前会重新按实际最终清单查语言结论。只审阅现有商品时省略 `proposal`。价格或库存单独操作沿用原入口。
