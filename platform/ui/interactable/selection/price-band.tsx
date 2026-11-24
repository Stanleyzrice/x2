import { type ReactNode, useId, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorOf } from "@/lib/state";
import { api } from "../../api.ts";
import { type PriceBandCategory, type PriceBandResult, type PriceBandSource, pricePosition, summarizePriceBand } from "./price-band-data.ts";

const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const money = (price: number) => `NT$${number.format(price)}`;
const percent = (value: number | null) => (value === null ? "—" : `${number.format(value)}%`);
const chartConfig = {
	itemShare: { label: "样本商品占比", color: "var(--chart-1)" },
	salesShare: { label: "近30天销量占比", color: "var(--chart-2)" },
};

export function PriceBand({ itemId }: { itemId: string }) {
	const id = useId();
	const [categories, setCategories] = useState<PriceBandCategory[] | null>(null);
	const [path, setPath] = useState("");
	const [keyword, setKeyword] = useState("");
	const [spec, setSpec] = useState("");
	const [price, setPrice] = useState("");
	const [result, setResult] = useState<PriceBandResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function readCategories() {
		setBusy(true);
		setError(null);
		try {
			setCategories(await api.act<PriceBandCategory[]>(itemId, "price-band-categories"));
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setBusy(false);
		}
	}

	async function query(term: string, wordId?: number) {
		if (!path || !term.trim() || busy) return;
		setKeyword(term);
		setResult(null);
		setBusy(true);
		setError(null);
		try {
			setResult(await api.act<PriceBandResult>(itemId, "price-band", { path: path.split(",").map(Number), keyword: term, wordId }));
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setBusy(false);
		}
	}

	const ownPrice = /^\d+(?:\.\d{1,2})?$/.test(price) && Number(price) > 0 && Number.isFinite(Number(price)) ? Number(price) : null;
	return (
		<Card>
			<CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
				<CardTitle>商品价格带</CardTitle>
				<span className="text-xs text-muted-foreground">知虾 · 台湾站 · 近30天</span>
			</CardHeader>
			<CardContent className="space-y-4">
				{categories ? (
					<form
						className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[1.3fr_1.45fr_1fr_0.8fr]"
						onSubmit={(event) => {
							event.preventDefault();
							void query(keyword);
						}}
					>
						<div className="min-w-0 space-y-1.5">
							<Label htmlFor={`${id}-category`}>类目</Label>
							<select
								id={`${id}-category`}
								className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm focus-visible:outline-ring"
								disabled={busy}
								value={path}
								onChange={(event) => {
									setPath(event.target.value);
									setResult(null);
								}}
							>
								<option value="">请选择知虾类目</option>
								{categories.map((category) => (
									<option key={category.path.join(",")} value={category.path.join(",")}>
										{category.name}
									</option>
								))}
							</select>
						</div>
						<div className="min-w-0 space-y-1.5">
							<Label htmlFor={`${id}-keyword`}>关键词</Label>
							<div className="flex items-center gap-2">
								<Input
									id={`${id}-keyword`}
									placeholder="例如 硅藻泥地垫"
									maxLength={120}
									disabled={busy}
									value={keyword}
									onChange={(event) => {
										setKeyword(event.target.value);
										setResult(null);
									}}
								/>
								<Button size="sm" type="submit" disabled={busy || !path || !keyword.trim()}>
									{busy ? "正在读取知虾" : "查询"}
								</Button>
							</div>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-spec`}>可比规格（标题包含）</Label>
							<Input id={`${id}-spec`} placeholder="例如 40×60，选填" maxLength={80} value={spec} onChange={(event) => setSpec(event.target.value)} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-price`}>本品售价（NT$）</Label>
							<Input
								id={`${id}-price`}
								inputMode="decimal"
								placeholder="例如 199，选填"
								maxLength={12}
								value={price}
								aria-invalid={!!price && ownPrice === null}
								onChange={(event) => setPrice(event.target.value)}
							/>
						</div>
					</form>
				) : (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void readCategories()}>
						{busy ? "正在读取知虾" : "读取知虾类目"}
					</Button>
				)}
				{error && (
					<div role="alert" className="space-y-2 text-sm">
						<p className="text-destructive">{error}</p>
						<Button variant="link" className="h-auto p-0" render={<a href="https://shopee.mobduos.com/workbench/home" target="_blank" rel="noreferrer" />}>
							打开知虾工作台
						</Button>
					</div>
				)}
				{result?.kind === "words" && (
					<div className="space-y-2 text-sm">
						<p className="text-muted-foreground">{result.words.length ? "请选择对应的知虾关键词" : "该类目的热搜词中未找到匹配，请调整类目或关键词。"}</p>
						<div className="flex flex-wrap gap-2">
							{result.words.map((word) => (
								<Button
									key={word.hotWordId}
									size="sm"
									variant="outline"
									className="h-auto max-w-full whitespace-normal"
									onClick={() => void query(word.word, word.hotWordId)}
								>
									{word.word}
								</Button>
							))}
						</div>
					</div>
				)}
				{result?.kind === "samples" && <Distribution source={result} spec={spec} ownPrice={ownPrice} />}
			</CardContent>
		</Card>
	);
}

function Distribution({ source, spec, ownPrice }: { source: PriceBandSource; spec: string; ownPrice: number | null }) {
	const { bands, items, mainBand } = useMemo(() => summarizePriceBand(source, spec), [source, spec]);
	const position =
		ownPrice === null
			? null
			: pricePosition(
					bands.map(({ price }) => price),
					ownPrice,
				);
	const ownBand = position?.exact ? bands[position.index] : undefined;
	const gap = ownBand?.salesShare == null ? null : ownBand.salesShare - ownBand.itemShare;
	const index = position?.index ?? 0;
	const start = Math.max(0, Math.min(index - 1, bands.length - 3));
	const nearby = bands.slice(start, start + 3);
	const priceLabel = position?.exact
		? `第 ${index + 1} / ${bands.length} 个价位`
		: index === 0
			? "低于样本价位"
			: index === bands.length
				? "高于样本价位"
				: `位于 ${money(bands[index - 1]!.price)} 与 ${money(bands[index]!.price)} 之间`;
	const points = bands.map(({ label, itemShare, salesShare }) => ({ label, itemShare: itemShare as number | null, salesShare }));
	if (position && !position.exact) points.splice(index, 0, { label: String(ownPrice), itemShare: null, salesShare: null });
	return (
		<section aria-label="价格带分析" className="space-y-3">
			<p className="text-xs tabular-nums text-muted-foreground">
				{source.keyword} · {source.date ? `快照 ${source.date}` : "暂无有日期的销量快照"} · 读到 {source.received} 款 · 同日有效 {source.dated} 款 · 纳入{" "}
				{items} 款
			</p>
			{!bands.length ? (
				<p className="py-5 text-sm text-muted-foreground">当前条件下没有可用的单一标价样本。</p>
			) : (
				<>
					<ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
						<ComposedChart accessibilityLayer data={points} margin={{ top: ownPrice === null ? 5 : 22, right: 18 }}>
							<CartesianGrid vertical={false} />
							<XAxis dataKey="label" tickLine={false} minTickGap={15} />
							<YAxis
								width={48}
								tickLine={false}
								tickFormatter={(value: number) => `${value}%`}
								domain={[0, (max: number) => Math.min(100, Math.max(10, Math.ceil(max / 10) * 10))]}
							/>
							<ChartLegend verticalAlign="top" content={<ChartLegendContent className="pb-5" />} />
							<ChartTooltip
								content={
									<ChartTooltipContent
										labelFormatter={(value: ReactNode) => (typeof value === "string" || typeof value === "number" ? money(Number(value)) : value)}
										formatter={(value, name) => (
											<span>
												{String(name)} · {percent(Number(value))}
											</span>
										)}
									/>
								}
							/>
							{mainBand && (
								<ReferenceArea x1={String(mainBand.lower)} x2={String(mainBand.upper)} fill="var(--muted-foreground)" fillOpacity={0.14} strokeOpacity={0} />
							)}
							<Bar dataKey="itemShare" name={chartConfig.itemShare.label} fill="var(--color-itemShare)" maxBarSize={56} isAnimationActive={false} />
							<Line
								dataKey="salesShare"
								name={chartConfig.salesShare.label}
								stroke="var(--color-salesShare)"
								strokeWidth={2}
								dot={points.length <= 35}
								connectNulls
								isAnimationActive={false}
							/>
							{ownPrice !== null && (
								<ReferenceLine
									x={String(ownPrice)}
									stroke="var(--foreground)"
									strokeDasharray="4 3"
									label={{ value: `本品 ${money(ownPrice)}`, position: "top", fill: "var(--foreground)", fontSize: 11 }}
								/>
							)}
						</ComposedChart>
					</ChartContainer>
					<p className="text-center text-xs text-muted-foreground">商品标价（NT$，从低到高）</p>
					<dl className="grid gap-3 border-y py-3 sm:grid-cols-3 sm:divide-x">
						<div className="space-y-1 sm:pr-3">
							<dt className="text-muted-foreground">主力价带</dt>
							<dd className="text-lg font-semibold tabular-nums">
								{mainBand ? `${money(mainBand.lower)}${mainBand.lower === mainBand.upper ? "" : `–${number.format(mainBand.upper)}`}` : "—"}
							</dd>
							<dd className="text-xs text-muted-foreground">按销量加权的中间价位</dd>
						</div>
						<div className="space-y-1 sm:px-3">
							<dt className="text-muted-foreground">本品价位</dt>
							<dd className="text-lg font-semibold tabular-nums">{ownPrice === null ? "—" : money(ownPrice)}</dd>
							{position && <dd className="text-xs text-muted-foreground">{priceLabel}</dd>}
						</div>
						<div className="space-y-1 sm:pl-3">
							<dt className="text-muted-foreground">销量占比 − 商品占比</dt>
							<dd className="text-lg font-semibold tabular-nums">{gap === null ? "—" : `${gap > 0 ? "+" : ""}${number.format(gap)} 个百分点`}</dd>
						</div>
					</dl>
					{position && (
						<div className="space-y-2">
							<h3 className="font-medium">相邻价位对比</h3>
							<Table className="tabular-nums">
								<TableHeader>
									<TableRow>
										<TableHead>标价</TableHead>
										<TableHead>样本商品数</TableHead>
										<TableHead>销量占比</TableHead>
										<TableHead>动销率</TableHead>
										<TableHead>前3店铺销量占比</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{nearby.map((row) => (
										<TableRow key={row.price} className={row.price === ownPrice ? "bg-muted font-semibold" : undefined}>
											<TableCell>{money(row.price)}</TableCell>
											<TableCell>{number.format(row.items)} 款</TableCell>
											<TableCell>{percent(row.salesShare)}</TableCell>
											<TableCell>{percent(row.sellingRate)}</TableCell>
											<TableCell>
												<div className="flex items-center gap-3">
													<span>{percent(row.topShopShare)}</span>
													{row.topShopShare !== null && (
														<div aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-muted-foreground/20">
															<div className="h-full bg-chart-2" style={{ width: `${row.topShopShare}%` }} />
														</div>
													)}
												</div>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</>
			)}
			<p className="text-xs text-muted-foreground">仅统计同日且只有一个标价的样本商品。在售状态、支付金额和支付买家口径待核实。</p>
		</section>
	);
}
