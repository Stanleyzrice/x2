// 只计算同口径观察值，不定义经营准入门槛；daily由调用者依据外部证据确认，不能由字段名推断。
import { z } from "zod";

const DAY_MS = 86_400_000;
const dateNumber = (date: string): number | null => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const value = Date.parse(`${date}T00:00:00.000Z`);
	return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : null;
};
const calendarDate = z.string().refine((date) => dateNumber(date) !== null, "日期须为有效YYYY-MM-DD日历日期");
export const timeSeriesInputSchema = z
	.strictObject({
		metric: z.string().trim().min(1),
		basis: z.enum(["daily", "rolling", "observed", "unknown"]),
		points: z.array(z.strictObject({ date: z.string(), value: z.union([z.number(), z.string(), z.null()]) })),
		// 上限仅防止错误输入展开无限日历，不是选品经营条件。
		windowDays: z.number().int().min(1).max(3660),
		minPoints: z.number().int().min(1),
		asOfDate: calendarDate,
		maxLagDays: z.number().int().nonnegative(),
	})
	.refine((input) => input.minPoints <= input.windowDays, "最少点数不得多于窗口天数");
export type TimeSeriesInput = z.input<typeof timeSeriesInputSchema>;
type Point = { date: string; value: number | null };
const windowSchema = z.object({
	startDate: z.string().nullable(),
	endDate: z.string().nullable(),
	expectedDays: z.number().int().positive(),
	validPoints: z.number().int().nonnegative(),
	missingDates: z.array(z.string()),
	nullDates: z.array(z.string()),
	mean: z.number().nullable(),
	total: z.number().nullable(),
});
export type TimeSeriesWindow = z.output<typeof windowSchema>;
const removedPoint = z.object({ date: z.string(), value: z.number().nullable() }).nullable();
export const timeSeriesSummarySchema = z.object({
	metric: z.string(),
	basis: z.enum(["daily", "rolling", "observed", "unknown"]),
	windowDays: z.number().int().positive(),
	minPoints: z.number().int().positive(),
	asOfDate: z.string(),
	maxLagDays: z.number().int().nonnegative(),
	comparable: z.boolean(),
	dailyComparable: z.boolean(),
	observationComparable: z.boolean(),
	older: windowSchema,
	previous: windowSchema,
	recent: windowSchema,
	absoluteChange: z.number().nullable(),
	growthRate: z.number().nullable(),
	previousGrowthRate: z.number().nullable(),
	withoutWindowMaximum: z.object({
		comparable: z.boolean(),
		olderMean: z.number().nullable(),
		previousMean: z.number().nullable(),
		recentMean: z.number().nullable(),
		growthRate: z.number().nullable(),
		previousGrowthRate: z.number().nullable(),
		removedOlder: removedPoint,
		removedPrevious: removedPoint,
		removedRecent: removedPoint,
	}),
	quality: z.object({
		inputPoints: z.number().int().nonnegative(),
		uniqueDates: z.number().int().nonnegative(),
		validPoints: z.number().int().nonnegative(),
		latestDate: z.string().nullable(),
		latestValidDate: z.string().nullable(),
		lagDays: z.number().nullable(),
		stale: z.boolean(),
		futureDates: z.array(z.string()),
		duplicateDates: z.array(z.string()),
		conflictDates: z.array(z.string()),
		invalidDatePoints: z.array(z.object({ index: z.number().int().nonnegative(), date: z.string() })),
		invalidValuePoints: z.array(z.object({ index: z.number().int().nonnegative(), date: z.string(), value: z.union([z.number(), z.string()]) })),
	}),
	limitations: z.array(z.string()),
});

const dateText = (value: number) => new Date(value).toISOString().slice(0, 10);
const meanOf = (values: Point[]): number | null => (values.length ? values.reduce((sum, point) => sum + point.value! / values.length, 0) : null);
const growth = (previous: number | null, recent: number | null): number | null =>
	previous === null || recent === null || previous === 0 ? null : (recent - previous) / previous;

/** 两个窗口各去掉一个最大值；相同最大值只去一个，避免把恒定序列全部删掉。 */
function withoutMaximum(points: Point[]) {
	if (!points.length) return { remaining: [], removed: null };
	const largest = points.reduce((best, point, index) => (point.value! > points[best]!.value! ? index : best), 0);
	return { remaining: points.filter((_, index) => index !== largest), removed: points[largest]! };
}

export function summarizeTimeSeries(value: TimeSeriesInput) {
	const input = timeSeriesInputSchema.parse(value);
	const byDate = new Map<string, (number | null)[]>();
	const invalidDatePoints: { index: number; date: string }[] = [];
	const invalidValuePoints: { index: number; date: string; value: string | number }[] = [];
	for (const [index, point] of input.points.entries()) {
		if (dateNumber(point.date) === null) {
			invalidDatePoints.push({ index, date: point.date });
			continue;
		}
		const raw = typeof point.value === "string" ? point.value.trim() : point.value;
		const empty = raw === null || raw === "";
		const parsed = empty ? null : Number(raw);
		const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
		if (!valid) invalidValuePoints.push({ index, date: point.date, value: point.value! });
		const values = byDate.get(point.date) ?? [];
		values.push(valid ? parsed : null);
		byDate.set(point.date, values);
	}
	const duplicateDates: string[] = [],
		conflictDates: string[] = [];
	const points = [...byDate.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([date, values]) => {
			if (values.length > 1) duplicateDates.push(date);
			const conflict = values.some((value) => value !== values[0]);
			if (conflict) conflictDates.push(date);
			return { date, value: conflict ? null : values[0]! };
		});
	const latestDate = points.at(-1)?.date ?? null;
	const latestValidDate = points.findLast((point) => point.value !== null)?.date ?? null;
	const lagDays = latestValidDate === null ? null : (dateNumber(input.asOfDate)! - dateNumber(latestValidDate)!) / DAY_MS;
	const stale = lagDays === null || lagDays > input.maxLagDays;
	const futureDates = points.filter((point) => point.date > input.asOfDate).map((point) => point.date);
	const pointMap = new Map(points.map((point) => [point.date, point.value]));
	const makeWindow = (offset: number): { summary: TimeSeriesWindow; valid: Point[] } => {
		if (latestDate === null)
			return {
				summary: { startDate: null, endDate: null, expectedDays: input.windowDays, validPoints: 0, missingDates: [], nullDates: [], mean: null, total: null },
				valid: [],
			};
		const end = dateNumber(latestDate)! - offset * input.windowDays * DAY_MS;
		const start = end - (input.windowDays - 1) * DAY_MS;
		const missingDates: string[] = [],
			nullDates: string[] = [],
			valid: Point[] = [];
		for (let date = start; date <= end; date += DAY_MS) {
			const text = dateText(date);
			if (!pointMap.has(text)) missingDates.push(text);
			else {
				const value = pointMap.get(text)!;
				if (value === null) nullDates.push(text);
				else valid.push({ date: text, value });
			}
		}
		return {
			summary: {
				startDate: dateText(start),
				endDate: dateText(end),
				expectedDays: input.windowDays,
				validPoints: valid.length,
				missingDates,
				nullDates,
				mean: meanOf(valid),
				total: input.basis === "daily" && valid.length === input.windowDays ? valid.reduce((sum, point) => sum + point.value!, 0) : null,
			},
			valid,
		};
	};
	const older = makeWindow(2),
		previous = makeWindow(1),
		recent = makeWindow(0);
	const windows = [older, previous, recent];
	const enoughPoints = windows.every((window) => window.summary.validPoints >= input.minPoints);
	const comparable = enoughPoints && !stale && !futureDates.length && !invalidDatePoints.length && !invalidValuePoints.length && !conflictDates.length;
	const trimmed = windows.map((window) => withoutMaximum(window.valid));
	// 各窗口均移除一项，因此移除后的技术点数要求也减一；至少保留一个实际观察值。
	const trimmedComparable = comparable && trimmed.every((window) => window.remaining.length >= Math.max(1, input.minPoints - 1));
	const [olderMean, previousMean, recentMean] = trimmed.map((window) => meanOf(window.remaining));
	const limitations: string[] = [];
	if (input.basis === "unknown") limitations.push("统计口径未知；窗口均值仅为同口径观察值描述，不是日销量证明，不得据此作趋势通过或选品通过。");
	if (input.basis === "rolling") limitations.push("滚动窗口观察值存在重叠，不能相加为销量；均值变化不代表每日新增销量。");
	if (input.basis === "observed") {
		limitations.push("这是已核实原生含义的带日期样本指标，聚合窗口未知；仅比较观察均值及变化，不是日销量或真实同期成交证明，也不是未来销量预测。");
		limitations.push("样本范围和成员可能变化，均值变化也可能来自样本变化；范围及字段定义的原生证据由调用者提供，不代表各日期已有不可变的历史快照。");
	}
	if (windows.some((window) => window.summary.missingDates.length || window.summary.nullDates.length))
		limitations.push("窗口存在缺日或空值，未补零；均值仅按实际有效点计算，缺失可能使窗口比较偏离真实情况。");
	if (!enoughPoints) limitations.push("至少一个窗口的有效点数少于传入最少点数，三窗口不能比较。");
	if (stale) limitations.push(`最新有效数据滞后${lagDays ?? "未知"}天，超过传入允许滞后${input.maxLagDays}天或没有有效日期。`);
	if (invalidDatePoints.length) limitations.push("存在无效日期，未猜测或转换日期格式，不能比较。");
	if (invalidValuePoints.length) limitations.push("存在无效数值，未补零，不能比较。");
	if (conflictDates.length) limitations.push("同一日期存在冲突值，未择一使用，不能比较。");
	if (futureDates.length) limitations.push("数据日期晚于比较基准日，不能比较。");
	if (older.summary.mean === 0 || previous.summary.mean === 0) limitations.push("增长率的基数为0，增长率保留未知，不返回无穷大。");
	if (!trimmedComparable) limitations.push("去掉每个窗口一个最大值后，可比较点数不足或原序列质量受限。");
	limitations.push("工具仅返回描述统计，不产生选品准入结论；daily口径必须由调用者通过外部来源核实。");
	return {
		metric: input.metric,
		basis: input.basis,
		windowDays: input.windowDays,
		minPoints: input.minPoints,
		asOfDate: input.asOfDate,
		maxLagDays: input.maxLagDays,
		comparable,
		dailyComparable: input.basis === "daily" && comparable,
		observationComparable: input.basis === "observed" && comparable,
		older: older.summary,
		previous: previous.summary,
		recent: recent.summary,
		absoluteChange: comparable ? recent.summary.mean! - previous.summary.mean! : null,
		growthRate: comparable ? growth(previous.summary.mean, recent.summary.mean) : null,
		previousGrowthRate: comparable ? growth(older.summary.mean, previous.summary.mean) : null,
		withoutWindowMaximum: {
			comparable: trimmedComparable,
			olderMean: olderMean ?? null,
			previousMean: previousMean ?? null,
			recentMean: recentMean ?? null,
			growthRate: trimmedComparable ? growth(previousMean ?? null, recentMean ?? null) : null,
			previousGrowthRate: trimmedComparable ? growth(olderMean ?? null, previousMean ?? null) : null,
			removedOlder: trimmed[0]!.removed,
			removedPrevious: trimmed[1]!.removed,
			removedRecent: trimmed[2]!.removed,
		},
		quality: {
			inputPoints: input.points.length,
			uniqueDates: points.length,
			validPoints: points.filter((point) => point.value !== null).length,
			latestDate,
			latestValidDate,
			lagDays,
			stale,
			futureDates,
			duplicateDates,
			conflictDates,
			invalidDatePoints,
			invalidValuePoints,
		},
		limitations,
	};
}

export type TimeSeriesSummary = ReturnType<typeof summarizeTimeSeries>;
