// 研究判断、外部查询与保存回执分开展示；历史记录缺结构化字段时仍显示原有文字。
import { Badge } from "@/components/ui/badge";
import { candidateQueryEvidence } from "./state.ts";
import type { BatchAudit, Candidate, QueryFact, ResearchConclusion, RunEvent, Strategy } from "./types.ts";

const demandLabels: Record<ResearchConclusion["demandLevel"], string> = { unknown: "需求尚未确认", search: "仅有搜索线索", purchase: "存在购买线索" };
const differenceLabels: Record<ResearchConclusion["differenceStatus"], string> = { supported: "有事实支持", hypothesis: "待验证假设", unknown: "尚无证据" };
const signal = (value: boolean | null) => (value === true ? "有" : value === false ? "未观察到" : "未知");
const references = (indexes: number[]) => [...new Set(indexes)].map((index) => `查询 ${index + 1}`).join("、");
const trendOutcome = (trend: NonNullable<QueryFact["trend"]>) => `样本指标初筛${trend.qualified ? "通过" : "未通过"}`;

export function ResearchConclusionView({ research, events }: { research: ResearchConclusion; events: RunEvent[] }) {
	const linked = candidateQueryEvidence({ research }, events);
	return (
		<section aria-label="研究结论" className="space-y-4 rounded-lg border p-3 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<p className="mr-auto font-medium">研究判断</p>
				<Badge variant="outline">{demandLabels[research.demandLevel]}</Badge>
				<Badge variant="secondary">差异：{differenceLabels[research.differenceStatus]}</Badge>
			</div>
			<dl className="space-y-2 leading-relaxed">
				<ConclusionItem label="购买任务" value={research.purchaseTask} />
				<ConclusionItem label="同组比较" value={research.comparableGroup} />
				<ConclusionItem label="可交付差异" value={research.deliverableDifference} />
			</dl>
			<p className="text-xs leading-relaxed text-muted-foreground">
				以上为本次研究判断。查询线索的范围见下方事实，关键词或整条商品的成交不能证明候选规格会成交。
			</p>
			{linked.facts.length > 0 ? (
				<div className="space-y-2">
					{linked.facts.map(({ index, fact }) => (
						<QueryEvidence key={index} index={index} fact={fact} />
					))}
				</div>
			) : (
				<p className="text-muted-foreground">未保存可关联的查询事实，需求与差异仍需核实。</p>
			)}
			{linked.missingIndexes.length > 0 && <p className="text-muted-foreground">缺少关联事实：{references(linked.missingIndexes)}。</p>}
			<Notes title="待补资料" values={research.missing} />
			<Notes title="这些情况会使判断失效" values={research.failureConditions} />
		</section>
	);
}

function ConclusionItem({ label, value }: { label: string; value: string }) {
	return value ? (
		<div>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd>
		</div>
	) : null;
}

export function QueryEvidence({ index, fact }: { index: number; fact: QueryFact }) {
	return (
		<details className="rounded-lg border p-3">
			<summary className="cursor-pointer leading-relaxed">
				查询 {index + 1} · {fact.query.keyword} · 搜索：{signal(fact.searchSignal)} · 购买：{signal(fact.purchaseSignal)}
				{fact.trend && ` · ${trendOutcome(fact.trend)}`}
			</summary>
			<div className="mt-3 space-y-3">
				<p className="text-xs leading-relaxed text-muted-foreground">范围：关键词、类目或整条商品；不代表具体规格。读取时间：{fact.observedAt}。</p>
				<dl className="space-y-2">
					<ConclusionItem label="查询对象" value={fact.query.role === "main" ? "主品" : fact.query.role === "accessory" ? "周边自身" : "待研究商品"} />
					<ConclusionItem label="货源查询词" value={fact.query.sourceKeyword} />
				</dl>
				{fact.trend && <TrendEvidence trend={fact.trend} />}
				<FactSection title="数据更新时间" value={fact.updateTime} />
				<FactSection title="热词事实" value={fact.words} />
				<FactSection title="相关商品事实" value={fact.items} />
				<FactSection title="竞争事实" value={fact.competition} />
				<FactSection title="问题与使用需求线索" value={fact.needs} />
				<FactSection title="读取缺项" value={fact.errors} />
			</div>
		</details>
	);
}

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const numberText = (value: unknown, percent = false) =>
	typeof value === "number" && Number.isFinite(value) ? (percent ? percentFormat : numberFormat).format(value) : "未返回";
const textValue = (value: unknown) => (typeof value === "string" && value ? value : "未返回");
const fieldsOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {});

export function TrendParameters({ parameters }: { parameters: NonNullable<Strategy["trend"]> }) {
	return (
		<section aria-label="趋势试行参数" className="space-y-3 rounded-lg bg-muted/50 p-3">
			<p className="font-medium">趋势试行参数</p>
			<dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
				<TrendValue label="每个比较窗口" value={`${numberText(parameters.windowDays)} 天`} />
				<TrendValue label="每个窗口至少有效点" value={numberText(parameters.minPoints)} />
				<TrendValue label="最多允许数据滞后" value={`${numberText(parameters.maxLagDays)} 天`} />
				<TrendValue label="基准窗口观察均值至少" value={numberText(parameters.minBaselineMean)} />
				<TrendValue label="最近窗口增长率至少" value={numberText(parameters.minGrowthRate, true)} />
				<TrendValue label="前一窗口增长率至少" value={numberText(parameters.minPreviousGrowthRate, true)} />
				<TrendValue label="去掉各窗口最大值后增长率至少" value={numberText(parameters.minRobustGrowthRate, true)} />
			</dl>
			<p className="text-xs leading-relaxed text-muted-foreground">
				参数沿用项目选品规则，可自定义下方研究步骤；这些是样本指标初筛的试行条件，不保证未来销量或盈利。
			</p>
		</section>
	);
}

function TrendValue({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="break-words font-medium tabular-nums">{value}</dd>
		</div>
	);
}

function TrendEvidence({ trend }: { trend: NonNullable<QueryFact["trend"]> }) {
	const summary = fieldsOf(trend.summary);
	const quality = fieldsOf(summary.quality);
	const withoutMaximum = fieldsOf(summary.withoutWindowMaximum);
	const basis =
		trend.basis === "daily"
			? "日值（已核实）"
			: trend.basis === "observed"
				? "带日期样本指标，聚合窗口未知"
				: trend.basis === "rolling"
					? "滚动窗口，不能累加为日销量"
					: "统计口径未知";
	const windows = [
		{ label: "更早窗口", value: fieldsOf(summary.older) },
		{ label: "前一窗口", value: fieldsOf(summary.previous) },
		{ label: "最近窗口", value: fieldsOf(summary.recent) },
	];
	return (
		<section aria-label="近期趋势证据" className="space-y-4 rounded-lg border bg-muted/30 p-3 text-sm">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="space-y-1">
					<p className="font-medium">近期样本指标 · {trend.word}</p>
					<p className="text-xs text-muted-foreground">平台需求词编号：{trend.wordId}</p>
				</div>
				<Badge variant={trend.qualified ? "secondary" : "outline"}>{trendOutcome(trend)}</Badge>
			</div>
			<dl className="grid gap-3 sm:grid-cols-2">
				<TrendValue label="数据口径" value={basis} />
				<TrendValue label="来源指标" value={`${trend.metric}（平台指标）`} />
				<TrendValue label="比较基准日" value={textValue(summary.asOfDate)} />
				<TrendValue label="最新有效日期" value={textValue(quality.latestValidDate)} />
				<TrendValue label="每个比较窗口" value={`${numberText(summary.windowDays)} 天`} />
				<TrendValue label="数据滞后" value={`${numberText(quality.lagDays)} 天`} />
			</dl>
			<div className="grid gap-3 sm:grid-cols-3">
				{windows.map(({ label, value }) => (
					<div key={label} className="space-y-2 rounded-md border bg-background p-3">
						<p className="text-xs font-medium">{label}</p>
						<p className="break-words text-xs leading-relaxed text-muted-foreground">
							{textValue(value.startDate)} 至 {textValue(value.endDate)}
						</p>
						<dl className="space-y-2">
							<TrendValue label={trend.basis === "daily" ? "日均值" : "观察均值"} value={numberText(value.mean)} />
							<TrendValue label="有效点数 / 窗口天数" value={`${numberText(value.validPoints)} / ${numberText(value.expectedDays)}`} />
						</dl>
					</div>
				))}
			</div>
			<dl className="grid gap-3 sm:grid-cols-3">
				<TrendValue label="最近窗口较前一窗口增长" value={numberText(summary.growthRate, true)} />
				<TrendValue label="前一窗口较更早窗口增长" value={numberText(summary.previousGrowthRate, true)} />
				<TrendValue label="各窗口去掉一个最大值后增长" value={numberText(withoutMaximum.growthRate, true)} />
			</dl>
			{trend.reasons.length > 0 ? <Notes title="初筛判定原因" values={trend.reasons} /> : <p className="text-xs text-muted-foreground">未返回具体判定原因。</p>}
			<p className="text-xs leading-relaxed text-muted-foreground">
				以上描述当前样本指标，样本成员变化也可能导致上升，不能证明台湾全市场成交增长或候选规格会成交，也不保证未来销量或盈利；仍需核对货源、差异和完整成本。
			</p>
			<details className="rounded-md border bg-background p-3">
				<summary className="cursor-pointer text-xs">查看原始趋势摘要（保留来源字段名）</summary>
				<pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed text-muted-foreground">
					{JSON.stringify(trend.summary, null, 2) ?? "未返回"}
				</pre>
			</details>
		</section>
	);
}

export function SavedReceipt({ receipt }: { receipt: NonNullable<Candidate["receipt"]> }) {
	return (
		<section aria-label="备选保存回执" className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
			<p className="font-medium">备选保存回执 · {receipt.status === "added" ? "本次新增" : "此前已存在"}</p>
			<p className="break-all leading-relaxed">
				备选编号 {receipt.sourceId} · 货源编号 {receipt.offerId}
			</p>
			{receipt.sourceCapturedAt && <p className="text-xs text-muted-foreground">货源资料读取时间：{receipt.sourceCapturedAt}</p>}
			{receipt.reusedSnapshot !== undefined && (
				<p className="text-xs text-muted-foreground">{receipt.reusedSnapshot ? "沿用已保存的货源资料" : "本次已读取货源资料"}</p>
			)}
		</section>
	);
}

export function EventEvidence({ event, events, workflow }: { event: RunEvent; events: RunEvent[]; workflow: string[] }) {
	const data = event.data;
	if (!data) return null;
	if (data.kind === "query") return <QueryEvidence index={data.queryFactIndex} fact={data.fact} />;
	if (data.kind === "analysis")
		return (
			<div className="space-y-3">
				{data.summary && data.summary !== event.message && <p className="whitespace-pre-wrap leading-relaxed">{data.summary}</p>}
				{data.audit && <BatchAuditView audit={data.audit} workflow={workflow} />}
				{data.research.length > 0 && (
					<details className="rounded-lg border p-3">
						<summary className="cursor-pointer">查看本批 {data.research.length} 个货源的研究判断</summary>
						<div className="mt-3 space-y-3">
							{data.research.map((research) => (
								<div key={`${research.offerId}-${research.skuId}`} className="space-y-2">
									<p className="text-xs text-muted-foreground">
										货源 {research.offerId} · 规格 {research.skuId}
									</p>
									<ResearchConclusionView research={research} events={events} />
								</div>
							))}
						</div>
					</details>
				)}
			</div>
		);
	if (data.kind === "tool")
		return (
			<details className="rounded-lg border p-3">
				<summary className="cursor-pointer">
					工具记录 · {data.tool} · {data.error ? "读取失败" : "已返回"}
				</summary>
				<div className="mt-3 space-y-3">
					<FactSection title="请求条件" value={data.input} />
					{data.error ? <p className="text-destructive">{data.error}</p> : <FactSection title="实际返回预览" value={data.result} />}
				</div>
			</details>
		);
	if (data.kind === "plan")
		return (
			<details className="rounded-lg border p-3">
				<summary className="cursor-pointer">查看第 {data.round} 轮研究计划</summary>
				<div className="mt-3">
					<FactPreview value={data.plan} />
				</div>
			</details>
		);
	return (
		<p className="text-xs leading-relaxed text-muted-foreground">
			{data.reason} · 本次新增 {data.added} · 此前已有 {data.existing}
		</p>
	);
}

function BatchAuditView({ audit, workflow }: { audit: BatchAudit; workflow: string[] }) {
	const labels = { supported: "有证据", partial: "仍有缺项", "not-applicable": "本批不适用" };
	return (
		<details className="rounded-lg border p-3">
			<summary className="cursor-pointer font-medium">本批步骤核对</summary>
			<div className="mt-3 space-y-4">
				<p className="text-xs text-muted-foreground">按本批事实核对已保存步骤；这份核对不代表每一步都曾单独调用工具。</p>
				{audit.steps.map((step) => (
					<div key={step.stepIndex} className="space-y-2">
						<p className="font-medium">
							{step.stepIndex}. {workflow[step.stepIndex - 1] ?? "研究步骤"} <Badge variant="outline">{labels[step.status]}</Badge>
						</p>
						<p className="whitespace-pre-wrap leading-relaxed">{step.conclusion}</p>
						{step.queryFactIndexes.length > 0 && <p className="text-xs text-muted-foreground">关联：{references(step.queryFactIndexes)}</p>}
						{step.offerIds.length > 0 && <p className="break-all text-xs text-muted-foreground">货源：{step.offerIds.join("、")}</p>}
						<Notes title="待补" values={step.missing} />
					</div>
				))}
				{audit.stopReason && <p className="leading-relaxed text-muted-foreground">停止理由：{audit.stopReason}</p>}
			</div>
		</details>
	);
}

function Notes({ title, values }: { title: string; values: string[] }) {
	return values.length > 0 ? (
		<div className="space-y-1">
			<p className="font-medium">{title}</p>
			<ul className="list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
				{[...new Set(values)].map((value) => (
					<li key={value}>{value}</li>
				))}
			</ul>
		</div>
	) : null;
}

function FactSection({ title, value }: { title: string; value: unknown }) {
	if (value === undefined) return null;
	return (
		<div className="space-y-1">
			<p className="text-xs font-medium">{title}</p>
			<FactPreview value={value} />
		</div>
	);
}

const fieldLabels: Record<string, string> = {
	keyword: "关键词",
	sourceKeyword: "货源词",
	categoryPath: "类目路径",
	role: "查询对象",
	focus: "重点",
	decision: "决定",
	explanation: "理由",
	queries: "查询",
	word: "词",
	hotWordId: "热词编号",
	searchVal: "搜索量",
	sales30day: "近30天销量",
	sales30Day: "近30天销量",
	itemId: "商品编号",
	itemDataList: "商品数据",
	title: "名称",
	offerId: "货源编号",
	price: "价格",
	stock: "库存",
	skuId: "规格编号",
	name: "名称",
	rows: "记录",
	data: "数据",
	status: "状态",
	problems: "待处理项",
	sourceId: "备选编号",
	updateTime: "数据更新时间",
};

/** 回包只做限量预览，省略明示；避免把大段原始数据铺满页面。 */
function FactPreview({ value, depth = 0 }: { value: unknown; depth?: number }) {
	if (value === null) return <span className="text-muted-foreground">未知</span>;
	if (value === undefined) return <span className="text-muted-foreground">未返回</span>;
	if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
	if (typeof value !== "object") {
		const text = String(value);
		return (
			<span className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
				{text.slice(0, 360)}
				{text.length > 360 && `…（省略 ${text.length - 360} 字）`}
			</span>
		);
	}
	const array = Array.isArray(value);
	const entries = array ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
	if (!entries.length) return <span className="text-muted-foreground">无记录</span>;
	if (depth >= 3)
		return (
			<span className="text-muted-foreground">
				{array ? "列表" : "字段组"}，共 {entries.length} 项（未展开）
			</span>
		);
	const shown = entries.slice(0, array ? 3 : 8);
	return (
		<div className="space-y-1 border-l pl-3">
			{shown.map(([key, item]) => (
				<div key={key} className="text-xs leading-relaxed">
					<span className="font-medium">{array ? `第 ${key} 项` : (fieldLabels[key] ?? key)}：</span>
					<FactPreview value={item} depth={depth + 1} />
				</div>
			))}
			{entries.length > shown.length && <p className="text-xs text-muted-foreground">另有 {entries.length - shown.length} 项未展开；此处为部分事实预览。</p>}
		</div>
	);
}
