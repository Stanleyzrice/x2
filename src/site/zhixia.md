# 知虾的接口

读者是给 x2 加知虾操作的 agent。

2026-09-30 从知虾页面的代码里读出来的：各页面的 webpack 模块里，每个接口是一个函数 `{url, method, params}`。这里只收和数据有关的；账号、支付、消息、后台管理的没收。前缀都是 `/api/shopee-report-service/pro`，下表省略。

怎么调：`api(路径, 参数)`（`zhixia.ts`），它带上 `siteId`、过限流、用页面的 axios 发。参数要看页面怎么传：在对应页面上找组件，读 `组件.$options.methods.getList` 的源码（`zhixia.ts` 里的具名函数就是这样查出来的）。回的外壳不统一：多数在 `data`，热搜词在 `hotWordList`，热词商品在 `itemListInfo`，长尾词在 `payload`。

「x2」一列打勾的已经写成 `zhixia.ts` 里的函数。另外 `/category/list`（类目树，在账号模块里）也已经写成函数 `categories()`。

参数里常见的：

| 参数 | 意思 |
|---|---|
| `catId`、`level` | 类目 id 和它是第几级（1～3）。`zhixia.ts` 里用类目路径 `[一级, 二级, 三级]` 表示，`at(path)` 换成这两个 |
| `type` / `exampleType` | `DAY`：按昨天；别的取值看页面 |
| `field`、`sortType` / `orderType` | 按哪个字段排、升序降序（`DESC`） |
| `isBorder` | 0：本土店和跨境店都算；页面上「只看跨境」时是 1 |
| `hotWordId`（有的接口写 `hotwordId`、`word`） | 热搜词的 id |
| `updateKey` | 热词详情的接口都带 `1` |

## 行业、类目

| 方法 | 路径 | x2 |
|---|---|---|
| get | `/industryAnalysis/search` |  |
| get | `/industryAnalysis/dataStatistics` |  |
| get | `/industryAnalysis/sellWell` | ✓ |
| get | `/industryAnalysis/soaring` |  |
| get | `/industryAnalysis/overview` |  |
| get | `/industryAnalysis/industryInfo` |  |
| get | `/industryAnalysis/industryInfoOverview` | ✓ |
| get | `/industryAnalysis/details` |  |
| get | `/compare/entrance` |  |
| get | `/category/price/distribute` |  |
| get | `/blueOceanCategory/top5BlueOceanCategory` |  |
| get | `/blueOceanCategory/top10BlueOceanCategory` |  |
| get | `/blueOceanCategory/getBlueOceanCategoryBasisData` |  |
| get | `/blueOceanCategory/getBlueOceanItemData` |  |
| get | `/blueOceanCategory/getCompetitiveList` |  |
| get | `/blueOceanCategory/getBlueShopTypeDistributionList` |  |
| get | `/blueOceanCategory/getBlueItemDistributionList` |  |
| get | `/category/getPriceRangeItems` |  |

## 店铺

| 方法 | 路径 | x2 |
|---|---|---|
| get | `/shop/hotSales` |  |
| get | `/shop/soar` |  |
| get | `/shop/hotSales/new` |  |
| get | `/shopAnalyze/statistics` |  |
| get | `/shopAnalyze/salesAnalyze/range` |  |
| get | `/shopAnalyze/rateOfPinAnalyze/range` |  |
| get | `/shopAnalyze/storeIncrement` |  |
| get | `/shopDetail/shopAdvertisedAnalysis` |  |
| get | `/shopDetail/shopAdvertisedList` |  |
| get | `/shopInfo/shopInfo` |  |
| get | `/shopInfo/getShopInfoByUserName` |  |
| get | `/shopInfo/getShopId` |  |
| get | `/shopInfo/trendComparison` |  |
| get | `/shopInfo/shopSellWellItems` |  |
| get | `/shopDetail/shopNewItemList` |  |
| get | `/shopDetail/shopCatItemCountStatis` |  |
| get | `/shopDetail/shopCatItemStatis` |  |
| get | `/shopDetail/shopCatDetailStatis` |  |
| get | `/shopAnalyze/activeShop30Day/range` |  |
| get | `/shopDetail/salesPriceEs` |  |
| get | `/competingShop/getRptShopData` |  |
| get | `/competingShop/getCompetingShopList` |  |
| get | `/competingShop/getCompetingItemList` |  |
| get | `/shopDetail/getShopChangeListV2` |  |
| post | `/shopDetail/getShopChangeDetail` |  |
| get | `/shop/getShopItemList` |  |
| get | `/category/listByShop` |  |
| get | `/shopDetail/getShopOverview` |  |
| get | `/shopDetail/getShopCatTrend` |  |
| get | `/shopDetail/getShopNewItemTrend` |  |
| get | `/shopInfo/brandItemDistribution` |  |
| get | `/shopInfo/brandCharts` |  |
| get | `/shop/tcTop` |  |
| get | `/activityMarketing/getShopActivityCalendar` |  |
| get | `/shop/searchShopByName` |  |
| post | `/item/getCategoryTopProductList` |  |

## 商品、1688/淘宝同款

| 方法 | 路径 | x2 |
|---|---|---|
| get | `/item/hotItemList` |  |
| get | `/item/surgeItemList` |  |
| get | `/item/hotNewItemList` |  |
| get | `/itemStatistics/itemSalesStatistics` |  |
| get | `/itemStatistics/siteCategoryItemIncrment` |  |
| get | `/itemDetails/info` |  |
| get | `/itemDetails/chart` |  |
| get | `/itemStatistics/itemSiteSalesGmvStatistics` |  |
| get | `/itemStatistics/siteItemIncrement` |  |
| get | `/itemSkuStatis/itemSkuDataStatis` |  |
| get | `/itemSkuStatis/itemSkuDataDayStatis` |  |
| get | `/itemDetails/itemAdvertisedAnalysis` |  |
| get | `/item/getItemId` |  |
| get | `/itemDetails/newTrace` |  |
| get | `/drainageWords/drainageWordsCorrelation` |  |
| get | `/drainageWords/hotWrodAdRatio` |  |
| get | `/similarProduct/query1688` | ✓ |
| get | `/similarProduct/query1688ExtendFieldsByOfferId` |  |
| get | `/similarProduct/queryTaoBao` |  |
| get | `/itemSkuStatis/priceChangeStatis` |  |
| get | `/activityMarketing/getActivityCalendar` |  |
| get | `/item/tcItemList` |  |
| get | `/item/getTcItemCategory` |  |

## 热搜词

| 方法 | 路径 | x2 |
|---|---|---|
| get | `/hotWord/hotWordList` | ✓ |
| get | `/hotWord/surgeHotWordList` |  |
| get | `/hotWord/newHotWord` |  |
| get | `/hotWordDetail/hotWordItemSalesDetail` | ✓ |
| get | `/hotWord/hotWordDetailInfo` |  |
| get | `/hotWord/wordItemCatStatistics` |  |
| get | `/hotWord/wordItemCtimeStatistics` |  |
| get | `/hotWord/wordItemTypeStatistics` |  |
| get | `/hotWordDetail/hotWordItemPriceRangeStatis` |  |
| post | `/siteWord/search` |  |
| post | `/siteWord/recommend` |  |
| get | `/hotWordTop/hotWordCategory` |  |
| get | `/hotWordTop/hotWordItemTop` |  |
| get | `/hotWordTop/hotwordSearchHistory` |  |
| get | `/hotWordTop/hotwordItemStatistic` |  |
| get | `/blueOceanWords/topBlueOceanWords` |  |

## 引流词、长尾词

| 方法 | 路径 | x2 |
|---|---|---|
| get | `/drainageWords/drainageWordsData` |  |
| get | `/drainageWords/longTailWords` | ✓ |
| get | `/drainageWords/queryProductList` |  |
| get | `/drainageWords/productRanking` |  |
| get | `/drainageWords/getDrainageContrast` |  |
| get | `/drainageWords/getDrainageTrend` |  |
| get | `/drainageWords/getHighFrequencyWord` |  |
| get | `/drainageWords/getFlowContrastChart` |  |
| get | `/drainageWords/getActivityFormList` |  |

## 热词详情（选品）、大数据选品

| 方法 | 路径 | x2 |
|---|---|---|
| post | `/bigData/bigDataSelectionList` |  |
| post | `/bigData/bigDataSelectionCategoryList` |  |
| get | `/bigData/getCategorySample` |  |
| get | `/bigData/getSellerSample` |  |
| get | `/bigData/getItemPriceAnalysis` |  |
| get | `/bigData/getShopTypeAnalysis` |  |
| get | `/bigData/getItemConcentration` |  |
| get | `/hotWordChopeeProduct/getChooseHeadData` |  |
| get | `/hotWordChopeeProduct/getDemandChange` | ✓ |
| get | `/hotWordChopeeProduct/getCategoryDistributionList` |  |
| get | `/category/listMarket` |  |
| get | `/hotWordChopeeProduct/getCompetitiveEnvironment` | ✓ |
| get | `/hotWordChopeeProduct/getSalesLine` |  |
| get | `/hotWordChopeeProduct/getPriceLine` | ✓ |
| get | `/hotWordChopeeProduct/getCompetitiveItemList` |  |
| get | `/hotWordChopeeProduct/getItemSalesTop` |  |
| get | `/hotWordChopeeProduct/getShopAnalysis` |  |
| get | `/hotWordChopeeProduct/getShopList` |  |
| get | `/hotWordChopeeProduct/commentInterval` |  |
| get | `/hotWordChopeeProduct/hotWordCorrelation` |  |
| get | `/hotWordChopeeProduct/perspective` |  |
| get | `/hotWordChopeeProduct/preference` | ✓ |
| get | `/hotWordChopeeProduct/tucaoPoint` | ✓ |
| get | `/hotWordChopeeProduct/attentionPoint` |  |
| get | `/hotWordChopeeProduct/tucaoPointContent` |  |
| get | `/hotWordChopeeProduct/commentList` |  |
| post | `/bigData/getBigDataOverview` |  |
| post | `/item/getCategoryTopProductTrend` |  |
