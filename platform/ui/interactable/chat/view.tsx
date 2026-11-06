// Chat 只操作已注册actions；建议与人工输入分离，确认内容绑定服务端引用。
import { ArrowLeftIcon, CheckIcon, RefreshCwIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, type Item as PageItem, usePoll } from "../../api.ts";
import { type Conversation, type Inbox, inboxSnapshots, type Suggestion, snapshotKey, type ThreadData, threadSnapshots, type Window } from "./cache.ts";
import type { Props } from "./schema.ts";

type Pending = { conversationId: string; buyerName: string | null; requestId: string; status: string; error: string | null };
type PendingInbox = { shop: string; rows: Pending[]; capturedAt: string };
type Confirmation = { token: string; display: string; contextHash: string; text: string; requestId: string };
const at = (iso: string | null) =>
	iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

function inWindow(value: string | null, window: Window | undefined, now: number, historyDays: number): boolean {
	if (!value) return false;
	const lower = Math.max(window ? Date.parse(window.from) : 0, now - (window?.days ?? historyDays) * 86_400_000);
	const upper = Math.max(window ? Date.parse(window.to) : now, now);
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp >= lower && timestamp <= upper;
}

export function View({ props, item }: { props: Props; item: PageItem }) {
	const inboxKey = snapshotKey(item.id, props.shop, props.historyDays);
	const [received, error, refresh] = usePoll(
		() => inboxSnapshots.read(inboxKey, () => api.act<Inbox>(item.id, "conversations")),
		30_000,
		[item.id, props.shop, props.historyDays],
		inboxSnapshots.peek(inboxKey),
	);
	const inbox = received?.shop === props.shop && received.window.days === props.historyDays ? received : null;
	const shownDays = inbox?.window.days ?? props.historyDays;
	const [pendingReceived, pendingReadError, refreshPending] = usePoll(() => api.act<PendingInbox>(item.id, "pending"), 30_000, [item.id, props.shop]);
	const pending = pendingReceived?.shop === props.shop ? pendingReceived : null;
	const [pendingBusy, setPendingBusy] = useState<string | null>(null),
		[pendingError, setPendingError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);
	const requestGeneration = useRef(0);
	const scopeKey = JSON.stringify([item.id, props.shop, props.historyDays]);
	const pendingScope = useRef(scopeKey);
	pendingScope.current = scopeKey;
	const activeScope = useRef(scopeKey);
	const windowRef = useRef<Window | undefined>(inbox?.window);
	windowRef.current = inbox?.window;
	const [extra, setExtra] = useState<Conversation[]>([]),
		[next, setNext] = useState<string | null | undefined>(undefined),
		[picked, setPicked] = useState<string | null>(props.conversationId ?? null);
	const [search, setSearch] = useState(""),
		[moreBusy, setMoreBusy] = useState(false),
		[localError, setLocalError] = useState<string | null>(null);
	const merged = [...new Map([...(activeScope.current === scopeKey ? extra : []), ...(inbox?.rows ?? [])].map((c) => [c.id, c])).values()];
	const rows = merged
		.filter((c) => inWindow(c.lastAt, inbox?.window, now, props.historyDays))
		.sort((a, b) => Number(b.unreplied) - Number(a.unreplied) || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
	const nextCursor = next === undefined ? inbox?.next : next;
	const selected = merged.find((c) => c.id === picked);
	const selectedExpired = Boolean(
		picked &&
			((selected?.lastAt && !inWindow(selected.lastAt, inbox?.window, now, props.historyDays)) ||
				(inbox && nextCursor === null && !rows.some((c) => c.id === picked))),
	);
	const current = selectedExpired ? null : (picked ?? rows[0]?.id ?? null);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		activeScope.current = scopeKey;
		requestGeneration.current++;
		setExtra([]);
		setNext(undefined);
		setPicked(props.conversationId ?? null);
		setLocalError(null);
		setMoreBusy(false);
		setPendingBusy(null);
		setPendingError(null);
		return () => {
			requestGeneration.current++;
		};
	}, [scopeKey, props.conversationId]);
	useEffect(() => {
		setExtra((old) => {
			const recent = old.filter((c) => inWindow(c.lastAt, inbox?.window, now, props.historyDays));
			return recent.length === old.length ? old : recent;
		});
	}, [inbox?.window, now, props.historyDays]);
	useEffect(() => {
		if (selectedExpired) setPicked(null);
	}, [selectedExpired]);
	const loadMore = async () => {
		const cursor = nextCursor;
		if (!cursor) return;
		const generation = requestGeneration.current;
		setMoreBusy(true);
		try {
			const page = await api.act<Inbox>(item.id, "conversations", { cursor });
			if (generation !== requestGeneration.current || page.shop !== props.shop) return;
			const window = windowRef.current ?? page.window;
			const recent = page.rows.filter((c) => inWindow(c.lastAt, window, Date.now(), props.historyDays));
			setExtra((old) => [...old, ...recent]);
			setNext(page.next);
			setLocalError(null);
		} catch (e) {
			if (generation === requestGeneration.current) setLocalError((e as Error).message);
		} finally {
			if (generation === requestGeneration.current) setMoreBusy(false);
		}
	};
	const reconcilePending = async (row: Pending) => {
		const scope = scopeKey;
		setPendingBusy(row.requestId);
		setPendingError(null);
		try {
			await api.act(item.id, "reconcile", { conversationId: row.conversationId, requestId: row.requestId });
			if (scope === pendingScope.current) refreshPending();
		} catch (e) {
			if (scope === pendingScope.current) setPendingError((e as Error).message);
		} finally {
			if (scope === pendingScope.current) setPendingBusy(null);
		}
	};
	const list = (
		<div className="flex h-full min-h-0 flex-col">
			<section aria-label="待核對發送" className="shrink-0 space-y-2 border-b p-3">
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-sm font-medium">待核對發送</h3>
					<Badge variant="secondary">{pending?.rows.length ?? "—"}</Badge>
					<Button aria-label="重新整理待核對發送" variant="ghost" size="icon" onClick={refreshPending}>
						<RefreshCwIcon />
					</Button>
				</div>
				{pendingReadError || pendingError ? (
					<p role="alert" className="break-words text-xs text-destructive">
						{pendingError ?? pendingReadError}
					</p>
				) : null}
				{!pending && !pendingReadError ? (
					<Skeleton className="h-8" />
				) : pending && !pending.rows.length ? (
					<p className="text-xs text-muted-foreground">沒有待核對發送</p>
				) : null}
				<div className="max-h-48 space-y-2 overflow-y-auto">
					{pending?.rows.map((row) => (
						<div key={row.requestId} className="rounded-md border p-2">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-xs font-medium">{row.buyerName || `會話 ${row.conversationId}`}</span>
								<Badge variant="outline">{row.status}</Badge>
							</div>
							{row.error ? <p className="mt-1 break-words text-xs text-muted-foreground">{row.error}</p> : null}
							<Button className="mt-2" variant="outline" size="sm" disabled={pendingBusy !== null} onClick={() => void reconcilePending(row)}>
								{pendingBusy === row.requestId ? "核對中…" : "核對結果"}
							</Button>
						</div>
					))}
				</div>
			</section>
			<div className="flex gap-2 border-b p-3">
				<Input aria-label="搜尋會話" placeholder="搜尋買家或訊息" value={search} onChange={(e) => setSearch(e.target.value)} />
				<Button
					aria-label="重新整理會話"
					size="icon"
					variant="outline"
					onClick={() => {
						requestGeneration.current++;
						setExtra([]);
						setNext(undefined);
						setMoreBusy(false);
						setLocalError(null);
						refresh();
					}}
				>
					<RefreshCwIcon />
				</Button>
			</div>
			{error || localError ? (
				<p role="alert" className="p-3 text-sm text-destructive">
					{error ?? localError}
				</p>
			) : null}
			<div className="min-h-0 grow overflow-y-auto">
				{!inbox ? (
					<Skeleton className="m-3 h-32" />
				) : (
					rows
						.filter((c) => `${c.buyer} ${c.lastText}`.includes(search))
						.map((c) => (
							<button
								key={c.id}
								type="button"
								onClick={() => setPicked(c.id)}
								className={`flex w-full flex-col gap-1 border-b p-3 text-left text-sm hover:bg-muted ${current === c.id ? "bg-muted" : ""}`}
							>
								<span className="flex items-center justify-between gap-2">
									<span className="truncate font-medium">{c.buyer || c.id}</span>
									{c.unreplied ? <Badge variant="destructive">未回覆</Badge> : c.unread ? <Badge variant="secondary">{c.unread}</Badge> : null}
								</span>
								<span className="truncate text-xs text-muted-foreground">{c.lastText}</span>
								<span className="text-xs text-muted-foreground">{at(c.lastAt)}</span>
							</button>
						))
				)}
				{inbox && !rows.length ? (
					<p className="p-4 text-sm text-muted-foreground">
						{nextCursor ? `目前已讀範圍沒有最近${shownDays}天會話，可繼續載入。` : `最近${shownDays}天沒有會話；較早記錄已移出目前頁面。`}
					</p>
				) : null}
			</div>
			{nextCursor ? (
				<Button variant="ghost" disabled={moreBusy} onClick={() => void loadMore()}>
					載入更多會話
				</Button>
			) : inbox ? (
				<p className="border-t p-3 text-xs text-muted-foreground">已到最近{shownDays}天範圍起點</p>
			) : null}
		</div>
	);
	return (
		<div className="flex h-full min-h-[38rem] flex-col">
			<div className="flex items-center gap-2 border-b px-4 py-2">
				<span className="font-medium">{props.shop}</span>
				<Badge variant="secondary">買家聊聊</Badge>
				<Badge variant="outline">最近{shownDays}天</Badge>
				<span className="text-xs text-muted-foreground">持續更新，記錄滿{shownDays}天移出目前頁面</span>
				{inbox ? <span className="ml-auto text-xs text-muted-foreground">上次讀取 {at(inbox.capturedAt)}</span> : null}
			</div>
			<div className="min-h-0 grow">
				<ResizablePanelGroup orientation="horizontal">
					<ResizablePanel defaultSize="28%" minSize="18%" className={picked ? "hidden md:block" : "block"}>
						{list}
					</ResizablePanel>
					<ResizableHandle withHandle className="hidden md:flex" />
					<ResizablePanel defaultSize="72%" minSize="45%" className={!picked ? "hidden md:block" : "block"}>
						<Button className="md:hidden" variant="ghost" onClick={() => setPicked(null)}>
							<ArrowLeftIcon />
							會話列表
						</Button>
						{current ? (
							<Thread
								key={`${item.id}:${props.shop}:${current}:${props.historyDays}`}
								item={item.id}
								shop={props.shop}
								conversationId={current}
								now={now}
								historyDays={props.historyDays}
							/>
						) : (
							<p className="p-6 text-sm text-muted-foreground">選擇一個會話</p>
						)}
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</div>
	);
}

function Thread({ item, shop, conversationId, now, historyDays }: { item: string; shop: string; conversationId: string; now: number; historyDays: number }) {
	const cacheKey = snapshotKey(item, shop, historyDays, conversationId);
	const [data, setData] = useState<ThreadData | null>(() => threadSnapshots.peek(cacheKey)),
		[error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState(false),
		[reading, setReading] = useState(false),
		[live, setLive] = useState(false);
	const [text, setText] = useState(""),
		[revision, setRevision] = useState(0),
		[dirty, setDirty] = useState(false),
		[recovery, setRecovery] = useState<string | null>(null);
	const [suggestion, setSuggestion] = useState<Suggestion | null>(null),
		[confirmation, setConfirmation] = useState<Confirmation | null>(null),
		[trial, setTrial] = useState(false),
		[uncertain, setUncertain] = useState<string | null>(null);
	const contextId = useRef<string | null>(data?.context.id ?? null),
		loading = useRef(false),
		mounted = useRef(false),
		initialized = useRef(false),
		textRef = useRef(""),
		generation = useRef(0);
	const key = data ? `x2-chat:${shop}:${data.context.shopId}:${conversationId}` : null;
	const shownDays = data?.context.window?.days ?? historyDays;
	const visibleMessages = data?.context.messages.filter((m) => inWindow(m.at, data.context.window, now, historyDays)) ?? [];
	const windowChanged = data !== null && (!data.context.window || visibleMessages.length !== data.context.messages.length);
	const load = useCallback(
		async (cursor?: string) => {
			if (loading.current) return;
			loading.current = true;
			setReading(true);
			try {
				const result = await threadSnapshots.read(cacheKey, () =>
					api.act<ThreadData>(item, "messages", {
						conversationId,
						...(contextId.current ? { contextId: contextId.current } : {}),
						...(cursor ? { cursor } : {}),
					}),
				);
				if (!mounted.current) return;
				contextId.current = result.context.id;
				setData(result);
				setLive(true);
				setError(null);
			} catch (e) {
				if (mounted.current) {
					setLive(false);
					setError((e as Error).message);
				}
			} finally {
				loading.current = false;
				if (mounted.current) setReading(false);
			}
		},
		[item, conversationId, cacheKey],
	);
	useEffect(() => {
		mounted.current = true;
		void load();
		const timer = setInterval(() => void load(), 15_000);
		return () => {
			mounted.current = false;
			generation.current++;
			clearInterval(timer);
		};
	}, [load]);
	useEffect(() => {
		if (!data || !live || initialized.current) return;
		initialized.current = true;
		let initial = data.draft.text;
		try {
			const saved = JSON.parse(localStorage.getItem(`x2-chat:${shop}:${data.context.shopId}:${conversationId}`) ?? "null") as {
				text?: string;
				revision?: number;
			} | null;
			if (typeof saved?.text === "string") {
				if (saved.revision === data.draft.revision) {
					initial = saved.text;
					setDirty(initial !== data.draft.text);
				} else if (saved.text !== initial) setRecovery(saved.text);
			}
		} catch {
			/* 不读取无法识别的本机草稿 */
		}
		setText(initial);
		textRef.current = initial;
		setRevision(data.draft.revision);
	}, [data, live, shop, conversationId]);
	const edit = (value: string) => {
		setText(value);
		textRef.current = value;
		setDirty(true);
		setConfirmation(null);
		if (key) localStorage.setItem(key, JSON.stringify({ text: value, revision }));
	};
	const persist = async () => {
		if (!data || !live || reading || !dirty) return;
		const value = textRef.current;
		const saved = await api.act<{ text: string; revision: number }>(item, "saveDraft", { conversationId, contextId: data.context.id, text: value, revision });
		setRevision(saved.revision);
		if (textRef.current === value) setDirty(false);
		if (key) localStorage.setItem(key, JSON.stringify({ text: textRef.current, revision: saved.revision }));
	};
	const perform = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const generate = async () => {
		if (!data || !live || reading || !visibleMessages.length || windowChanged) return;
		const id = ++generation.current;
		const result = await api.act<Suggestion>(item, "draft", { conversationId, contextId: data.context.id });
		if (mounted.current && generation.current === id) setSuggestion(result);
	};
	const prepare = async () => {
		if (!data || !live || reading) return;
		if (!data.context.window || data.context.messages.some((m) => !inWindow(m.at, data.context.window, Date.now(), historyDays)))
			throw new Error("讀取範圍已更新或缺少範圍，請重新讀取後確認");
		await persist();
		const body = textRef.current.trim(),
			hash = data.context.contextHash,
			requestId = crypto.randomUUID();
		const result = await api.prepare(item, "send", { conversationId, contextId: data.context.id, contextHash: hash, requestId, text: body });
		if (mounted.current && textRef.current.trim() === body) {
			setTrial(false);
			setConfirmation({ ...result, text: body, contextHash: hash, requestId });
		}
	};
	const confirm = async () => {
		if (
			!live ||
			reading ||
			!confirmation ||
			!data?.context.window ||
			confirmation.contextHash !== data.context.contextHash ||
			confirmation.text !== textRef.current.trim() ||
			data.context.messages.some((m) => !inWindow(m.at, data.context.window, Date.now(), historyDays))
		)
			throw new Error("上下文或正文已變更，請重新確認");
		const current = confirmation;
		setConfirmation(null);
		try {
			const result = await api.confirm<{ state: "completed" | "executing" | "unknown"; outcome?: { unknown: boolean } }>(current.token, trial);
			if (result.state !== "completed" || result.outcome?.unknown) setUncertain(current.requestId);
			await load();
		} catch (e) {
			setUncertain(current.requestId);
			throw e;
		}
	};
	const reconcile = async () => {
		const requestId = uncertain ?? data?.reply?.requestId;
		if (!requestId) return;
		const result = await api.act<{ status: string }>(item, "reconcile", { conversationId, requestId });
		if (!["結果未知", "结果未知", "已提交", "不一致"].includes(result.status)) setUncertain(null);
		await load();
	};
	if (!data)
		return (
			<div className="p-4">
				{error ? (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				) : (
					<Skeleton className="h-56" />
				)}
			</div>
		);
	const chosen = suggestion ?? data.suggestion,
		stale = windowChanged || chosen?.contextHash !== data.context.contextHash;
	const pending = Boolean(uncertain || (data.reply && ["已提交", "结果未知", "不一致"].includes(data.reply.status)));
	return (
		<div className="flex h-full min-h-[34rem] min-w-0 flex-col">
			<div className="flex items-center justify-between gap-2 border-b p-3">
				<div>
					<p className="font-medium">{data.context.buyerName}</p>
					<p className="text-xs text-muted-foreground">
						{data.context.buyerId} · 最近{shownDays}天 {visibleMessages.length} 則 · {at(visibleMessages[0]?.at ?? null)} —{" "}
						{at(visibleMessages.at(-1)?.at ?? null)}
						{windowChanged ? " · 讀取範圍已更新，等待重新讀取" : !data.context.range.complete ? " · 範圍內尚有較早訊息" : ` · 已到最近${shownDays}天範圍起點`}
						{` · ${live ? "讀取" : "快取"} ${at(data.context.capturedAt)}${reading ? " · 更新中…" : ""}`}
					</p>
				</div>
				<Button variant="ghost" size="icon" aria-label="重新讀取訊息" onClick={() => void load()} disabled={reading}>
					<RefreshCwIcon />
				</Button>
			</div>
			{error ? (
				<p role="alert" className="border-b p-3 text-sm text-destructive">
					{error}
				</p>
			) : null}
			<div className="min-h-32 grow">
				{data.context.nextCursor && !windowChanged ? (
					<Button className="w-full" variant="ghost" disabled={reading} onClick={() => void load(data.context.nextCursor ?? undefined)}>
						載入最近{shownDays}天內較早訊息
					</Button>
				) : null}
				<MessageScrollerProvider defaultScrollPosition="end" autoScroll>
					<MessageScroller>
						<MessageScrollerViewport>
							<MessageScrollerContent className="gap-3 p-4">
								{visibleMessages.map((m) => (
									<MessageScrollerItem key={m.id} messageId={m.id}>
										<Message align={m.sender === "us" || m.sender === "auto" ? "end" : "start"}>
											<MessageContent>
												<Bubble variant={m.sender === "us" ? "default" : "muted"}>
													<BubbleContent className="whitespace-pre-wrap break-words">{m.text}</BubbleContent>
												</Bubble>
												<MessageFooter>
													{m.sender === "auto" ? "自動回覆 · " : m.sender === "platform" ? "平台 · " : ""}
													{at(m.at)}
												</MessageFooter>
											</MessageContent>
										</Message>
									</MessageScrollerItem>
								))}
								{!visibleMessages.length ? (
									<p className="text-sm text-muted-foreground">最近{shownDays}天沒有訊息；較早記錄已移出目前頁面，人工草稿仍保留。</p>
								) : null}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						<MessageScrollerButton />
					</MessageScroller>
				</MessageScrollerProvider>
			</div>
			<div className="space-y-3 border-t p-3">
				{chosen && visibleMessages.length ? (
					<div className="rounded-lg border bg-muted/30 p-3">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">回覆建議</span>
							{stale ? (
								<Badge variant="destructive">上下文已更新</Badge>
							) : (
								<Button size="sm" variant="ghost" disabled={!live || reading} onClick={() => edit(chosen.text)}>
									採用建議
								</Button>
							)}
						</div>
						<p className="mt-2 whitespace-pre-wrap text-sm">{chosen.text}</p>
					</div>
				) : null}
				{data.reply || uncertain ? (
					<div className="flex items-center justify-between gap-2 text-xs">
						<span>
							{uncertain ? "發送結果未知" : data.reply?.status}
							{data.reply?.error ? ` · ${data.reply.error}` : ""}
						</span>
						{pending ? (
							<Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(reconcile)}>
								核對結果
							</Button>
						) : null}
					</div>
				) : null}
				{recovery !== null ? (
					<div className="text-xs text-muted-foreground">
						另有本機草稿保留。
						<Button
							size="sm"
							variant="link"
							onClick={() => {
								edit(recovery);
								setRecovery(null);
							}}
						>
							恢復本機草稿
						</Button>
					</div>
				) : null}
				<Textarea
					aria-label="人工回覆草稿"
					placeholder="編輯回覆，再確認收件方與正文"
					value={text}
					disabled={!live && !initialized.current}
					onChange={(e) => edit(e.target.value)}
					maxLength={2000}
					rows={3}
				/>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={busy || !live || reading || windowChanged || !visibleMessages.length}
						onClick={() => void perform(generate)}
					>
						<SparklesIcon />
						產生建議
					</Button>
					<Button variant="ghost" size="sm" disabled={busy || !live || reading || !dirty} onClick={() => void perform(persist)}>
						<CheckIcon />
						{dirty ? "儲存草稿" : "已儲存"}
					</Button>
					<span className="ml-auto text-xs text-muted-foreground">{text.length}/2000</span>
					<Button
						size="sm"
						disabled={busy || !live || reading || pending || windowChanged || !text.trim() || !visibleMessages.some((m) => m.sender === "buyer")}
						onClick={() => void perform(prepare)}
					>
						<SendIcon />
						確認發送
					</Button>
				</div>
			</div>
			<Dialog
				open={Boolean(confirmation)}
				onOpenChange={(open) => {
					if (!open) setConfirmation(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>確認收件方與回覆內容</DialogTitle>
					</DialogHeader>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{confirmation?.display}</pre>
					{confirmation && (windowChanged || confirmation.contextHash !== data.context.contextHash) ? (
						<p className="text-sm text-destructive">上下文已更新，請關閉後重新確認。</p>
					) : null}
					{data.trialRequired ? (
						<label htmlFor={`trial-${item}-${conversationId}`} className="flex gap-2 text-sm">
							<Checkbox id={`trial-${item}-${conversationId}`} checked={trial} onCheckedChange={(v) => setTrial(v === true)} />
							首次發送：確認這一位買家，並在 Shopee 核對結果
						</label>
					) : null}
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmation(null)}>
							取消
						</Button>
						<Button
							disabled={busy || !live || reading || windowChanged || (data.trialRequired && !trial) || confirmation?.contextHash !== data.context.contextHash}
							onClick={() => void perform(confirm)}
						>
							發送這一則
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
export const tab = (p: Props) => p.title ?? `聊聊 ${p.shop}`;
