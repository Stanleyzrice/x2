// stats：一排关键数字，一个一张小卡片；数字照中文的千分位写
import { Card, CardContent } from "@/components/ui/card";
import type { Props } from "../../web/pages.ts";
import { Title } from "./title.tsx";

export function Stats({ props }: { props: Props<"stats"> }) {
	return (
		<div>
			<Title>{props.title}</Title>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
				{props.items.map((x) => (
					<Card key={x.label} size="sm">
						<CardContent className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">{x.label}</span>
							<span className="text-xl font-semibold tabular-nums">{typeof x.value === "number" ? x.value.toLocaleString("zh-CN") : x.value}</span>
							{x.hint && <span className="text-xs text-muted-foreground">{x.hint}</span>}
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	);
}
