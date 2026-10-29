// 网页（x2 web）：侧栏是表（照 src/web/tables.ts 的顺序），地址 #表/视图
import { Loader, Sidebar, Toasty, useSidebar } from "@cloudflare/kumo";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Meta, toast } from "./api.ts";
import { TableView } from "./view.tsx";

const route = () => decodeURIComponent(location.hash.slice(1)).split("/") as [string?, string?];

function App() {
	const [metas, setMetas] = useState<Meta[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [[name, viewTitle], setRoute] = useState(route);
	useEffect(() => {
		api.meta().then(setMetas, (e: Error) => setError(e.message));
	}, []);
	useEffect(() => {
		const on = () => setRoute(route());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const go = (table: string, view?: string) => {
		location.hash = view ? `${table}/${view}` : table;
	};

	if (error) return <p className="p-6 text-kumo-danger">{error}</p>;
	if (!metas) return <Loader />;
	const meta = metas.find((m) => m.name === name) ?? metas[0]!;
	const view = meta.views.find((v) => v.title === viewTitle) ?? meta.views[0]!;
	return (
		<Sidebar.Provider defaultOpen collapsible="offcanvas" className="min-h-screen">
			<Nav metas={metas} active={meta.name} go={go} />
			<main className="min-w-0 flex-1">
				<TableView key={`${meta.name}/${view.title}`} meta={meta} view={view} onView={(v) => go(meta.name, v)} />
			</main>
		</Sidebar.Provider>
	);
}

/** 侧栏：一张表一项。手机上收起来，左上角的按钮打开，点了一项就收 */
function Nav({ metas, active, go }: { metas: Meta[]; active: string; go: (table: string) => void }) {
	const { isMobile, setOpenMobile } = useSidebar();
	return (
		<>
			<Sidebar className="md:sticky md:top-0 md:h-screen">
				<Sidebar.Header>
					<span className="px-2 font-semibold">x2</span>
				</Sidebar.Header>
				<Sidebar.Content>
					<Sidebar.Group>
						<Sidebar.Menu>
							{metas.map((m) => (
								<Sidebar.MenuButton
									key={m.name}
									active={m.name === active}
									onClick={() => {
										go(m.name);
										setOpenMobile(false);
									}}
								>
									{m.title}
								</Sidebar.MenuButton>
							))}
						</Sidebar.Menu>
					</Sidebar.Group>
				</Sidebar.Content>
			</Sidebar>
			{isMobile && (
				<Sidebar.Trigger aria-label="表" className="fixed top-3 left-3 z-10 rounded-lg border border-kumo-line bg-kumo-base p-2">
					<ListIcon size={18} />
				</Sidebar.Trigger>
			)}
		</>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Toasty toastManager={toast}>
			<App />
		</Toasty>
	</StrictMode>,
);
