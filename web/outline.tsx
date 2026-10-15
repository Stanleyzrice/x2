// 目录导航条：贴在页面右边，一节一道刻度，正在看的那道长、深。鼠标在刻度上移动，离鼠标近的刻度变长（像 Dock），
// 目录从旁边滑出来，鼠标对着的那一项高亮、滚进目录里看得见；点刻度条上任意位置跳到离鼠标最近的那一节，点目录里的一项也一样。
// 一节是一张卡片（审稿、设置）或一组（按列分组的表格）；不到两节、手机上不显示
import { useTableOfContentsActiveId } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";

export type Section = { id: string; label: string };

/** 刻度：间距（最多 10px，节多了挤一挤，整条不超过 60vh）、长度（平时、正在看的、鼠标旁边最多再长多少）、鼠标影响的范围 */
const PITCH = 10, SHORT = 10, LONG = 22, BULGE = 12, REACH = 48;

export function Outline({ sections, unit }: { sections: Section[]; unit: string }) {
	const [open, setOpen] = useState(false);
	const [mouseY, setMouseY] = useState<number | null>(null);
	const [hover, setHover] = useState<number | null>(null);
	const rail = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
	// 地址的 # 是网页的路由，不让它认
	const { activeId, selectSection } = useTableOfContentsActiveId({ ids: sections.map((s) => s.id), offset: 16, trackHash: false });
	const active = Math.max(0, sections.findIndex((s) => s.id === activeId));
	const pitch = Math.min(PITCH, (window.innerHeight * 0.6) / Math.max(sections.length, 1));

	// 目录里高亮的那一项（鼠标对着的，没有就是正在看的）滚进看得见的地方
	const shown = hover ?? active;
	useEffect(() => {
		if (open) list.current?.children[shown]?.scrollIntoView({ block: "nearest" });
	}, [open, shown]);

	if (sections.length < 2) return null;
	const go = (i: number) => {
		const id = sections[i]!.id;
		selectSection(id);
		document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	const enter = () => { clearTimeout(closing.current); setOpen(true); };
	const leave = () => { closing.current = setTimeout(() => { setOpen(false); setHover(null); }, 180); setMouseY(null); };
	// 鼠标在刻度条上：记下高度，算离它最近的那一节
	const move = (e: React.MouseEvent) => {
		const box = rail.current!.getBoundingClientRect();
		const y = e.clientY - box.top;
		setMouseY(y);
		setHover(Math.min(sections.length - 1, Math.max(0, Math.round((y - pitch / 2) / pitch))));
	};
	const width = (i: number) => {
		const base = i === active ? LONG : SHORT;
		if (mouseY === null) return base;
		const d = Math.abs(i * pitch + pitch / 2 - mouseY);
		return base + BULGE * Math.max(0, 1 - d / REACH) ** 2;
	};

	return (
		<nav aria-label="目录" className="fixed top-1/2 right-0 z-20 hidden -translate-y-1/2 md:block" onMouseEnter={enter} onMouseLeave={leave}>
			<div ref={rail} role="presentation" className="relative flex cursor-pointer flex-col items-end py-3 pr-3 pl-6"
				onMouseMove={move} onClick={() => hover !== null && go(hover)}>
				{sections.map((s, i) => (
					<div key={s.id} className="flex items-center justify-end" style={{ height: pitch }}>
						<span className={`block h-0.5 rounded-full transition-[width,background-color] duration-150 ease-out ${i === active ? "bg-kumo-contrast" : i === hover ? "bg-kumo-subtle" : "bg-kumo-line"}`}
							style={{ width: width(i) }} />
					</div>
				))}
			</div>
			<div className={`absolute top-1/2 right-full w-80 -translate-y-1/2 rounded-2xl border border-kumo-line bg-kumo-base py-4 shadow-xl transition duration-200 ease-out ${open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-3 opacity-0"}`}>
				<div className="px-5 pb-2">
					<div className="font-semibold">目录</div>
					<div className="text-sm text-kumo-subtle">{sections.length} {unit}</div>
				</div>
				<ol ref={list} className="max-h-[60vh] overflow-y-auto px-2">
					{sections.map((s, i) => (
						<li key={s.id}>
							<button type="button" onClick={() => go(i)} onMouseEnter={() => setHover(i)}
								className={`flex w-full gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-100 ${i === hover ? "bg-kumo-tint" : ""} ${i === active ? "font-medium text-kumo-default" : "text-kumo-subtle"}`}>
								<span className="w-5 shrink-0 text-right tabular-nums">{i + 1}</span>
								<span className="line-clamp-2">{s.label}</span>
							</button>
						</li>
					))}
				</ol>
			</div>
		</nav>
	);
}
