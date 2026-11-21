import {
	ArrowDownRightIcon,
	ArrowUpRightIcon,
	CalendarDaysIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	ExternalLinkIcon,
	EyeIcon,
	PackageCheckIcon,
	RefreshCwIcon,
	ShieldAlertIcon,
	ShoppingBagIcon,
	UsersIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, Pie, PieChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type Item } from "../../api.ts";
import { errorOf } from "../../lib/state.ts";
import { chooseDate } from "./comparison.ts";
import { DailyProducts } from "./daily-products.tsx";
import { type Snapshot, snapshotSchema } from "./schema.ts";

const chartConfig = {
	visitors: { label: "独立访客", color: "var(--chart-3)" },
	clicks: { label: "商品点击", color: "var(--chart-3)" },
	paid: { label: "付款订单", color: "var(--chart-3)" },
} satisfies ChartConfig;
type Metric = keyof typeof chartConfig;
const metrics: Metric[] = ["visitors", "clicks", "paid"];
const fmt = new Intl.NumberFormat("zh-CN");
const shortDate = (date: string) => date.slice(5).replace("-", "/");
const observedAt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short", hourCycle: "h23" });

type Detail = "blocked" | "restriction";

function Change({ value }: { value: number }) {
	if (value === 0) return null;
	const Icon = value < 0 ? ArrowDownRightIcon : ArrowUpRightIcon;
	return (
		<Badge variant="secondary" className="gap-0.5 tabular-nums" title="虾皮卖家数据中心环比">
			<Icon aria-hidden="true" />
			{value < 0 ? "−" : "+"}
			{(Math.abs(value) * 100).toFixed(1)}%
		</Badge>
	);
}

function MetricCard({
	label,
	value,
	note,
	icon: Icon,
	change,
}: {
	label: string;
	value: number | null;
	note: string;
	icon: typeof EyeIcon;
	change?: number | null;
}) {
	return (
		<Card className="gap-1.5 [--card-spacing:--spacing(4)]">
			<CardHeader className="items-center">
				<CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
				<CardAction>
					<Icon className="size-4 text-muted-foreground" aria-hidden="true" />
				</CardAction>
			</CardHeader>
			<CardContent>
				<div className="flex flex-wrap items-center gap-2.5">
					<p className="text-[34px] leading-none font-semibold tracking-tight tabular-nums">{value === null ? "—" : fmt.format(value)}</p>
					{change != null && <Change value={change} />}
				</div>
				<p className="mt-1.5 text-sm text-muted-foreground">{note}</p>
			</CardContent>
		</Card>
	);
}

function Trend({ traffic, dates, onDate }: { traffic: Snapshot["traffic"]; dates: string[]; onDate: (date: string) => void }) {
	const gradient = useId();
	return (
		<Tabs defaultValue="visitors" className="min-w-0">
			<Card className="h-full gap-2 [--card-spacing:--spacing(4)]">
				<CardHeader className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle className="text-lg tracking-tight">流量趋势</CardTitle>
					<TabsList aria-label="流量指标" className="h-8">
						{metrics.map((metric) => (
							<TabsTrigger key={metric} value={metric} className="px-2.5 text-xs sm:text-sm">
								{chartConfig[metric].label}
							</TabsTrigger>
						))}
					</TabsList>
				</CardHeader>
				<CardContent className="grow pl-3">
					{metrics.map((metric) => (
						<TabsContent key={metric} value={metric}>
							<ChartContainer config={chartConfig} className="aspect-auto h-38 w-full">
								<AreaChart
									accessibilityLayer
									data={traffic.points}
									margin={{ top: 12, right: 23, bottom: 2, left: 0 }}
									onClick={({ activeLabel }) => {
										if (typeof activeLabel === "string") onDate(activeLabel);
									}}
								>
									<defs>
										<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
											<stop offset="0%" stopColor={`var(--color-${metric})`} stopOpacity={0.23} />
											<stop offset="100%" stopColor={`var(--color-${metric})`} stopOpacity={0.025} />
										</linearGradient>
									</defs>
									<CartesianGrid vertical={false} strokeDasharray="3 4" />
									<XAxis dataKey="date" hide height={0} />
									<YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} tickMargin={5} />
									<ChartTooltip content={<ChartTooltipContent labelFormatter={(date) => shortDate(String(date))} />} />
									<Area
										type="monotone"
										dataKey={metric}
										fill={`url(#${gradient})`}
										stroke={`var(--color-${metric})`}
										strokeWidth={2}
										dot={{ r: 2.5, strokeWidth: 0 }}
										isAnimationActive={false}
									/>
								</AreaChart>
							</ChartContainer>
						</TabsContent>
					))}
					<fieldset className="mt-1.5 mr-[3px] ml-3 flex min-w-0 justify-between border-0 p-0" aria-label="趋势图日期">
						{traffic.points.map(({ date }) => {
							const selected = dates.includes(date);
							return (
								<Button
									key={date}
									variant={selected ? "secondary" : "ghost"}
									size="xs"
									type="button"
									className={`w-10 max-w-[14%] cursor-pointer px-0 tabular-nums ${selected ? "ring-1 ring-foreground/30" : "text-muted-foreground"}`}
									aria-label={date}
									aria-pressed={selected}
									onClick={() => onDate(date)}
								>
									{shortDate(date)}
								</Button>
							);
						})}
					</fieldset>
					<p className="px-1 pt-1 text-xs text-muted-foreground">{dates.length === 1 ? "再选一天对比商品" : "点日期查看商品，可选两天对比"}</p>
				</CardContent>
			</Card>
		</Tabs>
	);
}

function Availability({ data, onInspect }: { data: Snapshot; onInspect: (detail: Detail) => void }) {
	const { products, restriction } = data;
	const statuses = [
		{ key: "inStock", label: "有库存在售", value: products.inStock, fill: "var(--chart-3)" },
		{ key: "blocked", label: "禁卖", value: products.blocked.length, fill: "var(--destructive)" },
		{ key: "review", label: "审核中", value: products.review, fill: "var(--chart-4)" },
		{ key: "outOfStock", label: "在售缺货", value: products.outOfStock, fill: "var(--chart-2)" },
	];
	if (products.unknownStock > 0) statuses.push({ key: "unknown", label: "库存未知", value: products.unknownStock, fill: "var(--muted-foreground)" });
	const config = Object.fromEntries(statuses.map(({ key, label, fill }) => [key, { label, color: fill }])) satisfies ChartConfig;
	return (
		<Card className="gap-3 [--card-spacing:--spacing(4)]">
			<CardHeader>
				<CardTitle className="text-lg tracking-tight">商品可售状态</CardTitle>
				<CardAction>
					<PackageCheckIcon className="mt-1 size-4 text-muted-foreground" aria-hidden="true" />
				</CardAction>
			</CardHeader>
			<CardContent className="grid flex-1 content-between gap-3">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4">
					<div className="relative mx-auto w-full max-w-38">
						<ChartContainer config={config} className="aspect-square w-full">
							<PieChart accessibilityLayer>
								<ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="key" hideLabel />} />
								<Pie
									data={statuses}
									dataKey="value"
									nameKey="label"
									innerRadius="76%"
									outerRadius="97%"
									stroke="none"
									startAngle={90}
									endAngle={-270}
									isAnimationActive={false}
								/>
							</PieChart>
						</ChartContainer>
						<div className="pointer-events-none absolute inset-0 grid content-center justify-items-center gap-0.5">
							<span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{fmt.format(products.inStock)}</span>
							<span className="text-xs text-muted-foreground">有库存在售</span>
						</div>
					</div>
					<dl className="grid gap-3">
						{statuses.map((status) => (
							<div key={status.key} className="flex items-center justify-between gap-2">
								<dt className="flex items-center gap-2 text-muted-foreground">
									<span
										className="size-2 shrink-0 rounded-full"
										style={{ backgroundColor: status.value ? status.fill : "var(--muted-foreground)", opacity: status.value ? 1 : 0.3 }}
									/>
									{status.key === "blocked" && status.value > 0 ? (
										<Button variant="link" className="h-auto p-0 text-inherit" onClick={() => onInspect("blocked")}>
											{status.label} <ChevronRightIcon aria-hidden="true" className="size-3" />
										</Button>
									) : (
										status.label
									)}
								</dt>
								<dd className="font-medium tabular-nums">{fmt.format(status.value)}</dd>
							</div>
						))}
					</dl>
				</div>
				<Button variant="ghost" className="h-auto w-full justify-between gap-2 rounded-lg border py-2.5 text-left" onClick={() => onInspect("restriction")}>
					<span className="flex items-center gap-2 font-medium">
						<ShieldAlertIcon className="size-4 text-muted-foreground" aria-hidden="true" /> 店铺级限流
					</span>
					<span className="flex shrink-0 items-center gap-1.5">
						<Badge variant={restriction.status === "confirmed" ? "destructive" : "outline"}>{restriction.status === "confirmed" ? "已核实" : "未核实"}</Badge>
						<ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
					</span>
				</Button>
			</CardContent>
		</Card>
	);
}

function Evidence({ data, detail, close }: { data: Snapshot; detail: Detail | null; close: () => void }) {
	const blocked = detail === "blocked";
	return (
		<Dialog
			open={detail !== null}
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="max-h-[80vh] overflow-y-auto p-6 sm:max-w-lg">
				<DialogHeader className="pr-6">
					<DialogTitle className="text-lg">{blocked ? `禁卖商品 ${fmt.format(data.products.blocked.length)} 款` : "店铺级限流"}</DialogTitle>
					<DialogDescription>{blocked ? "禁卖状态来自虾皮商品目录。具体原因和处理期限以卖家中心为准。" : data.restriction.evidence}</DialogDescription>
				</DialogHeader>
				{blocked && (
					<ul className="divide-y">
						{data.products.blocked.map((product) => (
							<li key={product.id} className="flex items-center gap-3 py-2.5">
								<span className="min-w-0 flex-1 truncate" title={product.name}>
									{product.name}
								</span>
								<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{product.id}</span>
							</li>
						))}
					</ul>
				)}
				<a
					className="inline-flex w-fit items-center gap-2 font-medium underline underline-offset-4"
					href="https://seller.shopee.tw/"
					target="_blank"
					rel="noreferrer"
				>
					打开虾皮卖家中心 <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
				</a>
			</DialogContent>
		</Dialog>
	);
}

export function View({ item }: { item: Item }) {
	const [detail, setDetail] = useState<Detail | null>(null);
	const [data, setData] = useState<Snapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = item.id;
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		void api
			.act(id, "snapshot")
			.then((raw) => {
				if (active) setData(snapshotSchema.nullable().parse(raw));
			})
			.catch((failure: unknown) => {
				if (active) setError(errorOf(failure));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [id]);
	async function refresh() {
		setRefreshing(true);
		setError(null);
		try {
			setData(snapshotSchema.parse(await api.act(id, "refresh")));
			toast.success("店铺数据已更新");
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setRefreshing(false);
		}
	}
	return (
		<div className="@container mx-auto grid max-w-321 gap-4 px-4 py-5 sm:px-6 lg:px-8">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-3xl font-semibold tracking-tight">店铺监控</h2>
				<div className="flex flex-wrap items-center gap-2.5 text-sm text-muted-foreground">
					{data && (
						<>
							<time dateTime={data.capturedAt}>更新于 {observedAt.format(new Date(data.capturedAt))}</time>
							<Badge variant="outline" className="h-7 rounded-lg bg-card px-2.5 text-xs tabular-nums">
								<CalendarDaysIcon aria-hidden="true" /> {shortDate(data.start)} – {shortDate(data.end)}
							</Badge>
						</>
					)}
					<Button variant="outline" disabled={loading || refreshing} onClick={refresh}>
						<RefreshCwIcon aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
						{refreshing ? "刷新中…" : "刷新数据"}
					</Button>
				</div>
			</header>
			{error && (
				<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
					<CircleAlertIcon className="size-4" />
					{data ? "刷新失败，继续显示上次数据。" : "获取店铺数据失败。"} {error}
				</p>
			)}
			{data ? (
				<Dashboard data={data} item={id} detail={detail} setDetail={setDetail} />
			) : loading ? (
				<Skeleton className="h-96 w-full" />
			) : (
				!error && <p>暂无店铺数据，点击「刷新数据」采集。</p>
			)}
		</div>
	);
}

function Dashboard({ data, item, detail, setDetail }: { data: Snapshot; item: string; detail: Detail | null; setDetail: (value: Detail | null) => void }) {
	const [selected, setSelected] = useState<string[]>([]);
	const available = new Set(data.traffic.points.map((point) => point.date));
	const dates = selected.filter((date) => available.has(date));
	const active = data.products.inStock + data.products.outOfStock + data.products.unknownStock;
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-3">
				<MetricCard label="店铺独立访客" value={data.traffic.visitors.total} note="虾皮报表环比" change={data.traffic.visitors.change} icon={UsersIcon} />
				<MetricCard
					label="在售商品卡曝光"
					value={data.products.impressions}
					note={`报表覆盖 ${fmt.format(data.products.reported)} / ${fmt.format(active)} 款`}
					icon={EyeIcon}
				/>
				<MetricCard label="付款订单" value={data.traffic.paid.total} note={`确认订单 ${fmt.format(data.traffic.confirmed)} 笔`} icon={ShoppingBagIcon} />
			</div>
			<div className="grid gap-4 @min-[740px]:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
				<Trend
					traffic={data.traffic}
					dates={dates}
					onDate={(date) => {
						if (available.has(date))
							setSelected((previous) =>
								chooseDate(
									previous.filter((value) => available.has(value)),
									date,
								),
							);
					}}
				/>
				<Availability data={data} onInspect={setDetail} />
			</div>
			{dates.length > 0 && <DailyProducts item={item} shopId={data.shopId} stamp={data.capturedAt} dates={dates} onClear={() => setSelected([])} />}
			<Evidence data={data} detail={detail} close={() => setDetail(null)} />
		</>
	);
}
