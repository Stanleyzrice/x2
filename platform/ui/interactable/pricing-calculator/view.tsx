// 可复用定价试算：表单只收集输入，金额由业务工具计算；请求换代后立即隐藏旧结果。
import { CalculatorIcon, ChevronDownIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Item as PageItem } from "../../api.ts";
import type { Props } from "./schema.ts";
import { calculationInput, type Draft, emptyDraft, type TemplateDraft, templateDraft } from "./state.ts";
import type { Calculation, CalculationInput, Settings } from "./types.ts";

const amount = (value: number | null | undefined) =>
	value == null ? "—" : Number(value.toFixed(8)).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rmb = (value: number | null | undefined) => (value == null ? "待补数据" : `¥${amount(value)}`);
const twd = (value: number | null | undefined) => (value == null ? "—" : `NT$${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`);
const percent = (value: number | null | undefined) => (value == null ? "—" : `${(value * 100).toFixed(2)}%`);

function NumberField({
	id,
	label,
	value,
	unit,
	placeholder,
	hint,
	onChange,
	min = 0,
	step = "0.01",
}: {
	id: string;
	label: string;
	value: string;
	unit: string;
	placeholder?: string;
	hint?: string;
	onChange: (value: string) => void;
	min?: number;
	step?: string;
}) {
	return (
		<div className="min-w-0 space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<div className="relative">
				<Input
					id={id}
					type="number"
					inputMode="decimal"
					min={min}
					step={step}
					value={value}
					placeholder={placeholder}
					aria-describedby={hint ? `${id}-hint` : undefined}
					className="h-10 pr-16 tabular-nums"
					onChange={(event) => onChange(event.target.value)}
				/>
				<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>
			</div>
			{hint && (
				<p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
					{hint}
				</p>
			)}
		</div>
	);
}

const parameterFields: { key: keyof TemplateDraft; label: string; unit: string; min?: number }[] = [
	{ key: "fx", label: "汇率", unit: "TWD/RMB", min: 0.01 },
	{ key: "feeRate", label: "平台费率", unit: "%" },
	{ key: "freightPerKgRmb", label: "头程单价", unit: "¥/kg" },
	{ key: "labelFeeRmb", label: "贴单费 / 单", unit: "RMB" },
	{ key: "minMargin", label: "目标毛利率下限", unit: "%" },
	{ key: "maxMargin", label: "目标毛利率上限", unit: "%" },
];

export function View({ props, item }: { props: Props; item: PageItem }) {
	const id = useId();
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [settings, setSettings] = useState<Settings | null>(null);
	const [parameters, setParameters] = useState<TemplateDraft | null>(null);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [received, setReceived] = useState<{ input: CalculationInput; value: Calculation } | null>(null);
	const [failure, setFailure] = useState<{ input: CalculationInput; message: string } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是用户主动重试读取模板的版本号。
	useEffect(() => {
		let active = true;
		setSettingsError(null);
		api.act<Settings>(item.id, "settings").then(
			(value) => {
				if (!active) return;
				setSettings(value);
				setParameters(templateDraft(value.template));
			},
			(error: Error) => {
				if (active) setSettingsError(error.message);
			},
		);
		return () => {
			active = false;
		};
	}, [item.id, attempt]);
	const prepared = useMemo(() => (parameters ? calculationInput(draft, parameters) : { input: null, errors: [] }), [draft, parameters]);
	useEffect(() => {
		const input = prepared.input;
		if (!input) return;
		let active = true;
		const timer = setTimeout(() => {
			api.act<Calculation>(item.id, "calculate", input).then(
				(value) => {
					if (active) setReceived({ input, value });
				},
				(error: Error) => {
					if (active) setFailure({ input, message: error.message });
				},
			);
		}, 250);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [item.id, prepared.input]);
	const result = received?.input === prepared.input ? received.value : null;
	const error = failure?.input === prepared.input ? failure.message : null;
	const calculating = Boolean(prepared.input && !result && !error);
	const update = (key: keyof Draft) => (value: string) => setDraft((before) => ({ ...before, [key]: value }));
	const field = (key: keyof Draft, label: string, unit: string, options: { placeholder?: string; hint?: string; min?: number; step?: string } = {}) => (
		<NumberField id={`${id}-${key}`} label={label} unit={unit} value={draft[key]} onChange={update(key)} {...options} />
	);
	const reset = () => {
		setDraft(emptyDraft());
		if (settings) setParameters(templateDraft(settings.template));
	};
	return (
		<div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
			<div className="flex items-start justify-between gap-3">
				<div className="space-y-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<CalculatorIcon className="size-4" />
						利润试算
					</div>
					<h2 className="text-2xl font-semibold tracking-tight">{props.title ?? "定价模板"}</h2>
					<p className="text-sm leading-relaxed text-muted-foreground">输入人民币进货价，查看建议售价和每单预估毛利。</p>
				</div>
				<Button variant="outline" size="sm" onClick={reset} disabled={!settings}>
					<RotateCcwIcon />
					重置
				</Button>
			</div>
			{settingsError ? (
				<Card>
					<CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
						<p role="alert" className="text-sm text-destructive">
							{settingsError}
						</p>
						<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
							重新读取模板
						</Button>
					</CardContent>
				</Card>
			) : !parameters ? (
				<Skeleton className="h-96 w-full" />
			) : (
				<>
					<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
						<div className="space-y-5">
							<Card>
								<CardHeader>
									<CardTitle>商品与订单成本</CardTitle>
									<CardDescription>进货价和重量按每件填写，运费按整单填写。</CardDescription>
								</CardHeader>
								<CardContent className="grid gap-5 sm:grid-cols-2">
									{field("costRmb", "人民币进货价 / 件", "RMB", { placeholder: "输入采购单价" })}
									{field("units", "订单件数", "件", { min: 1, step: "1" })}
									{field("weightKg", "计费重量 / 件", "kg", { placeholder: "如 0.20", step: "0.001", min: 0.001 })}
									{field("freightRmb", "整单国内运费", "RMB", { placeholder: "未知请留空", hint: "明确包邮填 0；每单只计一次。" })}
								</CardContent>
							</Card>
							<Card>
								<CardHeader>
									<CardTitle>售价与优惠</CardTitle>
									<CardDescription>售价留空时，按目标毛利区间给出建议。</CardDescription>
								</CardHeader>
								<CardContent className="grid gap-5 sm:grid-cols-2">
									{field("priceTwd", "每件售价", "TWD", { placeholder: "自动建议，可自行输入", min: 0.01 })}
									{field("sellerDiscountTwd", "整单卖家优惠", "TWD", { placeholder: "未知请留空", hint: "由卖家承担的优惠；无优惠填 0。" })}
								</CardContent>
							</Card>
							<Card className="gap-0 py-0">
								<details className="group">
									<summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-6 py-5 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
										<span className="space-y-1">
											<span className="block text-sm font-medium">模板参数</span>
											<span className="block text-xs text-muted-foreground">沿用现行模板，可调整本次试算</span>
										</span>
										<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
									</summary>
									<CardContent className="grid gap-5 pb-6 sm:grid-cols-2">
										{parameterFields.map((parameter) => (
											<NumberField
												key={parameter.key}
												id={`${id}-${parameter.key}`}
												label={parameter.label}
												unit={parameter.unit}
												min={parameter.min}
												value={parameters[parameter.key]}
												onChange={(value) => setParameters((before) => (before ? { ...before, [parameter.key]: value } : before))}
											/>
										))}
									</CardContent>
								</details>
							</Card>
						</div>
						<div className="space-y-5" aria-live="polite" aria-busy={calculating}>
							<Card className="overflow-hidden">
								<CardHeader className="gap-3">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<CardTitle>本次试算</CardTitle>
										<Badge variant="secondary">
											{calculating
												? "计算中…"
												: result?.missing.length
													? "待补数据"
													: result?.status === "INVALID_INPUT"
														? "请调整输入"
														: result?.profitRmb == null
															? "待计算"
															: "预估结果"}
										</Badge>
									</div>
									<CardDescription>{result?.priceSource === "input" ? "按你输入的每件售价计算" : "按目标区间内的建议售价计算"}</CardDescription>
								</CardHeader>
								<CardContent className="space-y-6">
									<div>
										<p className="text-xs text-muted-foreground">{result?.priceSource === "input" ? "当前每件售价" : "建议每件售价"}</p>
										<p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">{twd(result?.priceTwd)}</p>
										<p className="mt-2 text-xs text-muted-foreground">
											目标毛利售价区间 {result?.rangeTwd ? `${twd(result.rangeTwd.min)} – ${twd(result.rangeTwd.max)} / 件` : "待补齐成本后计算"}
										</p>
									</div>
									<Separator />
									<div className="grid grid-cols-2 gap-4">
										<div>
											<p className="text-xs text-muted-foreground">每单预估毛利 / RMB</p>
											<p
												className={`mt-2 text-3xl font-semibold tabular-nums ${result?.profitRmb == null ? "" : result.profitRmb < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}
											>
												{result?.profitRmb == null ? "—" : `¥${amount(result.profitRmb)}`}
											</p>
										</div>
										<div>
											<p className="text-xs text-muted-foreground">毛利率</p>
											<p className="mt-2 text-3xl font-semibold tabular-nums">{percent(result?.margin)}</p>
										</div>
									</div>
									{result?.margin != null && (
										<p className={`text-sm ${result.withinTarget ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
											{result.profitRmb !== null && result.profitRmb < 0
												? "当前售价预计亏损"
												: result.withinTarget
													? "毛利率在本次目标区间内"
													: "毛利率超出本次目标区间"}
										</p>
									)}
									{prepared.errors.length > 0 || error || result?.problems.length || result?.missing.length ? (
										<div role="status" className="space-y-1 rounded-lg bg-muted p-3 text-sm leading-relaxed">
											{prepared.errors.map((message) => (
												<p key={message} className="text-destructive">
													{message}
												</p>
											))}
											{error && <p className="text-destructive">{error}</p>}
											{result?.missing.length ? <p>请补充：{result.missing.join("、")}。</p> : null}
											{result?.problems
												.filter((message) => !message.startsWith("缺"))
												.map((message) => (
													<p key={message} className="text-destructive">
														{message}
													</p>
												))}
										</div>
									) : null}
								</CardContent>
							</Card>
							<Card>
								<CardHeader>
									<CardTitle>每单费用明细</CardTitle>
									<CardDescription>金额统一折合人民币，优惠已从收入中扣除。</CardDescription>
								</CardHeader>
								<CardContent className="space-y-4 text-sm">
									<dl className="space-y-3">
										<CostRow label="商品进货成本" value={rmb(result?.breakdown.goodsRmb)} />
										<CostRow label="头程运费" value={rmb(result?.breakdown.firstLegRmb)} />
										<CostRow label="国内运费" value={rmb(result?.breakdown.domesticFreightRmb)} />
										<CostRow label="贴单费" value={rmb(result?.breakdown.labelFeeRmb)} />
										<CostRow label="平台费用" value={rmb(result?.breakdown.platformFeeRmb)} />
									</dl>
									<Separator />
									<dl className="space-y-3">
										<CostRow label="总成本（不含平台费）" value={rmb(result?.totalCostRmb)} />
										<CostRow label="扣平台费后到手" value={rmb(result?.netRmb)} />
									</dl>
								</CardContent>
							</Card>
						</div>
					</div>
					<div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
						<InfoIcon className="mt-0.5 size-4 shrink-0" />
						<p>毛利 = 扣平台费后到手 − 进货、头程、国内运费与贴单费；毛利率以扣平台费后的到手金额为分母。结果为模板预估，未计入模板之外的费用。</p>
					</div>
				</>
			)}
		</div>
	);
}

function CostRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="shrink-0 font-medium tabular-nums">{value}</dd>
		</div>
	);
}

export const tab = (props: Props) => props.title ?? "定价模板";
