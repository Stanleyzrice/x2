// 策略工作台由用户启动研究；进度和候选现读，未收到启动结果时沿用同一请求核对。
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ArrowUpRightIcon,
	CheckIcon,
	ChevronRightIcon,
	ClockIcon,
	LoaderCircleIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchCheckIcon,
	SquareIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorOf, remember, saved } from "@/lib/state";
import { api, type Item as PageItem, usePoll } from "../../api.ts";
import { EventEvidence, ResearchConclusionView, SavedReceipt, TrendParameters } from "./research.tsx";
import type { Props } from "./schema.ts";
import {
	canCancelRun,
	candidateLabel,
	canRequestStart,
	createStartGate,
	discardWorkflowDraft,
	initialStrategy,
	isTerminalRun,
	latestDetail,
	mergeRuns,
	moveWorkflowStep,
	pricingFacts,
	researchInput,
	restoredResearch,
	retryConditions,
	runOutcome,
	type SavedResearch,
	statusLabels,
	strategyCounts,
	type WorkflowReceipt,
	workbenchStrategies,
	workflowChanged,
	workflowInput,
} from "./state.ts";
import type { Candidate, Methodology, RunDetail, RunStatus, RunSummary, Strategy, Workbench } from "./types.ts";
import { strategyIds } from "./types.ts";

const dateTime = (value: string) => {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? value
		: date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const badgeVariant = (status: RunStatus) => (status === "failed" ? "destructive" : status === "completed" ? "default" : "secondary");
const readWorkspace = (key: string) => restoredResearch(saved(key));
const saveWorkspace = (key: string, value: SavedResearch) => remember(key, JSON.stringify(value));

export function View({ props, item }: { props: Props; item: PageItem }) {
	const formId = useId();
	const storageKey = `x2-selection:${item.id}:${props.shop}`;
	const [restored] = useState(() => readWorkspace(storageKey));
	const [strategyId, setStrategyId] = useState<string>(() => restored.pendingStart?.strategyId ?? initialStrategy(window.location.search, restored.strategyId));
	const [limit, setLimit] = useState(restored.limit);
	const [brief, setBrief] = useState(restored.brief);
	const [selectedRunId, setSelectedRunId] = useState<string | null>(restored.selectedRunId);
	const [receivedDetail, setReceivedDetail] = useState<RunDetail | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [pendingStart, setPendingStart] = useState(restored.pendingStart);
	const unresolvedStart = pendingStart !== null;
	const [stopping, setStopping] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, string[]>>({});
	const [editingWorkflows, setEditingWorkflows] = useState<Record<string, boolean>>({});
	const [workflowReceipt, setWorkflowReceipt] = useState<WorkflowReceipt>({ basis: null, values: {} });
	const [savingWorkflow, setSavingWorkflow] = useState(false);
	const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
	const startGate = useRef(createStartGate(restored.pendingStart));
	const stopPending = useRef(false);
	const workflowPending = useRef(false);
	const [receivedWorkbench, workbenchError, refreshWorkbench] = usePoll(() => api.act<Workbench>(item.id, "workbench"), 5000, [item.id, props.shop]);
	const workbench = receivedWorkbench?.shop === props.shop ? receivedWorkbench : null;
	const currentWorkbench = useRef(workbench);
	currentWorkbench.current = workbench;
	const strategies = workbenchStrategies(workbench, workflowReceipt);
	const counts = strategyCounts(strategies);
	const selectedStrategy = strategies.find((strategy) => strategy.id === strategyId);
	const workflowSteps = workflowDrafts[strategyId] ?? selectedStrategy?.steps ?? [];
	const unsavedWorkflow = Boolean(selectedStrategy && workflowChanged(selectedStrategy.steps, workflowSteps));
	const editingWorkflow = editingWorkflows[strategyId] === true || unsavedWorkflow;
	const preparedWorkflow = workflowInput(workflowSteps);
	const recordedRuns = mergeRuns(workbench?.runs ?? [], receivedDetail, props.shop);
	const runId = selectedRunId ?? recordedRuns[0]?.id ?? null;
	const summary = recordedRuns.find((run) => run.id === runId);
	const [polledDetail, detailError, refreshDetail] = usePoll(
		() => (runId ? api.act<RunDetail>(item.id, "detail", { runId }) : Promise.resolve(null)),
		summary && isTerminalRun(summary.status) ? 30_000 : 2000,
		[item.id, props.shop, runId],
	);
	const detail = latestDetail(runId, receivedDetail?.shop === props.shop ? receivedDetail : null, polledDetail?.shop === props.shop ? polledDetail : null);
	const runs = mergeRuns(recordedRuns, detail, props.shop);
	const activeRun = runs.find((run) => canCancelRun(run.status));
	const prepared = researchInput(strategyId, limit, brief);
	const formLocked = submitting || unresolvedStart || savingWorkflow;
	const canStart = Boolean(
		workbench &&
			selectedStrategy &&
			prepared.input &&
			!savingWorkflow &&
			(!unsavedWorkflow || unresolvedStart) &&
			canRequestStart(workbench.agent.available, unresolvedStart, submitting, runs),
	);
	useEffect(() => {
		saveWorkspace(storageKey, { strategyId, limit, brief, selectedRunId, pendingStart });
	}, [storageKey, strategyId, limit, brief, selectedRunId, pendingStart]);

	const start = async () => {
		if (!canStart || !prepared.input) return;
		const input = startGate.current.begin(prepared.input, () => crypto.randomUUID());
		if (!input) return;
		// 先保留同一请求，再提交；刷新或关闭窗口后也能核对这次启动。
		saveWorkspace(storageKey, { strategyId, limit, brief, selectedRunId, pendingStart: input });
		setPendingStart(input);
		setSubmitting(true);
		setActionError(null);
		try {
			const result = await api.act<RunDetail>(item.id, "start", input);
			startGate.current.settle(true);
			setReceivedDetail(result);
			setSelectedRunId(result.id);
			setPendingStart(null);
			saveWorkspace(storageKey, { strategyId, limit, brief, selectedRunId: result.id, pendingStart: null });
			refreshWorkbench();
		} catch (error) {
			startGate.current.settle(false);
			setActionError(errorOf(error));
		} finally {
			setSubmitting(false);
		}
	};

	const stop = async () => {
		if (!detail || !canCancelRun(detail.status) || detail.cancelRequested || stopPending.current) return;
		stopPending.current = true;
		setStopping(true);
		setActionError(null);
		try {
			setReceivedDetail(await api.act<RunDetail>(item.id, "cancel", { runId: detail.id }));
			refreshWorkbench();
			refreshDetail();
		} catch (error) {
			setActionError(errorOf(error));
		} finally {
			stopPending.current = false;
			setStopping(false);
		}
	};
	const refresh = () => {
		refreshWorkbench();
		refreshDetail();
	};
	const loadConditions = () => {
		if (!detail || formLocked || activeRun) return;
		const input = retryConditions(detail);
		if (!input) return;
		setStrategyId(input.strategyId);
		setLimit(String(input.limit));
		setBrief(input.brief);
		setActionError(null);
		document.getElementById(`${formId}-brief`)?.focus();
	};
	const updateWorkflow = (steps: string[]) => {
		setWorkflowDrafts((drafts) => ({ ...drafts, [strategyId]: steps }));
		setWorkflowMessage(null);
	};
	const cancelWorkflowEdit = () => {
		setWorkflowDrafts((drafts) => discardWorkflowDraft(drafts, strategyId));
		setEditingWorkflows((editing) => ({ ...editing, [strategyId]: false }));
		setWorkflowMessage(null);
	};
	const saveWorkflow = async (reset = false) => {
		if (!selectedStrategy || workflowPending.current || formLocked || (!reset && !preparedWorkflow.steps)) return;
		const savedId = selectedStrategy.id;
		workflowPending.current = true;
		setSavingWorkflow(true);
		setWorkflowMessage(null);
		setActionError(null);
		try {
			const result = await api.act<{ strategy: Strategy }>(item.id, reset ? "reset-workflow" : "save-workflow", {
				strategyId: savedId,
				...(reset ? {} : { steps: preparedWorkflow.steps }),
			});
			setWorkflowReceipt((saved) => ({
				basis: currentWorkbench.current,
				values: { ...(saved.basis === currentWorkbench.current ? saved.values : {}), [savedId]: result.strategy },
			}));
			setWorkflowDrafts((drafts) => discardWorkflowDraft(drafts, savedId));
			setEditingWorkflows((editing) => ({ ...editing, [savedId]: false }));
			setWorkflowMessage(reset ? "已恢复默认步骤，下次研究将使用此流程。" : "步骤已保存，下次研究将使用此流程。");
			refreshWorkbench();
		} catch (error) {
			setActionError(errorOf(error));
		} finally {
			workflowPending.current = false;
			setSavingWorkflow(false);
		}
	};

	return (
		<main className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-2">
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<SearchCheckIcon className="size-4" />
						{props.shop}
					</p>
					<h2 className="text-2xl font-semibold tracking-tight">{props.title ?? "策略选品"}</h2>
					<p className="text-sm text-muted-foreground">选择方法，按保存的步骤研究需求、竞争与货源，并将可继续审核的真实来源保存到上架备选区。</p>
					<p className="text-xs text-muted-foreground">入备选后继续补齐规格、图片和定价；仍须审核后才能上架。</p>
					{workbench && (
						<p className="text-xs text-muted-foreground">
							研究模型：{workbench.agent.model ?? "未记录"} · 推理强度：{workbench.agent.reasoningEffort ?? "未记录"}
						</p>
					)}
				</div>
				<Button variant="outline" render={<a href="#listing-candidates" />}>
					打开上架备选区
					<ArrowUpRightIcon />
				</Button>
			</header>
			<ErrorMessage message={actionError ?? workbenchError} />
			{!workbench ? (
				workbenchError ? (
					<Button variant="outline" onClick={refreshWorkbench}>
						<RefreshCwIcon />
						重新读取
					</Button>
				) : (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
						{strategyIds.map((key) => (
							<Skeleton key={key} className="h-44" />
						))}
					</div>
				)
			) : (
				<>
					{workbench.methodology && <MethodologyCard methodology={workbench.methodology} />}
					<section aria-labelledby={`${formId}-methods`} className="space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 id={`${formId}-methods`} className="text-sm font-medium">
								选择研究方法
							</h3>
							<p className="text-xs text-muted-foreground">
								{counts.total}种方法 · {counts.discovery}种商品发现 · {counts.salesUnit}种销售单位设计
								{counts.uncategorized > 0 && ` · ${counts.uncategorized}种历史方法尚未分类`}
							</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
							{strategies.map((strategy, index) => (
								<label
									key={strategy.id}
									className={`relative flex cursor-pointer flex-col gap-3 rounded-xl border bg-card p-5 transition-colors focus-within:ring-2 focus-within:ring-ring ${strategyId === strategy.id ? "border-primary bg-primary/5" : "hover:border-foreground/30"} ${formLocked ? "cursor-default opacity-70" : ""}`}
								>
									<input
										className="sr-only"
										type="radio"
										name={`${formId}-strategy`}
										value={strategy.id}
										checked={strategyId === strategy.id}
										onChange={() => setStrategyId(strategy.id)}
										disabled={formLocked}
									/>
									<span className="flex items-center justify-between gap-3">
										<span className="text-xs tabular-nums text-muted-foreground">0{index + 1}</span>
										<span
											className={`flex size-5 items-center justify-center rounded-full border ${strategyId === strategy.id ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30"}`}
										>
											{strategyId === strategy.id && <CheckIcon className="size-3" />}
										</span>
									</span>
									<span className="font-semibold">{strategy.name}</span>
									{strategy.kind && <span className="text-xs text-muted-foreground">{strategy.kind === "discovery" ? "商品发现" : "销售单位设计"}</span>}
									<span className="text-sm leading-relaxed text-muted-foreground">{strategy.description}</span>
								</label>
							))}
						</div>
						{!strategies.length && <p className="rounded-lg border p-4 text-sm text-muted-foreground">研究方法暂未载入，请刷新后重试。</p>}
					</section>
					<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
						<Card>
							<CardHeader>
								<CardTitle>{selectedStrategy ? `${selectedStrategy.name} · 研究依据与步骤` : "研究步骤"}</CardTitle>
								<CardDescription>先看购买理由与证据要求，再按保存的步骤执行研究。调整步骤后先保存。</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								{selectedStrategy && <StrategyBasis strategy={selectedStrategy} />}
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{selectedStrategy?.isCustomized ? "自定义流程" : "默认流程"}</Badge>
									{unsavedWorkflow && <span className="text-xs text-muted-foreground">有未保存的步骤</span>}
									{!editingWorkflow && (
										<Button
											variant="outline"
											size="sm"
											className="ml-auto"
											disabled={formLocked || !selectedStrategy}
											onClick={() => {
												setEditingWorkflows((editing) => ({ ...editing, [strategyId]: true }));
												setWorkflowMessage(null);
											}}
										>
											自定义步骤
										</Button>
									)}
								</div>
								<ol className={editingWorkflow ? "space-y-4" : "space-y-3"}>
									{workflowSteps.map((step, index) => (
										// 步骤可重名且编辑时不失焦，位置即编辑行身份。
										// biome-ignore lint/suspicious/noArrayIndexKey: 流程编辑器按顺序编辑，不以可变正文作key。
										<li key={index} className="flex gap-3 text-sm leading-relaxed">
											<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums">{index + 1}</span>
											{editingWorkflow ? (
												<div className="min-w-0 flex-1 space-y-2">
													<Textarea
														aria-label={`研究步骤 ${index + 1}`}
														value={step}
														maxLength={1000}
														disabled={formLocked}
														onChange={(event) => updateWorkflow(workflowSteps.map((value, row) => (row === index ? event.target.value : value)))}
														className="min-h-20 resize-y"
													/>
													<div className="flex justify-end gap-1">
														<Button
															variant="ghost"
															size="icon-sm"
															aria-label={`上移步骤 ${index + 1}`}
															disabled={formLocked || index === 0}
															onClick={() => updateWorkflow(moveWorkflowStep(workflowSteps, index, -1))}
														>
															<ArrowUpIcon />
														</Button>
														<Button
															variant="ghost"
															size="icon-sm"
															aria-label={`下移步骤 ${index + 1}`}
															disabled={formLocked || index === workflowSteps.length - 1}
															onClick={() => updateWorkflow(moveWorkflowStep(workflowSteps, index, 1))}
														>
															<ArrowDownIcon />
														</Button>
														<Button
															variant="ghost"
															size="icon-sm"
															aria-label={`删除步骤 ${index + 1}`}
															disabled={formLocked || workflowSteps.length === 1}
															onClick={() => updateWorkflow(workflowSteps.filter((_, row) => row !== index))}
														>
															<Trash2Icon />
														</Button>
													</div>
												</div>
											) : (
												<p className="min-w-0 flex-1 pt-0.5">{step}</p>
											)}
										</li>
									))}
								</ol>
								{editingWorkflow && <ErrorMessage message={unsavedWorkflow ? preparedWorkflow.error : null} />}
								{editingWorkflow && (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											size="sm"
											disabled={formLocked || workflowSteps.length >= 12}
											onClick={() => updateWorkflow([...workflowSteps, ""])}
										>
											<PlusIcon />
											添加步骤
										</Button>
										<Button size="sm" disabled={formLocked || !unsavedWorkflow || !preparedWorkflow.steps} onClick={() => void saveWorkflow()}>
											{savingWorkflow && <LoaderCircleIcon className="animate-spin" />}保存流程
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={formLocked || (!selectedStrategy?.isCustomized && !unsavedWorkflow)}
											onClick={() => void saveWorkflow(true)}
										>
											恢复默认
										</Button>
										<Button variant="ghost" size="sm" disabled={formLocked} onClick={cancelWorkflowEdit}>
											取消编辑
										</Button>
									</div>
								)}
								{workflowMessage && (
									<p role="status" className="text-xs leading-relaxed text-muted-foreground">
										{workflowMessage}
									</p>
								)}
								<p className="text-xs leading-relaxed text-muted-foreground">步骤可自定义研究重点；现行选品限制继续生效。执行中的研究使用启动时的流程。</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle>开始一次研究</CardTitle>
								<CardDescription>写清方向，帮助研究集中在你关心的商品上。</CardDescription>
							</CardHeader>
							<CardContent className="space-y-5">
								<div className="space-y-2">
									<Label htmlFor={`${formId}-brief`}>研究方向</Label>
									<Textarea
										id={`${formId}-brief`}
										maxLength={2000}
										value={brief}
										onChange={(event) => setBrief(event.target.value)}
										disabled={formLocked}
										placeholder="如：免打孔浴室收纳，优先轻小件；也可留空，由所选方法寻找方向。"
										className="min-h-28 resize-y"
									/>
								</div>
								<div className="flex items-end justify-between gap-4">
									<div className="max-w-36 space-y-2">
										<Label htmlFor={`${formId}-limit`}>目标新增货源数</Label>
										<Input
											id={`${formId}-limit`}
											type="number"
											min={1}
											max={10}
											step={1}
											value={limit}
											onChange={(event) => setLimit(event.target.value)}
											disabled={formLocked}
											aria-describedby={`${formId}-limit-hint`}
										/>
									</div>
									<p id={`${formId}-limit-hint`} className="text-right text-xs leading-relaxed text-muted-foreground">
										1—10个来源
										<br />
										不足时保留原因
									</p>
								</div>
								{prepared.error && <ErrorMessage message={prepared.error} />}
								{unsavedWorkflow && !unresolvedStart && (
									<p role="status" className="text-sm leading-relaxed text-muted-foreground">
										研究步骤尚未保存，请先保存流程后开始。
									</p>
								)}
								{!workbench.agent.available && <ErrorMessage message={workbench.agent.error ?? "研究暂时无法启动，请稍后刷新。"} />}
								{activeRun && !unresolvedStart && <p className="text-sm leading-relaxed text-muted-foreground">已有研究正在执行，可查看进展或停止后再开始。</p>}
								{unresolvedStart && (
									<p role="status" className="text-sm leading-relaxed text-muted-foreground">
										启动结果尚未返回。重试会核对同一次研究，方向和数量暂时保留。
									</p>
								)}
								<Button className="w-full" disabled={!canStart} onClick={() => void start()}>
									{submitting ? <LoaderCircleIcon className="animate-spin" /> : <SearchCheckIcon />}
									{submitting ? "正在提交研究…" : unresolvedStart ? "重试本次启动" : activeRun ? "已有研究进行中" : "开始研究"}
								</Button>
							</CardContent>
						</Card>
					</div>
				</>
			)}
			<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
				<section className="min-w-0 space-y-4" aria-live="polite">
					<div className="flex items-center justify-between gap-3">
						<h3 className="font-semibold">研究进展与候选</h3>
						<Button variant="ghost" size="sm" onClick={refresh}>
							<RefreshCwIcon />
							刷新
						</Button>
					</div>
					<ErrorMessage message={detailError} />
					{detail ? (
						<RunResult run={detail} stopping={stopping} stop={stop} loadConditions={loadConditions} canLoadConditions={!formLocked && !activeRun} />
					) : runId ? (
						detailError ? (
							<p className="rounded-xl border p-6 text-sm text-muted-foreground">未能读取这次研究，请刷新或从研究记录选择其他任务。</p>
						) : (
							<Skeleton className="h-64" />
						)
					) : (
						<div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">开始研究后，这里会显示每一步进展和候选依据。</div>
					)}
				</section>
				<aside className="space-y-3">
					<h3 className="flex items-center gap-2 font-semibold">
						<ClockIcon className="size-4" />
						研究记录
					</h3>
					{runs.length ? (
						runs.map((run) => <RunHistory key={run.id} run={run} selected={run.id === runId} select={() => setSelectedRunId(run.id)} />)
					) : (
						<p className="rounded-xl border p-5 text-sm text-muted-foreground">还没有研究记录。</p>
					)}
				</aside>
			</div>
		</main>
	);
}

function MethodologyCard({ methodology }: { methodology: Methodology }) {
	return (
		<Card className="gap-4 py-5">
			<CardHeader>
				<CardTitle className="text-base">选品依据与边界</CardTitle>
				<CardDescription className="leading-relaxed">{methodology.summary}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 text-sm">
				<details className="rounded-lg border p-3">
					<summary className="cursor-pointer font-medium">共用检查与证据规则</summary>
					<div className="mt-4 grid gap-4 md:grid-cols-2">
						<ResearchList title="每种方法都要检查" values={methodology.commonChecks} />
						<ResearchList title="证据能说明什么" values={methodology.evidenceRules} />
					</div>
				</details>
				{methodology.deferred.length > 0 && (
					<div className="space-y-2">
						<p className="font-medium">暂未启用的方法</p>
						{methodology.deferred.map((method) => (
							<p key={method.name} className="leading-relaxed text-muted-foreground">
								<span className="font-medium text-foreground">{method.name}</span>：{method.reason}
							</p>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function ResearchList({ title, values }: { title: string; values: string[] }) {
	return values.length ? (
		<div className="space-y-2">
			<p className="font-medium">{title}</p>
			<ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted-foreground">
				{values.map((value) => (
					<li key={value}>{value}</li>
				))}
			</ul>
		</div>
	) : null;
}

function StrategyBasis({ strategy }: { strategy: Strategy }) {
	if (!strategy.purchaseReason && !strategy.evidenceNeeded?.length && !strategy.rejectWhen?.length && !strategy.trend) return null;
	return (
		<section aria-label="方法依据" className="space-y-4 border-b pb-5 text-sm">
			{strategy.purchaseReason && (
				<div className="space-y-2">
					<p className="font-medium">为什么可能有人买</p>
					<p className="leading-relaxed text-muted-foreground">{strategy.purchaseReason}</p>
				</div>
			)}
			<div className="grid gap-4 md:grid-cols-2">
				<ResearchList title="需要找到的证据" values={strategy.evidenceNeeded ?? []} />
				<ResearchList title="出现这些情况就排除" values={strategy.rejectWhen ?? []} />
			</div>
			{strategy.trend && <TrendParameters parameters={strategy.trend} />}
		</section>
	);
}

function ErrorMessage({ message }: { message: string | null | undefined }) {
	return message ? (
		<p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive">
			{message}
		</p>
	) : null;
}

function RunHistory({ run, selected, select }: { run: RunSummary; selected: boolean; select: () => void }) {
	return (
		<button
			type="button"
			onClick={select}
			aria-pressed={selected}
			className={`w-full space-y-3 rounded-xl border p-4 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"}`}
		>
			<span className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium">{run.strategyName}</span>
				<Badge variant={badgeVariant(run.status)}>{runOutcome(run)}</Badge>
			</span>
			{run.brief && <span className="line-clamp-2 block text-xs leading-relaxed text-muted-foreground">{run.brief}</span>}
			<span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>{dateTime(run.createdAt)}</span>
				<span>
					新增 {run.found}／{run.limit} 个来源
				</span>
			</span>
		</button>
	);
}

function RunResult({
	run,
	stopping,
	stop,
	loadConditions,
	canLoadConditions,
}: {
	run: RunDetail;
	stopping: boolean;
	stop: () => Promise<void>;
	loadConditions: () => void;
	canLoadConditions: boolean;
}) {
	const added = run.candidates.filter((candidate) => candidate.status === "added" && candidate.sourceId).length;
	const existing = run.candidates.filter((candidate) => candidate.status === "existing" && candidate.sourceId).length;
	return (
		<>
			<Card>
				<CardHeader className="gap-3">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<CardTitle>{run.strategyName}</CardTitle>
						<Badge variant={badgeVariant(run.status)}>{runOutcome(run)}</Badge>
					</div>
					{run.brief && <CardDescription className="whitespace-pre-wrap">{run.brief}</CardDescription>}
				</CardHeader>
				<CardContent className="space-y-5">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="flex items-center gap-2 text-sm">
							{run.status === "running" && <LoaderCircleIcon className="size-4 animate-spin" />}
							{run.step || statusLabels[run.status]}
						</p>
						{canCancelRun(run.status) && (
							<Button variant="outline" size="sm" onClick={() => void stop()} disabled={stopping || run.cancelRequested}>
								<SquareIcon />
								{stopping || run.cancelRequested ? "正在停止…" : "停止研究"}
							</Button>
						)}
					</div>
					<div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 p-4 text-center">
						<Metric label="新增进度" value={`${run.found}／${run.limit}`} />
						<Metric label="新增备选" value={String(added)} />
						<Metric label="备选已有" value={String(existing)} />
					</div>
					{run.status === "needs-human" && run.error ? (
						<p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
							{run.error}
						</p>
					) : (
						<ErrorMessage message={run.error} />
					)}
					{retryConditions(run) && (
						<div className="space-y-2">
							<Button variant="outline" size="sm" disabled={!canLoadConditions} onClick={loadConditions}>
								<RefreshCwIcon />
								载入本次研究条件
							</Button>
							<p className="text-xs text-muted-foreground">载入后可调整方向，再点击开始研究。已有备选会保留，同源不重复新增。</p>
						</div>
					)}
					{run.status === "completed" && run.found < run.limit && (
						<p role="status" className="rounded-lg border p-3 text-sm leading-relaxed">
							{run.found === 0 ? "本次没有新增备选，未达到目标。" : `本次新增${run.found}个货源，少于目标${run.limit}个。`}
							请查看排除原因、已有来源和待补资料；研究结束不代表已完成上架审核。
						</p>
					)}
					{run.workflow && run.workflow.length > 0 && (
						<details className="rounded-lg border p-3 text-sm">
							<summary className="cursor-pointer">查看本次执行流程{run.agent ? ` · ${run.agent.model}` : ""}</summary>
							<ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
								{run.workflow.map((step, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 历史流程快照不可变，允许同名步骤。
									<li key={`${index}-${step}`}>{step}</li>
								))}
							</ol>
						</details>
					)}
					{run.events.length > 0 && (
						<ol className="max-h-72 space-y-4 overflow-auto pr-2">
							{run.events.map((event) => (
								<li key={event.id} className="flex gap-3 text-sm">
									<ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1 space-y-2">
										<p className="whitespace-pre-wrap break-words leading-relaxed">{event.message}</p>
										<p className="text-xs text-muted-foreground">
											{event.step} · {dateTime(event.at)}
										</p>
										<EventEvidence event={event} events={run.events} workflow={run.workflow ?? []} />
									</div>
								</li>
							))}
						</ol>
					)}
				</CardContent>
			</Card>
			{run.candidates.length > 0 ? (
				<div className="space-y-3">
					{run.candidates.map((candidate) => (
						<CandidateCard key={`${candidate.offerId}-${candidate.status}-${candidate.sourceId ?? candidate.url}`} candidate={candidate} events={run.events} />
					))}
				</div>
			) : isTerminalRun(run.status) ? (
				<p className="rounded-lg border p-5 text-sm text-muted-foreground">本次没有保存候选，取舍原因见研究进展。</p>
			) : null}
		</>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-1">
			<p className="text-xl font-semibold tabular-nums">{value}</p>
			<p className="text-xs text-muted-foreground">{label}</p>
		</div>
	);
}

function CandidateCard({ candidate, events }: { candidate: Candidate; events: RunDetail["events"] }) {
	const facts = pricingFacts(candidate.pricing);
	const sourceUrl = /^https?:\/\//.test(candidate.url) ? candidate.url : null;
	const hasSeparatedProblems = candidate.hardProblems !== undefined || candidate.warnings !== undefined;
	const problems = hasSeparatedProblems ? (candidate.hardProblems ?? []) : candidate.problems;
	const warnings = candidate.warnings ?? [];
	return (
		<Card className="gap-4 py-5">
			<CardHeader className="gap-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<CardTitle className="min-w-0 text-base leading-relaxed">
						{sourceUrl ? (
							<a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-start gap-2 hover:underline">
								{candidate.title}
								<ArrowUpRightIcon className="mt-0.5 size-4 shrink-0" />
							</a>
						) : (
							candidate.title
						)}
					</CardTitle>
					<Badge variant={candidate.status === "rejected" ? "outline" : "secondary"}>{candidateLabel(candidate)}</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				{candidate.sourceId && (
					<a href="#listing-candidates" className="inline-flex items-center gap-2 font-medium underline underline-offset-4">
						备选编号 {candidate.sourceId} · 查看上架备选区
						<ArrowUpRightIcon className="size-3.5" />
					</a>
				)}
				{candidate.reason && <p className="whitespace-pre-wrap leading-relaxed">{candidate.reason}</p>}
				{candidate.research && <ResearchConclusionView research={candidate.research} events={events} />}
				{candidate.receipt && <SavedReceipt receipt={candidate.receipt} />}
				{facts.length > 0 && (
					<dl className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg bg-muted/50 p-3">
						{facts.map((fact) => (
							<div key={fact.label} className="flex gap-2">
								<dt className="text-muted-foreground">{fact.label}</dt>
								<dd className="font-medium tabular-nums">{fact.value}</dd>
							</div>
						))}
					</dl>
				)}
				{candidate.evidence && (
					<details className="rounded-lg border px-3 py-2">
						<summary className="cursor-pointer text-muted-foreground">查看研究依据</summary>
						<p className="mt-3 whitespace-pre-wrap break-words leading-relaxed">{candidate.evidence}</p>
					</details>
				)}
				{candidate.sourceId && (
					<a href="#listing-candidates" className="inline-flex items-center gap-1 font-medium hover:underline">
						前往上架备选区
						<ArrowUpRightIcon className="size-3" />
					</a>
				)}
				{problems.length > 0 && (
					<div className="rounded-lg bg-muted/50 p-3">
						<p className="mb-1 font-medium">{hasSeparatedProblems ? "未纳入原因" : "待处理项（历史记录）"}</p>
						<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
							{[...new Set(problems)].map((problem) => (
								<li key={problem}>{problem}</li>
							))}
						</ul>
					</div>
				)}
				{warnings.length > 0 && (
					<div className="rounded-lg bg-muted/50 p-3">
						<p className="mb-1 font-medium">后续审核待补</p>
						<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
							{[...new Set(warnings)].map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export const tab = (props: Props) => props.title ?? "策略选品";
