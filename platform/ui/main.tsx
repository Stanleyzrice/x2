// 固定工作区和临时页共用注册组件；导航与首页只显示服务端提供的引用，不读取业务数据。
import "./app.css";
import { ArrowRightIcon, FileTextIcon, HouseIcon, MessageSquareIcon, MoonIcon, PackageIcon, ReceiptIcon, StoreIcon, SunIcon } from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, type PageSummary, usePoll } from "./api.ts";
import { OrderNotifications } from "./interactable/procurement/view.tsx";
import { PageView } from "./page.tsx";

const route = () => {
	try {
		return decodeURIComponent(location.hash.slice(1));
	} catch {
		return "";
	}
};
const iconOf = (icon?: string) => (icon === "package" ? PackageIcon : icon === "message" ? MessageSquareIcon : icon === "receipt" ? ReceiptIcon : FileTextIcon);
const groupsOf = (pages: PageSummary[]) => [...new Set(pages.filter((p) => p.workspace).map((p) => p.workspace!.group ?? "工作台"))];

function App() {
	const [id, setId] = useState(route);
	const [pages, error, reload] = usePoll(api.pages, 5000, []);
	useEffect(() => {
		const on = () => setId(route());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const current = pages?.find((p) => p.id === id || p.workspace?.key === id)?.id ?? (/^\d+$/.test(id) ? id : "");
	return (
		<SidebarProvider>
			<OrderNotifications pages={pages ?? []} />
			<Nav pages={pages ?? []} active={current} />
			<SidebarInset className="min-w-0">
				{current ? (
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

function Nav({ pages, active }: { pages: PageSummary[]; active: string }) {
	const { setOpenMobile } = useSidebar();
	const entries = (list: PageSummary[]) =>
		list.map((p) => {
			const Icon = iconOf(p.workspace?.icon);
			return (
				<SidebarMenuItem key={p.id}>
					<SidebarMenuButton isActive={p.id === active} render={<a href={`#${p.workspace?.key ?? p.id}`} />} onClick={() => setOpenMobile(false)}>
						<Icon />
						<span className="truncate">{p.title}</span>
					</SidebarMenuButton>
				</SidebarMenuItem>
			);
		});
	return (
		<Sidebar>
			<SidebarHeader className="border-b px-4 py-5">
				<a href="#home" className="flex items-center gap-3">
					<span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
						<StoreIcon className="size-5" />
					</span>
					<span>
						<span className="block font-semibold tracking-tight">X2</span>
						<span className="text-xs text-muted-foreground">Commerce workspace</span>
					</span>
				</a>
			</SidebarHeader>
			<SidebarContent className="gap-1 py-2">
				<SidebarGroup>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton isActive={!active} render={<a href="#home" />} onClick={() => setOpenMobile(false)}>
								<HouseIcon />
								<span>工作台</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
				{groupsOf(pages).map((group) => (
					<SidebarGroup key={group}>
						<SidebarGroupLabel>{group}</SidebarGroupLabel>
						<SidebarMenu>{entries(pages.filter((p) => p.workspace && (p.workspace.group ?? "工作台") === group))}</SidebarMenu>
					</SidebarGroup>
				))}
				{pages.some((p) => !p.workspace) && (
					<SidebarGroup>
						<SidebarGroupLabel>临时页面</SidebarGroupLabel>
						<SidebarMenu>{entries(pages.filter((p) => !p.workspace))}</SidebarMenu>
					</SidebarGroup>
				)}
			</SidebarContent>
			<SidebarFooter className="border-t px-4 py-3">
				<div className="flex items-center justify-between gap-2">
					<p className="text-xs text-muted-foreground">事实、草稿与操作状态</p>
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
									<CardDescription>打开常用功能</CardDescription>
								</CardHeader>
								<CardContent className="space-y-2">
									{pages
										?.filter((p) => p.workspace && (p.workspace.group ?? "工作台") === group)
										.map((p) => {
											const Icon = iconOf(p.workspace?.icon);
											return (
												<a
													key={p.id}
													href={`#${p.workspace?.key}`}
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
				<App />
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	</StrictMode>,
);
