import { Combobox } from "@base-ui/react/combobox";
import { ChevronsUpDownIcon } from "lucide-react";
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
import { readCache } from "../../read-cache.ts";
import { type PriceBandCategory, type PriceBandSource, type PriceBandWord, pricePosition, summarizePriceBand } from "./price-band-data.ts";

const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const money = (price: number) => `NT$${number.format(price)}`;
const percent = (value: number | null) => (value === null ? "—" : `${number.format(value)}%`);
const chartConfig = {
	itemShare: { label: "样本商品占比", color: "var(--chart-1)" },
	salesShare: { label: "近30天销量占比", color: "var(--chart-2)" },
};

function SearchChoice<T extends { searchKey?: string }>({
	id,
	items,
	value,
	label,
	itemKey,
	placeholder,
	empty,
	loading,
	disabled,
	onOpen,
	onSelect,
}: {
	id: string;
	items: T[];
	value: T | null;
	label: (item: T) => string;
	itemKey: (item: T) => string | number;
	placeholder: string;
	empty: string;
	loading: boolean;
	disabled: boolean;
	onOpen: () => void;
	onSelect: (item: T | null) => void;
}) {
	return (
		<Combobox.Root<T>
			items={items}
			value={value}
			itemToStringLabel={label}
			isItemEqualToValue={(item, selected) => itemKey(item) === itemKey(selected)}
			filter={(item, query) =>
				query
					.normalize("NFKC")
					.trim()
					.toLowerCase()
					.split(/\s+/)
					.every((token) => label(item).toLowerCase().includes(token) || item.searchKey?.includes(token))
			}
			limit={50}
			autoHighlight
			openOnInputClick
			disabled={disabled}
			onOpenChange={(open) => {
				if (open) onOpen();
			}}
			onValueChange={onSelect}
		>
			<div className="relative">
				<Combobox.Input id={id} render={<Input className="pr-8" />} placeholder={placeholder} onFocus={(event) => event.currentTarget.select()} />
				<Combobox.Trigger aria-label={placeholder} className="absolute inset-y-0 right-0 grid w-8 place-items-center rounded-r-lg text-muted-foreground">
					<ChevronsUpDownIcon className="size-4" />
				</Combobox.Trigger>
			</div>
			<Combobox.Portal>
				<Combobox.Positioner sideOffset={5} className="z-50">
					<Combobox.Popup className="w-(--anchor-width) min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
						<Combobox.Empty className="px-2 py-2 text-sm text-muted-foreground">{loading ? "正在读取知虾…" : empty}</Combobox.Empty>
						<Combobox.List className="max-h-72 overflow-auto">
							{(item: T) => (
								<Combobox.Item
									key={itemKey(item)}
									value={item}
									className="cursor-pointer rounded-md px-2 py-1.5 text-sm data-highlighted:bg-accent data-highlighted:text-accent-foreground"
								>
									{label(item)}
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

export function PriceBand({ itemId }: { itemId: string }) {
	const id = useId();
	const [categories, setCategories] = useState<PriceBandCategory[] | null>(null);
	const [category, setCategory] = useState<PriceBandCategory | null>(null);
	const [words, setWords] = useState<PriceBandWord[] | null>(null);
	const [word, setWord] = useState<PriceBandWord | null>(null);
	const [spec, setSpec] = useState("");
	const [price, setPrice] = useState("");
	const [result, setResult] = useState<PriceBandSource | null>(null);
	const [pending, setPending] = useState<"categories" | "words" | "analysis" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [wordCache] = useState(() => readCache<PriceBandWord[]>());

	async function load<T>(stage: NonNullable<typeof pending>, request: () => Promise<T>, receive: (value: T) => void) {
		if (pending) return;
		setPending(stage);
		setError(null);
		try {
			receive(await request());
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setPending(null);
		}
	}

	function analyze(selected: PriceBandWord | null) {
		if (pending) return;
		setWord(selected);
		setResult(null);
		if (!category || !selected) return;
		void load(
			"analysis",
			() => api.act<PriceBandSource>(itemId, "price-band", { path: category.path, keyword: selected.word, wordId: selected.hotWordId }),
			setResult,
		);
	}

	const ownPrice = /^\d+(?:\.\d{1,2})?$/.test(price) && Number(price) > 0 && Number.isFinite(Number(price)) ? Number(price) : null;
	return (
		<Card>
			<CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
				<CardTitle>商品价格带</CardTitle>
				<span className="text-xs text-muted-foreground">知虾 · 台湾站 · 近30天</span>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[1.3fr_1.45fr_1fr_0.8fr]">
					<div className="min-w-0 space-y-1.5">
						<Label htmlFor={`${id}-category`}>类目</Label>
						<SearchChoice
							id={`${id}-category`}
							items={categories ?? []}
							value={category}
							label={(item) => item.name}
							itemKey={(item) => item.path.join(",")}
							placeholder="搜索类目，如软件"
							empty={categories ? "没有匹配的类目" : "暂未读到类目"}
							loading={pending === "categories"}
							disabled={pending === "words" || pending === "analysis"}
							onOpen={() => {
								if (!categories) void load("categories", () => api.act<PriceBandCategory[]>(itemId, "price-band-categories"), setCategories);
							}}
							onSelect={(selected) => {
								setCategory(selected);
								setWords(null);
								setWord(null);
								setResult(null);
								setError(null);
							}}
						/>
					</div>
					<div className="min-w-0 space-y-1.5">
						<Label htmlFor={`${id}-keyword`}>关键词</Label>
						<SearchChoice
							id={`${id}-keyword`}
							items={words ?? []}
							value={word}
							label={(item) => item.word}
							itemKey={(item) => item.hotWordId}
							placeholder={category ? "搜索或选择知虾热词" : "请先选类目"}
							empty={words ? "该类目的热词里没有匹配" : "暂未读到热词"}
							loading={pending === "words"}
							disabled={!category || pending === "analysis"}
							onOpen={() => {
								if (category && !words)
									void load(
										"words",
										() => wordCache.read(category.path.join(","), () => api.act<PriceBandWord[]>(itemId, "price-band-words", { path: category.path })),
										setWords,
									);
							}}
							onSelect={analyze}
						/>
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
				</div>
				{pending === "analysis" && (
					<p className="text-sm text-muted-foreground" role="status">
						正在读取「{word?.word}」的竞品数据…
					</p>
				)}
				{error && (
					<div role="alert" className="space-y-2 text-sm">
						<p className="text-destructive">{error}</p>
						<div className="flex flex-wrap gap-2">
							{word && (
								<Button variant="link" className="h-auto p-0" onClick={() => analyze(word)}>
									重新查询
								</Button>
							)}
							<Button variant="link" className="h-auto p-0" render={<a href="https://shopee.mobduos.com/workbench/home" target="_blank" rel="noreferrer" />}>
								打开知虾工作台
							</Button>
						</div>
					</div>
				)}
				{result && <Distribution source={result} spec={spec} ownPrice={ownPrice} />}
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
	const index = position?.index ?? bands.reduce((best, row, i) => (row.sales > (bands[best]?.sales ?? 0) ? i : best), 0);
	const comparisonPrice = ownPrice ?? bands[index]?.price;
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
					<div className="space-y-2">
						<div className="flex flex-wrap items-baseline gap-2">
							<h3 className="font-medium">相邻价位对比</h3>
							{!position && !!bands[index]?.sales && <span className="text-xs text-muted-foreground">默认对比销量最高价位附近</span>}
						</div>
						<Table className="tabular-nums">
							<TableHeader>
								<TableRow>
									<TableHead>标价</TableHead>
									<TableHead>样本商品数</TableHead>
									<TableHead>近30天销量</TableHead>
									<TableHead>销量占比</TableHead>
									<TableHead>动销率</TableHead>
									<TableHead>前3店铺销量占比</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{nearby.map((row) => (
									<TableRow key={row.price} className={row.price === comparisonPrice ? "bg-muted font-semibold" : undefined}>
										<TableCell>{money(row.price)}</TableCell>
										<TableCell>{number.format(row.items)} 款</TableCell>
										<TableCell>{number.format(row.sales)} 件</TableCell>
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
				</>
			)}
			<p className="text-xs text-muted-foreground">仅统计同日且只有一个标价的样本商品。销量未按渠道拆分。在售状态、支付金额和支付买家口径待核实。</p>
		</section>
	);
}
