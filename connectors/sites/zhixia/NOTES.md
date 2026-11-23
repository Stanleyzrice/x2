# 知虾接口

已接入能力见 `node x2.ts zhixia --help`。连接器从当前已登录页面读取，回包字段按各工具的 Zod schema 校验。扩展接口时，以页面组件的实际请求和响应为准。

传入 `expectedSiteId` 时，每次请求前在浏览器锁内校验原生站点。站点不符或编号无效会要求人工处理。用 `node x2.ts zhixia context --json` 查看当前站点。市场对应关系由调用方配置。

## 回包样本

`fixtures/*.json` 是 api.ts 解析的回包，api.test.ts 拿它们跑解析。`hot-word-list.json`、`hot-word-item-sales-detail.json` 是真回包（penna 留下的，只有公开的店名），`site-context.json` 是 `context` 从原生 getter 实读的脱敏快照，`similar-1688.json` 照代码写的。站点样本只验证原生字段解析，不作为运行时站点或国家名称的默认值。别的接口（热销类目、类目每天的数据、竞争、价格带、吐槽、偏好、长尾词）原样回，只认列表那一层，没配样本。


### 需求变化样本与指标定义（2026-11-18）

fixtures/demand-change.json 是台湾站点（原生 siteId=1）睡衣热词 hotWordId=13192 的实际只读回包，不含账户资料；30点为2026-10-18至2026-11-16，日期原格式YYYY-MM-DD，顺序倒序。demandSeries只将timest与sales提取并排序，缺值不补0。原生关键词选品页DemandSupply.setChart将sales直接绑定“销量”、timest绑定日期轴；可见需求指数tooltip明示分析样本为“该关键词搜索结果下前10页商品”。聚合窗口及固定样本未获证明，basis=observed仅指带日期样本指标观察值；不认定日销量、周成交或全市场需求，样本排名变化可能导致曲线变化。不把charts内的top10滚动类指标统一当日值、不汇总销量；没有已核实的搜索量序列。字段证据脱敏记录见artifacts/selection-new-workflows-20261118/native-demand-definition.json。
