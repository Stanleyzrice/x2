// 目录导航条：贴在页面右边，一节一道刻度，当前在看的那道长、深；鼠标移上去展开目录（编号、名字），点一项滚到那里。
// 一节是一张卡片（审稿、设置）或一组（按列分组的表格）；不到两节、手机上不显示
import { TableOfContents, useTableOfContentsActiveId } from "@cloudflare/kumo";
import { useState } from "react";

export type Section = { id: string; label: string };

export function Outline({ sections, unit }: { sections: Section[]; unit: string }) {
	const [open, setOpen] = useState(false);
	// 地址的 # 是网页的路由，不让它认
	const { activeId, selectSection } = useTableOfContentsActiveId({ ids: sections.map((s) => s.id), offset: 16, trackHash: false });
	if (sections.length < 2) return null;
	const go = (id: string) => {
		selectSection(id);
		document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	const active = activeId ?? sections[0]!.id;
	return (
		<nav aria-label="目录" className="fixed top-1/2 right-2 z-20 hidden -translate-y-1/2 md:block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
			<div className="flex max-h-[70vh] flex-col items-end justify-center gap-[3px] overflow-hidden py-2 pl-3">
				{sections.map((s) => (
					<button key={s.id} type="button" aria-label={s.label} onClick={() => go(s.id)}
						className={`h-0.5 shrink-0 rounded-full ${s.id === active ? "w-5 bg-kumo-contrast" : "w-3 bg-kumo-line"}`} />
				))}
			</div>
			{open && (
				<div className="absolute top-1/2 right-full w-80 -translate-y-1/2 rounded-xl border border-kumo-line bg-kumo-base p-4 shadow-lg">
					<TableOfContents>
						<TableOfContents.Title>目录<span className="ml-2 font-normal text-kumo-subtle">{sections.length} {unit}</span></TableOfContents.Title>
						<TableOfContents.List className="max-h-[60vh] overflow-y-auto">
							{sections.map((s, i) => (
								<TableOfContents.Item key={s.id} active={s.id === active} onClick={() => go(s.id)} className="cursor-pointer">
									<span className="mr-2 inline-block w-6 text-right tabular-nums text-kumo-subtle">{i + 1}</span>{s.label}
								</TableOfContents.Item>
							))}
						</TableOfContents.List>
					</TableOfContents>
				</div>
			)}
		</nav>
	);
}
