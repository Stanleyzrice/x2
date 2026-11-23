// 固定工作区和临时页共用注册组件；导航与首页只显示服务端提供的引用，不读取业务数据。
import { errorOf } from "@/lib/state";
import "./app.css";
import {
	ActivityIcon,
	ArrowRightIcon,
	BotIcon,
	CalculatorIcon,
	FileTextIcon,
	HouseIcon,
	MessageSquareIcon,
	MoonIcon,
	PackageIcon,
	ReceiptIcon,
	SearchCheckIcon,
	Settings2Icon,
	StoreIcon,
	SunIcon,
	Trash2Icon,
} from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, type PageSummary, type SetupState, usePoll } from "./api.ts";
import { HermesChat } from "./hermes-chat.tsx";
import { OrderNotifications } from "./interactable/procurement/view.tsx";
import { PageView } from "./page.tsx";
import { preloadPage, usePagePreload } from "./preload.ts";
import { SetupPage } from "./setup.tsx";

const route = () => {
	try {
		return decodeURIComponent(location.hash.slice(1));
	} catch {
		return "";
	}
};
const iconOf = (icon?: string) =>
	(
		({
			activity: ActivityIcon,
			search: SearchCheckIcon,
			settings: Settings2Icon,
			calculator: CalculatorIcon,
			package: PackageIcon,
			message: MessageSquareIcon,
			receipt: ReceiptIcon,
		}) as Record<string, typeof FileTextIcon>
	)[icon ?? ""] ?? FileTextIcon;
const groups = ["店铺运营", "选品与上架", "履约与账务"] as const;
function pageGroup(page: PageSummary) {
	const workspace = page.workspace;
	if (workspace?.component === "procurement" || workspace?.component === "reimbursement") return groups[2];
	if (workspace?.component === "selection" || workspace?.component === "pricing-calculator" || workspace?.props.mode) return groups[1];
	return groups[0];
}
const groupsOf = (pages: PageSummary[]) => groups.filter((group) => pages.some((p) => p.workspace && pageGroup(p) === group));

function Root() {
	const [id, setId] = useState(route);
	const [setup, setSetup] = useState<SetupState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		const on = () => setId(route());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 用户点击重新连接时重新读取启动状态。
	useEffect(() => {
		let active = true;
		void api
			.setup()
			.then((value) => {
				if (active) {
					setSetup(value);
					setError(null);
				}
			})
			.catch((failure) => {
				if (active) setError(errorOf(failure));
			});
		return () => {
			active = false;
		};
	}, [retry]);
	if (!setup)
		return (
			<div className="grid min-h-svh place-items-center bg-muted/30 p-5">
				<Card className="w-full max-w-md">
					<CardContent className="space-y-3 py-6">
						<h1 className="font-semibold">X2 工作台</h1>
						{error ? (
							<>
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
								<Button
									variant="outline"
									onClick={() => {
										setError(null);
										setRetry(retry + 1);
									}}
								>
									重新连接
								</Button>
							</>
						) : (
							<Skeleton className="h-6 w-44" />
						)}
					</CardContent>
				</Card>
			</div>
		);
	if (!setup.ready || id === "setup")
		return (
			<SetupPage
				state={setup}
				onChange={setSetup}
				onEnter={() => {
					location.hash = "home";
					setId("home");
				}}
			/>
		);
	return <App id={id} setup={setup} />;
}

function App({ id, setup }: { id: string; setup: SetupState }) {
	const [pages, error, reload] = usePoll(api.pages, 5000, []);
	const current = pages?.find((p) => p.id === id || p.workspace?.key === id)?.id ?? (/^\d+$/.test(id) ? id : "");
	usePagePreload(pages ?? [], current);
	return (
		<SidebarProvider>
			<OrderNotifications pages={pages ?? []} />
			<Nav
				pages={pages ?? []}
				active={current}
				hermes={id === "hermes"}
				shop={setup.shop}
				onDeleted={(deleted) => {
					if (deleted.includes(route())) location.hash = "home";
					reload();
				}}
			/>
			<SidebarInset className="min-w-0">
				{id === "hermes" ? (
					<HermesChat
						setup={setup}
						openSettings={() => {
							location.hash = "setup";
						}}
					/>
				) : current ? (
					<PageView
						key={current}
						id={current}
						pages={pages ?? []}
						onDeleted={() => {
							location.hash = "home";
							reload();
						}}
					/>
				) : (
					<Home pages={pages} error={error} reload={reload} />
				)}
			</SidebarInset>
		</SidebarProvider>
	);
}

function Nav({
	pages,
	active,
	hermes,
	shop,
	onDeleted,
}: {
	pages: PageSummary[];
	active: string;
	hermes: boolean;
	shop: string | null;
	onDeleted: (ids: string[]) => void;
}) {
	const { setOpenMobile } = useSidebar();
	const [managing, setManaging] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const temporary = pages.filter((p) => !p.workspace);
	const picked = temporary.filter((p) => selected.has(p.id));
	const toggle = (id: string, checked: boolean) => {
		setSelected((before) => {
			const next = new Set(before);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	};
	const cancel = () => {
		setManaging(false);
		setSelected(new Set());
		setDeleteError(null);
	};
	const remove = async () => {
		if (deleting || !picked.length) return;
		if (!confirm(`删除选中的 ${picked.length} 个临时页面？\n${picked.map((p) => p.title).join("\n")}`)) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			const result = await api.deletePages(picked.map((p) => p.id));
			cancel();
			onDeleted(result.deleted);
		} catch (e) {
			setDeleteError(errorOf(e));
		} finally {
			setDeleting(false);
		}
	};
	const entries = (list: PageSummary[]) =>
		[...list]
			.sort((a, b) => (a.workspace?.order ?? 0) - (b.workspace?.order ?? 0))
			.map((p) => {
				const Icon = iconOf(p.workspace?.icon);
				return (
					<SidebarMenuItem key={p.id} className="flex items-center gap-2">
						{managing && !p.workspace && (
							<Checkbox
								className="ml-2 shrink-0"
								aria-label={`选择页面 ${p.title}`}
								checked={selected.has(p.id)}
								disabled={deleting}
								onCheckedChange={(checked) => toggle(p.id, checked === true)}
							/>
						)}
						<SidebarMenuButton
							isActive={p.id === active}
							className="h-9 data-[active=true]:bg-emerald-500/10 data-[active=true]:text-emerald-800 dark:data-[active=true]:text-emerald-200"
							render={<a href={`#${encodeURIComponent(p.workspace?.key ?? p.id)}`} />}
							onClick={() => setOpenMobile(false)}
							onMouseEnter={() => void preloadPage(p.id)}
							onFocus={() => void preloadPage(p.id)}
						>
							<Icon />
							<span className="truncate">{p.title}</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				);
			});
	return (
		<Sidebar>
			<SidebarHeader className="border-b px-4 py-4">
				<a href="#home" className="flex min-w-0 items-center gap-3">
					<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-sm font-bold tracking-tight text-background">X2</span>
					<span className="min-w-0">
						<span className="block truncate text-sm font-semibold tracking-tight">运营工作台</span>
						{shop && <span className="block truncate text-xs text-muted-foreground">{shop}</span>}
					</span>
				</a>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-1 py-2">
				<SidebarGroup>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton isActive={!active && !hermes} render={<a href="#home" />} className="h-9" onClick={() => setOpenMobile(false)}>
								<HouseIcon />
								<span>工作台</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
						<SidebarMenuItem>
							<SidebarMenuButton
								isActive={hermes}
								render={<a href="#hermes" />}
								className="h-9 font-medium data-[active=true]:bg-emerald-500/10 data-[active=true]:text-emerald-800 dark:data-[active=true]:text-emerald-200"
								onClick={() => setOpenMobile(false)}
							>
								<BotIcon />
								<span>Hermes Chat</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
				{groupsOf(pages).map((group) => (
					<SidebarGroup key={group}>
						<SidebarGroupLabel>{group}</SidebarGroupLabel>
						<SidebarMenu>{entries(pages.filter((p) => p.workspace && pageGroup(p) === group))}</SidebarMenu>
					</SidebarGroup>
				))}
				{temporary.length > 0 && (
					<SidebarGroup>
						<div className="flex items-center justify-between gap-2">
							<SidebarGroupLabel>临时页面</SidebarGroupLabel>
							<Button size="sm" variant="ghost" disabled={deleting} onClick={() => (managing ? cancel() : setManaging(true))}>
								{managing ? "取消" : "多选删除"}
							</Button>
						</div>
						{managing && (
							<div className="mb-2 space-y-2 px-2">
								<div className="flex items-center justify-between gap-2">
									<Button
										size="sm"
										variant="ghost"
										disabled={deleting}
										onClick={() => setSelected(picked.length === temporary.length ? new Set() : new Set(temporary.map((p) => p.id)))}
									>
										{picked.length === temporary.length ? "取消全选" : "全选"}
									</Button>
									<span className="text-xs text-muted-foreground">已选 {picked.length} 页</span>
								</div>
								<Button className="w-full" size="sm" variant="destructive" disabled={deleting || !picked.length} onClick={() => void remove()}>
									<Trash2Icon />
									{deleting ? "删除中…" : `删除选中（${picked.length}）`}
								</Button>
								{deleteError && (
									<p role="alert" className="text-xs text-destructive">
										{deleteError}
									</p>
								)}
							</div>
						)}
						<SidebarMenu>{entries(temporary)}</SidebarMenu>
					</SidebarGroup>
				)}
			</SidebarContent>
			<SidebarFooter className="border-t px-3 py-2">
				<div className="flex items-center justify-between gap-2">
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton render={<a href="#setup" />} onClick={() => setOpenMobile(false)}>
								<Settings2Icon />
								<span>设置</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<ThemeToggle />
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}

function Home({ pages, error, reload }: { pages: PageSummary[] | null; error: string | null; reload: () => void }) {
	return (
		<div className="flex min-h-svh flex-col bg-muted/20">
			<header className="flex h-14 items-center gap-3 border-b bg-background px-4">
				<SidebarTrigger />
				<span className="text-sm font-medium">工作台</span>
			</header>
			<main className="mx-auto w-full max-w-6xl space-y-8 p-5 md:p-10">
				{error && (
					<Card>
						<CardContent className="flex items-center justify-between gap-4 py-5">
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
							<Button variant="outline" onClick={reload}>
								重新读取
							</Button>
						</CardContent>
					</Card>
				)}
				{!pages && !error ? (
					<div className="grid gap-5 md:grid-cols-2">
						<Skeleton className="h-56" />
						<Skeleton className="h-56" />
					</div>
				) : (
					<div className="grid gap-5 md:grid-cols-2">
						{groupsOf(pages ?? []).map((group) => (
							<Card key={group} className="gap-5">
								<CardHeader>
									<div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-muted">
										<StoreIcon className="size-5" />
									</div>
									<CardTitle className="text-xl">{group}</CardTitle>
								</CardHeader>
								<CardContent className="space-y-2">
									{pages
										?.filter((p) => p.workspace && pageGroup(p) === group)
										.map((p) => {
											const Icon = iconOf(p.workspace?.icon);
											return (
												<a
													key={p.id}
													href={`#${encodeURIComponent(p.workspace!.key)}`}
													className="flex items-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
												>
													<Icon className="size-4 text-muted-foreground" />
													<span className="font-medium">{p.title}</span>
													<ArrowRightIcon className="ml-auto size-4 text-muted-foreground" />
												</a>
											);
										})}
								</CardContent>
							</Card>
						))}
					</div>
				)}
				{pages && !pages.some((p) => p.workspace) && (
					<p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">尚未注册固定工作区。</p>
				)}
			</main>
		</div>
	);
}

function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const dark = resolvedTheme === "dark";
	return (
		<Button size="icon-sm" variant="ghost" aria-label={dark ? "切换浅色模式" : "切换深色模式"} onClick={() => setTheme(dark ? "light" : "dark")}>
			{dark ? <SunIcon /> : <MoonIcon />}
		</Button>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<TooltipProvider>
				<Root />
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	</StrictMode>,
);
