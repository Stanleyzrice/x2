// 通用图片浏览：同组图片循环切换，保留完整比例；弹窗事件不传给表格行或底下的轮播。
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";

export type LightboxImage = { src: string; alt: string; label?: string };

export function useLightbox(images: LightboxImage[]) {
	const [index, setIndex] = useState<number | null>(null);
	const trigger = useRef<HTMLElement | null>(null);
	return {
		open: (next: number) => {
			if (!images[next]) return;
			trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			setIndex(next);
		},
		lightbox: <ImageLightbox images={images} index={index} onIndexChange={setIndex} returnFocus={trigger} />,
	};
}

export function ImageLightbox({
	images,
	index,
	onIndexChange,
	returnFocus,
}: {
	images: LightboxImage[];
	index: number | null;
	onIndexChange: (index: number | null) => void;
	returnFocus?: RefObject<HTMLElement | null>;
}) {
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const active = Math.max(0, Math.min(index ?? 0, images.length - 1));
	const image = images[active];
	if (!image) return null;
	const move = (delta: number) => onIndexChange((active + delta + images.length) % images.length);
	return (
		<Dialog open={index !== null} onOpenChange={(open) => !open && onIndexChange(null)}>
			<DialogPortal>
				<DialogOverlay className="bg-black/75" onClick={(e) => e.stopPropagation()} />
				<DialogPrimitive.Popup
					finalFocus={returnFocus}
					className="fixed inset-2 z-50 flex min-h-0 flex-col gap-3 rounded-xl bg-background p-3 text-foreground shadow-xl outline-none sm:inset-6 sm:p-4"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
							e.preventDefault();
							move(e.key === "ArrowLeft" ? -1 : 1);
						} else if (e.key === "Home" || e.key === "End") {
							e.preventDefault();
							onIndexChange(e.key === "Home" ? 0 : images.length - 1);
						}
					}}
				>
					<div className="flex shrink-0 items-center gap-2">
						<DialogTitle className="min-w-0 flex-1 truncate">{image.label ?? image.alt}</DialogTitle>
						<Button variant="ghost" size="sm" render={<a href={image.src} target="_blank" rel="noreferrer" />}>
							<ExternalLinkIcon />
							原图
						</Button>
						<DialogClose render={<Button variant="ghost" size="icon" aria-label="关闭图片浏览" />}>
							<XIcon />
						</DialogClose>
					</div>
					<div
						className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden rounded-lg bg-muted/40"
						onTouchStart={(e) => {
							const touch = e.touches[0];
							touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
						}}
						onTouchEnd={(e) => {
							const start = touchStart.current;
							const end = e.changedTouches[0];
							touchStart.current = null;
							if (!start || !end) return;
							const dx = end.clientX - start.x;
							if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(end.clientY - start.y)) move(dx > 0 ? -1 : 1);
						}}
					>
						<img src={image.src} alt={image.alt} referrerPolicy="no-referrer" draggable={false} className="h-full w-full object-contain" />
						{images.length > 1 && (
							<>
								<Button aria-label="上一张" aria-keyshortcuts="ArrowLeft" variant="outline" size="icon-lg" className="absolute left-2" onClick={() => move(-1)}>
									<ChevronLeftIcon />
								</Button>
								<Button
									aria-label="下一张"
									aria-keyshortcuts="ArrowRight"
									variant="outline"
									size="icon-lg"
									className="absolute right-2"
									onClick={() => move(1)}
								>
									<ChevronRightIcon />
								</Button>
							</>
						)}
					</div>
					<div className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
						<span aria-live="polite" aria-atomic="true" className="tabular-nums">
							{active + 1} / {images.length}
						</span>
						<span>← → 切换 · Esc 关闭</span>
					</div>
				</DialogPrimitive.Popup>
			</DialogPortal>
		</Dialog>
	);
}
