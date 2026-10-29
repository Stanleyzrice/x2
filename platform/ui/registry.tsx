// 组件的注册表：照目录收，放在哪个目录就是哪一类（generative/<名字>/view.tsx、interactable/<名字>/view.tsx）。服务端照同样的目录收 schema.ts（platform/web/pages.ts）
// view.tsx 导出 View（照自己 schema.ts 的 Props 画）；interactable 的还可以导出 tab（右边 tab 上写什么）
import type { ComponentType } from "react";
import type { Item } from "./api.ts";

type View = { View: ComponentType<{ props: any }>; tab?: (props: any) => string };

const byName = (mods: Record<string, View>) => new Map(Object.entries(mods).map(([path, m]) => [path.split("/").at(-2)!, m]));

const GENERATIVE = byName(import.meta.glob<View>("./generative/*/view.tsx", { eager: true }));
const INTERACTABLE = byName(import.meta.glob<View>("./interactable/*/view.tsx", { eager: true }));

export const isGenerative = (item: Item) => GENERATIVE.has(item.component);
export const isInteractable = (item: Item) => INTERACTABLE.has(item.component);

export const tabOf = (item: Item) => INTERACTABLE.get(item.component)?.tab?.(item.props) ?? item.component;

export function Render({ item }: { item: Item }) {
	const View = (GENERATIVE.get(item.component) ?? INTERACTABLE.get(item.component))?.View;
	return View ? <View props={item.props} /> : <p className="text-sm text-destructive">网页不认识组件 {item.component}</p>;
}
