# 1688

货源、搜索、购物车和加购、采购单、物流、退款。代码在 `1688.ts`。购物车、加购、采购单、物流、退款都在页面里用页面自己的 `lib.mtop.request` 发（签名由它算）。

## 采购单（`mtop.1688.trading.dataline.service`，serviceId `OrderListDataLineService.buyerOrderList`）

参数 `param: JSON.stringify({ tradeStatus, page, pageSize })`，一页最多 50，新的在前。下面的字段对真采购单核对过：

- 采购单号用 `idStr`（19 位，当数字会丢精度）；金额是分。
- 列表里**没有收货地址**（要的话得读详情）。采购单都寄到 1688 的默认地址，就是我们这里。
- 每一行（`orderEntries[]`）自带 `skuId`、`specId`、`specInfo.specItems`；`entryStatus` / `entryStatusLabel` 是这一行的状态（`waitsellersend` 待发货、`waitbuyerreceive` 已发货、`success` 已收货、`cancel` 交易关闭）；`entryExtension.receivedQuantity` 已收件数，`trackingNo` 快递单号，`sendgt` 发货时间。
- 每行商品图片来自自身 `mainSummImageUrl`，实际可为完整 `http://cbu01.alicdn.com/...` URL；协议相对地址转 HTTPS。缺失时保留 null，不拿订单级图片或其他行图片代替；`sourceId` 是这行商品的链接 ID，按字符串保留，不从图片推定。
- `tradeStatus`：空是全部；`dispute` 是「退款售后」，只回有进行中退款的采购单。页面上还有 `waitselleragree`（退款退货中）、`aftersale`（售后中）、`toushu`（投诉中），没试过。

## 退款、退货

读页面的 JS 找到的，对真退款单核对过。只用读的接口，申请、取消、修改退款的接口没调过。

**从采购单发现退款**：行上的 `entryExtension.refundId` + `refundStatus`（售中），或 `refundIdForAs` + `refundStatusForAs`（售后，确认收货以后申请的）。这里只有粗状态：

| 粗状态 | 意思 |
|---|---|
| `waitselleragree` | 进行中（页面显示「退款中」）。卖家同意以后、等买家寄回时**也还是它** |
| `refundsuccess` | 退款成功，终态。全额退了，采购单变成交易关闭 |
| `refundclose` | 关闭，终态（撤销、超时、卖家拒绝后没改、换货结束……） |

**细状态读详情**：`mtop.alibaba.cbu.refund.MtopRefundView.viewRefundDetail`，`{ refundId, disputeType }`，disputeType `"1"` 售中、`"2"` 售后（售后没实测）。回包 `data.model`：

| 字段 | 意思 |
|---|---|
| `status` / `statusLabel` | 细状态：`waitselleragree` 等卖家同意、`waitbuyermodify` 卖家拒绝等买家修改、`waitbuyersend` 等买家寄回、`waitsellerreceive` 等卖家收货、`refundsuccess`、`refundclose`。同一个状态码中文会变（「退款成功」「极速退款成功」），判断用状态码。实测见到的只有 waitbuyersend、refundsuccess、refundclose |
| `needReturnGoods` | true 退货退款，false 仅退款；`refundSceneModel.replaceNew` 换货、`reshipping` 补寄 |
| `refundPayment`、`refundCarriage` | 退的货款、运费（分） |
| `selfReturnGoodsLogisticModel` | 退货寄回：`freightBill` 运单号、`logisticsName`、`gmtSendGoods`、`logisticsStatus`（例「已签收」）。还没寄时 `hasReturnGoodsLogistics: false` |
| `refundOrderGroupModel.groupEntriesMap` | 退的是哪几行：key 是货源 id，值里 `specId`、`refundCount` |
| `gmtCreate`、`gmtModified` | 申请、最后变化的时间（北京时间字符串） |

回包里有卖家的电话、姓名、退货地址：x2 不取、不存。详情里的 `orderId`、行 `id` 是数字，19 位丢精度，不能拿来对；从采购单出发（本来就知道采购单号）不用它。

**x2 的读法**：读采购单（最近 3 页 + `dispute`），收集行上的退款单号；粗状态是终态就记下，是进行中再读详情拿细状态和退货运单号。

**别的接口**（没用）：`mtop.1688.dispute.dataline.service` 的 `RefundHallDataLineService.refundList`、`refundSummaryStat` 只回要关注的；`OrderCardDataLineService.batchQueryAftersaleSummary` 回给人看的 HTML 文字、不带状态码；旧页面 `dispute.1688.com/refund/buyerRefundList.htm` 有全部历史，是服务端渲染的 HTML。申请退款的写接口是 `mtop.shared.trade.service.refund.MtopRefundFlowNewService`：x2 不用。

**没弄清的**：waitselleragree、waitbuyermodify、waitsellerreceive 的中文；售后（disputeType 2）的详情；部分退款时采购单和行怎么变。

## 登录、滑块验证

**登录着没有**：cookie `__cn_logon__` 是 `true` / `false`（整个浏览器共用，借一个已经 attach 的标签页用 `Network.getCookies` 读，不用开 1688 的页面）。账号（userId、会员名）读首页服务端渲染的 loginStore。没登录的浏览器打开 1688，会经 `www.1688.com/_____tmd_____/page/login_jump` 跳到 `login.1688.com`、`login.taobao.com`。

**滑块验证**：读得太密（几个进程同时搜、连着加载页面）会跳阿里系风控的滑块验证，两种样子：整页跳到验证页，地址带 `/_____tmd_____/punish?x5secdata=…`（例 `s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?…`）；或者页面不变、弹一层验证框，框里的 iframe 是验证页（例 `h5api.m.1688.com//h5/mtop.…/_____tmd_____/punish?…`），这时页面里的 mtop 请求挂着、等人过验证。mtop 接口要过验证时回 `FAIL_SYS_USER_VALIDATE`、`RGV587_ERROR`。上面的 login_jump 不是验证。

**x2 的做法**（browser.ts）：同一个浏览器里的 1688 一次一个 x2 进程，页面两次加载之间隔 3 秒；同一页上的几个 mtop 请求不重新加载页面。在 1688 的页面里跑的每一步，先看有没有验证页、看得见的验证框，跑的时候每 0.5 秒再看：有就停下，退出码 3，说在哪家店的浏览器里拉。

## 回包样本

`fixtures/*.json` 是 api.ts 解析的回包，api.test.ts 拿它们跑解析。都是照代码和上面记的字段写的（不是抓的真回包）：`offer.json` 的值取自一个真货源解析后的样子，反推成商品页上的几块。登录以后用 live.ts 读一遍，把真回包换进来（买家、卖家的名字、电话、地址换成假的）。

`purchases.ts` 使用同一采购列表接口，金额字段保留为整数分字符串，缺失为 null；只用 `gmtPayment` 作为付款时间证据，不从状态名推定已付款。分页汇总缺失、不安全数字 ID 或金额会报错。供应商只读取明确的 sellerCompanyName、sellerLoginId 或 sellerInfo 对应字段；既有采购回包样本未含这些字段，缺失时返回 null。`buyer-order-facts.json` 为在既有合成样本上扩充的解析用 fixture，覆盖缺项、长金额和供应商字段，不是 live 证据。

`PurchaseFact.items[].fulfillment` 保留逐行履约事实：`specId`、`entryStatus` → `status`、`entryStatusLabel` → `statusLabel`；`entryExtension` 的 `refundIdForAs` / `refundStatusForAs`（售后）优先于 `refundId` / `refundStatus`（售中），没有退款单号时 `refund` 为 null，缺失状态不借用另一阶段或整单状态。新解析始终输出该对象，字段缺失为 null；旧缓存未带对象时履约信息未知。规格和退款 ID 同样保留精确字符串，拒绝不安全数字；这些字段不改变金额、付款时间和报账凭证的含义。
