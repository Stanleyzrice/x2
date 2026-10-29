// interactive 组件：引用一样活的东西（库里的表、站点上的会话），数据现读，人在上面做的事写回去。一个组件一个文件，名字和 web/sessions.ts 的 COMPONENTS 对上（少了、多了类型检查报错）
import type { ReactNode } from "react";
import type { InteractiveName, Item, Props } from "../../sessions.ts";
import { DataGrid } from "./datagrid.tsx";

const RENDER: { [C in InteractiveName]: (p: { props: Props<C> }) => ReactNode } = { datagrid: DataGrid };

export type InteractiveItem = Extract<Item, { component: InteractiveName }>;
export const isInteractive = (item: Item): item is InteractiveItem => item.component in RENDER;

export function Interactive({ item }: { item: InteractiveItem }) {
	const Render = RENDER[item.component] as (p: { props: unknown }) => ReactNode;
	return <Render props={item.props} />;
}
