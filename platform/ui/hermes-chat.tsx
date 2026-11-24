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
	SearchIcon,
	Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ToolTraceStep } from "../web/hermes.ts";
import type { ConversationEntry, HistoryMessage } from "../web/hermes-history.ts";
import { ApiError, api, type Conversation, type HermesRequest, type HermesRun, type SetupState } from "./api.ts";
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
import { ConversationHistory } from "./hermes-history.tsx";
import { attachmentLimit, chatAttachmentText, flashModel, type HermesAttachment, hermesModels, modelLabels, quoteLimit } from "./hermes-schema.ts";
import { errorOf } from "./lib/state.ts";

type Batch = { shop: string; sourceIds: string[]; notes?: string };
type LegacySession = { turns: HistoryMessage[]; awaiting: HermesRequest | null; lastPublish: HermesRun | null };
const sessionKey = "x2-hermes-session";
const activeKey = "x2bot-active-conversation";
const importKey = "x2bot-import-conversation";
const handoffKey = "x2-hermes-listing-handoff";
const modelKey = "x2-hermes-model";

function stored<T>(key: string): T | null {
	try {
		return JSON.parse(sessionStorage.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

function saveStorage(key: string, value: unknown) {
	try {
		if (value === null) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		// 浏览器配额不足时，已提交的会话仍从数据库读取。
	}
}

export function openHermesForBatch(batch: Batch) {
	saveStorage(handoffKey, batch);
	location.hash = "x2bot";
}

function legacyImport() {
	const value = stored<LegacySession>(sessionKey);
	if (!value) return null;
	const runIds = [...new Set([value.lastPublish?.id, value.awaiting?.id].filter((id): id is string => Boolean(id)))];
	const turns = value.turns ?? [];
	if (!turns.length && !runIds.length) return null;
	const id = stored<string>(importKey) ?? crypto.randomUUID();
	return { id, turns, runIds };
}

const shortcuts = [
	{ label: "查看选品策略", message: "请列出当前店铺可用的选品策略和最近的选品结果。", icon: SearchIcon },
	{ label: "查看上架流程", message: "请用 X2 工具读取现有上架流程，概括从备选到发布的步骤。", icon: ListChecksIcon },
	{ label: "检查最近商品稿", message: "请用 X2 工具查看当前店铺最近的商品稿，概括已发布和还需处理的项目。", icon: FileSearchIcon },
] as const;

export function HermesChat({ setup, openSettings }: { setup: SetupState; openSettings: () => void }) {
	const [legacy] = useState(() => (setup.local ? legacyImport() : null));
	const [active, setActive] = useState(() => (setup.local ? (stored<string>(activeKey) ?? legacy?.id ?? crypto.randomUUID()) : ""));
	const [importing, setImporting] = useState(Boolean(legacy));
	const [importError, setImportError] = useState<string | null>(null);
	const [importAttempt, retryImport] = useState(0);
	useEffect(() => {
		saveStorage(activeKey, active || null);
	}, [active]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 重试使用同一份旧会话和导入编号。
	useEffect(() => {
		if (!legacy) return;
		let current = true;
		saveStorage(importKey, legacy.id);
		void api
			.importHermesConversation(legacy)
			.then(() => {
				saveStorage(sessionKey, null);
				saveStorage(importKey, null);
				if (current) setImportError(null);
			})
			.catch((failure) => {
				if (current) setImportError(errorOf(failure));
			})
			.finally(() => {
				if (current) setImporting(false);
			});
		return () => {
			current = false;
		};
	}, [legacy, importAttempt]);

	if (active === legacy?.id && (importing || importError))
		return (
			<div className="grid min-h-svh place-items-center bg-muted/20 p-5">
				<div className="w-full max-w-sm space-y-4 rounded-xl border bg-background p-5 text-sm">
					{importError ? (
						<>
							<p role="alert">旧会话导入失败。{importError}</p>
							<div className="flex gap-2">
								<Button
									onClick={() => {
										setImporting(true);
										retryImport(importAttempt + 1);
									}}
								>
									重试导入
								</Button>
								<Button variant="outline" onClick={() => setActive(crypto.randomUUID())}>
									新对话
								</Button>
							</div>
						</>
					) : (
						<p role="status" className="flex gap-2">
							<Spinner aria-hidden="true" />
							正在导入此标签页的对话
						</p>
					)}
				</div>
			</div>
		);
	return <ConversationChat key={active} id={active} setup={setup} openSettings={openSettings} select={setActive} />;
}

function ConversationChat({ id, setup, openSettings, select }: { id: string; setup: SetupState; openSettings: () => void; select: (id: string) => void }) {
	const pendingKey = `x2bot-unconfirmed:${id}`;
	const [conversation, setConversation] = useState<Conversation | null | undefined>();
	const [pendingRequest, setPendingRequest] = useState(() => stored<HermesRequest>(pendingKey));
	const [batch, setBatch] = useState(() => stored<Batch>(handoffKey));
	const [message, setMessage] = useState("");
	const [attachments, setAttachments] = useState<HermesAttachment[]>([]);
	const [reading, setReading] = useState(false);
	const [model, setSelectedModel] = useState(() => {
		const previous = sessionStorage.getItem(modelKey);
		return hermesModels.find((value) => value === previous) ?? hermesModels.find((value) => value === setup.model) ?? flashModel;
	});
	const [error, setError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [trial, setTrial] = useState(false);
	const [pollAttempt, retryPoll] = useState(0);
	const [liveTrace, setLiveTrace] = useState<ToolTraceStep[]>([]);
	const [streamText, setStreamText] = useState("");
	const sending = useRef(false);
	const activeRun = conversation?.pending;
	const runningId = activeRun?.id;
	const blocked = !setup.hermes || !setup.local;
	const busy = (setup.local && conversation === undefined) || Boolean(activeRun || pendingRequest) || submitting || reading;
	const refresh = useCallback(async () => {
		const next = await api.hermesConversation(id);
		setConversation(next);
		setLoadError(null);
		return next;
	}, [id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 重新读取时重新启动读取和进度监听。
	useEffect(() => {
		if (!setup.local) return;
		let current = true;
		void api
			.hermesConversation(id)
			.then((next) => {
				if (!current) return;
				setConversation(next);
				setLoadError(null);
			})
			.catch((failure) => {
				if (current) setLoadError(errorOf(failure));
			});
		return () => {
			current = false;
		};
	}, [id, setup.local, pollAttempt]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 手动重新读取时重新订阅同一任务。
	useEffect(() => {
		if (!runningId) return;
		let current = true;
		const events = new EventSource(api.hermesEvents(runningId));
		events.addEventListener("snapshot", (event: MessageEvent<string>) => {
			const snapshot: { text: string; trace: ToolTraceStep[] } = JSON.parse(event.data);
			setStreamText(snapshot.text);
			setLiveTrace(snapshot.trace);
			setLoadError(null);
		});
		events.addEventListener("delta", (event: MessageEvent<string>) => {
			const delta: string = JSON.parse(event.data);
			setStreamText((text) => text + delta);
		});
		events.addEventListener("reset", () => setStreamText(""));
		events.addEventListener("tool", (event: MessageEvent<string>) => {
			const step: ToolTraceStep = JSON.parse(event.data);
			setLiveTrace((steps) => (steps.some((entry) => entry.id === step.id) ? steps.map((entry) => (entry.id === step.id ? step : entry)) : [...steps, step]));
		});
		events.addEventListener("done", () => {
			events.close();
			void api
				.hermesConversation(id)
				.then((next) => {
					if (!current) return;
					setConversation(next);
					setLoadError(next?.pending?.id === runningId ? "任务回执尚未更新，请重新读取" : null);
				})
				.catch((failure) => {
					if (current) setLoadError(errorOf(failure));
				});
		});
		events.onerror = () => {
			if (current) setLoadError("回复连接暂时中断，正在重新连接");
		};
		return () => {
			current = false;
			events.close();
		};
	}, [id, runningId, pollAttempt]);

	useEffect(() => {
		if (!pendingRequest || !conversation) return;
		if (conversation.pending?.id === pendingRequest.id || conversation.entries.some((entry) => entry.id === `user-${pendingRequest.id}`)) {
			saveStorage(pendingKey, null);
			setPendingRequest(null);
		}
	}, [conversation, pendingRequest, pendingKey]);

	async function launch(request: HermesRequest) {
		if (sending.current) return;
		sending.current = true;
		setSubmitting(true);
		setError(null);
		setLiveTrace([]);
		setStreamText("");
		setPendingRequest(request);
		saveStorage(pendingKey, request);
		let accepted = false;
		try {
			await api.startHermes(request);
			accepted = true;
			await refresh();
			setPendingRequest(null);
			saveStorage(pendingKey, null);
		} catch (failure) {
			setError(errorOf(failure));
			if (!accepted && failure instanceof ApiError && failure.status === 400) {
				setPendingRequest(null);
				saveStorage(pendingKey, null);
				if (request.kind === "chat") {
					setMessage(request.message);
					setAttachments(request.attachments ?? []);
				} else {
					const original = { shop: request.shop, sourceIds: request.sourceIds, notes: request.notes };
					setBatch(original);
					saveStorage(handoffKey, original);
				}
				await refresh().catch(() => {});
			}
		} finally {
			sending.current = false;
			setSubmitting(false);
		}
	}

	const send = (value: string) => {
		const content = value.trim();
		if (busy || blocked || (!content && !attachments.length)) return;
		setMessage("");
		setAttachments([]);
		void launch({ kind: "chat", id: crypto.randomUUID(), conversationId: id, message: content, model, history: [], attachments });
	};
	const publish = () => {
		if (!batch || busy || blocked) return;
		const request: HermesRequest = { kind: "publish", id: crypto.randomUUID(), conversationId: id, ...batch, confirmed: true, trial, model };
		saveStorage(handoffKey, null);
		setBatch(null);
		setConfirm(false);
		setTrial(false);
		void launch(request);
	};
	const entries: ConversationEntry[] = conversation?.entries ?? [];
	const optimistic =
		pendingRequest?.kind === "chat" && !entries.some((entry) => entry.id === `user-${pendingRequest.id}`)
			? [
					...entries,
					{
						id: `user-${pendingRequest.id}`,
						role: "user" as const,
						content: pendingRequest.message,
						context: chatAttachmentText(pendingRequest.attachments ?? []),
					},
				]
			: entries;
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
				{conversation && <span className="hidden min-w-0 truncate border-l pl-3 text-sm text-muted-foreground md:block">{conversation.title}</span>}
				{setup.local && (
					<div className="ml-auto flex shrink-0 items-center gap-1">
						<ConversationHistory
							active={id}
							select={select}
							onDeleted={(removed) => {
								saveStorage(`x2bot-unconfirmed:${removed}`, null);
								if (removed === id) select(crypto.randomUUID());
							}}
						/>
						<Button size="sm" variant="ghost" onClick={() => select(crypto.randomUUID())}>
							<PlusIcon />
							新对话
						</Button>
					</div>
				)}
			</header>
			<div className="min-h-0 flex-1">
				<MessageScrollerProvider autoScroll defaultScrollPosition="end">
					<MessageScroller>
						<MessageScrollerViewport aria-label="x2bot 对话消息">
							<MessageScrollerContent className="mx-auto max-w-4xl gap-5 px-4 py-6 sm:px-8 sm:py-9">
								{!optimistic.length && !activeRun && !pendingRequest && (
									<MessageScrollerItem messageId="welcome" className="flex flex-1">
										<Empty className="mx-auto max-w-xl flex-1 items-start px-0 py-8">
											<EmptyHeader className="max-w-none items-start text-left">
												<EmptyMedia variant="icon">
													<BotIcon />
												</EmptyMedia>
												<EmptyTitle className="text-2xl tracking-tight sm:text-3xl">今天要处理什么？</EmptyTitle>
												<EmptyDescription>按策略寻找货源、查询选品结果，或继续处理商品稿。</EmptyDescription>
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
								{optimistic.map((turn) =>
									turn.role === "task" ? (
										<MessageScrollerItem key={turn.id} messageId={turn.id}>
											<TaskReceipt run={turn.run} />
										</MessageScrollerItem>
									) : (
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
									),
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
								{(activeRun || submitting) && (
									<MessageScrollerItem messageId={`assistant-${activeRun?.id ?? pendingRequest?.id ?? "pending"}`}>
										<Message className="items-start gap-3">
											<MessageAvatar className="mt-1 size-8 self-start">
												<BotIcon className="size-4" />
											</MessageAvatar>
											<MessageContent className="gap-2">
												<ExecutionTrace steps={liveTrace.length ? liveTrace : (activeRun?.trace ?? [])} running />
												{streamText && (
													<div className="markdown text-sm leading-6 wrap-anywhere">
														<Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: () => null }}>
															{streamText}
														</Markdown>
														<span aria-hidden="true" className="inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" />
													</div>
												)}
											</MessageContent>
										</Message>
									</MessageScrollerItem>
								)}
								{(error || loadError || (pendingRequest && !submitting && !activeRun)) && (
									<MessageScrollerItem messageId="chat-error">
										<div
											role="alert"
											className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/20 bg-background p-3 text-sm text-destructive"
										>
											{loadError ?? error ?? "上次提交结果待核对"}
											{loadError ? (
												<Button variant="outline" size="sm" onClick={() => retryPoll(pollAttempt + 1)}>
													重新读取
												</Button>
											) : (
												pendingRequest &&
												!submitting &&
												!activeRun && (
													<Button variant="outline" size="sm" onClick={() => void launch(pendingRequest)}>
														核对原请求
													</Button>
												)
											)}
										</div>
									</MessageScrollerItem>
								)}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						{(optimistic.length > 0 || activeRun || pendingRequest || batch) && <MessageScrollerButton aria-label="回到最新消息" />}
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
						setModel={(value) => {
							setSelectedModel(value);
							sessionStorage.setItem(modelKey, value);
						}}
						attachments={attachments}
						setAttachments={setAttachments}
						busy={busy}
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
	selection_workbench: "查看选品策略和任务",
	selection_start: "启动策略选品",
	selection_result: "读取选品结果",
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

function TaskReceipt({ run }: { run: HermesRun }) {
	const result = run.result && "items" in run.result ? run.result : null;
	if (!result)
		return (
			<section className="space-y-2 rounded-xl border bg-background p-4">
				<p className="text-sm text-muted-foreground">{run.error ?? "任务已中断"}</p>
				{run.trace.length > 0 && <ExecutionTrace steps={run.trace} />}
			</section>
		);
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
