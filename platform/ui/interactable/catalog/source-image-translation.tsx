import { LanguagesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorOf } from "@/lib/state";
import { api } from "../../api.ts";

type Prepared = {
	expectedScope: string;
	sourceMain: string[];
	sourceDetail: string[];
	requiredOptions: { sourceUrl: string; skuIds: string[] }[];
	selectedMain: string[];
	selectedDetail: string[];
	hasSavedImages: boolean;
};
type Receipt = {
	sourceUrl: string;
	translation: { url: string; sha256: string } | null;
	status: "ready" | "download-pending" | "failed" | "unknown" | "not-submitted";
	message: string | null;
};
const statusText: Record<Receipt["status"], string> = {
	ready: "译图已返回，待核对",
	"download-pending": "译图已返回，等待取图",
	failed: "翻译失败",
	unknown: "结果待核对",
	"not-submitted": "未提交翻译",
};

export function SourceImageTranslation({ item, sourceId, targetShop, onSaved }: { item: string; sourceId: string; targetShop: string; onSaved: () => void }) {
	const [preview, setPreview] = useState<Prepared | null>(null);
	const [main, setMain] = useState<string[]>([]);
	const [detail, setDetail] = useState<string[]>([]);
	const [queued, setQueued] = useState<string[]>([]);
	const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
	const [adopted, setAdopted] = useState<Record<string, string>>({});
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const input = { sourceId, targetShop };
	const options = preview?.requiredOptions.map(({ sourceUrl }) => sourceUrl) ?? [];
	const selected = new Set([...main, ...detail, ...options]);

	async function perform(fn: () => Promise<void>) {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await fn();
		} catch (failure) {
			setError(errorOf(failure));
		} finally {
			setBusy(false);
		}
	}

	async function prepare() {
		const result = await api.act<Prepared>(item, "sourceImagesPreview", input);
		setPreview(result);
		setMain([...new Set(result.selectedMain)]);
		setDetail([...new Set(result.selectedDetail)]);
	}

	async function translate(submit: boolean) {
		if (!preview) return;
		const result = await api.act<{ images: Receipt[]; error: string | null }>(item, "sourceXiangjiImages", {
			...input,
			expectedScope: preview.expectedScope,
			urls: queued,
			submit,
		});
		setReceipts((previous) => ({ ...previous, ...Object.fromEntries(result.images.map((entry) => [entry.sourceUrl, entry])) }));
		setQueued([]);
		if (result.error) setError(result.error);
	}

	async function save() {
		if (!preview) return;
		const choice = (url: string) => ({ url, ...(adopted[url] ? { translatedSha: adopted[url] } : {}) });
		await api.act(item, "sourceImagesSave", {
			...input,
			expectedScope: preview.expectedScope,
			main: main.map(choice),
			detail: detail.map(choice),
			options: options.map(choice),
			evidence: evidence.trim(),
		});
		setPreview({ ...preview, hasSavedImages: true });
		setNotice("已保存到商品稿。");
		onSaved();
	}

	return (
		<section className="space-y-4">
			{preview ? (
				<>
					<div className="sticky top-0 z-10 space-y-2 rounded-lg border bg-background p-3">
						<p className="text-sm text-muted-foreground">勾选含后加简体说明的图片。象寄会按新翻译的张数收费，每次最多 5 张。</p>
						<div className="flex flex-wrap gap-2">
							<Button size="sm" disabled={busy || !queued.length} onClick={() => void perform(() => translate(true))}>
								<LanguagesIcon /> 用象寄翻译（{queued.length}）
							</Button>
							<Button variant="outline" size="sm" disabled={busy || !queued.length} onClick={() => void perform(() => translate(false))}>
								查询译图
							</Button>
						</div>
						{error && (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						)}
					</div>
					{[
						{ title: "主图", urls: preview.sourceMain, value: main, set: setMain, limit: 9 },
						{ title: "详情图", urls: preview.sourceDetail, value: detail, set: setDetail, limit: 12 },
						{ title: "规格图", urls: options, value: options, set: null, limit: 100 },
					].map(({ title, urls, value, set, limit }) =>
						urls.length ? (
							<div key={title} className="space-y-2">
								<h4 className="text-sm font-semibold">
									{title}（{value.length}）
								</h4>
								<div className="grid gap-2 sm:grid-cols-2">
									{[...new Set(urls)].map((url, index) => {
										const receipt = receipts[url];
										const translated = receipt?.translation;
										return (
											<div key={url} className="space-y-2 rounded-lg border p-3">
												<div className="grid grid-cols-2 gap-2 text-xs">
													<ImagePreview url={url} label={`${title} ${index + 1} 原图`} />
													{translated && <ImagePreview url={translated.url} label="象寄译图" />}
												</div>
												<div className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
													{set && (
														<Label className="gap-1.5">
															<Checkbox
																checked={value.includes(url)}
																disabled={busy || (!value.includes(url) && value.length >= limit)}
																onCheckedChange={(checked) => {
																	set(checked === true ? [...value, url] : value.filter((entry) => entry !== url));
																}}
															/>
															采用
														</Label>
													)}
													<Label className="gap-1.5">
														<Checkbox
															checked={queued.includes(url)}
															disabled={busy || (!queued.includes(url) && queued.length >= 5)}
															onCheckedChange={(checked) => setQueued(checked === true ? [...queued, url] : queued.filter((entry) => entry !== url))}
														/>
														选择翻译
													</Label>
													{translated && (
														<Label className="gap-1.5">
															<Checkbox
																checked={adopted[url] === translated.sha256}
																disabled={busy || !selected.has(url)}
																onCheckedChange={(checked) => setAdopted({ ...adopted, [url]: checked === true ? translated.sha256 : "" })}
															/>
															采用译图
														</Label>
													)}
												</div>
												{receipt && <p className="text-xs text-muted-foreground">{receipt.message || statusText[receipt.status]}</p>}
											</div>
										);
									})}
								</div>
							</div>
						) : null,
					)}
					<div className="space-y-2">
						<Label htmlFor="translation-evidence">图片核对记录</Label>
						<Textarea
							id="translation-evidence"
							value={evidence}
							onChange={(event) => setEvidence(event.target.value)}
							maxLength={2000}
							placeholder="记录译文、数字、单位和实物印字的核对结果"
							disabled={busy}
						/>
						<p className="text-xs text-muted-foreground">勾选「采用译图」的图片会替换为译图，其余采用的图片保留原图。</p>
						<Button disabled={busy || !main.length || !evidence.trim()} onClick={() => void perform(save)}>
							{preview.hasSavedImages ? "替换草稿图片" : "保存图片到草稿"}
						</Button>
					</div>
				</>
			) : (
				<>
					<p className="text-sm text-muted-foreground">选图后可用象寄译成台湾繁体。核对原图和译图后，再保存到商品稿。</p>
					<Button disabled={busy} onClick={() => void perform(prepare)}>
						{busy ? "正在准备…" : "准备图片"}
					</Button>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</>
			)}
			{notice && (
				<p role="status" className="text-sm text-muted-foreground">
					{notice}
				</p>
			)}
		</section>
	);
}

function ImagePreview({ url, label }: { url: string; label: string }) {
	return (
		<a href={url} target="_blank" rel="noreferrer" className="space-y-1 text-muted-foreground hover:text-foreground">
			<img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" className="aspect-square w-full rounded-md bg-muted object-contain" />
			<span>{label}</span>
		</a>
	);
}
