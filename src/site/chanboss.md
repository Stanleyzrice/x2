# chanboss（c.chanboss.com）

货代：收我们寄去的货，打包，寄到台湾。两家店的 Shopee 订单都在它的订单列表里，订单号和 Shopee 一样。代码在 `chanboss.ts`。

## 请求

- 凭证是 localStorage 的 `__tk`，放进 `x-wh-sessionkey` 请求头（没有 cookie）。外壳 `{ code, data, message }`：10000 成功，90000 会话失效。
- 接口前缀 `/api/v2/common/cangboss`。页面 JS 里的路径写成 `/cangboss/…`，前面的 `/api/v2/common` 是它的 axios 的 baseURL。
- 列表不按登录的账号过滤：每个都要带 `seller_id`，只用 `/sso/check` 读到的自己的 id（lilto 查到的越权）。
- 两次请求隔 2 秒以上。

## 订单（`/order/list_order`，POST）

一行是一张订单。用到的字段（2026-10-09 对 64 张真订单核对过）：

| 字段 | 意思 |
|---|---|
| `sn` | 订单号（= Shopee） |
| `id` | chanboss 上这张订单的 id：预报的 `order_id` |
| `platform_create_time` | 下单时间（秒）：预报的 `order_time` |
| `platform_shop_id`、`shop_name` | 店铺 id（= Shopee 的 shop_id）、店名 |
| `platform_status` | Shopee 的状态：READY_TO_SHIP、CANCELLED、COMPLETED、TO_CONFIRM_RECEIVE、TO_RETURN…… |
| `status` | chanboss 状态：paid 待处理、pre_report 已预报、arrive 已到齐、packaged 已打包、delivery 已出库及以后、other 取消等。paid、arrive 是推断的（这批数据里没有） |
| `ship_deadline_time` | 出货期限（秒，chanboss 上叫「截止」） |
| `item_detail_new[]` | 商品：`platform_item_id`、`platform_model_id`（Shopee 的规格 id；只有一个规格的商品是商品 id）、`model_id`（chanboss 的规格 id，预报要带）、`model_name`、`count`、`image` |
| `problem`、`problem_note`、`problem_type` | 问题单 |
| `sendway_id`、`sendway_name`、`line_id`、`warehouse_id` | 预报过的：752 海快、线路 1111、仓库 5176（台湾仓 CH） |
| `pack_sub_detail[]` | 预报的明细：每个规格一行，`track_num` 是快递单号，无单号是 `reserved` 开头的一串 |

## 预报（写，还没在真订单上跑过）

2026-10-09 读页面的 JS 找到的（`/assets/chunk-*.js`，webpack 模块 15342 是接口，38262、91182 是预报用的帮手）：

- **单张**：`POST /pack/add_report_new`。打拣货单时的「自动预报」这样发：
  ```json
  { "report_type": "order", "warehouse_id": 5176, "line_id": 1111, "sendway_id": 752,
    "order_id": "<订单 id>", "order_time": <下单时间（秒）>, "consumable_list": [],
    "detail": [{ "type": "express", "depend_id": "<Shopee 规格 id>", "model_id": "<chanboss 规格 id>", "note": "",
                 "track_num": "reserved", "purchase_price": 0, "express_code_type": 0, "purchase_sn": "", "count": 1 }] }
  ```
  `track_num` 填 `reserved`（页面上的常量）就是「无单号」；寄到 chanboss 的填快递单号。自动预报另带 `byFirst: true`，x2 不带。
- **批量**：`POST /pack/batch_add_report_new`，`{ ...发货线路, report_list: [每张一份上面的（不带线路）], is_test }`，回每张的 `{ order_id, success, reason }`。x2 用单张的。
- **读预报**：`GET /pack/get_report`（带 seller_id）。
- **取消预报**：页面上的按钮发 `POST /pack/cancel/pack/sub`，`{ sns: [订单号…] }`，回 `{ failed_sns }`；但它走的是另一个 axios（baseURL 没核实，可能是 `https://cn.connkey.com/api`）。x2 还没做：要先在页面上点一次，看它发到哪。

第一次预报要和运营约好一张单一起跑（`x2 run --try 预报`），跑完在 chanboss 上看那张订单变成「已预报」、明细是海快、无单号。
