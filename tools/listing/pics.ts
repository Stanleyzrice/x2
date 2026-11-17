// 商品稿的图的类型（纯数据）：筛字的结论、一张图走到哪了、水印的设置
export type Verdict = "d" | "r" | "m" | "p" | "n";
export type ImageMode = "processed" | "original" | "reviewed";

/** 独立审阅的真实来源，不作为 Gemini 筛字或象寄检查缓存。 */
export type ImageReview = {
	provider: "openai-image" | "clean-original";
	evidence: string;
	sourceSha256: string;
	processedSha256: string;
	path: string;
	scope: string;
	skuIds?: string[];
	at: string;
};

export type Pic = {
	from: string;
	sha?: string;
	verdict?: Verdict;
	simplified?: boolean;
	translated?: string;
	final?: string;
	imageId?: string;
	width?: number;
	height?: number;
	drop?: string;
	review?: ImageReview;
};
export type Pics = { main: Pic[]; detail: Pic[]; options: Pic[]; imageMode?: ImageMode };

/** 显式参数只作用于本次商品稿；没传时沿用该稿选择，旧稿保持原有处理方式。 */
export const imageModeOf = (requested: ImageMode | undefined, pics: Partial<Pics> | null | undefined, defaultMode: ImageMode = "processed"): ImageMode =>
	requested ?? pics?.imageMode ?? defaultMode;

export type Mark = { text: string; size: number; opacity: number; position: "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right" };
