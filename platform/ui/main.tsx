// 网页（x2 web）：侧栏是页列表（agent 开的，每 5 秒重读），地址 #页编号；打开一页见 page.tsx。深浅色跟系统
import "./app.css";
import { FileTextIcon } from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	Sidebar,
	SidebarContent,
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
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, type PageSummary, usePoll } from "./api.ts";
import { PageView } from "./page.tsx";

const route = () => decodeURIComponent(location.hash.slice(1));

function App() {
	const [id, setId] = useState(route);
	const [pages, , reload] = usePoll(api.pages, 5000, []);
	useEffect(() => {
		const on = () => setId(route());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const current = id || pages?.[0]?.id || "";
	return (
		<SidebarProvider>
			<Nav pages={pages ?? []} active={current} />
			<SidebarInset className="min-w-0">
				{current ? (
					<PageView
						key={current}
						id={current}
						onDeleted={() => {
							location.hash = "";
							reload();
						}}
					/>
				) : (
					<div className="flex h-svh flex-col">
						<header className="flex h-12 items-center border-b px-3">
							<SidebarTrigger />
						</header>
						<p className="p-12 text-center text-sm text-muted-foreground">还没有页：agent 用 x2 page create 开一个</p>
					</div>
				)}
			</SidebarInset>
		</SidebarProvider>
	);
}

function Nav({ pages, active }: { pages: PageSummary[]; active: string }) {
	const { setOpenMobile } = useSidebar();
	return (
		<Sidebar>
			<SidebarHeader>
				<span className="px-2 font-semibold">x2</span>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>页</SidebarGroupLabel>
					<SidebarMenu>
						{pages.map((s) => (
							<SidebarMenuItem key={s.id}>
								<SidebarMenuButton isActive={s.id === active} render={<a href={`#${s.id}`} />} onClick={() => setOpenMobile(false)}>
									<FileTextIcon />
									<span className="truncate">{s.title}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<TooltipProvider>
			<App />
			<Toaster />
		</TooltipProvider>
	</StrictMode>,
);
