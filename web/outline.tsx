// 目录：页面右边一列刻度，一节一道，按先后从上往下等距排（照 ~/repos/mixer 的 outline.tsx）。一节是一张卡片（审稿、设置）或一组（分组的表格）。
// 看得见的那几节（有一段在屏幕里）刻度长、颜色深，知道自己在哪、一屏看得到几节；指着的那道最长最深。两节以上、页面比一屏长才有，手机上不显示。
// 指着刻度一会儿出整个目录，指着哪道、目录里哪条亮（目录跟着滚到看得见）；点刻度（按点的位置算）、点目录里的一条都跳过去
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type Section = { id: string; label: string };

/** 刻度最疏 8 像素一道，放不下就挤密；挤到不到 4 像素一道时隔几节画一道（看得见的、指着的照样画） */
const PITCH = 8, DENSE = 4;
/** 刻度列上下多出来、也算指着刻度的地方 */
const PAD = 12;
/** 屏幕顶上这一段（像素）里露出来的上一节的尾巴不算看得见 */
const READ = 96;

/** 看得见的是第 a 到第 b 节 */
type View = { a: number; b: number };

/** 看得见的那几节，和页面是不是比一屏长：滚动、大小变了重量（一帧最多一次） */
function useView(sections: Section[]) {
	const [view, setView] = useState<View | null>(null);
	const [long, setLong] = useState(false);
	useEffect(() => {
		let raf = 0;
		const measure = () => {
			raf = 0;
			setLong(document.documentElement.scrollHeight > innerHeight + 1);
			const line = Math.min(READ, innerHeight / 4);
			let a = -1, b = -1;
			sections.forEach((s, i) => {
				const r = document.getElementById(s.id)?.getBoundingClientRect();
				if (!r || r.bottom <= line || r.top >= innerHeight - 24) return;
				if (a < 0) a = i;
				b = i;
			});
			setView((v) => (a < 0 ? null : v?.a === a && v.b === b ? v : { a, b }));
		};
		const later = () => { if (!raf) raf = requestAnimationFrame(measure); };
		later();
		addEventListener("scroll", later, { passive: true });
		addEventListener("resize", later);
		const ro = new ResizeObserver(later);
		ro.observe(document.body);
		return () => { cancelAnimationFrame(raf); removeEventListener("scroll", later); removeEventListener("resize", later); ro.disconnect(); };
	}, [sections]);
	return { view, long };
}

export function Outline({ sections, unit }: { sections: Section[]; unit: string }) {
	const { view, long } = useView(sections);
	const n = sections.length;
	const pitch = Math.min(PITCH, (innerHeight * 0.7 - 2 * PAD) / Math.max(n, 1));
	const rail = useRef<HTMLButtonElement>(null);
	// 指着的那道；from：指着刻度（目录跟着滚过去）还是指着目录里的一条
	const [pointed, setPointed] = useState<{ i: number; from: "rail" | "list" } | null>(null);
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	// 指着刻度一会儿就开，刻度和目录都离开了一会儿就关
	const later = (o: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			setOpen(o);
			if (!o) setPointed(null);
		}, ms);
	};
	const enter = () => later(true, open ? 0 : 150);
	const leave = () => later(false, 200);

	const at = (y: number) => Math.max(0, Math.min(n - 1, Math.floor((y - (rail.current?.getBoundingClientRect().top ?? 0) - PAD) / (pitch || 1))));
	const jump = (i: number) => {
		clearTimeout(timer.current);
		setOpen(false);
		setPointed(null);
		document.getElementById(sections[i]!.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const lit = (i: number) => !!view && i >= view.a && i <= view.b;
	if (n < 2 || !long) return null;
	const every = pitch >= DENSE ? 1 : Math.ceil(DENSE / pitch);
	const marks = sections.flatMap((s, i) => (i % every === 0 || lit(i) || pointed?.i === i ? [{ s, i }] : []));
	return (
		<nav aria-label="目录" className="fixed top-1/2 right-1 z-20 hidden -translate-y-1/2 md:block" onPointerLeave={leave}>
			<button ref={rail} type="button" aria-label={`目录：${n} ${unit}`} className="relative block w-6 outline-hidden" style={{ height: n * pitch + 2 * PAD }}
				onPointerEnter={enter}
				onPointerMove={(e) => { const i = at(e.clientY); setPointed((p) => (p?.i === i && p.from === "rail" ? p : { i, from: "rail" })); }}
				onClick={(e) => jump(at(e.clientY))}>
				{marks.map(({ s, i }) => (
					<span key={s.id} style={{ top: PAD + (i + 0.5) * pitch }}
						className={`absolute right-1 h-0.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 ${pointed?.i === i ? "w-5 bg-kumo-contrast" : lit(i) ? "w-4 bg-kumo-subtle" : "w-1.5 bg-kumo-line"}`} />
				))}
			</button>
			<div onPointerEnter={enter}
				className={`absolute top-1/2 right-full mr-1 w-80 -translate-y-1/2 rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-lg transition duration-150 ease-out ${open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"}`}>
				<div className="px-1 pb-2">
					<div className="font-semibold">目录</div>
					<div className="text-sm text-kumo-subtle">{n} {unit}</div>
				</div>
				{open && <List sections={sections} lit={lit} pointed={pointed} onPoint={setPointed} onPick={jump} />}
			</div>
		</nav>
	);
}

/** 整个目录：看得见的那几节字深，指着的那条亮；指着刻度时目录跟着滚到看得见；打开时先滚到正在看的那节 */
function List({ sections, lit, pointed, onPoint, onPick }: { sections: Section[]; lit: (i: number) => boolean; pointed: { i: number; from: "rail" | "list" } | null; onPoint: (p: { i: number; from: "list" } | null) => void; onPick: (i: number) => void }) {
	const list = useRef<HTMLDivElement>(null);
	const item = (i: number) => list.current?.children[i] as HTMLElement | undefined;
	useLayoutEffect(() => {
		const i = sections.findIndex((_, i) => lit(i));
		if (i >= 0) item(i)?.scrollIntoView({ block: "center" });
		// 只在打开时滚一次
	}, []);
	const follow = pointed?.from === "rail" ? pointed.i : null;
	useEffect(() => { if (follow !== null) item(follow)?.scrollIntoView({ block: "nearest" }); }, [follow]);
	return (
		<div ref={list} className="flex max-h-[min(32rem,60vh)] flex-col gap-0.5 overflow-y-auto" onPointerLeave={() => onPoint(null)}>
			{sections.map((s, i) => (
				<button key={s.id} type="button" onClick={() => onPick(i)} onPointerEnter={() => onPoint({ i, from: "list" })}
					className={`flex gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-kumo-tint ${pointed?.i === i ? "bg-kumo-tint" : ""} ${lit(i) ? "text-kumo-default" : "text-kumo-subtle"}`}>
					<span className="w-5 shrink-0 pt-px text-right text-xs tabular-nums text-kumo-subtle">{i + 1}</span>
					<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{s.label}</span>
				</button>
			))}
		</div>
	);
}
