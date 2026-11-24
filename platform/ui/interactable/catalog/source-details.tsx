// 备选商品沿用 Catalog 的可调宽度详情面板、图片浏览和详情内容；人工补充只写覆盖字段，原始采集快照保留。
import { ArrowUpRightIcon, LoaderCircleIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type Item, usePoll } from "../../api.ts";
import { ResizableSheetContent } from "../../resizable-sheet.tsx";
import { DetailImage, DetailsContent } from "./details-content.tsx";
import { SourceImageTranslation } from "./source-image-translation.tsx";
import type { SourceDetail, SourceFields } from "./source-types.ts";

const platformName = (_platform: SourceDetail["platform"]) => "1688";
const price = (value: number | null) => (value === null ? "未取得" : `¥${value.toFixed(2)}`);

export function SourceSheet({
	sourceId,
	targetShop,
	item,
	onClose,
	onSaved,
}: {
	sourceId: string | null;
	targetShop: string;
	item: Item;
	onClose: () => void;
	onSaved: () => void;
}) {
	const input = { sourceId: sourceId ?? "", targetShop };
	const [detail, error, reload] = usePoll(
		() => (sourceId ? api.sourceDetail(item.id, input, true) : Promise.resolve(null)),
		10_000,
		[item.id, sourceId, targetShop],
		sourceId ? api.peekSourceDetail(item.id, input) : null,
	);
	const current = detail?.id === sourceId ? detail : null;
	return (
		<Sheet open={sourceId !== null} onOpenChange={(open) => !open && onClose()}>
			<ResizableSheetContent storageKey="x2-source-detail-width" defaultWidth={800}>
				<SheetHeader className="border-b">
					<SheetTitle>备选商品详情</SheetTitle>
					<SheetDescription>货源原文、原图与上架资料</SheetDescription>
				</SheetHeader>
				{error ? (
					<p role="alert" className="p-6 text-sm text-destructive">
						{error}
					</p>
				) : current ? (
					<DetailBody
						key={`${current.id}:${targetShop}`}
						detail={current}
						item={item}
						targetShop={targetShop}
						saved={() => {
							api.invalidateSources();
							reload();
							onSaved();
						}}
					/>
				) : (
					<Skeleton className="m-6 h-80" />
				)}
			</ResizableSheetContent>
		</Sheet>
	);
}

function DetailBody({ detail, item, targetShop, saved }: { detail: SourceDetail; item: Item; targetShop: string; saved: () => void }) {
	const [tab, setTab] = useState("specs");
	const main = detail.selectedMain;
	const images = [...new Set([...main, ...detail.skus.map((sku) => sku.image).filter((src): src is string => Boolean(src))])];
	const lightbox = useLightbox(
		images.map((src, index) => ({ src, alt: `商品原图 ${index + 1}`, label: `${platformName(detail.platform)} · 商品原图 ${index + 1}` })),
	);
	return (
		<div className="space-y-6 p-5 sm:p-6">
			<div className="flex flex-wrap items-start gap-5">
				{main[0] && (
					<div className="w-52 space-y-2">
						<DetailImage src={main[0]} label="商品主图" open={() => lightbox.open(0)} />
						<div className="flex gap-2 overflow-x-auto">
							{main.slice(1, 4).map((src) => (
								<div key={src} className="shrink-0">
									<DetailImage src={src} label="商品主图" open={() => lightbox.open(images.indexOf(src))} thumbnail />
								</div>
							))}
						</div>
					</div>
				)}
				<div className="min-w-48 flex-1 space-y-3">
					<h3 className="text-lg font-semibold">{detail.title || "未取得商品标题"}</h3>
					<div className="flex flex-wrap items-center gap-3">
						<Badge variant="outline">{platformName(detail.platform)}</Badge>
						<a href={detail.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
							打开货源链接
							<ArrowUpRightIcon className="size-4" />
						</a>
					</div>
					{detail.editedAt && <Badge variant="secondary">已人工编辑</Badge>}
					{!detail.productId && detail.status !== "unknown" && (
						<Button size="sm" variant="outline" onClick={() => setTab("fields")}>
							编辑上架资料
						</Button>
					)}
					{[...detail.errors, ...detail.problems].map((problem) => (
						<p key={problem} className="text-xs text-muted-foreground">
							{problem}
						</p>
					))}
				</div>
			</div>
			{detail.research?.some((record) => record.shop === targetShop) && (
				<section className="space-y-3 rounded-xl border bg-muted/20 p-4">
					<div className="flex items-center justify-between gap-3">
						<h4 className="text-sm font-semibold">选品依据</h4>
						<a href="#strategy-selection" className="text-xs underline underline-offset-4">
							查看研究记录
						</a>
					</div>
					{detail.research
						.filter((record) => record.shop === targetShop)
						.map((record) => (
							<div key={`${record.runId}:${record.strategyId}`} className="space-y-2 text-sm">
								<Badge variant="outline">{record.strategyName}</Badge>
								<p className="whitespace-pre-wrap break-words leading-relaxed">{record.reason}</p>
								<details className="text-xs text-muted-foreground">
									<summary className="cursor-pointer">查看需求、竞争与货源证据</summary>
									<p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{record.evidence}</p>
								</details>
							</div>
						))}
				</section>
			)}
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList variant="line" className="border-b">
					<TabsTrigger value="specs">规格</TabsTrigger>
					<TabsTrigger value="content">上架图文</TabsTrigger>
					<TabsTrigger value="fields">编辑上架资料</TabsTrigger>
					{!detail.productId && detail.status !== "unknown" && <TabsTrigger value="translation">翻译图片</TabsTrigger>}
				</TabsList>
				<TabsContent value="specs" className="pt-4">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>规格图</TableHead>
								<TableHead>规格</TableHead>
								<TableHead>采购价 CNY（人民币）</TableHead>
								<TableHead>上架售价 TWD（新台币）</TableHead>
								<TableHead>库存</TableHead>
								<TableHead>重量 kg（千克）</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{detail.skus.map((sku) => (
								<TableRow key={sku.id}>
									<TableCell>
										{sku.image && !detail.fields.hiddenSkuImages?.includes(sku.image) ? (
											<DetailImage src={sku.image} label={sku.name || "规格图"} open={() => lightbox.open(images.indexOf(sku.image!))} thumbnail />
										) : (
											<span className="text-xs text-muted-foreground">未提供</span>
										)}
									</TableCell>
									<TableCell>
										<p>{detail.skuNames[sku.id] || sku.name || sku.attrs.join(" / ") || "单一规格"}</p>
										<p className="mt-1 text-xs text-muted-foreground">{sku.id}</p>
									</TableCell>
									<TableCell>{price(detail.fields.prices?.[sku.id] ?? sku.price)}</TableCell>
									<TableCell>{detail.salePrices[sku.id] == null ? "待核价" : `NT$${detail.salePrices[sku.id]}`}</TableCell>
									<TableCell>{sku.stock ?? "未取得"}</TableCell>
									<TableCell>{detail.fields.weightsKg?.[sku.id] ?? sku.weightKg ?? "未取得"}</TableCell>
								</TableRow>
							))}
							{!detail.skus.length && (
								<TableRow>
									<TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
										尚未取得规格，请在采购平台确认商品详情已完整加载。
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</TabsContent>
				<TabsContent value="content" className="pt-5">
					<DetailsContent
						product={{
							productImages: main,
							description: {
								blocks:
									detail.fields.description !== undefined || detail.fields.detailImages !== undefined || detail.listingDescription !== detail.description.text
										? [{ type: "text", text: detail.listingDescription }, ...detail.selectedDetail.map((src) => ({ type: "image" as const, src }))]
										: detail.description.blocks.filter((block) => block.type !== "image" || detail.selectedDetail.includes(block.src)),
								error: detail.errors.join("；") || null,
							},
							detailReadAt: detail.capturedAt,
						}}
						sourceLabel={targetShop}
						reading={false}
					/>
				</TabsContent>
				<TabsContent value="fields" className="pt-5">
					{detail.productId || detail.status === "listed" || detail.status === "unknown" ? (
						<p className="text-sm text-muted-foreground">已上架或结果待核对的商品保留当前资料，请先通过现有商品核对流程处理。</p>
					) : (
						<SourceEditor
							detail={detail}
							item={item}
							targetShop={targetShop}
							onSaved={() => {
								saved();
								setTab("specs");
							}}
						/>
					)}
				</TabsContent>
				{!detail.productId && detail.status !== "unknown" && (
					<TabsContent value="translation" className="pt-5">
						<SourceImageTranslation item={item.id} sourceId={detail.id} targetShop={targetShop} onSaved={saved} />
					</TabsContent>
				)}
			</Tabs>
			{lightbox.lightbox}
		</div>
	);
}

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const optionalNumber = (text: string, name: string) => {
	if (!text.trim()) return null;
	const value = Number(text);
	if (!Number.isFinite(value)) throw new Error(`${name}须为有效数字`);
	return value;
};
const numericMap = (values: Record<string, string>, name: string) =>
	Object.fromEntries(
		Object.entries(values).flatMap(([id, text]) => {
			const value = optionalNumber(text, name);
			return value === null ? [] : [[id, value]];
		}),
	);

function SourceEditor({ detail: initial, targetShop, item, onSaved }: { detail: SourceDetail; targetShop: string; item: Item; onSaved: () => void }) {
	const detail = useRef(initial).current;
	const [title, setTitle] = useState(detail.fields.title ?? detail.title);
	const [description, setDescription] = useState(detail.fields.description ?? detail.listingDescription);
	const [weight, setWeight] = useState(numberText(detail.fields.weightKg));
	const [freight, setFreight] = useState(numberText(detail.fields.freightRmb));
	const [minQty, setMinQty] = useState(numberText(detail.fields.minQty ?? detail.minQty));
	const [days, setDays] = useState(numberText(detail.fields.daysToShip));
	const [category, setCategory] = useState((detail.fields.categoryPath ?? []).join(","));
	const [attributes, setAttributes] = useState(JSON.stringify(detail.fields.attributes ?? [], null, 2));
	const [stocks, setStocks] = useState<Record<string, string>>(() =>
		Object.fromEntries(detail.skus.map((sku) => [sku.id, numberText(detail.fields.stocks?.[sku.id])])),
	);
	const [prices, setPrices] = useState<Record<string, string>>(() =>
		Object.fromEntries(detail.skus.map((sku) => [sku.id, numberText(detail.fields.prices?.[sku.id])])),
	);
	const [salePrices, setSalePrices] = useState<Record<string, string>>(() =>
		Object.fromEntries(Object.entries(detail.fields.salePricesTwd ?? {}).map(([id, value]) => [id, String(value)])),
	);
	const [weights, setWeights] = useState<Record<string, string>>(() =>
		Object.fromEntries(Object.entries(detail.fields.weightsKg ?? {}).map(([id, value]) => [id, String(value)])),
	);
	const tierDefaults = detail.tiers.map((t) => ({ source: t.source, name: t.name, options: Object.fromEntries(t.options.map((o) => [o.source, o.name])) }));
	const [tiers, setTiers] = useState(tierDefaults);
	const skuImages = [...new Set(detail.skus.flatMap((s) => (s.image ? [s.image] : [])))];
	const [hiddenSkuImages, setHiddenSkuImages] = useState(detail.fields.hiddenSkuImages ?? []);
	const [mainImages, setMainImages] = useState(detail.selectedMain);
	const [detailImages, setDetailImages] = useState(detail.selectedDetail);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const save = async () => {
		if (busy) return;
		setError(null);
		setMessage(null);
		setBusy(true);
		try {
			const categoryPath = category.trim()
				? category
						.split(/[,，\s>]+/)
						.filter(Boolean)
						.map(Number)
				: [];
			if (categoryPath.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("类目路径请填写以逗号分隔的类目编号");
			const parsedAttributes: unknown = JSON.parse(attributes || "[]");
			if (!Array.isArray(parsedAttributes)) throw new Error("类目属性须为 JSON（结构化数据）数组");
			const weightKg = optionalNumber(weight, "重量"),
				freightRmb = optionalNumber(freight, "国内运费"),
				minimum = optionalNumber(minQty, "起订量"),
				daysToShip = optionalNumber(days, "备货天数");
			if (!title.trim() || (!description.trim() && (detail.fields.description || detail.listingDescription))) throw new Error("请填写上架标题和描述");
			const fields: SourceFields = {};
			const resetFields: string[] = [];
			for (const [key, value] of Object.entries({ weightKg, freightRmb, minQty: minimum, daysToShip }) as [
				"weightKg" | "freightRmb" | "minQty" | "daysToShip",
				number | null,
			][]) {
				const previous = detail.fields[key] ?? (key === "minQty" ? detail.minQty : null);
				if (value !== null && value !== previous) fields[key] = value;
				else if (value === null && detail.fields[key] !== undefined) resetFields.push(key);
			}
			if (title.trim() !== (detail.fields.title ?? detail.title)) fields.title = title.trim();
			if (description.trim() !== (detail.fields.description ?? detail.listingDescription)) fields.description = description.trim();
			const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
			if (differs(categoryPath, detail.fields.categoryPath ?? [])) {
				if (categoryPath.length) fields.categoryPath = categoryPath;
				else resetFields.push("categoryPath");
			}
			if (differs(parsedAttributes, detail.fields.attributes ?? [])) fields.attributes = parsedAttributes as SourceFields["attributes"];
			for (const [key, values, label] of [
				["stocks", stocks, "库存"],
				["prices", prices, "采购价"],
				["salePricesTwd", salePrices, "上架售价"],
				["weightsKg", weights, "重量"],
			] as const) {
				const map = numericMap(values, label);
				const prev = detail.fields[key] ?? {};
				if (Object.keys(map).length !== Object.keys(prev).length || Object.entries(map).some(([id, v]) => prev[id] !== v)) fields[key] = map;
			}
			if (Object.values(fields.salePricesTwd ?? {}).some((v) => !Number.isSafeInteger(v) || v <= 0)) throw new Error("新台币上架售价请填写正整数");
			if (differs(tiers, tierDefaults)) fields.tierLabels = tiers;
			if (differs(hiddenSkuImages, detail.fields.hiddenSkuImages ?? [])) fields.hiddenSkuImages = hiddenSkuImages;
			if (differs(mainImages, detail.selectedMain)) {
				if (!mainImages.length || mainImages.length > 9) throw new Error("上架主图请保留 1 至 9 张");
				fields.mainImages = mainImages;
			}
			if (differs(detailImages, detail.selectedDetail)) {
				if (detailImages.length > 12) throw new Error("上架详情图最多 12 张");
				fields.detailImages = detailImages;
			}
			if (!Object.keys(fields).length && !resetFields.length) {
				setMessage("当前没有修改。");
				return;
			}
			await api.act<SourceDetail>(item.id, "sourceUpdate", {
				sourceId: detail.id,
				targetShop,
				expectedEditedAt: detail.editedAt ?? null,
				resetFields,
				...fields,
			});
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-5">
			<p className="text-xs text-muted-foreground">修改将用于 {targetShop} 的商品稿。每个规格可单独填写新台币售价。</p>
			<div className="space-y-2">
				<Label htmlFor="source-title">上架标题</Label>
				<Input id="source-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
			</div>
			<div className="space-y-2">
				<Label htmlFor="source-description">上架描述</Label>
				<Textarea id="source-description" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<NumberField id="source-weight" label="备用重量 kg（千克）" value={weight} change={setWeight} min="0.001" step="0.001" disabled={busy} />
				<NumberField id="source-freight" label="国内运费 CNY（人民币）" value={freight} change={setFreight} min="0" step="0.01" disabled={busy} />
				<NumberField id="source-minimum" label="采购起订量" value={minQty} change={setMinQty} min="1" step="1" disabled={busy} />
				<NumberField id="source-days" label="备货天数" value={days} change={setDays} min="1" step="1" disabled={busy} />
			</div>
			<div className="space-y-2">
				<Label htmlFor="source-category">Shopee（虾皮）类目路径</Label>
				<Input id="source-category" value={category} placeholder="类目编号，用逗号分隔" onChange={(e) => setCategory(e.target.value)} disabled={busy} />
			</div>
			<details className="rounded-lg border p-3">
				<summary className="cursor-pointer text-sm font-medium">类目必填属性</summary>
				<Label htmlFor="source-attributes" className="mt-3 text-xs text-muted-foreground">
					填写现有上架流程使用的属性编号与取值
				</Label>
				<Textarea
					id="source-attributes"
					className="mt-2 font-mono text-xs"
					rows={5}
					value={attributes}
					onChange={(e) => setAttributes(e.target.value)}
					disabled={busy}
				/>
			</details>
			{detail.skus.length > 0 && (
				<section className="space-y-2">
					<h4 className="text-sm font-semibold">规格与上架售价</h4>
					<p className="text-xs text-muted-foreground">售价按每件填写，留空沿用店铺核价。</p>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>规格</TableHead>
								<TableHead>采购价 CNY（人民币）</TableHead>
								<TableHead>上架售价 TWD（新台币）</TableHead>
								<TableHead>重量 kg（千克）</TableHead>
								<TableHead>库存</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{detail.skus.map((sku) => (
								<TableRow key={sku.id}>
									<TableCell className="max-w-48 whitespace-normal">{sku.name || sku.attrs.join(" / ") || sku.id}</TableCell>
									<TableCell>
										<Input
											aria-label={`${sku.name}采购价`}
											type="number"
											min="0.01"
											step="0.01"
											value={prices[sku.id] ?? ""}
											placeholder={numberText(sku.price) || "未取得"}
											disabled={busy}
											onChange={(e) => setPrices((before) => ({ ...before, [sku.id]: e.target.value }))}
										/>
									</TableCell>
									<TableCell>
										<Input
											aria-label={`${sku.name}上架售价`}
											type="number"
											min="1"
											step="1"
											placeholder={numberText(detail.salePrices[sku.id]) || "自动核价"}
											value={salePrices[sku.id] ?? ""}
											onChange={(e) => setSalePrices({ ...salePrices, [sku.id]: e.target.value })}
											disabled={busy}
										/>
									</TableCell>
									<TableCell>
										<Input
											aria-label={`${sku.name}重量`}
											type="number"
											min="0.001"
											step="0.001"
											placeholder={numberText(sku.weightKg)}
											value={weights[sku.id] ?? ""}
											onChange={(e) => setWeights({ ...weights, [sku.id]: e.target.value })}
											disabled={busy}
										/>
									</TableCell>
									<TableCell>
										<Input
											aria-label={`${sku.name}库存`}
											type="number"
											min="0"
											step="1"
											value={stocks[sku.id] ?? ""}
											placeholder={numberText(sku.stock) || "未取得"}
											disabled={busy}
											onChange={(e) => setStocks((before) => ({ ...before, [sku.id]: e.target.value }))}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</section>
			)}
			{tiers.map((tier, i) => (
				<div className="space-y-2" key={tier.source}>
					<Label>规格名称 · {tier.source}</Label>
					<Input
						aria-label={`${tier.source}规格名称`}
						value={tier.name}
						disabled={busy}
						onChange={(e) => setTiers(tiers.map((t, n) => (n === i ? { ...t, name: e.target.value } : t)))}
					/>
					<div className="grid gap-2 sm:grid-cols-3">
						{Object.entries(tier.options).map(([key, name]) => (
							<Label className="flex-col items-start" key={key}>
								{key}
								<Input
									value={name}
									disabled={busy}
									onChange={(e) => setTiers(tiers.map((t, n) => (n === i ? { ...t, options: { ...t.options, [key]: e.target.value } } : t)))}
								/>
							</Label>
						))}
					</div>
				</div>
			))}
			<ImageSelection label="上架主图" images={detail.images} selected={mainImages} max={9} change={setMainImages} disabled={busy} />
			<ImageSelection label="上架详情图" images={detail.description.images} selected={detailImages} max={12} change={setDetailImages} disabled={busy} />
			<ImageSelection
				label="规格图"
				images={skuImages}
				selected={skuImages.filter((url) => !hiddenSkuImages.includes(url))}
				max={skuImages.length}
				change={(urls) => setHiddenSkuImages(skuImages.filter((url) => !urls.includes(url)))}
				disabled={busy}
			/>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{message && (
				<p role="status" className="text-sm text-muted-foreground">
					{message}
				</p>
			)}
			<Button onClick={() => void save()} disabled={busy}>
				{busy && <LoaderCircleIcon className="animate-spin" />}
				{busy ? "正在保存…" : "保存上架资料"}
			</Button>
		</div>
	);
}

function NumberField({
	id,
	label,
	value,
	change,
	min,
	step,
	disabled,
}: {
	id: string;
	label: string;
	value: string;
	change: (value: string) => void;
	min: string;
	step: string;
	disabled: boolean;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Input id={id} type="number" value={value} onChange={(e) => change(e.target.value)} min={min} step={step} disabled={disabled} />
		</div>
	);
}

function ImageSelection({
	label,
	images,
	selected,
	max,
	change,
	disabled,
}: {
	label: string;
	images: string[];
	selected: string[];
	max: number;
	change: (value: string[]) => void;
	disabled: boolean;
}) {
	if (!images.length) return null;
	return (
		<section className="space-y-3">
			<h4 className="text-sm font-semibold">
				{label} · 已选 {selected.length} / {max}
			</h4>
			<p className="text-xs text-muted-foreground">取消勾选即可从本店上架稿移除，再次勾选可恢复。</p>
			<div className="flex flex-wrap gap-3">
				{[...new Set(images)].map((src, index) => (
					<label key={src} htmlFor={`${label}-${index}`} className="relative block cursor-pointer">
						<img
							src={src}
							alt={`${label} ${index + 1}`}
							referrerPolicy="no-referrer"
							loading="lazy"
							className={`size-24 rounded-lg border bg-background object-contain ${selected.includes(src) ? "" : "opacity-40"}`}
						/>
						<Checkbox
							id={`${label}-${index}`}
							className="absolute left-1 top-1 bg-background"
							aria-label={`${label} ${index + 1}`}
							checked={selected.includes(src)}
							disabled={disabled || (!selected.includes(src) && selected.length >= max)}
							onCheckedChange={(checked) => change(checked === true ? [...selected, src] : selected.filter((value) => value !== src))}
						/>
					</label>
				))}
			</div>
			{selected.length > max && <p className="text-xs text-destructive">当前超过 {max} 张，请取消部分图片后保存。</p>}
		</section>
	);
}
