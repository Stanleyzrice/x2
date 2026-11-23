import { ArrowUpIcon, ChevronDownIcon, FileTextIcon, ImageIcon, PlusIcon, QuoteIcon, XIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
} from "./components/ui/attachment";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "./components/ui/input-group";
import { Spinner } from "./components/ui/spinner";
import { Textarea } from "./components/ui/textarea";
import {
	attachmentLimit,
	flashModel,
	type HermesAttachment,
	type HermesModel,
	hermesModels,
	photoDataLimit,
	photoTypes,
	quoteLimit,
	textFileExtensions,
	textFileLimit,
} from "./hermes-schema.ts";
import { errorOf } from "./lib/state.ts";

export const modelLabels: Record<HermesModel, string> = {
	"deepseek-flash": "DeepSeek Flash",
	"deepseek-v4-pro": "DeepSeek V4 Pro",
};

type Props = {
	message: string;
	setMessage: (value: string) => void;
	model: HermesModel;
	setModel: (value: HermesModel) => void;
	attachments: HermesAttachment[];
	setAttachments: (value: HermesAttachment[]) => void;
	busy: boolean;
	reading: boolean;
	setReading: (value: boolean) => void;
	onSend: () => void;
};

async function photoURL(file: File) {
	if (file.size > 24 * 1024 * 1024) throw new Error("请先将单张照片缩小到 24 MB 以内");
	let blob: Blob = file;
	if (file.size > 320 * 1024) {
		const bitmap = await createImageBitmap(file);
		try {
			const canvas = document.createElement("canvas");
			const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("无法读取照片");
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			blob = await new Promise<Blob>((resolve, reject) =>
				canvas.toBlob((image) => (image ? resolve(image) : reject(new Error("无法转换照片"))), "image/jpeg", 0.84),
			);
		} finally {
			bitmap.close();
		}
	}
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("无法读取照片"));
		reader.readAsDataURL(blob);
	});
}

export function HermesComposer({ message, setMessage, model, setModel, attachments, setAttachments, busy, reading, setReading, onSend }: Props) {
	const form = useRef<HTMLFormElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const photoInput = useRef<HTMLInputElement>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [quoteOpen, setQuoteOpen] = useState(false);
	const [quote, setQuote] = useState("");
	const includesPhotos = attachments.some((item) => item.kind === "photo");
	const disabled = busy || reading;
	const full = attachments.length >= attachmentLimit;
	const canSend = !disabled && Boolean(message.trim() || attachments.length);

	async function addFiles(files: File[], kind: "file" | "photo") {
		if (!files.length || disabled) return;
		setProblem(null);
		if (attachments.length + files.length > attachmentLimit) {
			setProblem(`一次最多添加 ${attachmentLimit} 项资料。`);
			return;
		}
		setReading(true);
		try {
			const added = await Promise.all(
				files.map(async (file): Promise<HermesAttachment> => {
					if (kind === "photo") {
						if (!photoTypes.some((mime) => mime === file.type)) throw new Error("照片支持 JPG、PNG、WebP 和 GIF。");
						return { kind, name: file.name.slice(0, 255) || "剪贴板照片", url: await photoURL(file) };
					}
					if (!textFileExtensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
						throw new Error("文件支持 TXT、Markdown、CSV、TSV、JSON、日志、YAML 和 XML。");
					}
					if (file.size > 4 * textFileLimit) throw new Error(`${file.name} 超过 ${textFileLimit} 字，请分段添加。`);
					const text = await file
						.arrayBuffer()
						.then((buffer) => new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim())
						.catch(() => "");
					if (!text || text.includes("\0")) throw new Error(`${file.name} 需要包含有效的 UTF-8 文本。`);
					if (text.length > textFileLimit) throw new Error(`${file.name} 超过 ${textFileLimit} 字，请分段添加。`);
					return { kind, name: file.name.slice(0, 255), text };
				}),
			);
			const next = [...attachments, ...added];
			if (next.reduce((size, item) => size + (item.kind === "photo" ? item.url.length : 0), 0) > photoDataLimit) {
				throw new Error("照片合计超过 1 MB，请减少张数或缩小后再添加。");
			}
			if (kind === "photo") setModel(flashModel);
			setAttachments(next);
		} catch (failure) {
			setProblem(errorOf(failure));
		} finally {
			setReading(false);
		}
	}

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!canSend) return;
		setProblem(null);
		onSend();
	};
	return (
		<div className="mx-auto w-full max-w-4xl">
			<form ref={form} onSubmit={submit}>
				<input
					ref={fileInput}
					type="file"
					accept={textFileExtensions.join(",")}
					multiple
					hidden
					onChange={(event) => {
						void addFiles(Array.from(event.target.files ?? []), "file");
						event.target.value = "";
					}}
				/>
				<input
					ref={photoInput}
					type="file"
					accept={photoTypes.join(",")}
					multiple
					hidden
					onChange={(event) => {
						void addFiles(Array.from(event.target.files ?? []), "photo");
						event.target.value = "";
					}}
				/>
				<InputGroup className="rounded-2xl bg-background shadow-sm">
					{attachments.length > 0 && (
						<InputGroupAddon align="block-start" className="min-w-0">
							<AttachmentGroup className="w-full pb-1" aria-label="本条消息的资料">
								{attachments.map((item, index) => {
									const title = item.kind === "quote" ? "引用段落" : item.name;
									return (
										<Attachment key={item.kind === "quote" ? `quote-${item.text}` : `${item.kind}-${item.name}-${index}`} size="sm" className="max-w-60">
											<AttachmentMedia variant={item.kind === "photo" ? "image" : "icon"}>
												{item.kind === "photo" ? <img src={item.url} alt="" /> : item.kind === "quote" ? <QuoteIcon /> : <FileTextIcon />}
											</AttachmentMedia>
											<AttachmentContent>
												<AttachmentTitle title={title}>{title}</AttachmentTitle>
												<AttachmentDescription title={item.kind === "quote" ? item.text : undefined}>
													{item.kind === "quote" ? item.text : item.kind === "photo" ? "照片" : `${item.text.length} 字`}
												</AttachmentDescription>
											</AttachmentContent>
											<AttachmentActions>
												<AttachmentAction
													type="button"
													aria-label={`移除${title}`}
													disabled={reading}
													onClick={() => {
														setAttachments(attachments.filter((_, i) => i !== index));
														setProblem(null);
													}}
												>
													<XIcon />
												</AttachmentAction>
											</AttachmentActions>
										</Attachment>
									);
								})}
							</AttachmentGroup>
						</InputGroupAddon>
					)}
					<InputGroupTextarea
						aria-label="发消息给 Hermes"
						value={message}
						maxLength={10_000}
						onChange={(event) => setMessage(event.target.value)}
						placeholder="发消息给 Hermes…"
						className="min-h-16 max-h-44 px-4 pt-3"
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								form.current?.requestSubmit();
							}
						}}
						onPaste={(event) => {
							const photos = Array.from(event.clipboardData.files).filter((file) => photoTypes.some((mime) => mime === file.type));
							if (!photos.length) return;
							event.preventDefault();
							void addFiles(photos, "photo");
						}}
					/>
					<InputGroupAddon align="block-end" className="justify-between px-3 pb-3">
						<DropdownMenu>
							<DropdownMenuTrigger
								disabled={disabled || full}
								render={<InputGroupButton size="icon-sm" type="button" variant="outline" className="rounded-full" aria-label="添加资料" />}
							>
								{reading ? <Spinner aria-hidden="true" /> : <PlusIcon />}
							</DropdownMenuTrigger>
							<DropdownMenuContent side="top" align="start" className="w-52">
								<DropdownMenuItem onClick={() => fileInput.current?.click()}>
									<FileTextIcon /> 添加文件
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => photoInput.current?.click()}>
									<ImageIcon /> 添加照片
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setQuoteOpen(true)}>
									<QuoteIcon /> 引用文字段落
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<div className="ml-auto flex items-center gap-2">
							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={disabled}
									render={<InputGroupButton size="sm" type="button" aria-label={`选择模型，当前 ${modelLabels[model]}`} />}
								>
									{modelLabels[model]}
									<ChevronDownIcon className="text-muted-foreground" />
								</DropdownMenuTrigger>
								<DropdownMenuContent side="top" align="end" className="w-52">
									<DropdownMenuLabel>{includesPhotos ? "照片使用 DeepSeek Flash" : "选择模型"}</DropdownMenuLabel>
									<DropdownMenuRadioGroup value={model} onValueChange={(value) => setModel(value as HermesModel)}>
										{hermesModels.map((option) => (
											<DropdownMenuRadioItem key={option} value={option} closeOnClick disabled={includesPhotos && option !== flashModel}>
												{modelLabels[option]}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
							<InputGroupButton type="submit" size="icon-sm" variant="default" className="rounded-full" disabled={!canSend} aria-label="发送">
								{busy ? <Spinner aria-hidden="true" /> : <ArrowUpIcon />}
							</InputGroupButton>
						</div>
					</InputGroupAddon>
				</InputGroup>
			</form>
			{problem && (
				<p role="alert" className="mt-2 px-1 text-xs text-destructive">
					{problem}
				</p>
			)}
			<Dialog open={quoteOpen} onOpenChange={setQuoteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>引用文字段落</DialogTitle>
						<DialogDescription>粘贴想让 Hermes 参考的原文。</DialogDescription>
					</DialogHeader>
					<Textarea aria-label="引用原文" value={quote} onChange={(event) => setQuote(event.target.value)} maxLength={quoteLimit} rows={5} />
					<DialogFooter>
						<Button
							disabled={!quote.trim() || disabled || full}
							onClick={() => {
								const text = quote.trim();
								if (!attachments.some((item) => item.kind === "quote" && item.text === text)) setAttachments([...attachments, { kind: "quote", text }]);
								setQuote("");
								setQuoteOpen(false);
							}}
						>
							添加引用
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
