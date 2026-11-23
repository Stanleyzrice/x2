// 选中备选的任务导出：固定本批店铺与商品，复用弹窗和文本框预览、复制及下载，不触发上架。

import { BotIcon, CopyIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorOf } from "@/lib/state";
import { api, type Item } from "../../api.ts";
import { openHermesForBatch } from "../../hermes-chat.tsx";
import type { SourcePrompt } from "./source-types.ts";

type Selection = { shop: string; sourceIds: string[] };
type Batch = { selection: Selection; file: SourcePrompt | null; error: string | null; original?: string };

export function SourcePromptButton({ item, shop, sourceIds, disabled }: { item: Item; shop: string; sourceIds: string[]; disabled: boolean }) {
	const [batch, setBatch] = useState<Batch | null>(null);
	const [copying, setCopying] = useState(false);
	const text = useRef<HTMLTextAreaElement | null>(null);
	const opened = useRef(false);
	const generation = useRef(0);
	const copyingRef = useRef(false);
	useEffect(
		() => () => {
			generation.current++;
			opened.current = false;
		},
		[],
	);
	const load = async (selection: Selection) => {
		const request = ++generation.current;
		setBatch({ selection, file: null, error: null });
		try {
			const file = await api.act<SourcePrompt>(item.id, "sourcePrompt", { targetShop: selection.shop, sourceIds: selection.sourceIds });
			if (generation.current !== request) return;
			if (file.shop !== selection.shop || file.count !== selection.sourceIds.length) throw new Error("导出内容与本次选择不一致，请重试");
			setBatch({ selection, file, error: null, original: file.prompt });
		} catch (error) {
			if (generation.current === request) setBatch({ selection, file: null, error: errorOf(error) });
		}
	};
	const open = () => {
		if (disabled || opened.current || !sourceIds.length) return;
		opened.current = true;
		void load({ shop, sourceIds: [...sourceIds] });
	};
	const close = () => {
		generation.current++;
		opened.current = false;
		copyingRef.current = false;
		setCopying(false);
		setBatch(null);
	};
	const copy = async () => {
		if (!batch?.file?.prompt.trim() || copyingRef.current) return;
		const request = generation.current;
		copyingRef.current = true;
		setCopying(true);
		try {
			await navigator.clipboard.writeText(batch.file.prompt);
			if (generation.current === request) toast.success("提示词已复制");
		} catch {
			if (generation.current === request) {
				text.current?.focus();
				text.current?.select();
				toast.error("复制失败，已选中文本，请手动复制");
			}
		} finally {
			if (generation.current === request) {
				copyingRef.current = false;
				setCopying(false);
			}
		}
	};
	const download = () => {
		if (!batch?.file?.prompt.trim()) return;
		try {
			const url = URL.createObjectURL(new Blob([batch.file.prompt], { type: "text/plain;charset=utf-8" }));
			try {
				const link = document.createElement("a");
				link.href = url;
				link.download = batch.file.filename;
				link.click();
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			}
		} catch {
			toast.error("下载失败，请重试");
		}
	};
	return (
		<>
			<Button variant="outline" disabled={disabled || !sourceIds.length} onClick={open}>
				导出上架提示词（{sourceIds.length}）
			</Button>
			<Dialog open={batch !== null} onOpenChange={(next) => !next && close()}>
				<DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-5 overflow-y-auto p-4 sm:max-w-[740px] sm:p-6">
					<DialogHeader>
						<DialogTitle className="text-xl">导出上架提示词</DialogTitle>
						<DialogDescription>可补充本批要求，然后交给 Hermes，或复制、下载提示词。</DialogDescription>
						{batch && (
							<p className="text-sm text-muted-foreground">
								{batch.selection.shop} · {batch.selection.sourceIds.length} 件商品
							</p>
						)}
					</DialogHeader>
					{batch?.file ? (
						<Textarea
							ref={text}
							aria-label="上架任务提示词"
							value={batch.file.prompt}
							onChange={(event) => {
								const prompt = event.target.value;
								setBatch((current) => (current?.file ? { ...current, file: { ...current.file, prompt } } : current));
							}}
							style={{ fieldSizing: "fixed" }}
							className="h-[min(440px,55dvh)] min-h-40 resize-none overflow-y-auto px-4 py-3 text-sm leading-6"
						/>
					) : (
						<div className="flex h-[min(440px,55dvh)] min-h-40 flex-col items-center justify-center gap-3 rounded-lg border p-4">
							{batch?.error ? (
								<>
									<p role="alert" className="text-sm text-destructive">
										{batch.error}
									</p>
									<Button variant="outline" size="sm" onClick={() => void load(batch.selection)}>
										重新导出
									</Button>
								</>
							) : (
								<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
									<LoaderCircleIcon className="size-4 animate-spin" />
									正在生成提示词…
								</p>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" disabled={!batch?.file?.prompt.trim()} onClick={download}>
							<DownloadIcon />
							下载 .txt
						</Button>
						<Button variant="outline" disabled={!batch?.file?.prompt.trim() || copying} onClick={() => void copy()}>
							{copying ? <LoaderCircleIcon className="animate-spin" /> : <CopyIcon />}复制提示词
						</Button>
						<Button
							disabled={!batch?.file?.prompt.trim()}
							onClick={() => {
								if (!batch?.file) return;
								try {
									openHermesForBatch({ ...batch.selection, ...(batch.file.prompt !== batch.original ? { notes: batch.file.prompt } : {}) });
									close();
								} catch {
									toast.error("无法交接任务，请检查浏览器是否允许保存临时会话");
								}
							}}
						>
							<BotIcon />
							交给 Hermes
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
