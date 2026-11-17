// 时间序列仅做技术统计；经营窗口和准入条件由调用者显式提供。
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeTimeSeries, timeSeriesInputSchema, timeSeriesSummarySchema } from "./time-series.ts";

const points = (values: (number | string | null)[], start = 1) =>
	values.map((value, index) => ({ date: `2026-11-${String(start + index).padStart(2, "0")}`, value }));
const input = (values: (number | string | null)[]) => ({
	metric: "sales",
	basis: "daily" as const,
	points: points(values),
	windowDays: 3,
	minPoints: 3,
	asOfDate: "2026-11-09",
	maxLagDays: 0,
});

test("三组同长日历窗口按日期排序，计算连续变化且不改输入", () => {
	const source = { ...input([1, 1, 1, 2, 2, 2, 4, 4, 4]), points: points([1, 1, 1, 2, 2, 2, 4, 4, 4]).reverse() };
	const before = structuredClone(source);
	const result = summarizeTimeSeries(source);
	assert.deepEqual(source, before);
	assert.equal(result.older.mean, 1);
	assert.equal(result.previous.mean, 2);
	assert.equal(result.recent.mean, 4);
	assert.equal(result.previousGrowthRate, 1);
	assert.equal(result.absoluteChange, 2);
	assert.equal(result.growthRate, 1);
	assert.equal(result.comparable, true);
	assert.equal(result.dailyComparable, true);
	assert.equal(result.recent.total, 12);
	assert.equal(result.recent.startDate, "2026-11-07");
	assert.deepEqual(timeSeriesSummarySchema.parse(result), result);
});

test("未知和滚动口径可比较同口径观察均值，不相加也不冒充日销量", () => {
	for (const basis of ["unknown", "rolling"] as const) {
		const result = summarizeTimeSeries({ ...input([1, 1, 1, 2, 2, 2, 4, 4, 4]), basis });
		assert.equal(result.comparable, true);
		assert.equal(result.dailyComparable, false);
		assert.equal(result.observationComparable, false);
		assert.equal(result.growthRate, 1);
		assert.equal(result.recent.total, null);
		assert.match(result.limitations.join("；"), basis === "unknown" ? /口径未知.*日销量.*通过/ : /滚动.*相加/);
	}
});

test("有日期的原生样本指标可作观察值初筛，聚合窗口未知，不称日值或真实同期成交", () => {
	const result = summarizeTimeSeries({ ...input([1, 1, 1, 2, 2, 2, 4, 4, 4]), basis: "observed" });
	assert.equal(result.comparable, true);
	assert.equal(result.observationComparable, true);
	assert.equal(result.dailyComparable, false);
	assert.equal(result.recent.mean, 4);
	assert.equal(result.growthRate, 1);
	assert.equal(result.recent.total, null);
	assert.match(result.limitations.join("；"), /聚合窗口未知/);
	assert.match(result.limitations.join("；"), /样本.*变化/);
	assert.match(result.limitations.join("；"), /不.*同期成交.*预测/);
	assert.deepEqual(timeSeriesSummarySchema.parse(result), result);
	const stale = summarizeTimeSeries({ ...input([1, 1, 1, 2, 2, 2, 4, 4, 4]), basis: "observed", asOfDate: "2026-11-10" });
	assert.equal(stale.observationComparable, false);
});

test("缺日与空值分开统计，不补零，不按有效样本数移动窗口", () => {
	const source = input([1, 1, 1, 2, 2, 2, 4, null, ""]);
	source.points.splice(6, 1);
	const result = summarizeTimeSeries(source);
	assert.deepEqual(result.recent.missingDates, ["2026-11-07"]);
	assert.deepEqual(result.recent.nullDates, ["2026-11-08", "2026-11-09"]);
	assert.equal(result.recent.validPoints, 0);
	assert.equal(result.recent.mean, null);
	assert.equal(result.recent.total, null);
	assert.equal(result.comparable, false);
	assert.equal(result.growthRate, null);
});

test("最少点数按显式参数判断，日值缺日时不输出完整窗口总量", () => {
	const source = { ...input([1, 1, 1, 2, 2, 2, 4, null, 4]), minPoints: 2 };
	const result = summarizeTimeSeries(source);
	assert.equal(result.comparable, true);
	assert.equal(result.dailyComparable, true);
	assert.equal(result.recent.mean, 4);
	assert.equal(result.recent.total, null);
	assert.match(result.limitations.join("；"), /缺.*均值/);
});

test("同日相同值去重，冲突值不择一且阻断比较", () => {
	const source = input([1, 1, 1, 2, 2, 2, 4, 4, 4]);
	const same = summarizeTimeSeries({ ...source, points: [...source.points, { date: "2026-11-09", value: "4" }] });
	assert.deepEqual(same.quality.duplicateDates, ["2026-11-09"]);
	assert.equal(same.comparable, true);
	const conflict = summarizeTimeSeries({ ...source, points: [...source.points, { date: "2026-11-09", value: 400 }] });
	assert.deepEqual(conflict.quality.conflictDates, ["2026-11-09"]);
	assert.equal(conflict.recent.validPoints, 2);
	assert.equal(conflict.comparable, false);
	assert.equal(conflict.growthRate, null);
});

test("严格日历日期、坏数值和未来日期有明确质量结果", () => {
	const source = input([1, 1, 1, 2, 2, 2, 4, 4, 4]);
	const invalid = summarizeTimeSeries({
		...source,
		points: [...source.points, { date: "20261109", value: 4 }, { date: "2026-02-30", value: 4 }, { date: "2026-11-09", value: "NaN" }],
	});
	assert.equal(invalid.quality.invalidDatePoints.length, 2);
	assert.equal(invalid.quality.invalidValuePoints.length, 1);
	assert.equal(invalid.comparable, false);
	const future = summarizeTimeSeries({ ...source, asOfDate: "2026-11-08" });
	assert.deepEqual(future.quality.futureDates, ["2026-11-09"]);
	assert.equal(future.comparable, false);
});

test("真实零保留，零基数增长率为未知而非无穷大", () => {
	const result = summarizeTimeSeries(input([0, 0, 0, 0, 0, 0, 4, 4, 4]));
	assert.equal(result.previous.mean, 0);
	assert.equal(result.previous.total, 0);
	assert.equal(result.previousGrowthRate, null);
	assert.equal(result.growthRate, null);
	assert.equal(result.absoluteChange, 4);
	assert.match(result.limitations.join("；"), /基数.*0/);
});

test("尖峰移除每个窗口中恰好一个最大值后另算变化", () => {
	const result = summarizeTimeSeries(input([1, 1, 1, 2, 2, 2, 1, 1, 100]));
	assert.equal(result.growthRate, 16);
	assert.equal(result.withoutWindowMaximum.recentMean, 1);
	assert.equal(result.withoutWindowMaximum.previousMean, 2);
	assert.equal(result.withoutWindowMaximum.growthRate, -0.5);
	assert.equal(result.withoutWindowMaximum.previousGrowthRate, 1);
	assert.equal(result.withoutWindowMaximum.removedRecent?.date, "2026-11-09");
});

test("最大值移除后不足最少点数，明确不再可比", () => {
	const result = summarizeTimeSeries({ ...input([1, 1, 2]), windowDays: 1, minPoints: 1, asOfDate: "2026-11-03" });
	assert.equal(result.comparable, true);
	assert.equal(result.withoutWindowMaximum.comparable, false);
	assert.equal(result.withoutWindowMaximum.growthRate, null);
});

test("最新数据滞后按传入阈值判断，仍保留观察窗口但不允许比较通过", () => {
	const source = { ...input([1, 1, 1, 2, 2, 2, 4, 4, 4]), asOfDate: "2026-11-12", maxLagDays: 2 };
	const stale = summarizeTimeSeries(source);
	assert.equal(stale.quality.lagDays, 3);
	assert.equal(stale.quality.stale, true);
	assert.equal(stale.recent.mean, 4);
	assert.equal(stale.comparable, false);
	assert.equal(stale.growthRate, null);
	assert.equal(summarizeTimeSeries({ ...source, maxLagDays: 3 }).comparable, true);
});

test("空序列和缺第三窗口不冒充可比，参数拒绝无效日期与经营默认值", () => {
	const empty = summarizeTimeSeries({ ...input([]) });
	assert.equal(empty.comparable, false);
	assert.equal(empty.quality.latestDate, null);
	assert.equal(empty.growthRate, null);
	assert.equal(summarizeTimeSeries({ ...input([2, 2, 2, 4, 4, 4]), asOfDate: "2026-11-06" }).comparable, false);
	for (const change of [{ windowDays: 0 }, { minPoints: 4 }, { asOfDate: "2026-02-30" }, { maxLagDays: -1 }])
		assert.equal(timeSeriesInputSchema.safeParse({ ...input([]), ...change }).success, false);
	assert.equal(timeSeriesInputSchema.safeParse({ metric: "sales", basis: "daily", points: [] }).success, false);
});

test("真实知虾样本的日期和sales字符串只作为观察值，不因字段名推断日值", () => {
	// 2026-11-18实读 demand-change-sleepwear.json 中连续九日；源回包未证明sales口径。
	const observed = [2517, 2436, 2512, 2495, 2490, 2520, 2496, 2499, 2460];
	const result = summarizeTimeSeries({
		...input(observed.map(String)),
		points: points(observed.map(String), 8).reverse(),
		basis: "unknown",
		asOfDate: "2026-11-18",
		maxLagDays: 2,
	});
	assert.equal(result.quality.latestDate, "2026-11-16");
	assert.equal(result.quality.lagDays, 2);
	assert.equal(result.recent.mean, 2485);
	assert.equal(result.comparable, true);
	assert.equal(result.dailyComparable, false);
	assert.equal(result.recent.total, null);
});
