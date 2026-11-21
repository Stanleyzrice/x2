# cheeroutdoor 批次跟踪

NAS 用户任务 `x2-cheeroutdoor-follow-up.timer` 每 15 分钟检查排期。复查从台北时间 10:00 开始，按上架后第 3、7、14 个完整日生成报告。2026-11-19 的 3 批 22 款在 NAS 种子清单中，首轮复查为 11-23、11-27 和 12-04。

NAS 保存批次、排期、结果和当日缺数记录，路径为 `/srv/work/rice/x2/shopee-follow-up/`。Mac 的 `com.x2.cheeroutdoor-follow-up` 使用现有已登录的 X2/Ego 会话，定期登记新品、完成请求中的只读采集，并把报告同步到项目的 `artifacts/shopee-follow-up-20261119/nas-reports/`。系统通知关闭时，可在同步目录阅读报告。Shopee 登录信息留在 Mac。

一次 X2 命令行或网页发布请求分配一个批次编号。多次 `listing publish` 属于同一运营批时，可传入相同的 `--tracking-batch <UUID>`。同一批跨日期发布时按读回在售日期排期。单独在 Shopee 后台操作的商品需要由 X2 接续登记。

每次采集使用平台近期 7 天滚动窗口。报告展示每批及每件的商品卡曝光、点击、商品访客、加购、确认购买转化率、确认单和付款单。点击率和转化率按匹配的分子分母加权。访客与订单按商品汇总，跨商品可重复。没有商品表现行、字段缺失或分母为零时均留空。当日采集失败会在当日重试，过了窗口仍缺数据则保留缺数记录。

## 状态和产物

- 在 NAS 运行 `python3 /srv/work/rice/x2/shopee-follow-up/scheduler.py status` 查看当前所有批次和复查日。`systemctl --user list-timers --all x2-cheeroutdoor-follow-up.timer` 查看定时器。
- Mac 采集配置和日志在 `../.x2-local/cheeroutdoor-follow-up/`。若显示会话失效，重新登录 Ego 的 cheeroutdoor 后由下一次轮询恢复。
- `collector.mjs <本机配置路径> --baseline` 单独跑一次展示用基线，日期任务依旧按 NAS 排期执行。
