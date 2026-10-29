// diagram：一张 Mermaid 图。用到才加载 Mermaid（大）；深浅色跟系统；宽的图在流里会缩小，点「放大」在对话框里看原大；写错了显示 Mermaid 的原话和原文，好让 agent 改
import { Maximize2Icon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { Props } from "../../web/sessions.ts";
import { Title } from "./title.tsx";

export function Diagram({ props }: { props: Props<"diagram"> }) {
	const id = `d${useId().replace(/[^\w]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		import("mermaid").then(async ({ default: mermaid }) => {
			const dark = document.documentElement.classList.contains("dark");
			mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
			try {
				const r = await mermaid.render(id, props.mermaid);
				if (alive) setSvg(r.svg);
			} catch (e) {
				if (alive) setError((e as Error).message);
			}
		});
		return () => {
			alive = false;
		};
	}, [id, props.mermaid]);
	return (
		<div>
			<Title>{props.title}</Title>
			{error ? (
				<div className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
					<p className="text-destructive">图画不出来：{error}</p>
					<pre className="overflow-x-auto text-xs text-muted-foreground">{props.mermaid}</pre>
				</div>
			) : svg ? (
				<div className="relative">
					<Picture svg={svg} className="[&_svg]:h-auto [&_svg]:max-w-full" />
					<Dialog>
						<DialogTrigger
							render={
								<Button size="icon-sm" variant="ghost" aria-label="放大" className="absolute top-0 right-0">
									<Maximize2Icon />
								</Button>
							}
						/>
						<DialogContent className="max-h-[95vh] overflow-auto sm:max-w-[95vw]">
							<DialogTitle>{props.title ?? "图"}</DialogTitle>
							<Picture svg={svg} className="[&_svg]:h-auto [&_svg]:min-w-[min(100%,60rem)] [&_svg]:max-w-none" />
						</DialogContent>
					</Dialog>
				</div>
			) : (
				<div className="h-32 animate-pulse rounded-lg bg-muted" />
			)}
		</div>
	);
}

function Picture({ svg, className }: { svg: string; className: string }) {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid 画好的 SVG（securityLevel strict 已经去掉脚本和事件）
	return <div className={`flex justify-center overflow-x-auto ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
