// 通过 CDP 注入的采集控件：复用现有 shadcn 组件与样式，默认折叠为可拖动悬浮球；所有采集指令只接受真实用户事件。
import "./app.css";
import { ArrowUpRightIcon, DownloadIcon, LoaderCircleIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { collectionStatusLabels } from "./interactable/catalog/source-state.ts";
import type { CollectionSession } from "./interactable/catalog/source-types.ts";

type Action = "one" | "all" | "stop" | "open";
type Send = (action: Action, url?: string) => number;
type HoverTarget = { url: string; left: number; top: number; width: number };
type Point = { x: number; y: number };
type PendingCommand = { seq: number; epoch: number };
const BALL = 44;
const EDGE = 8;
const viewportWidth = () => Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
const viewport = () => ({ width: viewportWidth(), height: window.innerHeight });
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const ballPoint = (point: Point) => ({ x: clamp(point.x, EDGE, viewportWidth() - BALL - EDGE), y: clamp(point.y, EDGE, innerHeight - BALL - EDGE) });

/** 外部只更新事实与悬停目标；同一个 React 根保留用户的拖动位置与展开状态。 */
export function mount(container: HTMLElement, send: Send): { draw(state: CollectionSession): void; hover(target: HoverTarget | null): void; dispose(): void } {
	const root = createRoot(container);
	let session: CollectionSession | null = null;
	let target: HoverTarget | null = null;
	let disposed = false;
	const render = () => {
		if (!disposed) root.render(<CollectionControl state={session} target={target} send={send} />);
	};
	render();
	return {
		draw(state) {
			// 旧回包不能撤销已经确认的排队或停止边界。
			if (session && (state.epoch < session.epoch || (state.epoch === session.epoch && state.acknowledgedSeq < session.acknowledgedSeq))) return;
			session = state;
			render();
		},
		hover(next) {
			target = next;
			render();
		},
		dispose() {
			if (!disposed) {
				disposed = true;
				root.unmount();
			}
		},
	};
}

function CollectionControl({ state, target, send }: { state: CollectionSession | null; target: HoverTarget | null; send: Send }) {
	const [position, setPosition] = useState(() => ballPoint({ x: viewportWidth() - BALL - 12, y: innerHeight - BALL - 96 }));
	const [size, setSize] = useState(viewport);
	const [expanded, setExpanded] = useState(false);
	const [panelHeight, setPanelHeight] = useState(320);
	const [pending, setPending] = useState<Map<string, PendingCommand>>(() => new Map());
	const pendingRef = useRef(pending);
	const [stopCommand, setStopCommand] = useState<PendingCommand | null>(null);
	const panel = useRef<HTMLDivElement | null>(null);
	const drag = useRef<{ pointerId: number; start: Point; origin: Point; moved: boolean } | null>(null);
	const suppressClick = useRef(false);
	const panelId = useId();
	const epoch = state?.epoch;
	const acknowledgedSeq = state?.acknowledgedSeq;
	const localWaiting = [...pending].filter(([, command]) => command.epoch === state?.epoch && command.seq > state.acknowledgedSeq);
	const stopping = Boolean(state?.stopping || (stopCommand && stopCommand.epoch === state?.epoch && stopCommand.seq > state.acknowledgedSeq));
	const working = Boolean(state?.currentUrl);
	const busy = Boolean(working || state?.queued || localWaiting.length || state?.status === "scanning" || state?.status === "collecting");
	const waitingCount = (state?.queued ?? 0) + localWaiting.filter(([url]) => !state?.pendingUrls.includes(url) && state?.currentUrl !== url).length;
	const targetWaiting = Boolean(target && (localWaiting.some(([url]) => url === target.url) || state?.pendingUrls.includes(target.url)));
	const targetWorking = Boolean(target && state?.currentUrl === target.url);
	const targetResult = target
		? state?.results.findLast((result) => (result.submittedUrl ?? result.url) === target.url || result.url === target.url)
		: undefined;
	const oneLabel = targetWorking
		? "采集中"
		: targetWaiting
			? "已排队"
			: targetResult?.status === "added"
				? "已加入备选"
				: targetResult?.status === "exists"
					? "已在备选"
					: targetResult?.status === "failed"
						? "重试采集"
						: "加入备选";
	const oneDisabled = !state || state.mode === "all" || stopping || targetWaiting || targetWorking;
	const allDisabled = !state || busy || stopping || state.mode === "all";
	const queueSummary = `待采集 ${waitingCount} · 当前采集 ${working ? 1 : 0} · 失败 ${state?.failed ?? 0}`;
	const panelWidth = Math.min(320, Math.max(0, size.width - EDGE * 2));
	const hoverWidth = target ? Math.min(target.width, Math.max(0, size.width - EDGE * 2)) : 0;
	const panelLeft = clamp(position.x + BALL - panelWidth, EDGE, size.width - panelWidth - EDGE);
	const panelTop = clamp(
		position.y >= panelHeight + EDGE + 12 ? position.y - panelHeight - 12 : position.y + BALL + 12,
		EDGE,
		size.height - panelHeight - EDGE,
	);
	useEffect(() => {
		const resize = () => {
			setSize(viewport());
			setPosition((before) => ballPoint(before));
		};
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useLayoutEffect(() => {
		if (!expanded || !panel.current) return;
		const node = panel.current;
		const observer = new ResizeObserver(() => setPanelHeight(node.getBoundingClientRect().height));
		observer.observe(node);
		return () => observer.disconnect();
	}, [expanded]);
	useEffect(() => {
		if (epoch === undefined || acknowledgedSeq === undefined) return;
		setPending((before) => {
			const next = new Map([...before].filter(([, command]) => command.epoch === epoch && command.seq > acknowledgedSeq));
			pendingRef.current = next;
			return next.size === before.size ? before : next;
		});
	}, [acknowledgedSeq, epoch]);
	const command = (event: MouseEvent, action: Action, url?: string) => {
		if (!event.nativeEvent.isTrusted) return;
		event.preventDefault();
		event.stopPropagation();
		if (!state) return;
		if (action === "one" && url) {
			const previous = pendingRef.current.get(url);
			if (
				state.mode === "all" ||
				stopping ||
				state.currentUrl === url ||
				state.pendingUrls.includes(url) ||
				(previous?.epoch === state.epoch && previous.seq > state.acknowledgedSeq)
			)
				return;
			const seq = send(action, url);
			const next = new Map(pendingRef.current).set(url, { seq, epoch: state.epoch });
			pendingRef.current = next;
			setPending(next);
		} else if (action === "stop") {
			setStopCommand({ seq: send(action), epoch: state.epoch });
		} else if (action !== "all" || !allDisabled) send(action, url);
	};
	const start = (event: PointerEvent<HTMLButtonElement>) => {
		if (!event.nativeEvent.isTrusted || event.button !== 0) return;
		event.stopPropagation();
		suppressClick.current = false;
		drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: position, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const move = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!event.nativeEvent.isTrusted || !current || current.pointerId !== event.pointerId) return;
		const dx = event.clientX - current.start.x,
			dy = event.clientY - current.start.y;
		if (Math.hypot(dx, dy) > 4) current.moved = true;
		if (current.moved) {
			event.preventDefault();
			setPosition(ballPoint({ x: current.origin.x + dx, y: current.origin.y + dy }));
		}
	};
	const finish = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!event.nativeEvent.isTrusted || !current || current.pointerId !== event.pointerId) return;
		drag.current = null;
		suppressClick.current = current.moved;
		if (current.moved) setPosition((before) => ballPoint({ x: before.x + BALL / 2 < viewportWidth() / 2 ? EDGE : viewportWidth() - BALL - EDGE, y: before.y }));
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	};
	return (
		<div className="font-sans text-foreground">
			<span className="sr-only" role="status">
				{queueSummary}
			</span>
			{target && (
				<Card
					size="sm"
					className="pointer-events-auto fixed z-50 gap-0 py-1.5 shadow-sm"
					style={{
						left: clamp(target.left, EDGE, size.width - hoverWidth - EDGE),
						top: clamp(target.top, EDGE, size.height - 44 - EDGE),
						width: hoverWidth,
					}}
				>
					<CardContent className="flex gap-1.5 px-1.5">
						<Button size="sm" className="h-7 min-w-0 px-2 text-xs" disabled={oneDisabled} onClick={(event) => command(event, "one", target.url)}>
							{targetWorking ? <LoaderCircleIcon className="size-3 animate-spin" /> : <PlusIcon className="size-3" />}
							{oneLabel}
						</Button>
						<Button size="sm" className="h-7 min-w-0 px-2 text-xs" variant="outline" disabled={allDisabled} onClick={(event) => command(event, "all")}>
							采集当前页全部
						</Button>
					</CardContent>
				</Card>
			)}
			{expanded && (
				<Card
					id={panelId}
					ref={panel}
					size="sm"
					className="pointer-events-auto fixed z-50 gap-3 shadow-lg"
					style={{ left: panelLeft, top: panelTop, width: panelWidth, maxHeight: Math.max(80, size.height - EDGE * 2), overflowY: "auto" }}
				>
					<CardHeader>
						<CardTitle>X2 采集</CardTitle>
						<CardAction>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label="收起采集面板"
								onClick={(event) => {
									if (event.nativeEvent.isTrusted) setExpanded(false);
								}}
							>
								<XIcon />
							</Button>
						</CardAction>
					</CardHeader>
					<CardContent className="space-y-3">
						<Badge variant="secondary">
							{stopping ? "正在停止采集" : localWaiting.length && !working ? "商品已排队" : state ? collectionStatusLabels[state.status] : "正在连接采集会话"}
						</Badge>
						{state?.total !== null && state?.total !== undefined && (
							<progress
								aria-label="当前页采集进度"
								value={state.processed}
								max={Math.max(1, state.total)}
								className="h-2 w-full overflow-hidden rounded-full accent-primary"
							/>
						)}
						{state && (
							<p className="text-xs leading-relaxed text-muted-foreground">
								待采集 {waitingCount} · 当前采集 {working ? 1 : 0} · 失败 {state.failed}
								<br />
								已加入 {state.added} · 已存在 {state.existing} · 已取消 {state.cancelled}
								<br />
								已处理 {state.processed}
								{state.total === null ? "" : ` / ${state.total}`}
								{state.status === "scanning" ? ` · 已发现 ${state.scanned} 件` : ""}
							</p>
						)}
						{state?.error && (
							<p role="alert" className="break-words text-xs leading-relaxed text-destructive">
								{state.error}
							</p>
						)}
						<Separator />
						<div className="flex flex-col gap-2">
							<Button size="sm" disabled={allDisabled} onClick={(event) => command(event, "all")}>
								<DownloadIcon />
								采集当前页全部
							</Button>
							<div className="grid grid-cols-2 gap-2">
								<Button size="sm" variant="outline" disabled={!state || stopping || !busy} onClick={(event) => command(event, "stop")}>
									<SquareIcon />
									{stopping ? "正在停止…" : "停止采集"}
								</Button>
								<Button size="sm" variant="outline" onClick={(event) => command(event, "open")}>
									<ArrowUpRightIcon />
									打开备选区
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>
			)}
			<Button
				className="pointer-events-auto fixed z-50 size-11 touch-none rounded-full p-0 shadow-md"
				style={{ left: position.x, top: position.y, cursor: drag.current ? "grabbing" : "grab" }}
				title={`X2采集，点击展开，可拖动 · ${queueSummary}`}
				aria-label={`X2采集，点击展开，可拖动 · ${queueSummary}`}
				aria-expanded={expanded}
				aria-controls={expanded ? panelId : undefined}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={finish}
				onPointerCancel={finish}
				onLostPointerCapture={() => {
					drag.current = null;
				}}
				onClick={(event) => {
					if (!event.nativeEvent.isTrusted) return;
					event.stopPropagation();
					if (suppressClick.current) {
						suppressClick.current = false;
						return;
					}
					setExpanded((before) => !before);
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isTrusted && event.key === "Escape") {
						event.stopPropagation();
						setExpanded(false);
					}
				}}
			>
				<span className="text-xs font-semibold">{working || state?.status === "scanning" ? <LoaderCircleIcon className="animate-spin" /> : "X2"}</span>
				{(waitingCount > 0 || Boolean(state?.failed)) && (
					<Badge
						variant={waitingCount ? "secondary" : "destructive"}
						className="pointer-events-none absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[10px]"
						aria-hidden="true"
					>
						{waitingCount || state?.failed}
					</Badge>
				)}
			</Button>
		</div>
	);
}
