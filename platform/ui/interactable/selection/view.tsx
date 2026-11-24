import { ArrowUpRightIcon, SearchCheckIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorOf, remember, saved } from "@/lib/state";
import { ApiError, api, type Item as PageItem, usePoll } from "../../api.ts";
import { flashModel, hermesModel, hermesModels, modelLabels } from "../../hermes-schema.ts";
import type { Props } from "./schema.ts";
import { canCancelRun, createStartGate, initialStrategy, mergeRuns, restoredResearch, runOutcome, runOutcomeDetail } from "./state.ts";
import { defaultSelectionLimit, type RunReceipt, type RunSummary, socialDiscoveryStrategy, strategyIds, type Workbench } from "./types.ts";

const dateTime = (value: string) =>
	new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function View({ props, item }: { props: Props; item: PageItem }) {
	const id = useId();
	const storageKey = `x2-selection:${item.id}:${props.shop}`;
	const [restored] = useState(() => restoredResearch(saved(storageKey)));
	const [strategyId, setStrategyId] = useState(() => restored.pendingStart?.strategyId ?? initialStrategy(window.location.search, restored.strategyId));
	const [selectedModel, setModel] = useState(restored.model);
	const [pendingStart, setPendingStart] = useState(restored.pendingStart);
	const [busy, setBusy] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [received, setReceived] = useState<RunSummary | null>(null);
	const [shown, setShown] = useState(8);
	const gate = useRef(createStartGate(restored.pendingStart));
	const [value, loadError, refresh] = usePoll(() => api.act<Workbench>(item.id, "workbench"), 5000, [item.id, props.shop]);
	const workbench = value?.shop === props.shop ? value : null;
	const model = selectedModel ?? workbench?.agent.model ?? flashModel;
	const runs = mergeRuns(workbench?.runs ?? [], received, props.shop);
	const activeRun = runs.find((run) => canCancelRun(run.status));
	const records = runs.filter((run) => !canCancelRun(run.status));
	const locked = busy || Boolean(pendingStart) || Boolean(activeRun);
	const availableStrategy = workbench?.strategies.find((strategy) => strategy.id === strategyId);
	const canStart = !busy && (pendingStart || (availableStrategy && workbench?.agent.available && !activeRun));

	useEffect(() => {
		remember(storageKey, JSON.stringify({ strategyId, model: selectedModel, pendingStart }));
	}, [storageKey, strategyId, selectedModel, pendingStart]);

	async function start() {
		const fields = pendingStart ?? (strategyId ? { strategyId, model, limit: defaultSelectionLimit(strategyId), brief: "" } : null);
		if (!canStart || !fields) return;
		const input = gate.current.begin(fields, () => crypto.randomUUID());
		if (!input) return;
		remember(storageKey, JSON.stringify({ strategyId, model: selectedModel, pendingStart: input }));
		setPendingStart(input);
		setBusy(true);
		setError(null);
		try {
			const result = await api.act<RunReceipt>(item.id, "start", input);
			if (!("deleted" in result)) setReceived(result);
			gate.current.settle(true);
			setPendingStart(null);
			refresh();
		} catch (failure) {
			const rejected = failure instanceof ApiError && failure.status === 400;
			gate.current.settle(rejected);
			if (rejected) setPendingStart(null);
			setError(errorOf(failure));
			refresh();
		} finally {
			setBusy(false);
		}
	}

	async function stop(run: RunSummary) {
		setStopping(true);
		setError(null);
		try {
			setReceived(await api.act<RunSummary>(item.id, "cancel", { runId: run.id }));
			refresh();
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setStopping(false);
		}
	}

	return (
		<main className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-8">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight">{props.title ?? "策略选品"}</h1>
				<Button variant="ghost" size="sm" render={<a href="#listing-candidates" />}>
					上架备选区 <ArrowUpRightIcon />
				</Button>
			</header>
			<Card>
				<CardHeader>
					<CardTitle>开始选品</CardTitle>
				</CardHeader>
				<CardContent>
					<form
						className="space-y-5"
						onSubmit={(event) => {
							event.preventDefault();
							void start();
						}}
					>
						{!workbench && !loadError && <Skeleton className="h-28" />}
						{workbench && (
							<div className="space-y-2.5">
								<Label id={`${id}-strategy`}>策略</Label>
								<RadioGroup
									aria-labelledby={`${id}-strategy`}
									value={availableStrategy?.id ?? ""}
									disabled={locked}
									className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
									onValueChange={(value) => setStrategyId(strategyIds.find((option) => option === value) ?? null)}
								>
									{workbench.strategies.map((option) => (
										<Label
											key={option.id}
											htmlFor={`${id}-${option.id}`}
											className="flex min-h-11 cursor-pointer gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted/40 has-data-checked:border-foreground/45 has-data-checked:bg-muted/55"
										>
											<RadioGroupItem id={`${id}-${option.id}`} value={option.id} />
											<span>{option.name}</span>
										</Label>
									))}
								</RadioGroup>
							</div>
						)}
						<div className="flex flex-wrap items-end justify-between gap-3 border-t pt-4">
							<div className="space-y-2">
								<Label htmlFor={`${id}-model`}>DeepSeek 模型</Label>
								<Select
									value={model}
									disabled={locked || !workbench?.agent.available}
									onValueChange={(next) => {
										const parsed = hermesModel.safeParse(next);
										if (parsed.success) setModel(parsed.data);
									}}
								>
									<SelectTrigger id={`${id}-model`} className="w-48">
										<SelectValue>{modelLabels[model]}</SelectValue>
									</SelectTrigger>
									<SelectContent align="start">
										{hermesModels.map((option) => (
											<SelectItem key={option} value={option}>
												{modelLabels[option]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Button type="submit" disabled={!canStart}>
								{busy ? <Spinner aria-hidden="true" /> : <SearchCheckIcon />}
								{pendingStart && !busy ? "核对启动结果" : "开始选品"}
							</Button>
						</div>
						{strategyId === socialDiscoveryStrategy && model !== flashModel && (
							<p className="text-xs text-muted-foreground">笔记图片由 DeepSeek Flash 读取。</p>
						)}
						{workbench && !workbench.agent.available && (
							<Button variant="link" className="h-auto p-0" render={<a href="#setup" />}>
								前往设置连接 DeepSeek
							</Button>
						)}
						{(error || loadError) && (
							<p role="alert" className="text-sm text-destructive">
								{error ?? loadError}
							</p>
						)}
						{loadError && (
							<Button type="button" variant="outline" size="sm" onClick={refresh}>
								重新读取
							</Button>
						)}
						{activeRun && (
							<div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
								<p role="status" className="flex items-center gap-2">
									<Spinner aria-hidden="true" className="shrink-0" />
									<span>
										{activeRun.strategyName} · {activeRun.step}
									</span>
								</p>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={stopping || ("cancelRequested" in activeRun && activeRun.cancelRequested === true)}
									onClick={() => void stop(activeRun)}
								>
									停止
								</Button>
							</div>
						)}
					</form>
				</CardContent>
			</Card>
			{workbench && (
				<Card>
					<CardHeader>
						<CardTitle>研究记录</CardTitle>
					</CardHeader>
					<CardContent>
						{!records.length ? (
							<p className="text-sm text-muted-foreground">暂无研究记录</p>
						) : (
							<Table aria-label="研究记录" className="min-w-[44rem] table-fixed [&_td]:align-top">
								<TableHeader>
									<TableRow>
										<TableHead scope="col" className="w-28">
											策略
										</TableHead>
										<TableHead scope="col" className="w-20">
											状态
										</TableHead>
										<TableHead scope="col" className="w-28">
											执行结果
										</TableHead>
										<TableHead scope="col">具体原因</TableHead>
										<TableHead scope="col" className="w-40">
											处理方式
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{records.slice(0, shown).map((run) => {
										const outcome = runOutcome(run);
										const detail = runOutcomeDetail(run);
										return (
											<TableRow key={run.id}>
												<TableCell className="whitespace-normal">
													<p className="font-medium">{run.strategyName}</p>
													<time dateTime={run.createdAt} className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
														{dateTime(run.createdAt)}
													</time>
												</TableCell>
												<TableCell>
													<Badge variant={outcome === "失败" ? "destructive" : outcome === "成功" ? "default" : "secondary"}>{outcome}</Badge>
												</TableCell>
												<TableCell className="break-words whitespace-normal">{detail?.summary ?? "已达目标"}</TableCell>
												<TableCell className="break-words whitespace-normal text-muted-foreground">
													{detail?.reason ?? (detail ? "记录未注明具体原因" : "—")}
												</TableCell>
												<TableCell className="break-words whitespace-normal">{detail?.nextStep ?? "—"}</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
						{records.length > shown && (
							<Button variant="ghost" size="sm" onClick={() => setShown(shown + 8)}>
								显示更多
							</Button>
						)}
					</CardContent>
				</Card>
			)}
		</main>
	);
}

export const tab = (props: Props) => props.title ?? "策略选品";
