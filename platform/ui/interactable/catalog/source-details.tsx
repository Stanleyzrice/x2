// 备选商品沿用 Catalog 的可调宽度详情面板、图片浏览和详情内容；人工补充只写覆盖字段，原始采集快照保留。
import { ArrowUpRightIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
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
	const images = [...new Set([...detail.images, ...detail.skus.map((sku) => sku.image).filter((src): src is string => Boolean(src))])];
	const lightbox = useLightbox(
		images.map((src, index) => ({ src, alt: `商品原图 ${index + 1}`, label: `${platformName(detail.platform)} · 商品原图 ${index + 1}` })),
	);
	return (
		<div className="space-y-6 p-5 sm:p-6">
			<div className="flex flex-wrap items-start gap-5">
				{detail.images[0] && (
					<div className="w-52 space-y-2">
						<DetailImage src={detail.images[0]} label="商品主图" open={() => lightbox.open(0)} />
						<div className="flex gap-2 overflow-x-auto">
							{detail.images.slice(1, 4).map((src) => (
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
					<p className="text-sm text-muted-foreground">原文 · 原图保存</p>
					{[...detail.errors, ...detail.problems].map((problem) => (
						<p key={problem} className="text-xs text-muted-foreground">
							{problem}
						</p>
					))}
				</div>
			</div>
			<Tabs defaultValue="specs">
				<TabsList variant="line" className="border-b">
					<TabsTrigger value="specs">规格</TabsTrigger>
					<TabsTrigger value="content">原文与详情图</TabsTrigger>
					<TabsTrigger value="fields">补充上架资料</TabsTrigger>
				</TabsList>
				<TabsContent value="specs" className="pt-4">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>规格图</TableHead>
								<TableHead>规格</TableHead>
								<TableHead>采购价 CNY（人民币）</TableHead>
								<TableHead>库存</TableHead>
								<TableHead>重量 kg（千克）</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{detail.skus.map((sku) => (
								<TableRow key={sku.id}>
									<TableCell>
										{sku.image ? (
											<DetailImage src={sku.image} label={sku.name || "规格图"} open={() => lightbox.open(images.indexOf(sku.image!))} thumbnail />
										) : (
											<span className="text-xs text-muted-foreground">未提供</span>
										)}
									</TableCell>
									<TableCell>
										<p>{sku.name || sku.attrs.join(" / ") || "单一规格"}</p>
										<p className="mt-1 text-xs text-muted-foreground">{sku.id}</p>
									</TableCell>
									<TableCell>{price(sku.price)}</TableCell>
									<TableCell>{sku.stock ?? "未取得"}</TableCell>
									<TableCell>{sku.weightKg ?? "未取得"}</TableCell>
								</TableRow>
							))}
							{!detail.skus.length && (
								<TableRow>
									<TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
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
							productImages: detail.images,
							description: { blocks: detail.description.blocks, error: detail.errors.join("；") || null },
							detailReadAt: detail.capturedAt,
						}}
						sourceLabel={platformName(detail.platform)}
						reading={false}
					/>
				</TabsContent>
				<TabsContent value="fields" className="pt-5">
					{detail.status === "listed" || detail.status === "unknown" ? (
						<p className="text-sm text-muted-foreground">已上架或结果待核对的商品保留当前资料，请先通过现有商品核对流程处理。</p>
					) : (
						<SourceEditor detail={detail} item={item} targetShop={targetShop} onSaved={saved} />
					)}
				</TabsContent>
			</Tabs>
			<p className="text-xs text-muted-foreground">保留货源原始文字与全部图片；本阶段不做文字或图片翻译。</p>
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

function SourceEditor({ detail, targetShop, item, onSaved }: { detail: SourceDetail; targetShop: string; item: Item; onSaved: () => void }) {
	const [title, setTitle] = useState(detail.fields.title ?? detail.title);
	const [description, setDescription] = useState(detail.fields.description ?? detail.description.text);
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
	const [mainImages, setMainImages] = useState(detail.fields.mainImages ?? detail.images);
	const [detailImages, setDetailImages] = useState(detail.fields.detailImages ?? detail.description.images);
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
			const fields: SourceFields = {
				...(title.trim() ? { title } : {}),
				...(description.trim() ? { description } : {}),
				...(weightKg === null ? {} : { weightKg }),
				...(freightRmb === null ? {} : { freightRmb }),
				...(minimum === null ? {} : { minQty: minimum }),
				...(daysToShip === null ? {} : { daysToShip }),
				...(categoryPath.length ? { categoryPath } : {}),
				...(parsedAttributes.length || detail.fields.attributes ? { attributes: parsedAttributes as SourceFields["attributes"] } : {}),
				stocks: numericMap(stocks, "库存"),
				prices: numericMap(prices, "采购价"),
				...(detail.images.length ? { mainImages } : {}),
				detailImages,
			};
			await api.act<SourceDetail>(item.id, "sourceUpdate", { sourceId: detail.id, targetShop, ...fields });
			setMessage("已保存上架资料，原始采集内容保留。再次上架时会重新检查必填项。");
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-5">
			<p className="text-xs text-muted-foreground">以下资料仅用于 {targetShop} 上架。空白表示尚未补充，沿用既有店铺规则检查。</p>
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
					<h4 className="text-sm font-semibold">规格缺失资料</h4>
					<p className="text-xs text-muted-foreground">只填写需要补充或覆盖的值；未填时沿用采集到的采购价和库存。</p>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>规格</TableHead>
								<TableHead>采购价 CNY（人民币）</TableHead>
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
			<ImageSelection label="选用主图" images={detail.images} selected={mainImages} max={9} change={setMainImages} disabled={busy} />
			<ImageSelection label="选用详情图" images={detail.description.images} selected={detailImages} max={12} change={setDetailImages} disabled={busy} />
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
			<p className="text-xs text-muted-foreground">超过平台数量限制时请明确选择，未选图片仍保留在原始采集内容中。</p>
			<div className="flex flex-wrap gap-3">
				{[...new Set(images)].map((src, index) => (
					<label key={src} htmlFor={`${label}-${index}`} className="relative block cursor-pointer">
						<img
							src={src}
							alt={`${label} ${index + 1}`}
							referrerPolicy="no-referrer"
							loading="lazy"
							className="size-24 rounded-lg border bg-background object-contain"
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
