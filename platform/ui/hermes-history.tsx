import { HistoryIcon, MessageSquareIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { api, type ConversationSummary } from "./api.ts";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";
import { Spinner } from "./components/ui/spinner";
import { errorOf } from "./lib/state.ts";

const formatDate = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });

export function ConversationHistory({ active, select, onDeleted }: { active: string; select: (id: string) => void; onDeleted: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const [items, setItems] = useState<ConversationSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [target, setTarget] = useState<ConversationSummary | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	async function load() {
		setError(null);
		setItems(null);
		try {
			setItems(await api.hermesConversations());
		} catch (failure) {
			setError(errorOf(failure));
		}
	}

	async function remove() {
		if (!target || deleting) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await api.deleteHermesConversation(target.id);
			setItems((current) => current?.filter((item) => item.id !== target.id) ?? null);
			setTarget(null);
			onDeleted(target.id);
		} catch (failure) {
			setDeleteError(errorOf(failure));
		} finally {
			setDeleting(false);
		}
	}

	return (
		<Sheet
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) void load();
			}}
		>
			<SheetTrigger render={<Button size="sm" variant="ghost" aria-label="历史会话" />}>
				<HistoryIcon />
				<span className="hidden sm:inline">历史会话</span>
			</SheetTrigger>
			<SheetContent className="w-[min(24rem,calc(100vw-1.5rem))] gap-0" aria-describedby={undefined}>
				<SheetHeader className="border-b pr-12">
					<SheetTitle>历史会话</SheetTitle>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					{error ? (
						<div className="space-y-2 px-2 py-3">
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
							<Button size="sm" variant="outline" onClick={() => void load()}>
								重试
							</Button>
						</div>
					) : items === null ? (
						<p role="status" className="flex items-center gap-2 px-2 py-3 text-muted-foreground">
							<Spinner aria-hidden="true" />
							正在读取
						</p>
					) : !items.length ? (
						<p className="px-2 py-3 text-muted-foreground">还没有已保存的会话</p>
					) : (
						<ul className="space-y-1">
							{items.map((item) => (
								<li key={item.id} className="flex items-center gap-1">
									<Button
										variant={item.id === active ? "secondary" : "ghost"}
										aria-current={item.id === active ? "true" : undefined}
										className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-3 px-3 py-2 text-left"
										onClick={() => {
											select(item.id);
											setOpen(false);
										}}
									>
										<MessageSquareIcon className="text-muted-foreground" />
										<span className="min-w-0 flex-1">
											<span className="block truncate">{item.title}</span>
											<time className="block text-xs font-normal text-muted-foreground" dateTime={item.updatedAt}>
												{formatDate.format(new Date(item.updatedAt))}
											</time>
										</span>
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-muted-foreground hover:text-destructive"
										aria-label={`删除会话 ${item.title}`}
										onClick={() => {
											setDeleteError(null);
											setTarget(item);
										}}
									>
										<Trash2Icon />
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
				<Dialog open={Boolean(target)} onOpenChange={(value) => !value && !deleting && setTarget(null)}>
					<DialogContent showCloseButton={false}>
						<DialogHeader>
							<DialogTitle>删除这条会话？</DialogTitle>
							<DialogDescription>「{target?.title}」的聊天内容将永久删除。上架任务回执仍可在原商品稿中核对。</DialogDescription>
						</DialogHeader>
						{deleteError && (
							<p role="alert" className="text-sm text-destructive">
								{deleteError}
							</p>
						)}
						<DialogFooter>
							<Button variant="outline" disabled={deleting} onClick={() => setTarget(null)}>
								取消
							</Button>
							<Button variant="destructive" disabled={deleting} onClick={() => void remove()}>
								{deleting ? "正在删除…" : "删除会话"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</SheetContent>
		</Sheet>
	);
}
