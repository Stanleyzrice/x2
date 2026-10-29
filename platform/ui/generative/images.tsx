// images：一组图，带说明；给了链接的点了在新窗口开。不带 Referer（1688 的图挡别站的 Referer）
import type { Props } from "../../web/pages.ts";
import { Title } from "./title.tsx";

export function Images({ props }: { props: Props<"images"> }) {
	return (
		<div>
			<Title>{props.title}</Title>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
				{props.images.map((img) => {
					const pic = (
						<img
							src={img.url}
							alt={img.caption ?? ""}
							loading="lazy"
							referrerPolicy="no-referrer"
							className="aspect-square w-full rounded-lg border object-cover"
						/>
					);
					return (
						<figure key={img.url} className="flex flex-col gap-1">
							{img.link ? (
								<a href={img.link} target="_blank" rel="noreferrer">
									{pic}
								</a>
							) : (
								pic
							)}
							{img.caption && <figcaption className="line-clamp-2 text-xs text-muted-foreground">{img.caption}</figcaption>}
						</figure>
					);
				})}
			</div>
		</div>
	);
}
