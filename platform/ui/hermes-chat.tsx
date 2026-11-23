import {
	BotIcon,
	CheckCircle2Icon,
	CircleAlertIcon,
	ExternalLinkIcon,
	FileSearchIcon,
	ListChecksIcon,
	PackageIcon,
	PlusIcon,
	QuoteIcon,
	Settings2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ToolTraceStep } from "../web/hermes.ts";
import { api, type HermesRequest, type HermesRun, type HermesTurn, type SetupState } from "./api.ts";
import { Badge } from "./components/ui/badge";
import { Bubble, BubbleContent } from "./components/ui/bubble";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./components/ui/item";
import { Label } from "./components/ui/label";
import { Message, MessageAvatar, MessageContent, MessageFooter } from "./components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "./components/ui/message-scroller";
import { SidebarTrigger } from "./components/ui/sidebar";
import { Spinner } from "./components/ui/spinner";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "./components/ui/trace";
import { HermesComposer } from "./hermes-composer.tsx";
import {
	attachmentLimit,
	chatAttachmentText,
	flashModel,
	type HermesAttachment,
	type HermesModel,
	hermesModels,
	modelLabels,
	quoteLimit,
} from "./hermes-schema.ts";
import { errorOf } from "./lib/state.ts";

type Batch = { shop: string; sourceIds: string[]; notes?: string };
type Turn = HermesTurn & { id: string; context?: string; model?: HermesModel; trace?: ToolTraceStep[] };
type Session = { turns: Turn[]; awaiting: HermesRequest | null; lastPublish: HermesRun | null };
const sessionKey = "x2-hermes-session";
const handoffKey = "x2-hermes-listing-handoff";
const empty: Session = { turns: [], awaiting: null, lastPublish: null };
const modelKey = "x2-hermes-model";

export function openHermesForBatch(batch: Batch) {
	sessionStorage.setItem(handoffKey, JSON.stringify(batch));
	location.hash = "x2bot";
}

function savedSession(): Session {
	try {
		return JSON.parse(sessionStorage.getItem(sessionKey) ?? "null") ?? empty;
	} catch {
		return empty;
	}
}

function savedBatch(): Batch | null {
	try {
		return JSON.parse(sessionStorage.getItem(handoffKey) ?? "null");
	} catch {
		return null;
	}
}

function storeSession(session: Session) {
	try {
		sessionStorage.setItem(sessionKey, JSON.stringify({ ...session, turns: session.turns.slice(-24) }));
	} catch {
		// 当前页仍保留消息和请求编号，浏览器储存配额不足时也能继续查询进度。
	}
}

const shortcuts = [
	{ label: "查看上架流程", message: "请用 X2 工具读取现有上架流程，概括从备选到发布的步骤。", icon: ListChecksIcon },
	{ label: "检查最近商品稿", message: "请用 X2 工具查看当前店铺最近的商品稿，概括已发布和还需处理的项目。", icon: FileSearchIcon },
] as const;

export function HermesChat({ setup, openSettings }: { setup: SetupState; openSettings: () => void }) {
	const [session, setSession] = useState(savedSession);
	const [batch, setBatch] = useState(savedBatch);
	const [message, setMessage] = useState("");
	const [attachments, setAttachments] = useState<HermesAttachment[]>([]);
	const [reading, setReading] = useState(false);
	const [model, setSelectedModel] = useState(() => {
		const saved = sessionStorage.getItem(modelKey);
		return hermesModels.find((value) => value === saved) ?? hermesModels.find((value) => value === setup.model) ?? flashModel;
	});
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [trial, setTrial] = useState(false);
	const [polling, setPolling] = useState(true);
	const [liveTrace, setLiveTrace] = useState<ToolTraceStep[]>([]);
	const pending = session.awaiting;
	const blocked = !setup.hermes || !setup.local;
	const busy = Boolean(pending) || submitting || reading;
	const save = (state: Session) => {
		storeSession(state);
		setSession(state);
	};
	const setModel = (value: HermesModel) => {
		setSelectedModel(value);
		sessionStorage.setItem(modelKey, value);
	};
	useEffect(() => {
		if (!pending || !polling || submitting) return;
		let current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			try {
				const run = await api.hermesRun(pending.id);
				if (!current) return;
				setLiveTrace(run.trace ?? []);
				if (run.state === "running") {
					timer = setTimeout(() => void read(), 1800);
					return;
				}
				const turns =
					run.result && "text" in run.result
						? [...session.turns, { id: `assistant-${run.id}`, role: "assistant" as const, content: run.result.text, model: pending.model, trace: run.trace }]
						: session.turns;
				const next = { turns, awaiting: null, lastPublish: run.kind === "publish" ? run : session.lastPublish };
				storeSession(next);
				setSession(next);
				if (run.state === "failed" || run.state === "interrupted") setError(run.error ?? "上次任务已中断，可查看原商品稿和发布回执。");
			} catch (failure) {
				if (!current) return;
				setError(errorOf(failure));
				setPolling(false);
			}
		};
		void read();
		return () => {
			current = false;
			if (timer) clearTimeout(timer);
		};
	}, [pending, polling, session.lastPublish, session.turns, submitting]);

	async function launch(request: HermesRequest) {
		setSubmitting(true);
		setError(null);
		setLiveTrace([]);
		try {
			await api.startHermes(request);
			setPolling(true);
		} catch (failure) {
			setError(errorOf(failure));
			// 保留原编号与输入。再次点击会查询或领取同一请求。
			setPolling(false);
		} finally {
			setSubmitting(false);
		}
	}
	const send = (value: string) => {
		const content = value.trim();
		if (busy || blocked || (!content && !attachments.length)) return;
		const request: HermesRequest = {
			kind: "chat",
			id: crypto.randomUUID(),
			message: content,
			model,
			history: session.turns.slice(-16).map(({ role, content, context }) => ({
				role,
				content: [content, context].filter(Boolean).join("\n\n").slice(0, 30_000),
			})),
			attachments,
		};
		const context = chatAttachmentText(attachments);
		save({ ...session, turns: [...session.turns, { id: `user-${request.id}`, role: "user", content, context }], awaiting: request });
		setMessage("");
		setAttachments([]);
		void launch(request);
	};
	const publish = () => {
		if (!batch || busy || blocked) return;
		const request: HermesRequest = {
			kind: "publish",
			id: crypto.randomUUID(),
			shop: batch.shop,
			sourceIds: batch.sourceIds,
			confirmed: true,
			trial,
			notes: batch.notes,
			model,
		};
		save({ ...session, awaiting: request });
		sessionStorage.removeItem(handoffKey);
		setBatch(null);
		setConfirm(false);
		setTrial(false);
		void launch(request);
	};
	const quoteFrom = (element: HTMLElement, content: string) => {
		const selection = window.getSelection();
		const text =
			(selection?.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString().trim() : "") ||
			content.trim().split(/\n\s*\n/, 1)[0]!;
		if (!text || attachments.some((item) => item.kind === "quote" && item.text === text)) return;
		if (text.length > quoteLimit) {
			setError(`请选择最多 ${quoteLimit} 字的段落再引用。`);
			return;
		}
		setAttachments([...attachments, { kind: "quote", text }]);
		setError(null);
		selection?.removeAllRanges();
		focusComposer();
	};
	const focusComposer = () => document.querySelector<HTMLTextAreaElement>("[aria-label='发消息给 x2bot']")?.focus({ preventScroll: true });
	return (
		<div className="flex h-svh min-h-0 flex-col bg-muted/20">
			<header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 sm:px-5">
				<SidebarTrigger />
				<span className="min-w-0 truncate text-sm font-semibold">x2bot</span>
				<Badge variant="outline" className="hidden text-muted-foreground sm:inline-flex">
					{setup.hermes ? "已连接" : "待连接"}
				</Badge>
				<Button
					className="ml-auto"
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => {
						save(empty);
						setMessage("");
						setAttachments([]);
						setError(null);
					}}
				>
					<PlusIcon />
					新对话
				</Button>
			</header>
			<div className="min-h-0 flex-1">
				<MessageScrollerProvider autoScroll defaultScrollPosition="end">
					<MessageScroller>
						<MessageScrollerViewport aria-label="x2bot 对话消息">
							<MessageScrollerContent className="mx-auto max-w-4xl gap-5 px-4 py-6 sm:px-8 sm:py-9">
								{!session.turns.length && !session.lastPublish && !pending && (
									<MessageScrollerItem messageId="welcome" className="flex flex-1">
										<Empty className="mx-auto max-w-xl flex-1 items-start px-0 py-8">
											<EmptyHeader className="max-w-none items-start text-left">
												<EmptyMedia variant="icon">
													<BotIcon />
												</EmptyMedia>
												<EmptyTitle className="text-2xl tracking-tight sm:text-3xl">今天要处理什么？</EmptyTitle>
												<EmptyDescription>查看商品稿和运营流程，或接手从上架备选区交来的任务。</EmptyDescription>
											</EmptyHeader>
											<EmptyContent className="grid max-w-none gap-2 sm:grid-cols-2">
												{shortcuts.map(({ label, message, icon: Icon }) => (
													<Button
														key={label}
														variant="outline"
														disabled={blocked}
														className="justify-start rounded-full bg-background"
														onClick={() => {
															setMessage(message);
															focusComposer();
														}}
													>
														<Icon />
														{label}
													</Button>
												))}
											</EmptyContent>
										</Empty>
									</MessageScrollerItem>
								)}
								{session.turns.map((turn) => (
									<MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor={turn.role === "user"} data-chat-turn>
										<Message align={turn.role === "user" ? "end" : "start"} className="items-start gap-3">
											{turn.role === "assistant" && (
												<MessageAvatar className="mt-1 size-8 self-start group-has-data-[slot=message-footer]/message:translate-y-0">
													<BotIcon className="size-4" />
												</MessageAvatar>
											)}
											<MessageContent className="gap-1">
												<Bubble align={turn.role === "user" ? "end" : "start"} variant={turn.role === "user" ? "muted" : "ghost"}>
													<BubbleContent className={turn.role === "assistant" ? "leading-6" : undefined}>
														{turn.role === "user" ? (
															<>
																{turn.context && (
																	<details className="mb-2 text-xs text-muted-foreground">
																		<summary className="cursor-pointer">随消息发送的资料</summary>
																		<div className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap">{turn.context}</div>
																	</details>
																)}
																<p className="whitespace-pre-wrap">{turn.content}</p>
															</>
														) : (
															<div className="space-y-2">
																{turn.trace && <ExecutionTrace steps={turn.trace} />}
																<div className="markdown">
																	<Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: () => null }}>
																		{turn.content}
																	</Markdown>
																</div>
															</div>
														)}
													</BubbleContent>
												</Bubble>
												{turn.content && (
													<MessageFooter className="gap-2">
														<Button
															aria-label="引用这条消息中的段落"
															variant="ghost"
															size="xs"
															disabled={blocked || busy || attachments.length >= attachmentLimit}
															onMouseDown={(event) => event.preventDefault()}
															onClick={(event) => {
																const element = event.currentTarget.closest<HTMLElement>("[data-chat-turn]");
																if (element) quoteFrom(element, turn.content);
															}}
														>
															<QuoteIcon /> 引用
														</Button>
														{turn.model && <span>{modelLabels[turn.model]}</span>}
													</MessageFooter>
												)}
											</MessageContent>
										</Message>
									</MessageScrollerItem>
								))}
								{session.lastPublish && (
									<MessageScrollerItem messageId={`receipt-${session.lastPublish.id}`}>
										<PublishReceipt run={session.lastPublish} />
									</MessageScrollerItem>
								)}
								{batch && (
									<MessageScrollerItem messageId="listing-handoff">
										<Item variant="outline" className="bg-background">
											<ItemMedia variant="icon">
												<PackageIcon />
											</ItemMedia>
											<ItemContent>
												<ItemTitle>上架备选任务</ItemTitle>
												<ItemDescription>
													{batch.shop} · {batch.sourceIds.length} 件
												</ItemDescription>
												<p className="text-sm text-muted-foreground">备选编号 {batch.sourceIds.join("、")}</p>
												{batch.notes && (
													<details className="text-sm">
														<summary className="cursor-pointer">查看修改后的任务提示词</summary>
														<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{batch.notes}</pre>
													</details>
												)}
											</ItemContent>
											<ItemActions className="flex-wrap">
												<Button size="sm" disabled={busy || blocked} onClick={() => setConfirm(true)}>
													确认上架任务
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setBatch(null);
														sessionStorage.removeItem(handoffKey);
													}}
												>
													移除任务
												</Button>
											</ItemActions>
										</Item>
									</MessageScrollerItem>
								)}
								{pending && polling && (
									<MessageScrollerItem messageId={`assistant-${pending.id}`} key={`assistant-${pending.id}`}>
										<ExecutionTrace steps={liveTrace} running />
									</MessageScrollerItem>
								)}
								{error && (
									<MessageScrollerItem messageId="chat-error">
										{!pending && !session.lastPublish?.trace?.length && liveTrace.length > 0 && <ExecutionTrace steps={liveTrace} />}
										<div
											role="alert"
											className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/20 bg-background p-3 text-sm text-destructive"
										>
											{error}
											{pending && !polling && (
												<Button variant="outline" size="sm" onClick={() => void launch(pending)}>
													重试原请求
												</Button>
											)}
										</div>
									</MessageScrollerItem>
								)}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						{(session.turns.length > 0 || pending || session.lastPublish || batch) && <MessageScrollerButton aria-label="回到最新消息" />}
					</MessageScroller>
				</MessageScrollerProvider>
			</div>
			<div className="shrink-0 border-t bg-background px-4 py-3 sm:px-8 sm:py-4">
				{blocked ? (
					<div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
						<span>{setup.local ? "连接 DeepSeek 后即可使用 x2bot。" : "请通过本机地址使用 x2bot。"}</span>
						{setup.local && (
							<Button size="sm" variant="outline" onClick={openSettings}>
								<Settings2Icon />
								前往设置
							</Button>
						)}
					</div>
				) : (
					<HermesComposer
						message={message}
						setMessage={setMessage}
						model={model}
						setModel={setModel}
						attachments={attachments}
						setAttachments={setAttachments}
						busy={Boolean(pending) || submitting}
						reading={reading}
						setReading={setReading}
						onSend={() => send(message)}
					/>
				)}
			</div>
			<Dialog open={confirm} onOpenChange={setConfirm}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>确认交给 x2bot 上架</DialogTitle>
						<DialogDescription>
							使用 {modelLabels[model]} 为 {batch?.shop} 处理 {batch?.sourceIds.length} 件备选。符合 X2 审阅和发布条件的商品会正式上架。
						</DialogDescription>
					</DialogHeader>
					<p className="text-sm">备选编号 {batch?.sourceIds.join("、")}</p>
					{batch?.sourceIds.length === 1 && (
						<Label htmlFor="hermes-trial" className="flex items-center gap-2 text-sm">
							<Checkbox id="hermes-trial" checked={trial} onCheckedChange={(value) => setTrial(value === true)} />
							允许本件作为首次试单
						</Label>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirm(false)}>
							返回
						</Button>
						<Button disabled={busy || blocked} onClick={publish}>
							确认执行
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

const toolLabels: Record<string, string> = {
	read_rules: "读取 X2 流程",
	recent_listings: "查看最近商品稿",
	source_preflight: "预检备选商品",
	source_detail: "读取备选货源",
	source_update: "关联商品稿",
	listing_pricing: "读取定价模板",
	estimate: "试算商品价格",
	inspect_source_image: "检查货源图片",
	inspect_final_image: "检查商品图片",
	finish_review: "保存终审结果",
	publish: "调用上架工具",
};

function ExecutionTrace({ steps, running = false }: { steps: ToolTraceStep[]; running?: boolean }) {
	const [open, setOpen] = useState<boolean>();
	return (
		<Trace className="max-w-lg text-muted-foreground">
			<TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
				<TraceCollapsibleTrigger>
					<TraceLine status={running ? "running" : undefined}>
						<TraceTitle>{running ? "正在执行" : "执行链路"}</TraceTitle>
						{steps.length > 0 && <TraceDescription>{steps.length} 次工具调用</TraceDescription>}
					</TraceLine>
				</TraceCollapsibleTrigger>
				<TraceCollapsibleContent keepMounted>
					<Trace>
						{steps.length === 0 && (
							<TraceLine>
								<TraceTitle>{running ? "等待模型响应" : "本轮未调用 X2 工具"}</TraceTitle>
							</TraceLine>
						)}
						{steps.map((step) => (
							<TraceLine key={step.id} status={step.state === "running" ? "running" : step.state === "failed" ? "error" : undefined}>
								{step.state === "running" ? (
									<Spinner aria-hidden="true" />
								) : step.state === "failed" ? (
									<CircleAlertIcon className="size-4" />
								) : (
									<CheckCircle2Icon className="size-4" />
								)}
								<TraceTitle>{toolLabels[step.name] ?? step.name}</TraceTitle>
								<TraceDescription>{step.state === "running" ? "调用中" : step.state === "failed" ? "调用失败" : "已返回"}</TraceDescription>
							</TraceLine>
						))}
					</Trace>
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</Trace>
	);
}

function PublishReceipt({ run }: { run: HermesRun }) {
	const result = run.result && "items" in run.result ? run.result : null;
	if (!result) return run.trace?.length ? <ExecutionTrace steps={run.trace} /> : null;
	const listed = result.items.filter((item) => item.url).length;
	return (
		<section className="space-y-3 rounded-xl border bg-background p-4">
			{run.trace && <ExecutionTrace steps={run.trace} />}
			<div className="flex items-center gap-2 text-sm font-semibold">
				<CheckCircle2Icon className="size-4 text-emerald-700 dark:text-emerald-300" />
				{result.shop} · 已在售 {listed}/{result.items.length}
			</div>
			{result.error && (
				<p role="alert" className="text-sm text-destructive">
					{result.error}
				</p>
			)}
			<ul className="divide-y text-sm">
				{result.items.map(({ sourceId, draft, url }) => (
					<li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2" key={sourceId}>
						<span>备选 {sourceId}</span>
						{url ? (
							<a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 underline dark:text-emerald-300">
								查看商品
								<ExternalLinkIcon className="size-3" />
							</a>
						) : (
							<span className="text-muted-foreground">{draft?.pending.length ? `待核对 ${draft.pending.join("、")}` : draft?.problems || "待处理"}</span>
						)}
					</li>
				))}
			</ul>
			{result.summary && (
				<div className="markdown text-sm">
					<Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: () => null }}>
						{result.summary}
					</Markdown>
				</div>
			)}
		</section>
	);
}
