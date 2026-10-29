// 目录：页面右边一列刻度，一节一道，按先后从上往下等距排（照 ~/repos/mixer 的 outline.tsx）。一节是一张卡片（审稿、设置）或一组（分组的表格）。
// 看得见的那几节（有一段在屏幕里）刻度长、颜色深，知道自己在哪、一屏看得到几节；指着的那道最长最深。两节以上、页面比一屏长才有。
// 电脑上指着刻度一会儿出整个目录，指着哪道、目录里哪条亮（目录跟着滚到看得见）；点刻度（按点的位置算）、点目录里的一条都跳过去。
// 手机上按住刻度上下拖，旁边浮出那一节，松手跳过去（往左拖开再松手就不跳）；点一下开关整个目录
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

export type Section = { id: string; label: string };

/** 刻度最疏多少像素一道（手指的疏一点，好拖）；放不下就挤密。挤到不到 DENSE 一道时隔几节画一道（看得见的、指着的照样画） */
const PITCH = { fine: 8, coarse: 12 },
	DENSE = 4;
/** 刻度列上下多出来、也算按在刻度上的地方 */
const PAD = 12;
/** 手指按住不动这么久（毫秒）也算开始拖 */
const HOLD = 300;
/** 拖着往左离开刻度这么远（像素），松手不跳 */
const AWAY = 48;
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
			let a = -1,
				b = -1;
			sections.forEach((s, i) => {
				const r = document.getElementById(s.id)?.getBoundingClientRect();
				if (!r || r.bottom <= line || r.top >= innerHeight - 24) return;
				if (a < 0) a = i;
				b = i;
			});
			setView((v) => (a < 0 ? null : v?.a === a && v.b === b ? v : { a, b }));
		};
		const later = () => {
			if (!raf) raf = requestAnimationFrame(measure);
		};
		later();
		addEventListener("scroll", later, { passive: true });
		addEventListener("resize", later);
		const ro = new ResizeObserver(later);
		ro.observe(document.body);
		return () => {
			cancelAnimationFrame(raf);
			removeEventListener("scroll", later);
			removeEventListener("resize", later);
			ro.disconnect();
		};
	}, [sections]);
	return { view, long };
}

type Pointed = { i: number; from: "rail" | "list" };

export function Outline({ sections, unit }: { sections: Section[]; unit: string }) {
	const { view, long } = useView(sections);
	const n = sections.length;
	const [coarse] = useState(() => matchMedia("(pointer: coarse)").matches);
	const pitch = Math.min(coarse ? PITCH.coarse : PITCH.fine, (innerHeight * 0.7 - 2 * PAD) / Math.max(n, 1));
	const nav = useRef<HTMLElement>(null);
	const rail = useRef<HTMLButtonElement>(null);
	// 指着的、拖到的那道；from：指着刻度（目录跟着滚过去）还是指着目录里的一条
	const [pointed, setPointed] = useState<Pointed | null>(null);
	// 手指拖着：浮出来的那一节放在哪（y，相对刻度），往左拖开了（away）
	const [drag, setDrag] = useState<{ y: number; away: boolean } | null>(null);
	const touch = useRef<{ id: number; x: number; y: number; on: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
	const last = useRef<{ i: number; away: boolean } | null>(null);
	// 拖完松手后浏览器补的那下 click 不算点
	const swallow = useRef(false);
	// 上一次按下的是什么：鼠标点刻度是跳过去，手指点一下、键盘是开关目录
	const kind = useRef("");
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	// 手指点开的目录：点到目录和刻度外面就关
	// biome-ignore lint/correctness/useExhaustiveDependencies: close 每次渲染都是新的，只跟着开关重挂
	useEffect(() => {
		if (!open) return;
		const outside = (e: globalThis.PointerEvent) => {
			if (!nav.current?.contains(e.target as Node)) close();
		};
		addEventListener("pointerdown", outside);
		return () => removeEventListener("pointerdown", outside);
	}, [open]);

	const close = () => {
		clearTimeout(timer.current);
		setOpen(false);
		setPointed(null);
	};
	// 鼠标指着刻度一会儿就开，刻度和目录都离开了一会儿就关
	const later = (o: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => (o ? setOpen(true) : close()), ms);
	};
	const enter = (e: PointerEvent) => {
		if (e.pointerType === "mouse") later(true, open ? 0 : 150);
	};
	const leave = (e: PointerEvent) => {
		if (e.pointerType === "mouse") later(false, 200);
	};

	const at = (y: number) => Math.max(0, Math.min(n - 1, Math.floor((y - (rail.current?.getBoundingClientRect().top ?? 0) - PAD) / (pitch || 1))));
	const jump = (i: number) => {
		close();
		document.getElementById(sections[i]!.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	/** 手指拖到 (x, y)：指着那道，浮出那一节 */
	const follow = (x: number, y: number) => {
		const r = rail.current?.getBoundingClientRect();
		const i = at(y);
		const away = !!r && x < r.left - AWAY;
		last.current = { i, away };
		setPointed({ i, from: "rail" });
		setDrag({ y: y - (r?.top ?? 0), away });
	};
	const end = () => {
		if (touch.current) clearTimeout(touch.current.timer);
		touch.current = null;
		last.current = null;
		setDrag(null);
		setPointed(null);
	};
	const down = (e: PointerEvent<HTMLButtonElement>) => {
		kind.current = e.pointerType;
		swallow.current = false;
		if (e.pointerType === "mouse") return;
		e.currentTarget.setPointerCapture(e.pointerId);
		const { clientX: x, clientY: y } = e;
		const t = {
			id: e.pointerId,
			x,
			y,
			on: false,
			timer: setTimeout(() => {
				if (touch.current !== t) return;
				t.on = true;
				follow(x, y);
			}, HOLD),
		};
		touch.current = t;
	};
	const move = (e: PointerEvent<HTMLButtonElement>) => {
		if (e.pointerType === "mouse") {
			const i = at(e.clientY);
			return setPointed((p) => (p?.i === i && p.from === "rail" ? p : { i, from: "rail" }));
		}
		const t = touch.current;
		if (!t || t.id !== e.pointerId) return;
		if (!t.on) {
			// 横着划：不是在拖刻度
			if (Math.abs(e.clientX - t.x) > 8 && Math.abs(e.clientX - t.x) > Math.abs(e.clientY - t.y)) return end();
			if (Math.abs(e.clientY - t.y) < 4) return;
			clearTimeout(t.timer);
			t.on = true;
		}
		follow(e.clientX, e.clientY);
	};
	const up = (e: PointerEvent<HTMLButtonElement>) => {
		const t = touch.current;
		if (!t || t.id !== e.pointerId) return;
		const l = last.current;
		if (t.on) {
			swallow.current = true;
			if (l && !l.away) jump(l.i);
		}
		end();
	};

	const lit = (i: number) => !!view && i >= view.a && i <= view.b;
	if (n < 2 || !long) return null;
	const every = pitch >= DENSE ? 1 : Math.ceil(DENSE / pitch);
	const marks = sections.flatMap((s, i) => (i % every === 0 || lit(i) || pointed?.i === i ? [{ s, i }] : []));
	// 浮出来的那一节放在手指左下；太靠下了放到左上（不被大拇指挡住）
	const above = !!drag && drag.y > 72;
	return (
		<nav ref={nav} aria-label="目录" className="fixed top-1/2 right-1 z-20 -translate-y-1/2" onPointerLeave={leave}>
			<button
				ref={rail}
				type="button"
				aria-label={`目录：${n} ${unit}`}
				className="relative block w-6 touch-none outline-hidden select-none"
				style={{ height: n * pitch + 2 * PAD }}
				onPointerEnter={enter}
				onPointerLeave={(e) => {
					if (e.pointerType === "mouse") setPointed((p) => (p?.from === "rail" ? null : p));
				}}
				onPointerDown={down}
				onPointerMove={move}
				onPointerUp={up}
				onPointerCancel={end}
				onClick={(e) => {
					if (swallow.current) {
						swallow.current = false;
						return;
					}
					// 鼠标点刻度：跳到点着的那节；手指点一下、键盘：开关目录
					if (e.detail !== 0 && kind.current === "mouse") return jump(at(e.clientY));
					if (open) close();
					else setOpen(true);
				}}
			>
				{marks.map(({ s, i }) => (
					<span
						key={s.id}
						style={{ top: PAD + (i + 0.5) * pitch }}
						className={`absolute right-1 h-0.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 ${pointed?.i === i ? "w-5 bg-kumo-contrast" : lit(i) ? "w-4 bg-kumo-subtle" : "w-1.5 bg-kumo-line"}`}
					/>
				))}
			</button>
			<div
				onPointerEnter={enter}
				className={`absolute top-1/2 right-full mr-1 w-[min(20rem,calc(100vw-3rem))] -translate-y-1/2 rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-lg transition duration-150 ease-out ${open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"}`}
			>
				<div className="px-1 pb-2">
					<div className="font-semibold">目录</div>
					<div className="text-sm text-kumo-subtle">
						{n} {unit}
					</div>
				</div>
				{open && <List sections={sections} lit={lit} pointed={pointed} onPoint={setPointed} onPick={jump} />}
			</div>
			{drag && pointed && (
				<div
					className={`pointer-events-none absolute right-full mr-2 w-max max-w-[min(18rem,calc(100vw-4rem))] rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm shadow-md ${above ? "-translate-y-full" : ""}`}
					style={{ top: above ? drag.y - 8 : drag.y + 28 }}
				>
					{drag.away ? (
						<span className="text-kumo-subtle">松手不跳</span>
					) : (
						<span className="flex gap-2">
							<span className="shrink-0 pt-px text-xs tabular-nums text-kumo-subtle">{pointed.i + 1}</span>
							<span className="line-clamp-3 min-w-0 break-words">{sections[pointed.i]?.label}</span>
						</span>
					)}
				</div>
			)}
		</nav>
	);
}

/** 整个目录：看得见的那几节字深，指着的那条亮；指着刻度时目录跟着滚到看得见；打开时先滚到正在看的那节 */
function List({
	sections,
	lit,
	pointed,
	onPoint,
	onPick,
}: {
	sections: Section[];
	lit: (i: number) => boolean;
	pointed: Pointed | null;
	onPoint: (p: Pointed | null) => void;
	onPick: (i: number) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const item = (i: number) => list.current?.children[i] as HTMLElement | undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时滚一次
	useLayoutEffect(() => {
		const i = sections.findIndex((_, i) => lit(i));
		if (i >= 0) item(i)?.scrollIntoView({ block: "center" });
		// 只在打开时滚一次
	}, []);
	const follow = pointed?.from === "rail" ? pointed.i : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着指着的那节滚
	useEffect(() => {
		if (follow !== null) item(follow)?.scrollIntoView({ block: "nearest" });
	}, [follow]);
	return (
		<div
			ref={list}
			className="flex max-h-[min(32rem,60vh)] flex-col gap-0.5 overflow-y-auto"
			onPointerLeave={(e) => e.pointerType === "mouse" && onPoint(null)}
		>
			{sections.map((s, i) => (
				<button
					key={s.id}
					type="button"
					onClick={() => onPick(i)}
					onPointerEnter={(e) => e.pointerType === "mouse" && onPoint({ i, from: "list" })}
					className={`flex gap-2.5 rounded-md px-2 py-2.5 text-left text-sm transition-colors hover:bg-kumo-tint md:py-1.5 ${pointed?.i === i ? "bg-kumo-tint" : ""} ${lit(i) ? "text-kumo-default" : "text-kumo-subtle"}`}
				>
					<span className="w-5 shrink-0 pt-px text-right text-xs tabular-nums text-kumo-subtle">{i + 1}</span>
					<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{s.label}</span>
				</button>
			))}
		</div>
	);
}
