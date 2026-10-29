// 一个会话：中间是 generative 组件的流（agent 放进来的先后），右边是 interactive 组件，一个一个 tab（新放进来的那个打开；人能关掉）。
// 每 3 秒重读会话（agent 随时会往里放）。手机上两边换成上面的两个 tab
import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, fail, usePoll } from "./api.ts";
import { Generative, isGenerative } from "./generative/index.tsx";
import { Interactive, type InteractiveItem, isInteractive } from "./interactive/index.tsx";

const at = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function SessionView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
	const [session, error, reload] = usePoll(() => api.session(id), 3000, [id]);
	const mobile = useIsMobile();
	if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
	if (!session) return <Skeleton className="m-6 h-40" />;
	const stream = session.items.filter(isGenerative);
	const panel = session.items.filter(isInteractive);
	const remove = () => {
		if (confirm(`删掉会话「${session.title}」？`)) api.deleteSession(id).then(onDeleted, fail);
	};

	const flow = (
		<div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
			{stream.length ? (
				stream.map((item) => (
					<article key={item.id} className="flex flex-col gap-1">
						<time className="text-xs text-muted-foreground">{at(item.at)}</time>
						<Generative item={item} />
					</article>
				))
			) : (
				<p className="py-12 text-center text-sm text-muted-foreground">agent 还没往这里放东西</p>
			)}
		</div>
	);
	const side = panel.length ? <Panel items={panel} onClosed={reload} /> : null;

	return (
		<div className="flex h-svh min-w-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
				<SidebarTrigger />
				<h1 className="truncate text-sm font-medium">{session.title}</h1>
				<div className="grow" />
				<Button size="icon-sm" variant="ghost" aria-label="删掉会话" onClick={remove}>
					<Trash2Icon />
				</Button>
			</header>
			{!side ? (
				<div className="min-h-0 flex-1 overflow-y-auto">{flow}</div>
			) : mobile ? (
				<Tabs defaultValue="flow" className="min-h-0 flex-1 gap-0">
					<TabsList className="mx-3 mt-2">
						<TabsTrigger value="flow">内容</TabsTrigger>
						<TabsTrigger value="panel">要你填的（{panel.length}）</TabsTrigger>
					</TabsList>
					<TabsContent value="flow" className="min-h-0 overflow-y-auto">
						{flow}
					</TabsContent>
					<TabsContent value="panel" className="min-h-0">
						{side}
					</TabsContent>
				</Tabs>
			) : (
				<ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
					<ResizablePanel defaultSize="45%" minSize="25%" className="overflow-y-auto">
						{flow}
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel defaultSize="55%" minSize="30%" className="min-w-0 overflow-hidden">
						{side}
					</ResizablePanel>
				</ResizablePanelGroup>
			)}
		</div>
	);
}

function Panel({ items, onClosed }: { items: InteractiveItem[]; onClosed: () => void }) {
	const newest = [...items].sort((a, b) => b.at.localeCompare(a.at))[0]!;
	const [active, setActive] = useState(newest.id);
	const seen = useRef(newest.at);
	useEffect(() => {
		if (newest.at !== seen.current) {
			seen.current = newest.at;
			setActive(newest.id);
		}
	}, [newest]);
	const value = items.some((i) => i.id === active) ? active : newest.id;
	const close = (id: string) => api.closeItem(id).then(onClosed, fail);
	return (
		<Tabs value={value} onValueChange={(v) => setActive(String(v))} className="flex h-full min-w-0 flex-col gap-0">
			<TabsList variant="line" className="w-full justify-start overflow-x-auto border-b px-2">
				{items.map((i) => (
					<div key={i.id} className="flex flex-none items-center">
						<TabsTrigger value={i.id} className="max-w-56">
							<span className="truncate">{i.props.title ?? i.props.table}</span>
						</TabsTrigger>
						<Button size="icon-xs" variant="ghost" aria-label="关掉" className="opacity-50 hover:opacity-100" onClick={() => close(i.id)}>
							<XIcon />
						</Button>
					</div>
				))}
			</TabsList>
			{items.map((i) => (
				<TabsContent key={i.id} value={i.id} className="min-h-0 flex-1 overflow-y-auto">
					<Interactive item={i} />
				</TabsContent>
			))}
		</Tabs>
	);
}
