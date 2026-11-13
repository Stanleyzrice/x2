// 商品描述按 Shopee 原文与图片顺序展示；图片中的信息保留在原图中，不推测或补写规格。
import { ImageOffIcon } from "lucide-react";
import { useState } from "react";
import { useLightbox } from "@/components/lightbox";
import type { Product } from "./types.ts";

export function DetailImage({ src, label, open, thumbnail = false }: { src: string; label: string; open: () => void; thumbnail?: boolean }) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	if (failedSrc === src)
		return (
			<div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-muted/30 p-5 text-xs text-muted-foreground">
				<ImageOffIcon className="size-5" />
				<p>{label}暂时无法加载</p>
				<a href={src} target="_blank" rel="noreferrer" className="underline underline-offset-4">
					打开原图
				</a>
			</div>
		);
	return (
		<button
			type="button"
			className={`block overflow-hidden rounded-lg border bg-muted/20 outline-none focus-visible:ring-2 focus-visible:ring-ring ${thumbnail ? "size-24 shrink-0" : "w-full"}`}
			aria-label={`放大${label}`}
			onClick={open}
		>
			<img
				src={src}
				alt={label}
				loading="lazy"
				referrerPolicy="no-referrer"
				className={thumbnail ? "h-full w-full object-contain" : "mx-auto h-auto max-w-full"}
				onError={() => setFailedSrc(src)}
			/>
		</button>
	);
}

export function DetailsContent({
	product,
	reading,
	sourceLabel = "Shopee",
}: {
	product: Pick<Product, "productImages" | "description" | "sizeChartImage" | "detailReadAt">;
	reading: boolean;
	sourceLabel?: string;
}) {
	const images = [...new Set(product.productImages ?? [])];
	const description = product.description;
	const blocks = description?.blocks ?? [];
	const photos = [
		...images.map((src, index) => ({ src, alt: `商品图 ${index + 1}`, label: `${sourceLabel} · 商品图 ${index + 1}` })),
		...blocks
			.filter((block) => block.type === "image")
			.map((block, index) => ({ src: block.src, alt: `详情图 ${index + 1}`, label: `${sourceLabel} · 详情图 ${index + 1}` })),
		...(product.sizeChartImage ? [{ src: product.sizeChartImage, alt: "尺码表", label: `${sourceLabel} · 尺码表` }] : []),
	];
	const lightbox = useLightbox(photos);
	const occurrences = new Map<string, number>();
	let descriptionImage = 0;
	return (
		<>
			{images.length > 0 && (
				<section className="space-y-3" aria-label="商品图片">
					<h3 className="text-sm font-semibold">商品图片</h3>
					<div className="flex flex-wrap gap-2">
						{images.map((src, index) => (
							<DetailImage key={src} src={src} label={`商品图 ${index + 1}`} open={() => lightbox.open(index)} thumbnail />
						))}
					</div>
				</section>
			)}
			<section className="space-y-3" aria-label="商品描述与详情图">
				<h3 className="text-sm font-semibold">商品描述与详情图</h3>
				{blocks.map((block) => {
					const content = JSON.stringify(block);
					const occurrence = occurrences.get(content) ?? 0;
					occurrences.set(content, occurrence + 1);
					const key = `${content}:${occurrence}`;
					if (block.type === "text")
						return (
							<p key={key} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
								{block.text}
							</p>
						);
					const photoIndex = images.length + descriptionImage++;
					return <DetailImage key={key} src={block.src} label={`详情图 ${descriptionImage}`} open={() => lightbox.open(photoIndex)} />;
				})}
				{description?.error && (
					<p className="text-sm text-destructive" role="alert">
						{description.error}
					</p>
				)}
				{!blocks.length && !description?.error && (
					<p className="text-sm text-muted-foreground">
						{reading ? "正在读取商品描述与详情图…" : product.detailReadAt ? `${sourceLabel} 未返回商品描述或详情图。` : "尚未取得商品描述与详情图。"}
					</p>
				)}
			</section>
			{product.sizeChartImage && (
				<section className="space-y-3" aria-label="尺码表">
					<h3 className="text-sm font-semibold">尺码表</h3>
					<DetailImage src={product.sizeChartImage} label="尺码表" open={() => lightbox.open(photos.length - 1)} />
				</section>
			)}
			{lightbox.lightbox}
		</>
	);
}
