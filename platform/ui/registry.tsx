// 组件的注册表：照目录收，放在哪个目录就是哪一类（generative/<名字>/view.tsx、interactable/<名字>/view.tsx）。服务端照同样的目录收 schema.ts（platform/web/pages.ts）
// view.tsx 导出 View（照自己 schema.ts 的 Props 画；interactable 的还拿到这个组件 item：编号、人的答案）；interactable 的还可以导出 tab（右边 tab 上写什么）
import type { ComponentType } from "react";
import type { Item } from "./api.ts";

// 各个组件的 Props 不一样：注册表里写成 never（照目录收来，props 是照这个组件自己的 schema.ts 校验过的）
type View = { View: ComponentType<{ props: never; item: Item }>; tab?: (props: never) => string };

const byName = (mods: Record<string, View>) => new Map(Object.entries(mods).map(([path, m]) => [path.split("/").at(-2)!, m]));

const GENERATIVE = byName(import.meta.glob<View>("./generative/*/view.tsx", { eager: true }));
const INTERACTABLE = byName(import.meta.glob<View>("./interactable/*/view.tsx", { eager: true }));

export const isGenerative = (item: Item) => GENERATIVE.has(item.component);
export const isInteractable = (item: Item) => INTERACTABLE.has(item.component);

export const tabOf = (item: Item) => INTERACTABLE.get(item.component)?.tab?.(item.props as never) ?? item.component;

export function Render({ item }: { item: Item }) {
	if (item.invalid)
		return (
			<p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
				这个组件的参数和现在的组件对不上，没有画：{item.invalid}（agent 用 x2 page update --item {item.id} 改）
			</p>
		);
	const View = (GENERATIVE.get(item.component) ?? INTERACTABLE.get(item.component))?.View;
	return View ? <View props={item.props as never} item={item} /> : <p className="text-sm text-destructive">网页不认识组件 {item.component}</p>;
}
