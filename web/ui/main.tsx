// 网页（x2 web）：侧栏是会话列表（agent 开的，每 5 秒重读），地址 #会话编号；打开一个会话见 session.tsx。深浅色跟系统
import "./app.css";
import { MessageSquareIcon } from "lucide-react";
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
import { api, type SessionSummary, usePoll } from "./api.ts";
import { SessionView } from "./session.tsx";

const route = () => decodeURIComponent(location.hash.slice(1));

function App() {
	const [id, setId] = useState(route);
	const [sessions, , reload] = usePoll(api.sessions, 5000, []);
	useEffect(() => {
		const on = () => setId(route());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const current = id || sessions?.[0]?.id || "";
	return (
		<SidebarProvider>
			<Nav sessions={sessions ?? []} active={current} />
			<SidebarInset className="min-w-0">
				{current ? (
					<SessionView
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
						<p className="p-12 text-center text-sm text-muted-foreground">还没有会话：agent 用 x2 session create 开一个</p>
					</div>
				)}
			</SidebarInset>
		</SidebarProvider>
	);
}

/** 侧栏：一个会话一项，最近有动静的在上面。手机上点了一项就收 */
function Nav({ sessions, active }: { sessions: SessionSummary[]; active: string }) {
	const { setOpenMobile } = useSidebar();
	return (
		<Sidebar>
			<SidebarHeader>
				<span className="px-2 font-semibold">x2</span>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>会话</SidebarGroupLabel>
					<SidebarMenu>
						{sessions.map((s) => (
							<SidebarMenuItem key={s.id}>
								<SidebarMenuButton isActive={s.id === active} render={<a href={`#${s.id}`} />} onClick={() => setOpenMobile(false)}>
									<MessageSquareIcon />
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
