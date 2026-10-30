// choice：一个问题、几个选项，单选是圆点、多选是勾；选项带图、说明、链接。人点「确定」存进库（POST /api/page/answer），选过的显示选了什么、什么时候，可以改了再存
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { api, fail, type Item as PageItem } from "../../api.ts";
import type { Answer, Props } from "./schema.ts";

const at = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function View({ props, item }: { props: Props; item: PageItem }) {
	const saved = item.answer as Answer | null;
	const [picked, setPicked] = useState<string[]>(saved?.picked ?? []);
	const [reason, setReason] = useState(saved?.reason ?? "");
	const [busy, setBusy] = useState(false);
	const toggle = (label: string, on: boolean) => setPicked((x) => (props.multiple ? (on ? [...x, label] : x.filter((l) => l !== label)) : on ? [label] : []));
	const submit = () => {
		setBusy(true);
		api
			.answer(item.id, { picked, ...(props.reason && reason.trim() ? { reason } : {}) })
			.catch(fail)
			.finally(() => setBusy(false));
	};
	const changed = JSON.stringify([...picked].sort()) !== JSON.stringify([...(saved?.picked ?? [])].sort()) || reason.trim() !== (saved?.reason ?? "");

	const options = props.options.map((o) => {
		const on = picked.includes(o.label);
		const mark = props.multiple ? (
			<Checkbox checked={on} onCheckedChange={(c) => toggle(o.label, Boolean(c))} aria-label={o.label} />
		) : (
			<RadioGroupItem value={o.label} aria-label={o.label} />
		);
		return (
			// biome-ignore lint/a11y/noLabelWithoutControl: 圆点、勾就在 label 里面（base-ui 画成按钮加隐藏的 input），点整行就是点它
			<Item key={o.label} variant="outline" render={<label />} className={on ? "border-primary" : "cursor-pointer"}>
				<ItemMedia>{mark}</ItemMedia>
				{o.image && (
					<ItemMedia variant="image" className="size-16">
						<img src={o.image} alt={o.label} loading="lazy" referrerPolicy="no-referrer" />
					</ItemMedia>
				)}
				<ItemContent>
					<ItemTitle>{o.label}</ItemTitle>
					{o.description && <ItemDescription>{o.description}</ItemDescription>}
					{o.link && (
						<a href={o.link} target="_blank" rel="noreferrer" className="text-xs text-primary underline-offset-4 hover:underline">
							打开
						</a>
					)}
				</ItemContent>
			</Item>
		);
	});

	return (
		<div className="flex flex-col gap-3 p-4">
			<p className="text-sm font-medium">{props.question}</p>
			<p className="text-xs text-muted-foreground">{props.multiple ? "可以选几个" : "选一个"}</p>
			{props.multiple ? (
				<div className="flex flex-col gap-2">{options}</div>
			) : (
				<RadioGroup value={picked[0] ?? null} onValueChange={(v) => setPicked(v ? [String(v)] : [])}>
					{options}
				</RadioGroup>
			)}
			{props.reason && <Textarea placeholder="理由（可以不写）" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />}
			<div className="flex items-center gap-3">
				<Button onClick={submit} disabled={busy || !picked.length || (Boolean(saved) && !changed)}>
					{saved ? "改成这个" : "确定"}
				</Button>
				{saved && item.answeredAt && (
					<span className="text-xs text-muted-foreground">
						{at(item.answeredAt)} 选了 {saved.picked.join("、")}
					</span>
				)}
			</div>
		</div>
	);
}

export const tab = (p: Props) => p.title ?? "要你选";
