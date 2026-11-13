// 人工采集页面管理当前浏览器的采集会话与进度；外站控件独立注入，采集结果使备选缓存失效。
import { ArrowUpRightIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type Item, usePoll } from "../../api.ts";
import { withCurrentBrowserMarker } from "../../browser-connection.tsx";
import { collectionStatusLabels, errorOf, remember, saved } from "./source-state.ts";
import type { CollectionSession, SourcePlatform } from "./source-types.ts";

function ErrorMessage({ children }: { children: string | null | undefined }) {
	return children ? (
		<p role="alert" className="rounded-lg border border-destructive/30 bg-background p-3 text-sm text-destructive">
			{children}
		</p>
	) : null;
}

export function Collector({ item }: { item: Item }) {
	const storageKey = `x2-collection:${item.id}`;
	const [sessionId, setSessionId] = useState(() => saved(storageKey));
	const [opened, setOpened] = useState<CollectionSession | null>(null);
	const [choosing, setChoosing] = useState(true);
	const [opening, setOpening] = useState<SourcePlatform | null>(null);
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const [current, pollError, reload] = usePoll(
		() => (sessionId ? api.act<CollectionSession>(item.id, "collectionState", { sessionId }) : Promise.resolve(null)),
		2000,
		[item.id, sessionId],
		opened,
	);
	const session = current?.id === sessionId ? current : opened?.id === sessionId ? opened : null;
	const processed = session?.processed;
	const observedSessionId = session?.id;
	const observedCollection = useRef<{ id: string; processed: number } | null>(null);
	useEffect(() => {
		if (!observedSessionId || processed === undefined) return;
		const previous = observedCollection.current;
		if (previous?.id === observedSessionId && previous.processed !== processed) api.invalidateSources();
		observedCollection.current = { id: observedSessionId, processed };
	}, [observedSessionId, processed]);
	const open = async (platform: SourcePlatform) => {
		if (pending.current) return;
		pending.current = true;
		setOpening(platform);
		setError(null);
		try {
			const result = await withCurrentBrowserMarker((input) => api.act<CollectionSession>(item.id, "collectionOpen", { platform, ...input }));
			setOpened(result);
			setSessionId(result.id);
			remember(storageKey, result.id);
			setChoosing(false);
		} catch (e) {
			setError(errorOf(e));
		} finally {
			pending.current = false;
			setOpening(null);
		}
	};
	const stop = async () => {
		if (!session || stopping) return;
		setStopping(true);
		setError(null);
		try {
			setOpened(await api.act<CollectionSession>(item.id, "collectionStop", { sessionId: session.id }));
			reload();
		} catch (e) {
			setError(errorOf(e));
		} finally {
			setStopping(false);
		}
	};
	return (
		<main className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<h2 className="text-2xl font-semibold tracking-tight">人工采集</h2>
				<Button variant="outline" render={<a href="#listing-candidates" />}>
					打开备选区
					<ArrowUpRightIcon />
				</Button>
			</div>
			<ErrorMessage>{error ?? pollError}</ErrorMessage>
			<section className="rounded-xl border bg-background p-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h3 className="font-semibold">选择采购平台</h3>
					<Button onClick={() => setChoosing(true)} disabled={opening !== null}>
						打开平台
						<ArrowUpRightIcon />
					</Button>
				</div>
			</section>
			{session && <CollectionProgress session={session} stopping={stopping} stop={stop} />}
			<Dialog open={choosing} onOpenChange={(next) => !opening && setChoosing(next)}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>选择采购平台</DialogTitle>
						<DialogDescription className="sr-only">选择要打开的采购平台。</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						{(["1688"] as const).map((platform) => (
							<Button
								key={platform}
								variant="outline"
								className="h-auto flex-col items-start gap-3 px-5 py-6 text-left"
								onClick={() => void open(platform)}
								disabled={opening !== null}
							>
								<span className="text-xl font-semibold">{platform}</span>
								<span className="mt-1 flex items-center gap-2">
									{opening === platform ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpRightIcon />}
									{opening === platform ? "正在打开…" : "打开平台"}
								</span>
							</Button>
						))}
					</div>
					<ErrorMessage>{error}</ErrorMessage>
				</DialogContent>
			</Dialog>
		</main>
	);
}

function CollectionProgress({ session, stopping, stop }: { session: CollectionSession; stopping: boolean; stop: () => Promise<void> }) {
	const active = session.stopping || ["browsing", "scanning", "collecting"].includes(session.status);
	return (
		<section className="space-y-4 rounded-xl border bg-background p-5" aria-live="polite">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="font-semibold">{session.stopping ? "正在停止采集" : collectionStatusLabels[session.status]}</h3>
				{active && (
					<Button variant="outline" size="sm" onClick={() => void stop()} disabled={stopping || session.stopping}>
						<SquareIcon />
						{stopping || session.stopping ? "正在停止…" : "停止采集"}
					</Button>
				)}
			</div>
			{session.total !== null && (
				<progress
					aria-label="商品采集进度"
					value={session.processed}
					max={Math.max(1, session.total)}
					className="h-2 w-full overflow-hidden rounded-full accent-primary"
				/>
			)}
			<p className="text-sm">
				待采集 {session.queued} · 当前采集 {session.currentUrl ? 1 : 0} · 失败 {session.failed}
			</p>
			<p className="text-sm">
				已加入 {session.added} · 已存在 {session.existing} · 已取消 {session.cancelled} · 已处理 {session.processed}
				{session.total === null ? "" : ` / ${session.total}`}
			</p>
			{session.status === "scanning" && <p className="text-xs text-muted-foreground">正在加载本页商品，已发现 {session.scanned} 件。</p>}
			<ErrorMessage>{session.error}</ErrorMessage>
		</section>
	);
}
