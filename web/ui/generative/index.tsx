// generative 组件：agent 说话那一刻的快照，数据在组件里，只给人看。一个组件一个文件，名字和 web/sessions.ts 的 COMPONENTS 对上（少了、多了类型检查报错）
import type { ReactNode } from "react";
import type { GenerativeName, Item, Props } from "../../sessions.ts";
import { Chart } from "./chart.tsx";
import { Images } from "./images.tsx";
import { Markdown } from "./markdown.tsx";
import { SnapshotTable } from "./table.tsx";

const RENDER: { [C in GenerativeName]: (p: { props: Props<C> }) => ReactNode } = { markdown: Markdown, table: SnapshotTable, chart: Chart, images: Images };

export const isGenerative = (item: Item): item is Extract<Item, { component: GenerativeName }> => item.component in RENDER;

export function Generative({ item }: { item: Extract<Item, { component: GenerativeName }> }) {
	const Render = RENDER[item.component] as (p: { props: unknown }) => ReactNode;
	return <Render props={item.props} />;
}
