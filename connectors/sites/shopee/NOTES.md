# Shopee 卖家中心（台湾站）

读者是给 x2 加 Shopee 操作的 agent。

## 怎么发请求

- 请求一定在卖家中心页面里用页面的 `fetch` 发（`seller.ts` 的 `call`）。Shopee 的反爬 SDK 给页面里的请求现签名，页面外发会被拒（90309999）。
- 每个请求带查询参数 `SPC_CDS`（cookie 里的值）、`SPC_CDS_VER=2`，请求头 `x-csrftoken`（cookie 里的 `csrftoken`）。
- 外壳：多数是 `{code, message, data}`，`code` 0 是成功；财务、售后是 `{error, error_msg, data}`；数据中心是 `{code, result}`；聊聊没有外壳（按 HTTP 状态）。
- 读用 `seller()`，出错就抛错。写用 `write()`，回三态：`done`、`refused`（站点回了失败，确定没做）、`unknown`（没拿到答复，可能已经做了）。`unknown` 时不重发，先回读。
- 金额：订单是新台币；广告、折扣、财务是新台币乘 100000。时间是秒，台湾时间（UTC+8，没有夏令时）。
- 图片 id 接在 `https://down-tw.img.susercontent.com/file/` 后面，加 `_tn` 是缩略图。

## 已经写成函数的

| 文件 | 函数 | 接口 |
|---|---|---|
| `seller.ts` | `shop` | `GET /api/selleraccount/shop_info/`（shop_id 是店铺 id）、`GET /api/selleraccount/user_info/`（user_id 是卖家账号，不是店铺 id）、`GET /api/v3/general/get_shop_info/` |
| `shop-categories.ts` | `shopCategories`、`shopCategory`、`shopCategoryDrafts` | `GET /api/shopcategory/v4/category/get_collection_list/`、`get_collection/`、`get_collection_draft_list/` |
| | `createShopCategoryDraft`、`createShopCategory`（写） | `POST /api/shopcategory/v4/category/create_collection_draft/`、`create_parent_or_sub_category/` |
| | `setShopCategoryStatus`、`sortShopCategories`（写） | `POST /api/shopcategory/v4/category/update_category/`、`update_shop_collection_sequence/` |
| `orders.ts` | `orderIndex`、`orders`、`toShipOrders` | `POST /api/v3/order/search_order_list_index` |
| | `orderCards` | `POST /api/v3/order/get_order_list_card_list`（一次最多 5 张） |
| | `oneOrder` | `GET /api/v3/order/get_one_order` |
| | `arrangeDropoff`（写） | `POST /api/v3/shipment/init_order` |
| `products.ts` | `liveProducts` | `GET /api/v3/opt/mpsku/list/v2/get_product_list?list_type=live_all`（一页最多 48） |
| | `allProducts` | `GET /api/v3/opt/mpsku/list/v2/get_product_list?list_type=all`（page_number 分页，一页最多48） |
| | `productInfo` | `GET /api/v3/product/get_product_info` |
| | `channels` | `POST /api/v3/listing-upload/component/get_product_channel_info` |
| | `countLimit` | `GET /api/v3/opt/mpsku/list/get_product_count_limit` |
| | `performance` | `GET /api/mydata/v4/product/performance/` |
| | `categoryTree` | `GET /api/v3/category/get_category_tree` |
| | `attributes` | `POST /api/v3/listing-upload/component/get_attribute_tree` |
| | `recommendedCategory` | `POST /api/v3/category/get_recommended_category`（只给标题回空；要标题加一张已传的图） |
| | `shippingDays` | `GET /api/v3/product/get_product_constraints/` |
| | `createProduct`（写） | `POST /api/v3/product/create_product_info` |
| | `updateProduct`、`setUnlisted`（写） | `POST /api/v3/product/update_product_info` |
| `variants.ts` | `addSizeProduct`（写） | 同一更新接口的 `name`、`description_info`、`std_tier_variation_list`、`model_list`；既有模型提交 `id`、`tier_index`、`price`，新模型使用 `id: 0` 和 `stock_setting_list`、货号、图片 |
| | `expandProduct`（写） | 同一更新接口，只显式交最终 `std_tier_variation_list`、`model_list` 及可选 `weight`；既有模型带原 `id`、新索引、原价、规格图，新模型带 `id: 0`、货号、显式库存、价格、规格图；不交标题、描述或旧库存 |
| | `edit-product`（写，只经业务工具调用） | 同上；`name` 和可选的 `model_list`（规格 id、tier_index、price），不交库存、规格名或商品其他字段 |
| | `deleteProducts`（写） | `POST /api/v3/product/delete_product_info` |
| | `uploadImage`（写） | 原生 upload lazy loader 返回的 default 实例，或旧版 `UploadService.$instance.uploadImage` |
| `mass.ts` | `template` | `GET /api/tool/mass_product/download_template/`、`download_basic_template/` |
| | `records`、`recordFile` | `GET /api/tool/mass_product/get_mass_record_list/`、`download_record_file/` |
| | `drafts` | `GET /api/tool/mass_product/get_unpublished_product_list/` |
| | `upload`（写） | `POST /api/mass/mpsku/upload_template`（multipart） |
| | `publish`、`deleteDrafts`（写） | `POST /api/tool/mass_product/publish_product/`、`delete_product/` |
| `finance.ts` | `income` | `POST /api/v4/accounting/pc/seller_income/income_overview/get_income_detail` |
| | `incomeComponents` | `POST /api/v4/accounting/pc/seller_income/income_detail/get_order_income_components` |
| `returns.ts` | `cases` | `POST /api/v4/seller_center/return/return_list/get_exceptional_case_list` |
| `marketing.ts` | `shopMetrics` | `GET /api/mydata/v3/dashboard/key-metrics/` |
| | `reviews` | `GET /api/v3/settings/search_shop_rating_comments_new/` |
| | `adsAccount`、`adsSetup`、`campaigns`、`campaign`、`campaignGraph`、`gmsItems` | `POST /api/pas/v1/…`（见函数注释） |
| | `vouchers`、`voucher` | `GET /api/marketing/v3/voucher/list/`、`/api/marketing/v3/voucher/` |
| | `bundles` | `POST /api/marketing/v3/public/discount/list/`（`discount_type` 3） |
| | `discounts`、`discountItems` | `POST /api/marketing/v4/discount/get_discount_list/`、`get_discount_items_aggregated/` |
| | `updateDiscountItems`（写） | `POST /api/marketing/v4/discount/update_seller_discount_items/` |
| `chat.ts` | `conversations`、`unreplied`、`messages` | `/webchat/api/v1.2/conversations`、`conversation/list`、`conversations/<id>/messages` |
| `help.ts` | `articles`、`article` | `GET /help/api/v3/article/list/`、`detail/` |

读的都对真店跑通过（`connectors/sites/shopee/live.ts`）。写的除了上品用的，都还没在 x2 里接上；第一次用时和人一起跑。

## 只能在页面上点的（没写成函数）

这几样没有接口可调，要操作页面：照这里的做法，在对应的页面上找元素、找 React 的状态。

| 做什么 | 页面 | 做法 |
|---|---|---|
| 回复评价 | `/portal/shop/rating`（评价管理） | 按钮 `[data-testid="reply-button"]`，从它的 React fiber 往上找 `memoizedProps.info`，核对 `commentId`、`orderId` 和评价原文；点开后在 `[data-testid="reply-modal"]` 的 textarea 里用原生的 value setter 填字、发 input 事件，再点 `[data-testid="reply-submit-button"]` |
| 发聊聊（`chat.ts` 的 `sendMessage`） | `/new-webchat/conversations` | 消息由页面的 SharedWorker/WebSocket 发送。`MiniChatRedirect` 打开指定会话；用原生 value setter 填入唯一可用的 `textarea[placeholder="輸入文字"]`，发 input 事件；核对 Redux 当前会话、买家、店铺、正文及 `latest_message_id` 均与确认引用一致，再只触发一次 Enter。提交结果须读回新消息核对 |
| 建商品优惠券 | `/portal/marketing/vouchers/new?usecase=2` | 从输入框的 React fiber 找到表单对象（有 `fields["convertFields.items"]`），用 `form.setValuesIn` 填、`form.validate()`，再点「確認」 |
| 广告：从自动选品里移出一个商品、单独开广告 | — | `POST /api/pas/v1/product/gms/item/edit`（`type: "delete"`）、`POST /api/pas/v1/product/publish`（`bidding_strategy: "roi_two"`，预算和 ROAS 乘 100000）；lilto 做过，没搬 |

## 踩过的坑

- 商品图上传的原生入口是产品模块的 lazy loader：它先 `Promise.all` 加载伴随依赖和 upload 块，再 require 返回 `default` 上传实例的服务初始化模块。块号、模块号从当前页面运行时读取；准备服务只初始化这个 loader 指向的模块，不因UI模块源码提到 `uploadImage` 就 require 它，也不自行 `new UploadService`。过早 require 缺依赖的模块会留下空 exports 缓存，依赖补齐后仍可能保持空值；重新加载无未保存表单的X2自有新增商品页可清除这种旧缓存。服务准备失败发生在上传调用之前，不代表图片或商品已提交。

- Shop Categories 是买家浏览用的店铺导览分类，独立于商品详情的 `category_path`。`get_collection_list` 的 `product_count` 仅表示有效成员；`get_collection?collection_ids=<id>` 的 `product_id_list` 可能保留异常或已不可售的成员，不能看到 count 为零就认定分类为空。
- 空草稿池的 `get_collection_draft_list` 原生响应是 `data: {}`，页面为缺失的 `draft_list` 补 `[]`。只有这个已确认空池字段允许缺失，分类详情的成员字段仍必填。页面读取草稿行的 `id`、`name`；UI 内部把 id 转负数作标记，接口提交使用正 id。
- 分类创建遵循页面的两步接口：先以 `name` 创建草稿，再用 `create_parent_or_sub_category` 的 `independent_shop_category` 提交 `name`、`collection_type: customized`、`to_delete_draft_id`、`product_id_list`。各步只提交一次，草稿转换结果用正式分类完整成员与草稿消失分别核对。
- `update_category` 显示状态请求仅交 `shop_category_id` 与 `status: active|inactive`；隐藏不删除分类或成员。排序接口交完整 `collection_list: [{id, sort_weight}]`，页面按目标顺序赋予从列表长度递减到 1 的权重。请求字段为 snake_case；生产页面 request 默认启用 requestCaseOptions，UI camelCase 不能直接作为线上 JSON 合约。
- 分类接口与参数依据卖家中心 `decoration/category` 当前页面的生产 JavaScript：category chunk 6 的 module199/200 提供 helper 与 endpoint，chunk11 提供草稿和正式分类创建、状态切换，chunk5 提供排序。解析样本取自真实读取；写响应在第一次已授权操作前尚无成功样本。

- 订单列表的 `order_list_tab`：100 全部、200 未付款、300 待出货、400 运送中、500 已完成。
- 待出货列表真回包的卡片状态是 `待出貨`；`get_one_order.create_time` 是真实下单时间（Unix 秒），`status` 是数字状态，不能与卡片的状态文字互换。
- `search_order_list_index` 必须返回 `pagination.total`；缺失不能当作零单。卡片按请求的订单编号对应店铺，漏单、重复或返回未请求订单时读取失败，不补用第一张订单的店铺。
- `fixtures/order-index.json` 是待出货索引的真回包字段摘录，订单和店铺编号已替换。
- 订单详情有两种外壳：`package_level_order_card`（分包裹的）、`order_card`。
- 商品状态码：0 删除、1 在售、2 审核中、3 禁卖、8 下架。
- 全状态目录分页使用 `get_product_list` 的 `list_type=all`、`page_number`、`page_size`。商品列表前端的 `search_product_list` 用于搜索/重置条件，不带页码；向它传 `page_number=2` 仍会重复第一页，不能拿来遍历目录。
- `get_product_list(all)` 的商品行原生包含 `parent_sku`、`model_list`；规格用 `price_detail.origin_price`、`stock_detail.total_seller_stock`、`tier_index`。`allProducts` 在规格列表非空且没有截断/数量不符提示时提供 `bulk`；缺失规格仍须另读详情。有限核对的两个多规格商品及一个下架商品，列表与详情的 model id 集合相同；此证据不代表未来回包不会缺项。
- `bulk.models[].isDefault` 只保留模型原生 boolean `is_default`。单 SKU 的空 `name`、`tier_index: [0]` 可以同时出现，不能仅凭空名字或层下标推定默认规格。
- 属性的可选值在 `children`，`value_list` 恒空；值要一字不差地取自 `children` 的名字，编的值发布时被拒。
- 规格最多两层；一个商品最多 100 个规格，规格之间价差不超过 5 倍。
- `1000100256` 是通用的字段校验失败码（缺尺码表也回它），不等于重复。
- 创建接口：直接在售的请求样本返回 10025；已验证成功的请求样本使用 `unlisted: true`。这是请求样本与接口响应记录。
- 商品列表的上下架按钮使用 `update_product_info`，只交 `product_info: { unlisted }`，带 `Entrance-Identification: 1`（2026-10-30 读当前 product-list 模块的单件下架按钮）。普通编辑请求不带这个入口标识；不要为了下架擅自补尺码表或重交整份商品资料。
- 普通编辑的 `product_info` 可显式提交 `name`、`model_list`，改类目时同时交 `category_path` 和新类目的 `attributes`，不沿用旧类目属性。详情的 `category_path` 和 `attributes[].attribute_id/attribute_values[].value_id` 用于读回核对；站点可附带属性名称等字段。
- 旧商品的自填属性可只有 `attribute_values[].raw_value`，没有 `value_id`（2026-11-05 原生回包见 `custom-attributes.json`）。读取保留 `raw_value` 和缺失的 id，不补零；显式修改类目属性的写入参数仍要求明确 `value_id`，不把自填属性当作枚举值重交。
- `images` 是完整有序主图id列表，普通编辑可显式替换该字段；不补发 `model_list`、描述等其他字段。详情可返回图片id或完整图片URL，读回时按URL末段的id保持原顺序核对。
- `description_info` 只在显式提供时发送，保留整个对象；`description` 是普通文字或富文本JSON字符串，`description_type` 为 `normal` 或 `json`。不把富文本内的图片与主图列表混用。
- 普通编辑可显式提供完整 `size_chart_info`，`size_chart` 为已上传的Shopee图片id，其余字段原样保留；不提供时不发送。预览及提交前核对原完整对象（允许原图为空），读回核对目标完整对象；站点把图片id展开为URL时只归一化图片字段，不豁免其他字段差异。
- 2026-11-04 实测追加详情图成功后，`get_product_info` 会在富文本图片项中省略提交的 `width`、`height`，保留 `type: 1` 和图片id；文字及图片顺序不变。样本 `get-product-description-images.json`。尺寸须在提交前按实际图片验证，读回以完整文字、图片id和顺序核对；只豁免站点省略的图片宽高，不忽略其他变化。
- 规格更新用 `std_tier_variation_list` 的 `custom_value`、`value_list[].custom_value/image_id` 和 `model_list[].tier_index` 对应；新模型 `id: 0`，已有模型沿用原id。2026-11-04 已在 cheeroutdoor 单件确认单默认模型展开为8款和15款，保留原modelId、货号、价格及库存，并逐SKU读回图片。
- 一层规格图挂在第一层 `value_list[].image_id`，`model_list[].sku_image` 须为空；传非空值会被 `100010263 sku_image.auth` 拒绝（model sku_image is only allowed for 2-tier variation）。两层规格可交显式model图片。更新回读可能延迟，未知先核对，不重交；属性数组返回顺序不稳定，指纹按attribute_id/value_id排序，仍核对属性值。
- 列表下架还设置 `listingSignature`，请求拦截器发送 `sc-listing-sign`（MD5：原请求体 JSON + `SIGNCODE` + 四舍五入到秒的时间 + 当前 `SPC_CDS`）、`sc-listing-sign-t`、`sc-listing-sign-v: 1.0.0`；`SPC-SLT` 用当前店铺 id、页面公开固定串和当前 `SPC_CDS` 计算。不能只补入口标识而漏签名；这些会话值不进日志和写入记录。
- 列表的批量下架使用 `product/update_product/?version=3.1.0&source=seller_center`，请求是 `[{ id, unlisted: true }]`，入口标识为 `2`（当前 `delistPublishedProducts`）。它与单件 `update_product_info` 不同，但两个入口都可能因旧商品缺尺码表而拒绝。x2 逐件交批量入口，解析 `data.result` 的商品 id、code，再读详情核对状态；不补尺码表、不重交商品内容。
- 批量上架的草稿 id 是 `unpublished_product_id`；图还在摄取时发布会丢图。
- 广告计划列表的时间要对齐到台湾时间的整天，不然回 `5 invalid request`。
- 自动选品广告的商品表现一页只能 10 个；`item_with_impression_only: false` 回的是全店能投的商品，不是这个计划的。
- 财务区可能要求再输入一次登录密码（401、403，或消息里有「密碼」「驗證」）：请人在浏览器里验证，不代输。
- 聊聊的 token 在 localStorage 的 `chat-session`，几个小时就失效；打开聊聊页、等页面发出 `GET conversation/unread-count`，就刷新了。后台标签页要打开焦点模拟，聊聊才会启动（`browser.ts` 已经对每个标签页打开）。
- 聊聊不调 `conversation/enter`、`conversation/open`：会把消息标成已读。

## 回包样本

- `fixtures/get-all-products-created-at.json` 是 2026-11-13 全状态列表（`list_type=all`）真回包的两条摘录，商品 id、名称已替换；`create_time` 是 Unix 秒级创建时间，转换为 `createdAt`，不能当成最近一次重新上架时间。缺失或无效时间保留 null。
- `fixtures/shop-category-list.json`、`shop-category-detail.json` 为 2026-11-05 当前 Shop Categories 列表、详情真回包摘录，分类 id、名称和成员 id 已替换；保留有效商品数为零但仍有异常成员的字段关系。`shop-category-drafts.json` 是同次读取的空草稿池原生 `data: {}`。

- `fixtures/get-product-attributes.json` 是 2026-11-04 商品详情真回包的类目、属性摘录，商品 id 和名称已替换；用于类目修改前后的属性解析，不代表该编辑请求已获站点验证。
- `fixtures/custom-attributes.json` 是 2026-11-05 旧商品详情真回包的最小摘录，商品 id、名称和描述已替换；保留枚举属性与仅有 `raw_value: "nil"` 的自填属性共存形状。
- SKU 图片：`get_product_list` 的 `model_list[].image` 是图片 id；`get_product_info` 的 `model_list[].sku_image` 是字符串，可为空。为空时，图片由 `std_tier_variation_list[0].value_list[model.tier_index[0]].image_id` 对应，索引 0 也是有效值。尺寸层可能没有图片，不按名称匹配、不借用商品封面。图片 id 拼接 `https://down-tw.img.susercontent.com/file/`，已是 HTTP(S) URL 则直接使用，缺图保留 null。`fixtures/get-product-images.json` 保留此字段形状，覆盖零索引、重复名称、直接 URL 和缺图。

`fixtures/unlist-product.json` 是 2026-10-30 列表批量入口成功下架的 `data` 摘录，商品 id 已替换。提交前后详情的 `is_unlisted` 从 false 变 true；详情的 `status` 可以暂时还是 1，因此对账不能只看 status。

`fixtures/product-performance.json` 是 2026-10-30 从商品表现接口真回包抽取的有销量、零销量两条（其余字段省略，total 保留原值）；用于 id、确认件数和付款件数的解析。商品表现已逐项解析这些字段，缺少件数保留未知，不补零。`unlist-product` 的请求接口为 `update_product_info`，响应与商品状态字段见上述样本。

`fixtures/*.json` 是解析过的回包（商品列表、订单卡片、商品资料、属性树、聊聊的会话和消息），api.test.ts 拿它们跑解析。都是照代码和上面记的写的（不是抓的真回包）。别的接口（经营数据、广告、优惠券、折扣、收入、售后、批量上架的记录）原样回，只解析外壳和列表那一层，没配样本。登录以后用 live.ts 读一遍，把真回包换进来（买家的名字、电话、地址、聊天内容换成假的）。

- `fixtures/get-product-default-model.json`：get_product_info 的脱敏单规格回包；`is_default: true` 且变体层与选项均为空占位时为默认规格，`tier_index: [0]` 不代表存在实际选项。
