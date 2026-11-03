// product：几张商品卡，一行排几张（窄了自动换行）。图多张的左右翻（shadcn 的 carousel）；图不带 Referer（1688 的图挡别站的 Referer）；数字照中文的千分位写
import { StarIcon } from "lucide-react";
import { useLightbox } from "@/components/lightbox";
import { Title } from "@/components/title.tsx";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import type { Props } from "./schema.ts";

type Product = Props["products"][number];

const money = (n: number, currency: "TWD" | "CNY") => `${currency === "TWD" ? "NT$" : "¥"}${n.toLocaleString("zh-CN")}`;
const priceText = (p: NonNullable<Product["price"]>) =>
	p.max === undefined || p.max === p.min ? money(p.min, p.currency) : `${money(p.min, p.currency)}–${p.max.toLocaleString("zh-CN")}`;

export function View({ props }: { props: Props }) {
	const { open, lightbox } = useLightbox(props.products.flatMap((p) => p.images.map((src, i) => ({ src, alt: p.name, label: `${p.name} · 图片 ${i + 1}` }))));
	const offsets = props.products.map((_, i) => props.products.slice(0, i).reduce((n, p) => n + p.images.length, 0));
	return (
		<div>
			<Title>{props.title}</Title>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
				{props.products.map((p, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 快照，卡片不会变；同一个商品可以放两次（例 两家店）
					<ProductCard key={i} product={p} openImage={(index) => open(offsets[i]! + index)} />
				))}
			</div>
			{lightbox}
		</div>
	);
}

function ProductCard({ product: p, openImage }: { product: Product; openImage: (index: number) => void }) {
	const name = p.link ? (
		<a href={p.link} target="_blank" rel="noreferrer" className="hover:underline">
			{p.name}
		</a>
	) : (
		p.name
	);
	const facts = [
		p.sold30d !== undefined && `30 天售 ${p.sold30d.toLocaleString("zh-CN")}`,
		p.rating !== undefined && (
			<span key="r" className="inline-flex items-center gap-0.5">
				<StarIcon className="size-3 fill-current" />
				{p.rating}
			</span>
		),
		p.shop,
	].filter(Boolean);
	return (
		<Card size="sm" className="gap-2 overflow-hidden pt-0">
			<Pictures images={p.images} alt={p.name} openImage={openImage} />
			<CardContent className="flex flex-col gap-1">
				<div className="line-clamp-2 text-sm font-medium">{name}</div>
				{p.price && <div className="text-base font-semibold tabular-nums">{priceText(p.price)}</div>}
				{facts.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						{facts.map((f, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 几样固定的字，顺序不变
							<span key={i}>{f}</span>
						))}
					</div>
				)}
				{p.tags && p.tags.length > 0 && (
					<div className="flex flex-wrap gap-1 pt-1">
						{p.tags.map((t) => (
							<Badge key={t} variant="secondary">
								{t}
							</Badge>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function Pictures({ images, alt, openImage }: { images: string[]; alt: string; openImage: (index: number) => void }) {
	const img = (url: string, index: number) => (
		<button
			type="button"
			aria-label={`放大 ${alt} 图片 ${index + 1}`}
			className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-ring"
			onClick={() => openImage(index)}
		>
			<img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="aspect-square w-full bg-muted object-cover" />
		</button>
	);
	if (images.length === 1) return img(images[0]!, 0);
	return (
		<Carousel opts={{ loop: true }}>
			<CarouselContent className="ml-0">
				{images.map((url, index) => (
					<CarouselItem key={url} className="pl-0">
						{img(url, index)}
					</CarouselItem>
				))}
			</CarouselContent>
			<CarouselPrevious className="left-2" />
			<CarouselNext className="right-2" />
		</Carousel>
	);
}
