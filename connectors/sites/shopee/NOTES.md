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
| `orders.ts` | `orderIndex`、`orders`、`toShipOrders` | `POST /api/v3/order/search_order_list_index` |
| | `orderCards` | `POST /api/v3/order/get_order_list_card_list`（一次最多 5 张） |
| | `oneOrder` | `GET /api/v3/order/get_one_order` |
| | `arrangeDropoff`（写） | `POST /api/v3/shipment/init_order` |
| `products.ts` | `liveProducts` | `GET /api/v3/opt/mpsku/list/v2/get_product_list?list_type=live_all`（一页最多 48） |
| | `allProducts` | `GET /api/v3/opt/mpsku/list/v2/search_product_list?list_type=all` |
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
| | `deleteProducts`（写） | `POST /api/v3/product/delete_product_info` |
| | `uploadImage`（写） | 页面的 `UploadService.$instance.uploadImage`（webpack 模块里找） |
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
| 发聊聊 | `/new-webchat/conversations` | 消息走 WebSocket（SharedWorker `webchat/worker.js`，socket.io），不是 HTTP。做法：`window.postMessage({type: "MiniChatRedirect", userId, shopId, conversationId, isFromSearch: true})` 打开会话；在 `textarea[placeholder="輸入文字"]` 里填字；从 redux store 的 `conversationReducer`、`entityReducer.conversations` 核对会话和最新消息 id 没变；再点输入框旁边唯一的 `i` 图标 |
| 建商品优惠券 | `/portal/marketing/vouchers/new?usecase=2` | 从输入框的 React fiber 找到表单对象（有 `fields["convertFields.items"]`），用 `form.setValuesIn` 填、`form.validate()`，再点「確認」 |
| 广告：从自动选品里移出一个商品、单独开广告 | — | `POST /api/pas/v1/product/gms/item/edit`（`type: "delete"`）、`POST /api/pas/v1/product/publish`（`bidding_strategy: "roi_two"`，预算和 ROAS 乘 100000）；lilto 做过，没搬 |

## 踩过的坑

- 订单列表的 `order_list_tab`：100 全部、200 未付款、300 待出货、400 运送中、500 已完成。
- 订单详情有两种外壳：`package_level_order_card`（分包裹的）、`order_card`。
- 商品状态码：0 删除、1 在售、2 审核中、3 禁卖、8 下架。
- 属性的可选值在 `children`，`value_list` 恒空；值要一字不差地取自 `children` 的名字，编的值发布时被拒。
- 规格最多两层；一个商品最多 100 个规格，规格之间价差不超过 5 倍。
- `1000100256` 是通用的字段校验失败码（缺尺码表也回它），不等于重复。
- 发布：直接开卖的路径回 10025；成功的配方是先发成下架（`unlisted: true`），人看过再上架。
- 批量上架的草稿 id 是 `unpublished_product_id`；图还在摄取时发布会丢图。
- 广告计划列表的时间要对齐到台湾时间的整天，不然回 `5 invalid request`。
- 自动选品广告的商品表现一页只能 10 个；`item_with_impression_only: false` 回的是全店能投的商品，不是这个计划的。
- 财务区可能要求再输入一次登录密码（401、403，或消息里有「密碼」「驗證」）：请人在浏览器里验证，不代输。
- 聊聊的 token 在 localStorage 的 `chat-session`，几个小时就失效；打开聊聊页、等页面发出 `GET conversation/unread-count`，就刷新了。后台标签页要打开焦点模拟，聊聊才会启动（`browser.ts` 已经对每个标签页打开）。
- 聊聊不调 `conversation/enter`、`conversation/open`：会把消息标成已读。

## 回包样本

`fixtures/*.json` 是解析过的回包（商品列表、订单卡片、商品资料、属性树、聊聊的会话和消息），api.test.ts 拿它们跑解析。都是照代码和上面记的写的（不是抓的真回包）。别的接口（经营数据、广告、优惠券、折扣、收入、售后、批量上架的记录）原样回，只解析外壳和列表那一层，没配样本。登录以后用 live.ts 读一遍，把真回包换进来（买家的名字、电话、地址、聊天内容换成假的）。
