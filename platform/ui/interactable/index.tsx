// interactable 组件：引用一样活的东西（库里的表、聊聊的会话），数据现读，人在上面做的事写回去。一个组件一个文件，名字和 platform/web/pages.ts 的 COMPONENTS 对上（少了、多了类型检查报错）
import type { ReactNode } from "react";
import type { InteractableName, Item, Props } from "../../web/pages.ts";
import { DataGrid } from "./datagrid.tsx";

const RENDER: { [C in InteractableName]: (p: { props: Props<C> }) => ReactNode } = { datagrid: DataGrid };

export type InteractableItem = Extract<Item, { component: InteractableName }>;
export const isInteractable = (item: Item): item is InteractableItem => item.component in RENDER;

export function Interactable({ item }: { item: InteractableItem }) {
	const Render = RENDER[item.component] as (p: { props: unknown }) => ReactNode;
	return <Render props={item.props} />;
}
