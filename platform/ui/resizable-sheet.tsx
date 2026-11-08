// 在侧栏外层控制宽度和拖动区，沿用 Sheet 的焦点管理与关闭行为；宽度偏好只保存在当前浏览器。
import { type ComponentProps, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { SheetContent } from "./components/ui/sheet";

type Props = Omit<ComponentProps<typeof SheetContent>, "side"> & {
	storageKey: string;
	defaultWidth?: number;
	minWidth?: number;
};

function storedWidth(key: string, fallback: number): number {
	try {
		const value = Number(localStorage.getItem(key));
		return Number.isFinite(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

export function ResizableSheetContent({ storageKey, defaultWidth = 672, minWidth = 400, children, style, className, ...props }: Props) {
	const [width, setWidth] = useState(() => storedWidth(storageKey, defaultWidth));
	const [viewport, setViewport] = useState(() => window.innerWidth);
	const [dragging, setDragging] = useState(false);
	const stopDrag = useRef<(() => void) | null>(null);
	const handleRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) stopDrag.current?.();
	}, []);
	const scrollId = useId();
	const maximum = Math.max(0, viewport - 32);
	const minimum = Math.min(minWidth, maximum);
	const shownWidth = viewport < 640 ? viewport : Math.max(minimum, Math.min(width, maximum));

	useEffect(() => {
		const resized = () => setViewport(window.innerWidth);
		window.addEventListener("resize", resized);
		return () => {
			window.removeEventListener("resize", resized);
			stopDrag.current?.();
		};
	}, []);
	useEffect(() => setWidth(storedWidth(storageKey, defaultWidth)), [storageKey, defaultWidth]);

	const remember = (next: number) => {
		setWidth(next);
		try {
			localStorage.setItem(storageKey, String(next));
		} catch {
			// 浏览器禁用本地存储时仍可调整当前侧栏。
		}
	};
	const startDrag = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || viewport < 640) return;
		event.preventDefault();
		event.stopPropagation();
		stopDrag.current?.();
		const handle = event.currentTarget;
		const pointerId = event.pointerId;
		const startX = event.clientX;
		const startWidth = shownWidth;
		const previousCursor = document.body.style.cursor;
		const previousSelection = document.body.style.userSelect;
		let nextWidth = shownWidth;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		handle.focus();
		handle.setPointerCapture(pointerId);
		setDragging(true);
		const move = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId !== pointerId) return;
			const limit = Math.max(0, window.innerWidth - 32);
			nextWidth = Math.max(Math.min(minWidth, limit), Math.min(startWidth + startX - pointer.clientX, limit));
			setWidth(nextWidth);
		};
		const finish = () => {
			stopDrag.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", ended);
			window.removeEventListener("pointercancel", ended);
			window.removeEventListener("blur", finish);
			if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousSelection;
			setDragging(false);
			remember(nextWidth);
		};
		const ended = (pointer: globalThis.PointerEvent) => {
			if (pointer.pointerId === pointerId) finish();
		};
		stopDrag.current = finish;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", ended);
		window.addEventListener("pointercancel", ended);
		window.addEventListener("blur", finish);
	};
	const keyboardResize = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 80 : 20;
		const next =
			event.key === "ArrowLeft"
				? shownWidth + step
				: event.key === "ArrowRight"
					? shownWidth - step
					: event.key === "Home"
						? minimum
						: event.key === "End"
							? maximum
							: null;
		if (next === null) return;
		event.preventDefault();
		remember(Math.max(minimum, Math.min(next, maximum)));
	};

	return (
		<SheetContent
			{...props}
			side="right"
			className={className}
			style={{ ...style, width: shownWidth, maxWidth: "100vw", overflow: "hidden", gap: 0, transitionProperty: dragging ? "none" : "transform, opacity" }}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: 这是可拖动、可键盘操作且包含抓手的分隔器，hr 无法包含可见抓手。 */}
			<div
				ref={handleRef}
				role="separator"
				tabIndex={0}
				aria-label="调整侧栏宽度"
				aria-orientation="vertical"
				aria-controls={scrollId}
				aria-valuemin={minimum}
				aria-valuemax={maximum}
				aria-valuenow={shownWidth}
				aria-valuetext={`${Math.round(shownWidth)} 像素`}
				title="拖动调整宽度；左右方向键微调；双击恢复默认宽度"
				className="absolute inset-y-0 left-0 z-10 hidden w-3 touch-none cursor-col-resize items-center justify-center outline-none hover:bg-primary/5 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex"
				onPointerDown={startDrag}
				onLostPointerCapture={() => stopDrag.current?.()}
				onKeyDown={keyboardResize}
				onDoubleClick={() => remember(defaultWidth)}
			>
				<span className="h-10 w-1 rounded-full bg-border" />
			</div>
			<div id={scrollId} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{children}
			</div>
		</SheetContent>
	);
}
